/**
 * Regenerate src/shared/icons.js from the lucide-static package.
 *   npm i -D lucide-static && node tools/gen-icons.mjs
 * Icons stay MIT (Lucide, https://lucide.dev). Inlining the SVG paths (instead of
 * shipping the icon runtime) keeps the shadow-DOM UI dependency-free at runtime.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ICONS = [
  'radar', 'clapperboard', 'settings', 'settings-2', 'x', 'copy', 'download', 'file-down', 'users', 'captions',
  'external-link', 'sun', 'moon', 'refresh-cw', 'check', 'chevron-down', 'play', 'search', 'bell', 'eye',
  'keyboard', 'palette', 'link-2', 'list-filter', 'loader', 'shield-check', 'sparkles', 'trash-2', 'info',
  'monitor-smartphone', 'plug-zap', 'video', 'circle',
];
const pkg = 'lucide-static';
const out = [];
for (const name of ICONS) {
  const raw = await readFile(path.join('node_modules', pkg, 'icons', name + '.svg'), 'utf8');
  const inner = raw
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<svg[^>]*>/i, '')
    .replace(/<\/svg>/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const vb = (raw.match(/viewBox="([^"]+)"/) || [, '0 0 24 24'])[1];
  out.push({ name, vb, inner });
}
const js =
  `/**\n * Icons: generated from the lucide-static package (MIT, https://lucide.dev).\n * Do not edit by hand — run \`node tools/gen-icons.mjs\` after changing the list.\n */\n(function (root) {\n  'use strict';\n  const SR = (root.SR = root.SR || {});\n  const defs = ${JSON.stringify(out, null, 1).replace(/\n/g, '\n  ')};\n` +
  `  function icon(name, cls) {\n    const d = defs.find((x) => x.name === name) || defs[0];\n    return (\n      '<svg class="' + (cls || '') + '" viewBox="' +\n      d.vb +\n      '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +\n      d.inner +\n      '</svg>'\n    );\n  }\n  icon.raw = (name) => (defs.find((x) => x.name === name) || defs[0]).inner;\n  icon.names = defs.map((d) => d.name);\n  SR.icons = icon;\n})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);\n`;
await writeFile('src/shared/icons.js', js);
console.log('✓ src/shared/icons.js — ' + out.length + ' lucide icons');
