/**
 * Manifest guardrails.
 * ------------------------------------------------------------------
 * The `commands` block is the one place where a manifest that *looks* fine
 * (and even passes web-ext lint) makes Chrome refuse to load the extension at
 * all. These tests pin the rules so a future shortcut edit can't reintroduce:
 *
 *   Failed to load extension … Error: Could not find key specification for
 *   'command[1].suggested_key': Either specify a key for 'windows', or specify
 *   a default key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCommands } from '../lib/commands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readManifest = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

test('src/manifest.json: every shortcut loads in Chrome and Firefox', () => {
  const manifest = readManifest('src/manifest.json');
  const problems = validateCommands(manifest);
  assert.deepEqual(problems, [], problems.join('\n  '));
});

test('shipped dist manifests: shortcuts are browser-safe too', () => {
  for (const target of ['chrome', 'firefox']) {
    const file = `dist/${target}/manifest.json`;
    if (!existsSync(path.join(ROOT, file))) continue; // not built yet
    const problems = validateCommands(readManifest(file));
    assert.deepEqual(problems, [], `${file}: ${problems.join('; ')}`);
  }
});

test('regression: a mac-only suggested_key is rejected (the "Failed to load extension" bug)', () => {
  const broken = {
    commands: {
      '_execute_action': {
        'suggested_key': { mac: 'Alt+Shift+A' },
        'description': 'Open the Stream Radar popup'
      }
    }
  };
  const problems = validateCommands(broken);
  assert.ok(
    problems.some((p) => p.includes('suggested_key') && p.includes('"windows"')),
    `expected a missing-windows error, got: ${problems.join(' | ')}`
  );

  const fixed = {
    commands: {
      '_execute_action': {
        'suggested_key': { default: 'Ctrl+Shift+A', mac: 'Command+Shift+A' },
        'description': 'Open the Stream Radar popup'
      }
    }
  };
  assert.deepEqual(validateCommands(fixed), []);
});

test('shortcut syntax: Ctrl+Alt, lone Shift, wrong-platform modifiers and bad keys are rejected', () => {
  const check = (suggested_key, command = 'scan-now') =>
    validateCommands({ commands: { [command]: { suggested_key, description: 'x' } } });

  assert.deepEqual(check({ default: 'Alt+Shift+D' }), []);
  assert.deepEqual(check({ default: 'Ctrl+Shift+Y' }), []);
  assert.deepEqual(check({ default: 'Alt+Shift+S', mac: 'Command+Shift+S' }), []);
  assert.deepEqual(check('Ctrl+Shift+Y'), []);

  assert.ok(check({ default: 'Ctrl+Alt+F' }).some((p) => p.includes('AltGr')));
  assert.ok(check({ default: 'Shift+F' }).some((p) => p.includes('Ctrl or Alt')));
  assert.ok(check({ default: 'F' }).some((p) => p.includes('Ctrl or Alt')));
  assert.ok(check({ default: 'Ctrl+f' }).some((p) => p.includes('case-sensitive')));
  assert.ok(check({ default: 'Ctrl+Shift+MediaStop' }).some((p) => p.includes('media keys')));
  assert.ok(check({ default: 'MediaPlayPause' }), 'bare media key is fine for normal commands');
  assert.deepEqual(check({ default: 'MediaPlayPause' }), []);
  assert.ok(check({ windows: 'Command+Shift+D' }).some((p) => p.includes('macOS-only')));
  assert.ok(check({ windows: 'Search+D' }).some((p) => p.includes('ChromeOS-only')));
  assert.ok(check({ default: 'Ctrl+Shift+D', moon: 'Ctrl+Shift+X' }).some((p) => p.includes('unknown platform')));
  assert.ok(
    check({ default: 'MediaNextTrack' }, '_execute_action').some((p) => p.includes('media keys')),
    'action commands cannot use media keys'
  );
});

test('structure: descriptions required, at most four suggested shortcuts', () => {
  assert.ok(validateCommands({ commands: { 'scan-now': { suggested_key: 'Ctrl+Shift+D' } } })
    .some((p) => p.includes('description')), 'normal commands need a description');
  assert.deepEqual(
    validateCommands({ commands: { '_execute_action': { suggested_key: 'Ctrl+Shift+A' } } }),
    [],
    'action commands need no description'
  );

  const five = { commands: {} };
  for (const n of ['a', 'b', 'c', 'd', 'e']) {
    five.commands[n] = { suggested_key: 'Ctrl+Shift+' + n.toUpperCase(), description: 'x' };
  }
  assert.ok(validateCommands(five).some((p) => p.includes('only assigns the first 4')));

  assert.ok(validateCommands({ commands: { 'scan-now': { suggested_key: 'Alt+X', global: true, description: 'x' } } })
    .some((p) => p.includes('global commands')), 'global commands are limited to Ctrl+Shift+[0-9]');
});
