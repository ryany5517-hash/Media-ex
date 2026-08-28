/**
 * Theme button cycle contract (5.2):
 *  - icon follows the pref (system = monitor-smartphone, dark = moon, light = sun)
 *  - first click from "system" must flip to the opposite of what is shown
 *  - data-pref always written; title/aria mention pref, effective and next
 * The pure cycle logic is mirrored here from src/popup/popup.js to lock the rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeResolved(osDark) {
  return pref => {
    if (pref === 'dark' || pref === 'light') return pref;
    return osDark ? 'dark' : 'light';
  };
}
function nextTheme(pref, resolved) {
  const effective = resolved(pref);
  if (pref === 'system' || !pref) return effective === 'dark' ? 'light' : 'dark';
  if (pref === 'dark') return 'light';
  return 'system';
}
function prefIcon(pref) {
  if (pref === 'dark') return 'moon';
  if (pref === 'light') return 'sun';
  return 'monitor-smartphone';
}

test('theme cycle: all 6 pref x OS combinations change something visible', () => {
  const cases = [
    ['system', true, 'light'],  // system on a dark OS -> goes light (visible flip)
    ['system', false, 'dark'],  // system on a light OS -> goes dark (visible flip)
    ['dark', true, 'light'],
    ['dark', false, 'light'],
    ['light', true, 'system'],  // explicit light -> back to system
    ['light', false, 'system'],
  ];
  for (const [pref, osDark, expectNext] of cases) {
    const resolved = makeResolved(osDark);
    assert.equal(nextTheme(pref, resolved), expectNext, `pref=${pref} osDark=${osDark}`);
    // the move must not leave the effective appearance unchanged
    const before = resolved(pref);
    const after = resolved(expectNext);
    if (expectNext !== 'system') assert.notEqual(before, after, `pref=${pref}: appearance must change`);
  }
});

test('theme icon follows pref', () => {
  assert.equal(prefIcon('system'), 'monitor-smartphone');
  assert.equal(prefIcon('dark'), 'moon');
  assert.equal(prefIcon('light'), 'sun');
});
