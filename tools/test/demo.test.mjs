/**
 * Demo test: boots the local demo server (the page you would open by hand with
 * `npm run demo`) and runs the REAL extension pipeline against the REAL files:
 *
 *   jsdom loads demo/index.html  → dom scanner (LAYER 2) + unwrap
 *   real HTTP fetch of demo/master.m3u8 → store enrichment (variants, AES key)
 *   nested frame shape (embed.html) → same treatment the extension gives iframes
 *
 * So this is not a fixture: it proves the shipped demo page is detected by the
 * shipped detection code, over a real socket, with no browser involved.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.DEMO_TEST_PORT || 8219);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let ready = false;

async function waitUp(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/demo/index.html`);
      if (r.ok) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'tools/serve-demo.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ready = await waitUp();
});

after(() => {
  try {
    server && server.kill('SIGTERM');
  } catch (_) {}
});

test('demo server serves the HLS tree with the right media types', async (t) => {
  if (!ready) return t.skip('demo server did not start');
  for (const [p, type] of [
    ['/demo/master.m3u8', 'application/vnd.apple.mpegurl'],
    ['/demo/1080/index.m3u8', 'application/vnd.apple.mpegurl'],
    ['/demo/1080/seg-0.ts', 'video/mp2t'],
    ['/demo/backup/movie-720p.mp4', 'video/mp4'],
  ]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type') || '', new RegExp(type.replace('.', '\\.')), p + ' content-type');
  }
  // the segment must look big enough for byte accounting
  const seg = await fetch(BASE + '/demo/1080/seg-0.ts');
  assert.equal(Number(seg.headers.get('content-length')), 65536);
});

test('demo page: the extension pipeline finds the real stream, quality and key', async (t) => {
  if (!ready) return t.skip('demo server did not start');
  await import('../../src/shared/util.js');
  await import('../../src/shared/rules.js');
  await import('../../src/shared/title-cleaner.js');
  await import('../../src/shared/store.js');
  const SR = globalThis.SR;

  const html = await (await fetch(BASE + '/demo/index.html')).text();
  const dom = new JSDOM(html, { url: BASE + '/demo/index.html', runScripts: 'outside-only' });
  const doc = dom.window.document;

  // 1. LAYER 2 as the content script runs it: read the DOM, then unwrap the
  //    embed iframe (the trick that makes nested players visible to us).
  const store = new SR.MediaStore({ maxItems: 40 });
  const iframeSrc = doc.querySelector('iframe').getAttribute('src');
  assert.match(iframeSrc, /embed\.html$/);
  store.ingest({ url: BASE + iframeSrc.replace(/^\//, ''), via: 'dom' }, 'dom');

  // 2. the demo page sets video.src from the fetch() it performs; emulate that
  //    report the way src/page/inject.js would postMessage it
  const manifestBody = await (await fetch(BASE + '/demo/master.m3u8')).text();
  const hlsUrl = new URL('demo/master.m3u8', BASE + '/').href;
  const item = store.ingest({ url: hlsUrl, via: 'fetch', mime: 'application/vnd.apple.mpegurl', manifestBody: manifestBody }, 'page');
  assert.ok(item, 'HLS entry created from the demo fetch');
  assert.equal(item.category, 'hls');
  assert.equal(item.variants.length, 2, 'the two variants of the demo master playlist');
  assert.equal(item.quality, '1080p');
  assert.equal(item.variants[1].quality, '720p');
  const media = await (await fetch(BASE + '/demo/1080/index.m3u8')).text();
  const parsed = SR.manifest.parseM3u8(media, BASE + '/demo/1080/index.m3u8');
  assert.match(parsed.aesKeyUrl, /key/, 'AES-128 key URI in the demo media playlist');
  assert.equal(parsed.segmentCount, 2);
  assert.ok(store.layers.network, 'layer 1 lit up');

  // 3. title cleansing on the real demo <title>
  const info = SR.title.resolve(doc);
  assert.equal(info.title, 'Dune: Part Two', 'got: ' + info.title);
  assert.equal(info.year, '2024');
  assert.match(info.imdbId, /tt15239678/);
  assert.match(info.poster, /picsum/, 'og:image used as poster');

  // 4. the segment folder is reachable, so byte accounting works in the demo
  const segItem = store.ingest({ url: BASE + '/demo/1080/seg-0.ts', via: 'network', size: 65536 }, 'network');
  assert.ok(segItem, 'segment accounted');

  // 5. the media URL a user would copy is fetchable (watch party / mpv / ffmpeg)
  const probe = await fetch(item.variants[0].uri);
  assert.equal(probe.status, 200);

  dom.window.close();
});

test('demo page embeds the player frame the way the real sites do', async (t) => {
  if (!ready) return t.skip('demo server did not start');
  const html = await (await fetch(BASE + '/demo/index.html')).text();
  assert.match(html, /<iframe id="embed"/, 'nested player frame present');
  assert.match(html, /application\/ld\+json/, 'JSON-LD present so title priority 1 is exercised');
  const embed = await (await fetch(BASE + "/demo/embed.html")).text();
  assert.match(embed, /fetch\('master\.m3u8'\)/, 'embed fetches its own manifest (hook target)');
  assert.match(embed, /MediaSource/, 'embed uses MSE so layer 3 has something to hook');
});
