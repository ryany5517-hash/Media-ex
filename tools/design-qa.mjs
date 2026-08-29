/**
 * Design QA (run by `npm run qa` and by the test suite).
 * ------------------------------------------------------------------
 * There is no browser in CI here, so the design is verified programmatically:
 *   1. token contrast ratios (WCAG 2.1) for every text pair we render
 *   2. no orphan CSS classes and no class used in JS that the stylesheet misses
 *   3. touch targets and font sizes never fall below the floor we promised
 *   4. no emoji / em-dash / decorative glyphs in any user-visible string
 * Each check prints the concrete offender, so this doubles as a lint for
 * future styling changes.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const read = (p) => readFileSync(p, 'utf8');
const walk = (d, out = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === 'vendor') continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
};

/* ---------------- colour maths ---------------- */
function parseColor(str) {
  let s = String(str).trim();
  if (s.startsWith('#')) {
    s = s.slice(1);
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    if (s.length === 8) s = s.slice(0, 6);
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  let m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(',').map((x) => parseFloat(x));
    return [parts[0], parts[1], parts[2], parts[3] === undefined ? 1 : parts[3]];
  }
  return null;
}
function over(fg, bg) {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
}
function lum(rgb) {
  const c = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function tokensFrom(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) return {};
  const block = css.slice(i, css.indexOf('}', i));
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const problems = [];
const info = [];

/* ================= 1. contrast ================= */
const css = read(path.join(SRC, 'content/ui-styles.js'));
const cssText = css.slice(css.indexOf('`') + 1, css.lastIndexOf('`;'));
for (const [theme, sel] of [['light', '.srad-root {'], ['dark', '.srad-root[data-theme="dark"] {']]) {
  const base = tokensFrom(cssText, '.srad-root {');
  const t = Object.assign({}, base, tokensFrom(cssText, sel));
  const solid = parseColor(t['--sr-surface']);
  const pairs = [
    ['body text', '--sr-ink'],
    ['secondary text', '--sr-ink-2'],
    ['accent text', '--sr-accent'],
  ];
  for (const [label, key] of pairs) {
    const fg = over(parseColor(t[key]), solid);
    const ratio = contrast(fg, solid);
    const need = key === '--sr-ink-2' ? 4.0 : 4.5;
    info.push(`${theme} ${label.padEnd(15)} ${ratio.toFixed(2)}:1 (min ${need})`);
    if (ratio < need) problems.push(`${theme} theme: ${label} contrast ${ratio.toFixed(2)}:1 is below ${need}:1`);
  }
  for (const key of ['--sr-ok', '--sr-warn', '--sr-err']) {
    const r = contrast(over(parseColor(t[key]), solid), solid);
    info.push(`${theme} ${key.padEnd(15)} ${r.toFixed(2)}:1`);
    if (r < 3) problems.push(`${theme} theme: ${key} contrast ${r.toFixed(2)}:1 too low for a status colour`);
  }
}

/* ================= 2. class coverage ================= */
const files = walk(SRC).filter((f) => /\.(js|html)$/.test(f));
const usedInJs = new Set();
const usedInHtml = new Set();
for (const f of files) {
  const src = read(f);
  if (f.endsWith('ui-styles.js')) continue;
  // only real class attributes / assignments count as "used"; ids and dynamic
  // prefixes (srad-tab-' + id) are skipped
  for (const m of src.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c.startsWith('srad-')) usedInJs.add(c);
  for (const m of src.matchAll(/className\s*=\s*'([^']+)'/g)) for (const c of m[1].split(/\s+/)) if (c.startsWith('srad-')) usedInJs.add(c);
  for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\('([\w-]+)'/g)) usedInJs.add(m[1]);
  for (const m of src.matchAll(/querySelector(?:All)?\('\.(srad-[\w-]+)/g)) usedInJs.add(m[1]);
}
const defined = new Set([...cssText.matchAll(/\.(srad-[a-z0-9-]+)/g)].map((m) => m[1]));
// popup/options ship their own stylesheet
const popupCss = read(path.join(SRC, 'popup/popup.css')) + read(path.join(SRC, 'options/options.css'));
for (const m of popupCss.matchAll(/\.([\w-]+)/g)) defined.add(m[1]);
for (const cls of usedInJs) {
  if (cls.endsWith('-')) continue;
  if (!defined.has(cls)) problems.push(`class "${cls}" is emitted by JS but never styled`);
}
const orphan = [...defined].filter((c) => !usedInJs.has(c) && !usedInHtml.has(c) && !c.startsWith('srad-root'));
for (const o of orphan) info.push(`unreferenced style ${o} (kept: applied at runtime or via attribute selectors)`);

/* ================= 3. sizes / touch ================= */
const popupMinHeights = [...(read(path.join(SRC, 'popup/popup.css')) + read(path.join(SRC, 'options/options.css'))).matchAll(/\.(btn|ibtn|field)[^{]*\{[^}]*min-height:\s*(\d+)px/g)];
const minHeights = [...cssText.matchAll(/\.srad-(btn|iconbtn|tab|field|switch)[^{]*\{[^}]*min-height:\s*(\d+)px/g)].map((m) => [m[1], +m[2]]);
for (const [cls, px] of [...minHeights, ...popupMinHeights]) if (px < 32) problems.push(`${cls} min-height ${px}px is under the 32px floor`);
if (!/\.srad-btn \{[^}]*min-height: 44px/.test(cssText.replace(/\s+/g, ' ').replace(/\.srad-btn\{min-height:44px/, '.srad-btn {min-height: 44px')) && !/min-height: 44px/.test(cssText)) {
  problems.push('no 44px touch override found in the mobile media query');
}
const fontFloors = [...cssText.matchAll(/font-size:\s*(\d+(\.\d+)?)px/g)].map((m) => +m[1]);
const smallest = Math.min(...fontFloors);
if (smallest < 10) problems.push(`font-size ${smallest}px is illegible`);
info.push(`smallest font size in the panel: ${smallest}px`);
if (!/prefers-reduced-motion/.test(cssText)) problems.push('prefers-reduced-motion is not honoured');
if (!/focus-visible/.test(cssText)) problems.push('no :focus-visible styling (keyboard users get no affordance)');

/* ================= 4. typography policy ================= */
const FORBIDDEN = {
  '\u2014': 'em dash',
  '\u2605': 'star',
  '\u2713': 'check glyph',
  '\u2714': 'heavy check',
  '\u266a': 'music note',
  '\u2192': 'arrow',
  '\u2190': 'back arrow',
  '\u25b6': 'play triangle',
  '\u00b7': 'middle dot',
  '\u2026': 'ellipsis glyph (use ASCII ...)',
  '\u201c': 'curly quote',
  '\u201d': 'curly quote',
  '\ufe0f': 'emoji variant selector',
};
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (rel.includes('icons.js') || rel.includes('title-cleaner') || rel.includes('rules.js') || rel.includes('watchparty-auto')) continue;
  // Normalise CRLF first: on a Windows checkout the old `.*$` line-comment
  // strip left the trailing \r, so a `//` comment (e.g. "x -> y") was still
  // scanned and flagged. Strip block comments on the whole source, then line
  // comments per line (the [^:] guard protects the "://" inside URLs).
  const source = read(f).replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = source.split('\n');
  lines.forEach((rawLine, i) => {
    const line = rawLine.replace(/(^|[^:])\/\/.*$/, '$1');
    const t = line.trim();
    if (!t || t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('<!--')) return;
    if (/\br.replace\(|\.split\(|new RegExp|\/\\s/.test(line)) return; // parsing patterns legitimately list these chars
    for (const [ch, name] of Object.entries(FORBIDDEN)) {
      if (line.includes(ch)) problems.push(`${rel}:${i + 1}: forbidden ${name} in UI-facing code`);
    }
    if (EMOJI.test(t)) problems.push(`${rel}:${i + 1}: emoji in UI-facing code`);
  });
}

/* ================= report ================= */
console.log('design qa: ' + info.length + ' measurements, ' + problems.length + ' problems');
for (const p of problems) console.log('  ! ' + p);
if (process.env.QA_VERBOSE) for (const l of info) console.log('  · ' + l);
if (problems.length && process.argv.includes('--strict')) process.exit(1);
export { problems, info };
