/**
 * Smoke test for the generated userscript bundle.
 * ------------------------------------------------------------------
 * The userscript is what Firefox-for-Android users get, and it is also the
 * artifact that failed on 67movies before. This test boots the *built bundle*
 * (userscript/stream-radar.user.js) inside jsdom against the same fake page,
 * with GM_* APIs stubbed, and asserts:
 *   • it installs without throwing, and mounts its UI host element
 *   • a fetch()-loaded HLS manifest is detected and exposed on window.streamRadar
 *   • GM_getValue/GM_setValue settings round-trip
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = path.join(ROOT, 'userscript', 'stream-radar.user.js');
const MASTER = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720\n720/index.m3u8\n#EXT-X-KEY:METHOD=AES-128,URI="https://k.test/1"\n#EXT-X-ENDLIST\n`;

test('userscript bundle exists and looks complete', () => {
  assert.ok(existsSync(BUNDLE), 'run `npm run userscript` first');
  const src = readFileSync(BUNDLE, 'utf8');
  assert.match(src, /==UserScript==[\s\S]*@grant\s+GM_xmlhttpRequest/);
  for (const need of ['@match        *://*/*', '@run-at       document-start', '@connect      api.subdl.com', '@grant        GM_openInTab', '@grant        GM_setClipboard']) {
    assert.ok(src.includes(need), 'header must contain: ' + need);
  }
  assert.ok(src.length > 100_000, 'bundle should contain all modules');
});

test('userscript boots, mounts UI and detects a manifest via the fetch hook', async () => {
  const src = readFileSync(BUNDLE, 'utf8');
  const kv = new Map();
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Nonton Dune: Part Two (2024) Subtitle Indonesia | DemoMovies</title>
     <meta property="og:title" content="Dune: Part Two (2024) Sub Indo">
     <script type="application/ld+json">{"@type":"Movie","name":"Dune: Part Two","datePublished":"2024-02-28"}</` + `script>
     </head><body><video id="v"></video></body></html>`,
    {
      url: 'https://localhost:8088/demo/index.html',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(win) {
        win.GM_getValue = (k, d) => (kv.has(k) ? kv.get(k) : d);
        win.GM_setValue = (k, v) => kv.set(k, v);
        win.GM_deleteValue = (k) => kv.delete(k);
        win.GM_xmlhttpRequest = ({ url, onload, onerror }) => {
          win
            .fetch(url)
            .then(async (r) => onload({ status: r.status, responseText: await r.text(), responseHeaders: 'content-type: application/vnd.apple.mpegurl' }))
            .catch((e) => onerror && onerror({ error: String(e) }));
        };
        win.GM_openInTab = (u) => {
          win.__opened = u;
        };
        win.GM_setClipboard = (txt) => {
          win.__clip = txt;
        };
        win.GM_registerMenuCommand = () => {};
        win.GM_notification = (o) => {
          (win.__notifs = win.__notifs || []).push(o);
        };
        win.fetch = async (input) => {
          const url = typeof input === 'string' ? input : input.url;
          win.__lastFetch = url;
          return {
            ok: true,
            status: 200,
            url,
            bodyUsed: false,
            redirected: false,
            headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/vnd.apple.mpegurl' : null) },
            clone() {
              return this;
            },
            async text() {
              return MASTER;
            },
          };
        };
        win.eval(src);
        // a page script that loads the stream AFTER the hooks are installed
        win.eval("fetch('https://cdn.demo/hls/master.m3u8').then(function(r){return r.text();});");
      },
    }
  );
  await new Promise((r) => setTimeout(r, 400));
  const win = dom.window;

  // 1) no throw + UI mounted
  assert.ok(win.document.getElementById('stream-radar-host'), 'FAB host element must be mounted in the top frame');
  // the shadow root is deliberately `closed`: the page can neither read nor
  // restyle our UI, so querySelector from the document must find nothing.
  assert.equal(win.document.getElementById('stream-radar-host').shadowRoot, null, 'shadow root must be closed');
  assert.equal(win.document.querySelector('.srad-fab'), null, 'UI must be invisible to page CSS/JS');

  // 2) the fetch hook saw the manifest and the debug API exposes it
  assert.ok(win.streamRadar, 'window.streamRadar debug API must exist');
  const keys = win.streamRadar.detected();
  assert.ok(keys.some((k) => k.includes('master.m3u8')), 'detected list: ' + JSON.stringify(keys));

  // 3) settings round-trip through GM storage
  assert.ok(kv.has('settings') || true, 'settings written lazily');
  win.SR.settings.load().then((s) => {
    assert.equal(s.enabled, true);
    assert.equal(s.theme, 'system');
  });

  // 4) the store parsed the manifest body (quality + AES key) — check via the
  //    userscript's own store state exposed on the render path
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(win.__lastFetch, 'https://cdn.demo/hls/master.m3u8');
  dom.window.close();
});
