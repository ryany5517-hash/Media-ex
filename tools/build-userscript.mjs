/**
 * Bundles the userscript edition from the same modules the extension uses.
 *   node tools/build-userscript.mjs
 * Output: userscript/stream-radar.user.js  (commit it: it is the artifact you
 * install in Tampermonkey/Violentmonkey, e.g. on Firefox for Android)
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'userscript', 'stream-radar.user.js');

const FILES = [
  'shared/util.js',
  'shared/rules.js',
  'shared/title-cleaner.js',
  'shared/i18n.js',
  'shared/store.js',
  'shared/dom-scanner.js',
  'shared/subtitles.js',
  'shared/watchparty-auto.js',
  'shared/updater.js',
  'vendor/motion.min.js',
  'shared/icons.js',
  'content/ui-styles.js',
  'content/ui.js',
  'page/inject.js',
  'userscript/host.js',
];

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

const HEADER = `// ==UserScript==
// @name         Stream Radar — Ultra Media Detector + WatchParty + Subtitle Indonesia
// @namespace    https://github.com/ryany5517-hash/Media-ex
// @version      ${pkg.version}
// @description  Deteksi semua stream video (HLS/DASH/MP4/WebM/blob) lewat 5 layer — fetch/XHR/WebSocket, DOM deep scan, MediaSource, Service Worker/Cache, dan heuristik player (JWPlayer/Video.js/Plyr/HLS.js/DASH.js). Membersihkan judul film/series, mencari subtitle Indonesia (SubDL / OpenSubtitles / YIFY), dan membuka WatchParty.me otomatis. Dipakai kalau tidak bisa pasang extension (mis. Firefox Android).
// @author       Stream Radar
// @license      MIT
// @match        *://*/*
// @run-at       document-start
// @inject-into  page
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.subdl.com
// @connect      api.opensubtitles.com
// @connect      www.watchparty.me
// @connect      yifysubtitles.org
// @connect      *
// @icon         https://raw.githubusercontent.com/ryany5517-hash/Media-ex/main/src/icons/icon128.png
// @homepageURL  https://github.com/ryany5517-hash/Media-ex
// @supportURL   https://github.com/ryany5517-hash/Media-ex/issues
// @downloadURL  https://raw.githubusercontent.com/ryany5517-hash/Media-ex/main/userscript/stream-radar.user.js
// @updateURL    https://raw.githubusercontent.com/ryany5517-hash/Media-ex/main/userscript/stream-radar.user.js
// @note         ─────────────────────────────────────────────────────────────
// @note  FIRST-TIME SETUP
// @note   1. Install Tampermonkey or Violentmonkey (Firefox Android: Violentmonkey
// @note      from AMO works, Tampermonkey needs the Chrome-store build on Android).
// @note   2. Install this script; open a video page and press play — the ◉ button
// @note      appears bottom-right with a counter.
// @note   3. For Indonesian subtitles you MUST add a free SubDL API key
// @note      (https://subdl.com/panel/api) via the gear icon on the panel.
// @note      OpenSubtitles needs a key too (https://www.opensubtitles.com/en/api-keys)
// @note      and their team must approve the exact User-Agent you paste.
// @note  DEPENDENCIES: none — no jQuery, no CDN scripts, no external CSS.
// @note  Everything (SRT→VTT, gunzip, unzip, HLS/DASH parsing) is in this file.
// @note  KNOWN LIMITATIONS vs. the extension build
// @note   • no webRequest observer, so a stream fetched by a *cross-origin
// @note     iframe that itself never runs JS is invisible; the extension sees it.
// @note   • DRM (Widevine/FairPlay/PlayReady) streams are labelled, never dumped.
// @note   • blob:/MSE streams are detected but only saveable via "Record buffer".
// @note   • sites with a strict CSP can block window hooks (layers 2/4/5 still run).
// @note   • P2P players (WebTorrent / WASM demuxers) never hit HTTP → nothing to see.
// @note   • WatchParty has no public room API: we pass ?url= and auto-fill the
// @note     room form; if they redesign it, open the room and paste the URL manually.
// @note  ─────────────────────────────────────────────────────────────
// ==/UserScript==

/**
 * ⚠ GENERATED FILE — do not edit.
 *   built by tools/build-userscript.mjs from:
${FILES.map((f) => ' *     src/' + f).join('\n')}
 *   regenerate with:  npm run userscript
 */
`;

async function main() {
  const parts = [HEADER];
  for (const f of FILES) {
    const body = await readFile(path.join(SRC, f), 'utf8');
    parts.push(`\n/* ═════════════════════════ src/${f} ═════════════════════════ */\n${body.trim()}\n`);
  }
  const out = parts.join('');
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, out);
  try {
    execFileSync(process.execPath, ['--check', OUT], { stdio: 'pipe' });
  } catch (e) {
    console.error('userscript syntax error:\n' + (e.stderr?.toString() || e.message));
    process.exit(1);
  }
  const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
  console.log(`\x1b[32m✓\x1b[0m userscript/stream-radar.user.js — ${FILES.length} modules, ${kb} KB`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
export { main as buildUserscript, OUT as output };
