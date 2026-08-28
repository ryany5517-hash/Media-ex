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
