/**
 * Theme single-source guard. theme.css is the one source; the shadow-DOM panel
 * gets a synced copy. These tests assert theme.css drives everything and no
 * legacy token survives in the panel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8');

test('theme.css defines the full --sr-* token set for light and dark', () => {
  const css = read('src/shared/theme.css');
  for (const need of [
    '--sr-canvas', '--sr-surface', '--sr-surface-2', '--sr-surface-3', '--sr-glass',
    '--sr-ink', '--sr-ink-2', '--sr-ink-3', '--sr-line', '--sr-line-2',
    '--sr-accent', '--sr-accent-ink', '--sr-accent-soft', '--sr-accent-line',
    '--sr-ok', '--sr-warn', '--sr-err', '--sr-info',
  ]) {
    assert.ok(css.includes(need + ':'), 'theme.css missing ' + need);
  }
  const dark = css.slice(css.indexOf("[data-theme='dark']"));
  for (const need of ['--sr-surface', '--sr-ink', '--sr-accent']) {
    assert.ok(dark.includes(need + ':'), 'dark theme missing ' + need);
  }
});

test('panel ui-styles.js tokens are managed by sync-theme with no legacy c- tokens', () => {
  const js = read('src/content/ui-styles.js');
  assert.ok(js.includes('/* tokens:start'), 'panel must carry the managed token marker');
  assert.ok(js.includes('--sr-accent:'), 'panel must include synced --sr tokens');
  // no legacy token references remain in rule bodies
  const ruleBodies = js.replace(/\/\* tokens:start[\s\S]*?tokens:end \*\//g, ' ');
  assert.ok(!/var\(--c-/.test(ruleBodies), 'panel must not reference legacy --c-* tokens');
});

test('popup and options link the shared theme stylesheet', () => {
  assert.ok(read('src/popup/popup.html').includes('shared/theme.css'), 'popup must link theme.css');
  assert.ok(read('src/options/options.html').includes('shared/theme.css'), 'options must link theme.css');
});

test('popup has a single scroll container .p-scroll with the required constraints', () => {
  const html = read('src/popup/popup.html');
  const css = read('src/popup/popup.css');
  assert.ok(html.includes('class="p-scroll"'), 'popup middle blocks must live in .p-scroll');
  assert.match(css, /\.p-scroll\s*\{[^}]*flex:\s*1 1 auto/, '.p-scroll must be flex:1 1 auto');
  assert.match(css, /\.p-scroll\s*\{[^}]*min-height:\s*0/, '.p-scroll needs min-height:0');
  assert.match(css, /\.p-scroll\s*\{[^}]*scrollbar-gutter:\s*stable/, '.p-scroll needs scrollbar-gutter:stable');
  // history list must not open its own scroller
  assert.match(css, /\.history-list\s*\{[^}]*overflow:\s*visible/, '.history-list must not scroll itself');
});

test('global webkit scrollbar is token styled and transparent-tracked', () => {
  const css = read('src/shared/theme.css');
  assert.match(css, /::-webkit-scrollbar\s*\{[^}]*width:\s*var\(--sr-scroll-size\)/);
  assert.match(css, /::-webkit-scrollbar-thumb\s*\{[^}]*background-clip:\s*content-box/);
  assert.match(css, /::-webkit-scrollbar-thumb\s*\{[^}]*border:\s*3px solid transparent/);
  assert.match(css, /prefers-reduced-motion[\s\S]*?transition:\s*none/, 'reduced motion disables transitions');
});
