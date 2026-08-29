/**
 * Self-registering shared modules must not assume another module already ran
 * and must not wipe state a previous load (or another module) set. A pattern
 * like `const subs = (SR.subs = {})` resets the namespace on every load, so a
 * provider registered by another script vanishes with no error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', 'src');
const read = rel => readFileSync(path.join(SRC, rel), 'utf8');

function freshWorld() {
  const sandbox = {};
  vm.createContext(sandbox);
  return sandbox;
}
function runIn(rel, sandbox) {
  vm.runInContext(read(rel), sandbox, { filename: rel });
}

test('subtitles.js self-registers alone in an empty world and keeps providers', () => {
  const world = freshWorld();
  runIn('shared/subtitles.js', world); // no util, no rules, nothing else
  assert.ok(world.SR && world.SR.subs, 'SR.subs must be created without other modules');
  assert.ok(Array.isArray(world.SR.subs.providers), 'providers array must exist');
  assert.equal(world.SR.subs.providers.length, 4, 'four built-in providers registered');
  for (const id of ['wyzie', 'subdl', 'opensubtitles', 'yify']) {
    assert.ok(world.SR.subs.providers.some(p => p.id === id), `provider ${id} registered`);
  }

  // A provider another module/script added must survive a second load, and the
  // built-ins must not double-register.
  world.SR.subs.providers.push({ id: 'external', label: 'External' });
  runIn('shared/subtitles.js', world);
  const ids = world.SR.subs.providers.map(p => p.id);
  assert.ok(ids.includes('external'), 'pre-existing external provider must not be wiped');
  for (const id of ['wyzie', 'subdl', 'opensubtitles', 'yify']) {
    assert.equal(ids.filter(x => x === id).length, 1, `${id} registered exactly once after reload`);
  }
});

test('content.js missing shared module warns once and stops instead of throwing per frame', () => {
  const warnings = [];
  const fakeConsole = { warn: m => warnings.push(String(m)), error: () => {}, log: () => {} };
  // Empty SR: no shared modules loaded. The guard must warn and return, not throw.
  const emptyWorld = freshWorld();
  emptyWorld.console = fakeConsole;
  assert.doesNotThrow(() => runIn('content/content.js', emptyWorld), 'must not throw when modules are missing');
  assert.equal(warnings.length, 1, 'exactly one warning, not a per-frame TypeError flood');
  assert.match(warnings[0], /missing shared module/, 'warning must explain the problem');
  assert.match(warnings[0], /util/, 'warning must name at least the missing module');
  assert.ok(!emptyWorld.__streamRadarContent, 'content script must not mark itself started');

  // With every required module present it must start and not emit the missing-module warning.
  const okWorld = freshWorld();
  const okWarn = [];
  okWorld.console = { warn: m => okWarn.push(String(m)), error: () => {}, log: () => {} };
  vm.runInContext('var SR = { VERSION: "1.0.0", util: { api: () => ({}) }, i18n: { t: k => k }, domScan: { create: () => ({}) }, ui: { create: () => ({}) }, defaults: {} };', okWorld);
  runIn('content/content.js', okWorld);
  assert.ok(okWorld.__streamRadarContent, 'with all modules the content script marks itself started');
  assert.ok(!okWarn.some(w => /missing shared module/.test(w)), 'no missing-module warning when complete');
});
