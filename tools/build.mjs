/**
 * Stream Radar build + validation.
 *
 *   node tools/build.mjs            → dist/chrome/, dist/firefox/ + zips + userscript
 *   node tools/build.mjs --chrome   → chrome only
 *   node tools/build.mjs --firefox  → firefox only
 *   node tools/build.mjs --no-zip   → skip archives
 *
 * Why a build step at all?
 *  1. MV3 service workers can only be ONE file. src/ keeps modules separate
 *     (readable, unit-testable); the build concatenates the shared modules in
 *     front of background.js so Firefox works without importScripts support.
 *  2. Browser-specific manifest keys are stripped per target so neither browser
 *     shows "unknown manifest key" warnings.
 *  3. It runs a validation pass (syntax, manifest refs, settings keys) — this is
 *     the "did you actually try it before handing it over" check.
 */
import { readdir, readFile, writeFile, mkdir, rm, stat, cp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zip } from './lib/zip.mjs';
import { validateScriptOrder } from './lib/script-order.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const PRELUDE = ['shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'shared/subtitles.js', 'shared/i18n.js', 'shared/store.js', 'shared/updater.js'];

const args = process.argv.slice(2);
const only = args.includes('--chrome') ? 'chrome' : args.includes('--firefox') ? 'firefox' : null;
const noZip = args.includes('--no-zip');

const log = (...a) => console.log('\x1b[36m▸\x1b[0m', ...a);
const ok = (...a) => console.log('\x1b[32m✓\x1b[0m', ...a);
const warn = (...a) => console.log('\x1b[33m!\x1b[0m', ...a);
const fail = (msg) => {
  console.error('\x1b[31m✗ ' + msg + '\x1b[0m');
  process.exitCode = 1;
  throw new Error(msg);
};

