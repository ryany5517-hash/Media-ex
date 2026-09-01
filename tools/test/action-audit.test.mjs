/**
 * Action audit: every action name the UI can fire must resolve to a real
 * handler (content onAction, background handleAction, or a documented local
 * effect). Catches the class of bug where a button routes to an unknown
 * action and does nothing (e.g. 'options' vs 'open-options', 'reset-fab').
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// Handled locally inside the UI layers (no worker round-trip needed).
const LOCAL_UI = new Set([
  'close', 'x', 'theme', 'settings', 'tab', 'toggle-expand', 'reset-fab',
  'refresh', 'toggle-auto', 'copy', 'hist-copy', 'ads', 'open',
]);
// Handled inside content onAction().
const CONTENT_ACTIONS = new Set([
  'copy', 'copy-all', 'ffmpeg', 'variant', 'record', 'play', 'watchparty',
  'scan-now', 'subs', 'set-setting',
]);
// Handled inside background handleAction().
const BACKGROUND_ACTIONS = new Set([
  'open', 'download', 'variant', 'play', 'watchparty', 'subs', 'subs-search',
  'sub-attach', 'sub-download', 'sub-pick', 'sub-selftest', 'sub-download-info', 'set-setting',
  'toggle-site', 'clear', 'rescan', 'options', 'open-options', 'check-updates',
  'update-check', 'search-subtitles-manual',
]);

test('every action fired from panel/popup resolves to a real handler', () => {
  const ui = read('src/content/ui.js');
  const popup = read('src/popup/popup.js');
  const names = new Set();
  const add = (re, src, label) => {
    for (const m of src.matchAll(re)) names.add([m[1], label]);
  };
  // direct fire('name') / act('name') calls
  add(/fire\('([a-z0-9-]+)'/g, ui, 'ui.fire');
  add(/act\('([a-z0-9-]+)'/g, popup, 'popup.act');
  // data-act attributes (some are prefixes handled generically)
  add(/data-act="([a-z0-9:-]+)"/g, ui, 'ui.data-act');
  add(/data-act="([a-z0-9:-]+)"/g, popup, 'popup.data-act');
  // direct worker messages from the popup
  add(/name: '([a-z0-9-]+)'/g, popup, 'popup.sendMessage');

  const READ_ONLY = new Set(['get-state', 'get-live', 'get-party-payload', 'history', 'sub-download-info', 'ping', 'clear-seen', 'health']);
  const unknown = [];
  for (const [n, label] of names) {
    if (READ_ONLY.has(n)) continue; // message types, not button actions
    if (n.startsWith('set:') || n.startsWith('theme-') || n.startsWith('lang-')) continue; // generic local handlers
    if (LOCAL_UI.has(n) || CONTENT_ACTIONS.has(n) || BACKGROUND_ACTIONS.has(n)) continue;
    unknown.push(`${label} "${n}"`);
  }
  assert.deepEqual(unknown, [], 'unresolved actions:\n  ' + unknown.join('\n  '));
});

test('background handleAction covers every content-forwarded name', () => {
  const content = read('src/content/content.js');
  const bg = read('src/background.js');
  // names that fall through content's default switch are forwarded verbatim
  const bgCases = new Set([...bg.matchAll(/^\s*case '([a-z0-9-]+)':/gm)].map((m) => m[1]));
  const forwarded = new Set([...content.matchAll(/sendAction\('([a-z0-9-]+)'/g)].map((m) => m[1]));
  forwarded.delete('set-setting'); // handled in content directly
  for (const n of forwarded) {
    assert.ok(bgCases.has(n), `background must handle forwarded action "${n}"`);
  }
});

test('re-injection targets ALL frames (player lives in an iframe)', () => {
  const bg = read('src/background.js');
  const iso = bg.match(/api\.scripting\.executeScript\(\{ target: \{ tabId, allFrames: true \}, files: iso \}\)/);
  const main = bg.match(/api\.scripting\.executeScript\(\{ target: \{ tabId, allFrames: true, world: 'MAIN' \}, files: main \}\)/);
  assert.ok(iso, 'isolated-world re-injection uses allFrames:true');
  assert.ok(main, 'MAIN-world re-injection uses allFrames:true');
});

test('attach is sent PER FRAME so iframe players are never missed (webNavigation)', () => {
  const bg = read('src/background.js');
  assert.match(bg, /webNavigation\.getAllFrames\(\{ tabId \}\)/, 'attachPendingSub enumerates frames via webNavigation');
  assert.ok(bg.includes('{ frameId: fr.frameId }'), 'attach-subtitle is sent with a per-frame frameId');
  assert.match(read('src/manifest.json'), /"webNavigation"/, 'manifest grants webNavigation');
});
