/**
 * Validator for the manifest `commands` block (keyboard shortcuts).
 * ----------------------------------------------------------------
 * Chrome is stricter than it looks: a `suggested_key` given as an object of
 * per-platform keys is only accepted when *every* desktop platform is covered
 * (windows, mac, linux, chromeos) or a `default` key is present. Miss one and
 * the browser refuses to load the whole extension with:
 *
 *   Could not find key specification for 'command[1].suggested_key':
 *   Either specify a key for 'windows', or specify a default key.
 *
 * Firefox is more forgiving, so the bug ships silently — this module encodes
 * the rules both browsers agree on and is used by:
 *   • tools/build.mjs          → `npm run build` fails loudly
 *   • tools/test/manifest.test.mjs → regression tests
 *
 * Rules mirror Chromium's extensions/common/command.cc + the "Key combination
 * requirements" section of the chrome.commands docs (shortcut must contain
 * Ctrl or Alt — never both, AltGr — macOS-only modifiers stay on "mac", media
 * keys take no modifiers, at most four suggested shortcuts).
 */

/** platforms Chrome/Firefox understand inside a `suggested_key` object */
export const PLATFORMS = ['default', 'chromeos', 'linux', 'mac', 'windows'];
/** platforms that MUST be covered when no `default` key is present */
export const REQUIRED_WHEN_NO_DEFAULT = ['windows', 'mac', 'linux', 'chromeos'];

/** reserved commands that open the popup instead of firing onCommand */
export const ACTION_COMMANDS = new Set(['_execute_action', '_execute_browser_action', '_execute_page_action']);

export const MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift', 'MacCtrl', 'Command', 'Option', 'Search']);
/** macOS-only modifiers (Command / Option / MacCtrl) — invalid on other platforms */
export const MAC_MODIFIERS = new Set(['MacCtrl', 'Command', 'Option']);
/** modifiers that satisfy "must include Ctrl or Alt" */
const CTRL_MODIFIERS = new Set(['Ctrl', 'MacCtrl', 'Command']);
const ALT_MODIFIERS = new Set(['Alt', 'Option']);

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const DIGITS = '0123456789'.split('');
const NAMED_KEYS = [
  'Comma', 'Period', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Insert', 'Delete',
  'Up', 'Down', 'Left', 'Right'
];
export const MEDIA_KEYS = new Set(['MediaNextTrack', 'MediaPlayPause', 'MediaPrevTrack', 'MediaStop']);
export const KEYS = new Set([...LETTERS, ...DIGITS, ...NAMED_KEYS, ...MEDIA_KEYS]);

/** max number of commands that may carry a `suggested_key` */
export const MAX_SUGGESTED_KEYS = 4;

/**
 * @param {object} manifest  parsed manifest.json
 * @returns {string[]} human readable problems; empty array means "loads clean"
 */
export function validateCommands(manifest) {
  const commands = manifest && manifest.commands;
  const problems = [];
  if (!commands) return problems;
  if (typeof commands !== 'object' || Array.isArray(commands)) {
    return ['"commands" must be an object'];
  }

  let bound = 0;
  for (const [name, command] of Object.entries(commands)) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      problems.push(`commands.${name}: must be an object`);
      continue;
    }

    const isAction = ACTION_COMMANDS.has(name);
    if (!isAction && typeof command.description !== 'string') {
      problems.push(`commands.${name}: non-action commands need a "description" (Chrome rejects the manifest without one)`);
    }
    if ('global' in command && command.global === true && !/^(Ctrl|Command)\+Shift\+[0-9]$/.test(command.suggested_key ?? '')) {
      problems.push(`commands.${name}: global commands may only suggest Ctrl+Shift+[0-9]`);
    }
    if (!('suggested_key' in command)) continue;

    const suggested = command.suggested_key;
    bound += 1;

    if (typeof suggested === 'string') {
      checkKey(name, 'default', suggested, isAction, problems);
      continue;
    }
    if (!suggested || typeof suggested !== 'object' || Array.isArray(suggested)) {
      problems.push(`commands.${name}.suggested_key: must be a string or an object of platform keys`);
      continue;
    }

    for (const platform of Object.keys(suggested)) {
      if (!PLATFORMS.includes(platform)) {
        problems.push(`commands.${name}.suggested_key: unknown platform "${platform}" (use ${PLATFORMS.join(', ')})`);
      }
    }
    // The actual "Failed to load extension" trigger: platform keys without a
    // `default` fallback have to cover *every* desktop platform.
    if (!('default' in suggested)) {
      for (const platform of REQUIRED_WHEN_NO_DEFAULT) {
        if (!(platform in suggested)) {
          problems.push(
            `commands.${name}.suggested_key: platform-specific keys must include "${platform}" (or add a "default" key) — ` +
            'Chrome refuses to load the extension on that platform otherwise'
          );
        }
      }
    }
    for (const platform of Object.keys(suggested)) {
      checkKey(name, platform, suggested[platform], isAction, problems);
    }
  }

  if (bound > MAX_SUGGESTED_KEYS) {
    problems.push(`commands: ${bound} suggested shortcuts — Chrome only assigns the first ${MAX_SUGGESTED_KEYS}`);
  }
  return problems;
}

function checkKey(name, platform, value, isAction, problems) {
  const where = `commands.${name}.suggested_key${platform === 'default' ? '' : '.' + platform}`;
  if (typeof value !== 'string' || !value.trim()) {
    problems.push(`${where}: must be a non-empty shortcut string`);
    return;
  }

  const tokens = value.split('+').map((t) => t.trim()).filter(Boolean);
  if (tokens.length !== new Set(tokens).size) {
    problems.push(`${where}: "${value}" repeats a token`);
  }
  const keyTokens = tokens.filter((t) => !MODIFIERS.has(t));
  const modifiers = tokens.filter((t) => MODIFIERS.has(t));

  if (keyTokens.length !== 1) {
    problems.push(`${where}: "${value}" must end with exactly one key (A-Z, 0-9, Comma, Period, Home, End, PageUp, PageDown, Space, Insert, Delete, arrows, media keys)`);
    return;
  }
  const key = keyTokens[0];
  if (!KEYS.has(key)) {
    problems.push(`${where}: "${key}" is not a supported key (names are case-sensitive)`);
    return;
  }

  for (const mod of modifiers) {
    if (MAC_MODIFIERS.has(mod) && platform !== 'mac') {
      problems.push(`${where}: "${mod}" is macOS-only — move it to suggested_key.mac`);
    }
    if (mod === 'Search' && platform !== 'chromeos') {
      problems.push(`${where}: "Search" is ChromeOS-only`);
    }
  }

  if (MEDIA_KEYS.has(key)) {
    if (isAction) problems.push(`${where}: media keys cannot trigger an action command`);
    if (modifiers.length) problems.push(`${where}: "${value}" — media keys cannot be combined with modifiers`);
    return;
  }

  const hasCtrl = modifiers.some((m) => CTRL_MODIFIERS.has(m));
  const hasAlt = modifiers.some((m) => ALT_MODIFIERS.has(m));
  if (!hasCtrl && !hasAlt) {
    problems.push(`${where}: "${value}" must include Ctrl or Alt`);
  }
  if (hasCtrl && hasAlt) {
    problems.push(`${where}: "${value}" mixes Ctrl and Alt — that combo is reserved for AltGr and never fires`);
  }
}

export default validateCommands;