async function walk(dir, out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * prelude inlining
 * ------------------------------------------------------------------ */
async function bundleBackground(srcDir) {
  const file = path.join(srcDir, 'background.js');
  let body = await readFile(file, 'utf8');
  const parts = [];
  for (const rel of PRELUDE) {
    const mod = await readFile(path.join(SRC, rel), 'utf8');
    parts.push(`/* ===== inlined: src/${rel} ===== */\n${mod.trim()}\n`);
  }
  body = body.replace(/\/\* ---8<--- prelude:start \*\/[\s\S]*?\/\* ---8<--- prelude:end \*\//, '/* shared modules are inlined above by tools/build.mjs */');
  return parts.join('\n') + '\n' + body;
}

/* ------------------------------------------------------------------ *
 * manifest tweaks per target
 * ------------------------------------------------------------------ */
function manifestFor(target, m) {
  const out = JSON.parse(JSON.stringify(m));
  if (target === 'firefox') {
    delete out.minimum_chrome_version;
    out.browser_specific_settings = out.browser_specific_settings || { gecko: {} };
    out.browser_specific_settings.gecko = out.browser_specific_settings.gecko || {};
    // Firefox wants an event-page fallback next to the service worker
    // (web-ext: BACKGROUND_SERVICE_WORKER_NOFALLBACK).
    // Firefox wants an event-page fallback next to the service worker
    // (web-ext: BACKGROUND_SERVICE_WORKER_NOFALLBACK). Firefox uses whichever
    // key it understands; Chrome (stripped below) only ever sees service_worker.
    out.background = out.background || {};
    out.background.scripts = [out.background.service_worker || 'background.js'];
    out.background.persistent = false;
    delete out.background.service_worker;
  } else {
    delete out.browser_specific_settings;
    delete out.author;
    if (out.background) delete out.background.scripts;
    for (const cs of out.content_scripts || []) {
      // Chrome < 133 warns on this key; the isolated-world fallback in
      // content.js covers older builds anyway.
      delete cs.match_origin_as_fallback;
    }
    for (const w of out.web_accessible_resources || []) delete w.extension_pages;
    // Firefox-only command description keys are fine in Chrome, keep them.
  }
  if (out.web_accessible_resources) {
    for (const w of out.web_accessible_resources) {
      if (target === 'firefox') w.matches = w.matches || ['<all_urls>'];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * validation
 * ------------------------------------------------------------------ */
async function validate(target, dir, manifest) {
  // 1. every referenced file exists
  const refs = new Set();
  for (const cs of manifest.content_scripts || []) (cs.js || []).concat(cs.css || []).forEach((f) => refs.add(f));
  (manifest.web_accessible_resources || []).forEach((w) => (w.resources || []).forEach((r) => refs.add(r)));
  if (manifest.background?.service_worker) refs.add(manifest.background.service_worker);
  if (manifest.options_page) refs.add(manifest.options_page.replace(/^\.\//, ''));
  if (manifest.action?.default_popup) refs.add(manifest.action.default_popup.replace(/^\.\//, ''));
  Object.values(manifest.icons || {}).forEach((i) => refs.add(i));
  Object.values(manifest.action?.default_icon || {}).forEach((i) => refs.add(i));

  for (const r of refs) {
    if (r.includes('*')) {
      const dirPart = r.split('*')[0].replace(/\/$/, '');
      const base = path.join(dir, dirPart);
      if (dirPart && !existsSync(base)) fail(`${target}: web_accessible_resources "${r}" matches nothing (${dirPart} missing)`);
      continue;
    }
    if (!existsSync(path.join(dir, r))) fail(`${target}: manifest references missing file "${r}"`);
  }

  // 2. syntax check every script
  const files = await walk(dir);
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      fail(`${target}: syntax error in ${path.relative(dir, f)}\n${e.stderr?.toString?.() || e.message}`);
    }
  }

  // 3. every options.html data-key must exist in SR.defaults (typo guard)
  const defaultsSrc = await readFile(path.join(SRC, 'shared/util.js'), 'utf8');
  const optHtml = await readFile(path.join(dir, 'options/options.html'), 'utf8');
  const keys = [...optHtml.matchAll(/data-key="([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]);
  const sr = { SR: {} };
  await import(pathToFileUrl(path.join(dir, 'shared/util.js')));
  const defs = globalThis.SR?.defaults || {};
  for (const k of keys) {
    const top = k.split('.')[0];
    if (!(top in defs) && !defaultsSrc.includes(top + ':')) fail(`${target}: options.html binds unknown setting "${k}"`);
  }

  // 4. injection order: SR.foo must not be consumed before a js entry provides
  // it, and every manifest-listed file must exist in the build.
  const { errors: orderErrors } = validateScriptOrder(manifest, dir, rel => readFileSync(path.join(dir, rel), 'utf8'));
  for (const e of orderErrors) fail(`${target}: ${e}`);

  // 5. manifest JSON validity is implied by the parse above; check MV3 basics
  if (manifest.manifest_version !== 3) fail(`${target}: manifest_version must be 3`);
  if (!manifest.content_scripts?.length) fail(`${target}: no content scripts`);
  if (!(manifest.host_permissions || []).includes('<all_urls>')) warn(`${target}: <all_urls> host permission missing → detection will be crippled`);
  if (!manifest.action?.default_popup) warn(`${target}: no popup defined`);
  return files.length;
}

function pathToFileUrl(p) {
  return 'file://' + p;
}

/* ------------------------------------------------------------------ *
 * build one target
 * ------------------------------------------------------------------ */
async function buildTarget(target) {
  const out = path.join(DIST, target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(SRC, out, { recursive: true });
  await rm(path.join(out, 'icons/preview.png'), { force: true });
  await rm(path.join(out, 'icons/icon512.png'), { force: true });

  const manifest = manifestFor(target, JSON.parse(await readFile(path.join(SRC, 'manifest.json'), 'utf8')));
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const version = manifest.version;
  await writeFile(path.join(out, 'background.js'), await bundleBackground(SRC));
  const n = await validate(target, out, manifest);
  ok(`${target}: ${n} files, manifest v${version}, validated`);

  if (!noZip) {
    const base = `stream-radar-${target}-${version}`;
    const file = path.join(DIST, base + (target === 'firefox' ? '.xpi' : '.zip'));
    await zip(out, file);
    ok(`${target}: packed → dist/${base}.${target === 'firefox' ? 'xpi' : 'zip'}`);
  }
  return { out, manifest, version };
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
async function main() {
  const t0 = Date.now();
  await mkdir(DIST, { recursive: true });
  const targets = only ? [only] : ['chrome', 'firefox'];
  let built;
  for (const t of targets) built = await buildTarget(t);
  // the userscript build reuses the same shared modules (see tools/build-userscript.mjs)
  if (!only) {
    const { buildUserscript } = await import('./build-userscript.mjs');
    await buildUserscript();
  }
  ok(`build finished in ${Date.now() - t0} ms`);
  console.log('\nLoad it:\n  Chrome  → chrome://extensions → "Load unpacked" → dist/chrome\n  Firefox → about:debugging#/runtime/this-firefox → "Load Temporary Add-on" → dist/firefox/manifest.json\n');
}

main().catch((e) => {
  console.error('\x1b[31mBuild failed:\x1b[0m', e.message);
  process.exit(1);
});
