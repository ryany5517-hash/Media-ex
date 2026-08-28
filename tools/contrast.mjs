/**
 * Contrast + literal-colour audit (B3/B4).
 * ------------------------------------------------------------------
 * Reads the single token source src/shared/theme.css, composites every
 * semi-transparent token (the ok/warn/err/info *-soft washes and accent-soft)
 * over the surface it sits on BEFORE computing WCAG 2.1 contrast - a raw
 * rgba(90,211,159,.14) read as a background gives ~1.7 and makes people
 * "fix" colours that already pass. Text threshold 4.5; large/non-text 3.0.
 * Decorative lines/shadows are reported as notes, not failures. Also scans UI
 * files for hard-coded colours, which are only allowed inside mask-image.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const THEME = path.join(ROOT, 'src/shared/theme.css');

const problems = [];
const notes = [];

function parseColor(str) {
  let s = String(str).trim();
  if (s.startsWith('#')) {
    s = s.slice(1);
    if (s.length === 3) s = s.split('').map(c => c + c).join('');
    if (s.length === 8) s = s.slice(0, 6);
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(',').map(x => parseFloat(x));
    return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
  }
  return null;
}
function over(fg, bg) {
  const a = fg[3];
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a));
}
function lum(rgb) {
  const c = rgb.map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function block(css, marker) {
  const i = css.indexOf(marker);
  if (i < 0) return '';
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}
function tokens(cssBlock) {
  const out = {};
  for (const m of cssBlock.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  return out;
}

function auditTheme(themeName, t) {
  const surface = parseColor(t['--sr-surface']);
  const canvas = parseColor(t['--sr-canvas']);
  if (!surface || !canvas) {
    problems.push(`${themeName}: cannot parse surface/canvas tokens`);
    return;
  }
  const textPairs = [
    ['--sr-ink', surface, 4.5, 'body text on surface'],
    ['--sr-ink-2', surface, 4.5, 'secondary text on surface'],
    ['--sr-ink', canvas, 4.5, 'body text on canvas'],
    ['--sr-accent-ink', t['--sr-accent'] ? parseColor(t['--sr-accent']) : surface, 4.5, 'text on accent button'],
    ['--sr-accent', surface, 3.0, 'accent on surface (non-text/links)'],
  ];
  for (const [key, bg, need, label] of textPairs) {
    const fg = parseColor(t[key]);
    if (!fg) {
      notes.push(`${themeName}: ${key} missing`);
      continue;
    }
    const r = ratio(over(fg, bg), bg);
    if (r < need) problems.push(`${themeName}: ${label} contrast ${r.toFixed(2)} below ${need}`);
    else notes.push(`${themeName}: ${label} ${r.toFixed(2)} (min ${need})`);
  }
  // status colours composited over their soft wash, wash over surface
  for (const name of ['ok', 'warn', 'err', 'info']) {
    const softRaw = t[`--sr-${name}-soft`];
    const fgRaw = t[`--sr-${name}`];
    if (!softRaw || !fgRaw) continue;
    const softColor = parseColor(softRaw);
    if (!softColor) continue;
    const softOnSurface = softColor[3] < 1 ? over(softColor, surface) : softColor;
    const fg = parseColor(fgRaw);
    const r = ratio(over(fg, softOnSurface), softOnSurface);
    if (r < 3.0) problems.push(`${themeName}: ${name} text on ${name}-soft contrast ${r.toFixed(2)} below 3.0`);
    else notes.push(`${themeName}: ${name} on soft ${r.toFixed(2)} (min 3.0)`);
  }
  // decorative lines are notes only
  notes.push(`${themeName}: line tokens are decorative, not asserted`);
}

function auditLiterals() {
  const uiFiles = [
    'src/popup/popup.css',
    'src/options/options.css',
    'src/popup/popup.html',
    'src/options/options.html',
    'src/popup/popup.js',
    'src/options/options.js',
  ];
  for (const rel of uiFiles) {
    const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/mask(-image)?\s*:/.test(line)) return; // alpha channel mask, allowed
      // strip string literals that are URLs (data: URIs may embed rgba in payloads)
      const stripped = line.replace(/'[^']*'|"[^"]*"/g, m => (/https?:|data:|\.css|\.js/.test(m) ? '' : m));
      if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(stripped) && !/var\(/.test(stripped)) {
        problems.push(`${rel}:${i + 1}: literal colour outside tokens/mask: ${line.trim().slice(0, 80)}`);
      }
    });
  }
}

function main() {
  const css = readFileSync(THEME, 'utf8');
  const light = tokens(block(css, ':root,'));
  const dark = tokens(block(css, "[data-theme='dark']"));
  if (!Object.keys(light).length) problems.push('theme.css: light token block not found');
  if (!Object.keys(dark).length) problems.push('theme.css: dark token block not found');
  auditTheme('light', light);
  auditTheme('dark', dark);
  auditLiterals();

  for (const n of notes) console.log('  - ' + n);
  console.log('contrast: ' + problems.length + ' problem(s), ' + notes.length + ' measurement(s)');
  for (const p of problems) console.log('  ! ' + p);
  if (problems.length) process.exit(1);
}
main();
