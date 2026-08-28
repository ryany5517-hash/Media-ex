/**
 * Injection-order validator (B6). A content script that reads SR.foo before the
 * file assigning SR.foo loads produces a per-frame TypeError in the browser.
 * The validator must reject a deliberately broken order, accept the real
 * manifest, and flag a listed-but-missing file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScriptOrder } from '../lib/script-order.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DIST = path.join(ROOT, 'dist', 'chrome');
const readDist = rel => readFileSync(path.join(DIST, rel), 'utf8');

const FILES = {
  'content/a-consumer.js': "(function(r){var SR=r.SR=r.SR||{}; SR.ui.create(); SR.i18n.t('x'); })(globalThis);",
  'content/z-provider.js': '(function(r){var SR=r.SR=r.SR||{}; SR.ui = { create(){} }; })(globalThis);',
  'shared/i18n.js': "(function(r){var SR=r.SR=r.SR||{}; SR.i18n = { t(){} }; })(globalThis);",
};

function makeTempBuild() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sr-order-'));
  for (const [rel, src] of Object.entries(FILES)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  const read = rel => readFileSync(path.join(dir, rel), 'utf8');
  return { dir, read };
}

test('script-order: real built manifest passes', () => {
  const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const { errors } = validateScriptOrder(manifest, DIST, readDist);
  assert.deepEqual(errors, [], 'real manifest must have zero order errors:\n' + errors.join('\n'));
});

test('script-order: consumer before provider is rejected; correct order passes', () => {
  const { dir, read } = makeTempBuild();
  try {
    const broken = { content_scripts: [{ js: ['content/a-consumer.js', 'content/z-provider.js', 'shared/i18n.js'] }] };
    const r1 = validateScriptOrder(broken, dir, read);
    assert.ok(r1.errors.some(e => /uses SR\.(ui|i18n) before/.test(e)), 'consumer-before-provider must error:\n' + r1.errors.join('\n'));

    const good = { content_scripts: [{ js: ['shared/i18n.js', 'content/z-provider.js', 'content/a-consumer.js'] }] };
    const r2 = validateScriptOrder(good, dir, read);
    assert.deepEqual(r2.errors, [], 'correct order must pass:\n' + r2.errors.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script-order: a manifest listing a missing file is rejected', () => {
  const manifest = { content_scripts: [{ js: ['shared/util.js', 'shared/does-not-exist.js'] }] };
  const { errors } = validateScriptOrder(manifest, DIST, readDist);
  assert.ok(errors.some(e => /does-not-exist\.js/.test(e) && /does not exist/.test(e)), 'missing file must be reported:\n' + errors.join('\n'));
});
