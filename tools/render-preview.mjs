/**
 * Renders the panel UI with a demo state into a standalone HTML file so the
 * redesign can be reviewed in any browser, without installing the extension:
 *   npm run preview  →  docs/preview/ui.html
 * It uses the same modules the extension ships (ui-styles + ui + rules + i18n).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, 'src', rel), 'utf8');
const dom = new JSDOM('<!doctype html><html><body style="margin:0;background:#0a0d18"></body></html>', { runScripts: 'dangerously', pretendToBeVisual: true });
const win = dom.window;
for (const f of ['shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'shared/i18n.js', 'shared/icons.js', 'content/ui-styles.js', 'content/ui.js']) win.eval(read(f));
win.__sradOpenShadow = true;
win.eval(`
  const state = ${JSON.stringify(
    {
      items: [
        { id: 'a', url: 'https://cdn.master.film/hls/1516698/master.m3u8?token=7f2a91c4b0e5d2f1', category: 'hls', ext: 'm3u8', host: 'cdn.master.film', name: 'master.m3u8', quality: '1080p', duration: 7380, via: ['fetch', 'performance', 'dom'], confidence: 6, ts: Date.now(), aes: 'https://k/1', variants: [
          { uri: 'https://cdn/x/1080/index.m3u8', quality: '1080p', codecs: 'avc1.640028,mp4a.40.2', bandwidthLabel: '6.0 Mb/s' },
          { uri: 'https://cdn/x/720/index.m3u8', quality: '720p', codecs: '', bandwidthLabel: '2.2 Mb/s' },
          { uri: 'https://cdn/x/480/index.m3u8', quality: '480p', codecs: '', bandwidthLabel: '900 kb/s' },
        ], sub: { status: 'found', name: 'Dune.2024.1080p.ID.srt' } },
        { id: 'b', url: 'https://cdn.master.film/movie/movie-1080p.mp4', category: 'mp4', ext: 'mp4', host: 'cdn.master.film', name: 'movie-1080p.mp4', size: 2147483648, quality: '1080p', via: ['network'], confidence: 3, ts: Date.now(), sub: { status: 'searching' } },
        { id: 'c', url: 'blob:https://player.film/8f2e-1a4b', category: 'blob', host: 'player.film', name: 'blob:8f2e', mseBytes: 78643200, duration: 7380, via: ['mse-src'], confidence: 2, ts: Date.now(), sub: { status: 'skipped' } },
      ],
      ads: [{ id: 'd', url: 'https://vast.adx.test/preroll.mp4', category: 'mp4', name: 'preroll.mp4', host: 'vast.adx.test', isAd: true, via: ['network'], confidence: 1, ts: Date.now() }],
      title: { title: 'Dune: Part Two', year: '2024', kind: 'movie', url: 'https://67movies.nl/watch/movie/1516698', poster: 'https://picsum.photos/seed/dune/200/300', imdbId: 'tt15239678' },
      layers: { network: true, dom: true, mse: true, sw: true, heuristic: true },
      frames: [{ url: 'https://vidlove.org/embed/1516698' }, { url: 'https://embed.filemoon.sx/e/abc' }],
      players: ['hls.js', 'jwplayer'],
      sub: { status: 'found', items: [{ name: 'Dune Part Two 2024 1080p ID', providerLabel: 'SubDL', format: 'srt' }], query: 'Dune: Part Two' },
      rulesVersion: 2026082801,
      update: { status: 'current', version: 2026082801, notes: 'rules pack' },
      settings: { enabled: true, theme: 'dark', showAds: false, maxItems: 80, layerNetwork: true, layerDom: true, layerMse: true, layerSw: true, layerHeuristic: true, autoSubtitle: true, notify: true, recordMse: false, lang: 'en' },
    },
    null,
    1
  )};
  window.__ui = SR.ui.create({ shadowMode: 'open', getSettings: () => state.settings, onAction: () => {} });
  window.__ui.mount();
  window.__ui.render(state);
  window.__ui.setOpen(true);
`);
const host = win.document.getElementById('stream-radar-host');
const css = read('content/ui-styles.js').match(/SR\.uiCss = `([\s\S]*?)`;/)[1];
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stream Radar UI preview</title>
<style>
  body { min-height: 100vh; background: #0a0d18 url('https://picsum.photos/seed/cinema/1600/900') center/cover no-repeat; }
  body::after { content: ""; position: fixed; inset: 0; background: rgba(6,8,16,.72); backdrop-filter: blur(2px); }
  #stream-radar-host { position: fixed !important; inset: 0 !important; z-index: 999 !important; }
  .cap { position: fixed; left: 18px; top: 16px; z-index: 1000; color: #cfd6ee; font: 12px/1.6 ui-sans-serif, system-ui; }
  .cap b { color: #fff; }
</style>
</head>
<body>
<div class="cap"><b>Stream Radar, preview statis</b><br>
Dihasilkan oleh <code>npm run preview</code> memakai modul UI asli (src/content/ui*.js).
Panel dan tombolnya hidup, tapi aksi tidak terhubung ke browser: ini pratinjau desain.<br>
Ganti tema lewat ikon bulan di header. Resize jendela ke <b>&le;720px</b> untuk melihat layout mobile.</div>
<div id="stream-radar-host">${host.innerHTML}</div>
<style>${css.replace(/:host\s*{[^}]*}/, '')}</style>
</body>
</html>`;
mkdirSync(path.join(ROOT, 'docs/preview'), { recursive: true });
writeFileSync(path.join(ROOT, 'docs/preview/ui.html'), html);
console.log('✓ docs/preview/ui.html');
process.exit(0);
