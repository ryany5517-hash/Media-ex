/**
 * Content-script injection-order validator (B6).
 * ------------------------------------------------------------------
 * MV3 content scripts run each js entry in order and share one global SR.
 * If a module reads SR.foo before the file that assigns SR.foo has loaded,
 * the user sees dozens of "Cannot read properties of undefined" errors - one
 * per frame - with no build-time signal. The same failure happens when the
 * manifest names a file that the build does not actually contain.
 *
 * This is a deliberately conservative STATIC check:
 *   provides: identifiers a file assigns on the shared namespace, e.g.
 *             SR.foo = ...  (captured as "foo")
 *   consumes: identifiers a file references on SR, e.g. SR.foo / SR.foo.bar
 *             (ignoring assignments, dynamic SR[name], and the local
 *             `const SR = (root.SR = root.SR || {})` bootstrap).
 * For every content_scripts group, a consume is satisfied if the identifier
 * is provided earlier in the same group OR in a file that appears in every
 * content_scripts group that loads in the same world (a shared prelude that
 * is guaranteed to have run). A referenced-but-missing build file is an
 * unconditional error.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

// Bare globals that exist without any SR provider.
const PROVIDED_BY_GLOBAL = new Set(['VERSION', 'NS', 'PREFIX']);

// Strip strings/comments so content inside them is never mistaken for code.
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, ' ');
}

/** {provides: Set, consumes: Set} for one file's source. */
function analyze(src) {
  const code = stripNoise(src);
  const provides = new Set();
  const consumes = new Set();

  // assignments: SR.foo =   and   SR.foo.bar = (top-level id is "foo")
  for (const m of code.matchAll(/\bSR\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) provides.add(m[1]);
  // also the bootstrap root.SR = root.SR shape provides nothing new; skip SR[name]
  for (const m of code.matchAll(/\bSR\[["']?([\w$]+)["']?\]\s*=(?!=)/g)) {
    // dynamic namespace assignment like SR[name] is not analyzable; ignore
  }

  // references: SR.foo  that are NOT the target of an assignment
  const reRef = /\bSR\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = reRef.exec(code))) {
    const id = m[1];
    const after = code.slice(reRef.lastIndex);
    // skip if this occurrence is being assigned (SR.foo =) - it is a provide
    if (/^\s*=(?!=)/.test(after)) continue;
    consumes.add(id);
  }

  // provides are satisfied in-file by definition.
  for (const p of provides) consumes.delete(p);
  return { provides, consumes };
}

/**
 * Validate manifest content_scripts order against the built directory.
 * @param {object} manifest  parsed manifest for the build target
 * @param {string} buildDir  dist/<target> directory files were copied into
 * @param {(rel:string)=>string} read  read a built file by its rel path
 * @returns {{errors: string[], order: object}}
 */
export function validateScriptOrder(manifest, buildDir, read) {
  const errors = [];
  const groups = (manifest.content_scripts || []).map((cs, gi) => ({
    index: gi,
    world: cs.world || 'ISOLATED',
    files: (cs.js || []),
  }));

  // identifiers provided in EVERY group of the same world (a guaranteed prelude)
  const worldGroups = {};
  for (const g of groups) (worldGroups[g.world] ??= []).push(g);
  const commonByWorld = {};
  for (const [world, gs] of Object.entries(worldGroups)) {
    let common = null;
    for (const g of gs) {
      const s = new Set(g.files);
      common = common === null ? s : new Set([...common].filter(f => s.has(f)));
    }
    commonByWorld[world] = common || new Set();
  }

  const analyzed = new Map(); // rel -> {provides, consumes}
  const order = {};

  for (const g of groups) {
    const seen = new Set([...PROVIDED_BY_GLOBAL]);
    order[g.index] = { world: g.world, files: [] };

    for (const rel of g.files) {
      const file = path.join(buildDir, rel);
      if (rel.includes('*')) continue; // globs checked elsewhere
      if (!existsSync(file)) {
        errors.push(`content_scripts[${g.index}] lists "${rel}" but the built file does not exist`);
        continue;
      }
      let a = analyzed.get(rel);
      if (!a) {
        a = analyze(read(rel));
        analyzed.set(rel, a);
      }
      // missing identifiers for THIS group
      const missing = [];
      for (const id of a.consumes) {
        if (seen.has(id)) continue;
        // provided by a file shared by every group of the same world?
        const commonProvides = commonProvidesFor(rel, id, worldGroups[g.world], analyzed, buildDir, read);
        if (commonProvides) continue;
        missing.push(id);
      }
      for (const id of missing) {
        errors.push(`content_scripts[${g.index}] "${rel}" uses SR.${id} before any file in this group provides it (check the js order in src/manifest.json)`);
      }
      for (const p of a.provides) seen.add(p);
      order[g.index].files.push({ rel, provides: [...a.provides], consumes: [...a.consumes], missing });
    }
  }
  return { errors, order };
}

// Is `id` provided by a file that is present in EVERY group of this world and
// loads before (or is) the current file? Approximation: the common prelude set
// of the world. We compute providers of the common files lazily.
function commonProvidesFor(currentRel, id, groupsOfWorld, analyzed, buildDir, read) {
  // Files common to every group in this world.
  let common = null;
  for (const g of groupsOfWorld) {
    const s = new Set(g.files);
    common = common === null ? s : new Set([...common].filter(f => s.has(f)));
  }
  if (!common) return false;
  for (const rel of common) {
    if (rel === currentRel) return false;
    let a = analyzed.get(rel);
    if (!a) {
      const file = path.join(buildDir, rel);
      if (!existsSync(file)) continue;
      a = analyze(read(rel));
      analyzed.set(rel, a);
    }
    if (a.provides.has(id)) return true;
  }
  return false;
}
