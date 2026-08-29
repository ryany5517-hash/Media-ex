/**
 * Design guard: tokens, contrast, touch targets and the typography policy
 * (no emoji, no em-dash, no decorative glyphs in UI-facing code).
 * The checks themselves live in tools/design-qa.mjs so `npm run qa` and this
 * test can never disagree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../design-qa.mjs');

test('design QA reports no problems', () => {
  assert.deepEqual(mod.problems, [], 'design problems: ' + mod.problems.join(' | '));
  assert.ok(mod.info.length > 40, 'expected the contrast/class measurements to run, got ' + mod.info.length);
});

test('panel keeps its design contract', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync('src/content/ui-styles.js', 'utf8');
  for (const need of ['--sr-accent', '--sr-spring', 'prefers-reduced-motion', 'focus-visible', 'min-height: 44px', 'backdrop-filter']) {
    assert.ok(css.includes(need), 'stylesheet must define ' + need);
  }
  const ui = readFileSync('src/content/ui.js', 'utf8');
  assert.ok(ui.includes('SR.icons'), 'UI must render Lucide icons instead of glyph characters');
  assert.ok(!/[\u2605\u2713\u266a\u2192\u00b7]/.test(ui.replace(/\\u[0-9a-f]{4}/gi, '')), 'no decorative glyphs in the panel source');
});

test('comment stripping handles CRLF so arrows in // comments are not flagged', () => {
  // Mirror the exact pipeline design-qa.mjs uses per file. Before the fix the
  // `.*$` line-comment strip left a trailing \r on Windows checkouts, so the
  // arrow in "isolated world -> content" below was scanned and reported.
  const strip = (source) =>
    source
      .replace(/\r\n?/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');
  const crlf = '  return;\t// isolated world \u2192 content script\r\n  const ok = 1;\r\n';
  const out = strip(crlf);
  assert.ok(!out.includes('\u2192'), 'arrow in a CRLF line comment must be stripped, got: ' + JSON.stringify(out));
  const block = '/* arrow \u2192 in a\r\n block comment */\r\ncode();\r\n';
  assert.ok(!strip(block).includes('\u2192'), 'arrow in a CRLF block comment must be stripped');
  const url = '  fetch("https://x.test/y"); // note\r\n';
  assert.ok(strip(url).includes('https://x.test/y'), ':// inside a string must not be eaten');
});
