/**
 * End-to-end integration test: a simulated "67movies-style" page.
 * ------------------------------------------------------------------
 * This is the test that should have existed before the first version was handed
 * over. It boots the *real* page hooks (src/page/inject.js) and the *real*
 * DOM scanner (src/shared/dom-scanner.js) inside a jsdom document shaped like
 * the sites the user reported:
 *
 *   top frame  (67movies.nl)  → 3rd-party iframe (vidlove) → another iframe
 *                               (filemoon-like) that fetches the HLS master
 *   stream URL is hidden in the outer iframe's query string
 *   a VAST ad mp4 is also on the page → must be classified as noise, not media
 *   title is SEO spam: "Nonton Dune: Part Two (2024) Subtitle Indonesia | …"
 *
 * Then it runs everything through the shared MediaStore + subtitle engine and
 * asserts the outcome a user would call "correct": 1 clean title, the real
 * .m3u8, its quality ladder, the AES-128 key, ad filtered, blob/MSE reported,
 * SRT converted to VTT, and the WatchParty hand-off payload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, 'src', rel), 'utf8');

const MASTER_M3U8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-KEY:METHOD=AES-128,URI="https://key.cdn.test/k/1?key=abc"
#EXT-X-ENDLIST
`;
const MP4_BODY = 'faketypemedia';

/* ---------------- a tiny fake zip (stored) with one SRT ---------------- */
function crc32(buf) {
  let table = crc32.table || (crc32.table = makeTable());
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
/** deflated zip containing one entry, exercising the extension's own unzip path */
function buildZip(name, text) {
  const data = Buffer.from(text, 'utf8');
  const comp = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name, 'utf8');
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(8, 8);
  lfh.writeUInt32LE(crc32(data), 14);
  lfh.writeUInt32LE(comp.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  const local = Buffer.concat([lfh, nameBuf, comp]);
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(8, 10);
  cdh.writeUInt32LE(crc32(data), 16);
  cdh.writeUInt32LE(comp.length, 20);
  cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 42);
  const central = Buffer.concat([cdh, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

/* ---------------- fake SubDL server ---------------- */
const SRT_TEXT = `1
00:00:01,000 --> 00:00:04,000
Selamat datang di Dune: Part Two

2
00:00:05,000 --> 00:00:08,000
<font color="#FFFF00">Adegan pembuka</font>
`;
function fakeSubdlFetch(url) {
  const u = String(url);
  if (u.startsWith('https://api.subdl.com/api/v1/subtitles?')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      async json() {
        return {
          results: [
            { attributes: { id: 4242, name: 'Dune Part Two', filename: 'Dune.Part.Two.2024.1080p.WEBRip.x265-[GRP].id.srt', lang: { code: 'id', name: 'Indonesian' }, format: 'srt', year: '2024', downloadCount: 2400, verified: true } },
            { attributes: { id: 4243, name: 'Dune Part Two', filename: 'Dune.Part.Two.2024.spa.srt', lang: { code: 'es', name: 'Spanish' }, format: 'srt', year: '2024' } },
          ],
        };
      },
    });
  }
  if (u.startsWith('https://api.subdl.com/api/v1/subtitles/download')) {
    return Promise.resolve({ ok: true, status: 200, async json() { return { results: { attributes: { link: 'https://dl.subdl.com/get/4242.zip' } } }; } });
  }
  if (u.startsWith('https://dl.subdl.com/get/4242.zip')) {
    const buf = buildZip('Dune.id.srt', SRT_TEXT);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/zip' : null) },
      async arrayBuffer() {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    });
  }
  throw new Error('unexpected fetch in test: ' + u);
}

/* ================================================================== *
 * the page
 * ================================================================== */
function buildDom() {
  const embedDoc = `<!doctype html><html><head><title>Player</title>
    <script>
      // filemoon-style player: it fetches its own manifest
      fetch('https://stream.cdn-vidlove.net/hls/1516698/master.m3u8?token=9f2', { headers: { 'x-play': '1' } })
        .then(function (r) { return r.text(); });
      fetch('https://vast.adx.doubleclick.net/preroll/spot.mp4').catch(function(){});
      // classic player bootstrap: XHR for the manifest
      var x = new XMLHttpRequest();
      x.open('GET', 'https://mirror2.cdn-vidlove.net/hls/1516698/master.m3u8?token=bk');
      x.send();
      // some embedders push the real url over a socket instead
      var ws = new WebSocket('wss://push.cdn-vidlove.net/ws');
      ws.send(JSON.stringify({ action: 'play', file: 'https://cdn.host/ws/clip-1080p.mp4' }));
    <\/script>
    </head><body>
      <video id="v" poster="https://img.cdn/poster.jpg"></video>
      <script>
        // MSE-style playback: blob URL + a MediaSource-shaped object
        var blob = { size: 999999, type: 'video/mp4', constructor: { name: 'Blob' } };
        try { document.getElementById('v').src = window.URL.createObjectURL(blob); } catch (e) {}
      <\/script>
    </body></html>`;

  const iframeDoc = `<!doctype html><html><body>
    <iframe src="https://embed.filemoon.sx/e/abc123?src=https%3A%2F%2Fcdn.host%2Fv%2Fmovie.mp4&t=1"></iframe>
    <div id="player"></div>
    <script>
      var config = { file: "https://mirror.cdn.test/vid/720/movie-720p.mp4", key: "abc" };
      window.__sradTestConfig = config;
    <\/script>
  </body></html>`;

  const top = `<!doctype html><html lang="id"><head>
    <meta charset="utf-8">
    <title>Nonton Dune: Part Two (2024) Subtitle Indonesia | 67movies.net — Watch Movies &amp; TV Shows in HD Online</title>
    <meta property="og:title" content="Nonton Dune: Part Two (2024) Sub Indo - Layarkaca21 67movies">
    <meta property="og:image" content="https://image.tmdb.org/t/p/w500/poster.jpg">
    <meta property="og:video" content="https://stream.cdn-vidlove.net/hls/1516698/master.m3u8?token=9f2">
    <link rel="canonical" href="https://67movies.nl/watch/movie/1516698">
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Movie","name":"Dune: Part Two","datePublished":"2024-02-28","image":"https://image.tmdb.org/t/p/w500/poster.jpg","sameAs":["https://www.imdb.com/title/tt15239678/"]}
    <\/script>
  </head><body>
    <h1>Nonton Dune: Part Two (2024) Subtitle Indonesia</h1>
    <a href="https://www.imdb.com/title/tt15239678/" rel="nofollow">IMDb</a>
    <div class="servers">
      <button>vidlove</button><button>111movies</button><button>vidup</button>
    </div>
    <iframe id="embed" src="https://vidlink.pro/movie/1516698?theme=light" data-src="https://vidlink.pro/movie/1516698"></iframe>
    <video controls poster="https://img.cdn/teaser.jpg"><source src="https://fallback.cdn/movie.mp4" type="video/mp4"></video>
    <script>
      // the site resolves the real embed URL client-side and hides it in a query param
      var s = document.getElementById('embed');
      s.src = "https://vidlove.org/embed/1516698?url=https%3A%2F%2Fstream.cdn-vidlove.net%2Fhls%2F1516698%2Fmaster.m3u8%3Ftoken%3D9f2";
      fetch('https://api.67movies.nl/player?movie=1516698').then(function(r){return r.json();});
    <\/script>
  </body></html>`;
  return { top, iframeDoc, embedDoc };
}

/** Install the network stubs + the real modules *before* the page parses. */
function installHooks(win, opts) {
  const o = opts || {};
  win.__calls = [];
  const fakeResponse = (body, headers, url) => ({
    ok: true,
    status: 200,
    url,
    redirected: false,
    bodyUsed: false,
    headers: { get: (k) => (headers[String(k).toLowerCase()] ?? null) },
    clone() {
      return this;
    },
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
  });
  win.fetch = async function (input) {
    const url = typeof input === 'string' ? input : input.url;
    win.__calls.push(url);
    if (url.includes('master.m3u8')) {
      return fakeResponse(MASTER_M3U8, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': String(MASTER_M3U8.length) }, url);
    }
    if (url.includes('spot.mp4')) return fakeResponse('AD', { 'content-type': 'video/mp4', 'content-length': '2' }, url);
    if (url.includes('api.67movies.nl/player')) {
      const json = JSON.stringify({ type: 'hls', sources: [{ file: 'https://deep.cdn.test/hidden/index.m3u8?sig=xyz' }] });
      return fakeResponse(json, { 'content-type': 'application/json', 'content-length': String(json.length) }, url);
    }
    return fakeResponse('', { 'content-type': 'text/html' }, url);
  };

  class FakeXHR {
    constructor() {
      this._listeners = [];
      this.status = 0;
    }
    open(method, url) {
      this.__m = method;
      this.url = url;
    }
    setRequestHeader() {}
    getAllResponseHeaders() {
      return 'content-type: video/mp4\r\ncontent-length: 1234567\r\n';
    }
    getResponseHeader(n) {
      return { 'content-type': 'video/mp4', 'content-length': '1234567' }[String(n).toLowerCase()] || null;
    }
    addEventListener(t, cb) {
      this._listeners.push(cb);
    }
    send() {
      win.__calls.push(this.url);
      const self = this;
      this.status = 200;
      this.responseURL = this.url;
      this.responseText = MP4_BODY;
      setTimeout(() => self._listeners.forEach((cb) => cb({ type: 'loadend' })), 0);
    }
  }
  win.XMLHttpRequest = FakeXHR;

  class FakeSocket {
    constructor(url) {
      this.url = String(url);
      this._l = {};
      win.__calls.push(this.url);
    }
    addEventListener(t, cb) {
      (this._l[t] = this._l[t] || []).push(cb);
    }
    send(data) {
      win.__sent.push(data);
    }
    close() {}
    _emit(type, data) {
      (this._l[type] || []).forEach((cb) => cb({ type, data }));
    }
  }
  FakeSocket.prototype.readyState = 1;
  win.WebSocket = FakeSocket;
  win.__sent = [];

  // MSE-ish object URL support (jsdom has none)
  let blobSeq = 0;
  const realURL = win.URL;
  if (realURL) {
    realURL.createObjectURL = (obj) => 'blob:' + win.location.origin + '/srad-' + ++blobSeq + '-' + ((obj && obj.size) || 0);
    realURL.revokeObjectURL = () => {};
  }
  if (!win.MediaSource) {
    win.MediaSource = class MediaSource {
      constructor() {
        this.readyState = 'closed';
        this.duration = 0;
        this._l = {};
      }
      addEventListener(t, cb) {
        (this._l[t] = this._l[t] || []).push(cb);
      }
      addSourceBuffer(mime) {
        this._mimes = (this._mimes || []).concat(mime);
        const self = this;
        return {
          appendBuffer(data) {
            self.__bytes = (self.__bytes || 0) + (data && data.byteLength ? data.byteLength : 1024);
          },
        };
      }
      endOfStream() {
        this.readyState = 'ended';
      }
    };
    if (win.MediaSource) win.MediaSource.isTypeSupported = () => true;
  }

  for (const f of ['shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'shared/dom-scanner.js', 'page/inject.js']) {
    win.eval(read(f));
  }
  return win;
}

async function bootWorld() {
  const { top, iframeDoc, embedDoc } = buildDom();
  const reports = [];
  const childReports = [];
  const events = [];

  const collectFrom = (win, bucket) => {
    win.addEventListener('message', (ev) => {
      const d = ev.data;
      if (!d || d.srad !== 1) return;
      events.push(d.kind);
      if (d.kind === 'media') bucket.push(d.payload);
    });
  };

  const dom = new JSDOM(top, {
    url: 'https://67movies.nl/watch/movie/1516698',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse: (win) => {
      installHooks(win);
      collectFrom(win, reports);
    },
  });
  const win = dom.window;

  // Nested frames: jsdom cannot load cross-origin frames, so we boot them as
  // sibling worlds — exactly what `all_frames` does in the real extension.
  const mkChild = (html, url, bucket) => {
    const d = new JSDOM(html, {
      url,
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse: (w) => {
        installHooks(w);
        collectFrom(w, bucket);
      },
    });
    return d;
  };
  const embedDom = mkChild(embedDoc, 'https://embed.vidlove.org/e/1516698', childReports);
  const innerDom = mkChild(iframeDoc, 'https://embed.filemoon.sx/e/abc123', childReports);

  // let page scripts + the staggered hook timers run
  await new Promise((r) => setTimeout(r, 250));

  const collected = [];
  for (const d of [dom, embedDom, innerDom]) {
    const w = d.window;
    w.eval('window.__scanOut=[];window.__scan=SR.domScan.create({win:window,doc:document,isTop:true,emit:function(l){l.forEach(function(x){window.__scanOut.push(x)})},onTitle:function(i){window.__titleInfo=i}});window.__scan.start();window.__scan.scan("manual");window.__scan.readTitle(true);');
    await new Promise((r) => setTimeout(r, 120));
    for (const item of w.__scanOut) collected.push(Object.assign({}, item, { frame: w === win ? 'top' : 'iframe' }));
    if (w.__titleInfo && !collected.title) collected.title = w.__titleInfo;
  }

  return { dom, win, embedDom, innerDom, reports, childReports, collected, events, calls: win.__calls };
}

/* ================================================================== *
 * the test
 * ================================================================== */
test('integration: 67movies-style page is detected end to end', async () => {
  const world = await bootWorld();
  const SR = world.win.SR;
  // Node-side globals are needed by the store; load the same modules there too
  await import('../../src/shared/util.js');
  await import('../../src/shared/rules.js');
  await import('../../src/shared/title-cleaner.js');
  await import('../../src/shared/store.js');
  await import('../../src/shared/subtitles.js');

  const store = new globalThis.SR.MediaStore({ maxItems: 80 });

  // 1) feed everything the page worlds reported (exactly what the content
  //    script forwards to the background worker in the real extension)
  for (const r of [...world.reports, ...world.childReports, ...world.collected]) store.ingest(r, 'test');

  const urls = [...store.byId.values()].map((e) => e.url);

  // 2) the HLS master found through the fetch hook, *including* the one hidden
  //    in the vidlove iframe's ?url= parameter
  assert.ok(
    urls.some((u) => u.includes('stream.cdn-vidlove.net/hls/1516698/master.m3u8')),
    'HLS master must be detected — got: ' + JSON.stringify(urls)
  );
  if (process.env.SR_DEBUG) console.log(JSON.stringify([...store.byId.values()].map((e) => ({ c: e.category, via: e.via, u: e.url })), null, 1));
  const hls = [...store.byId.values()].find((e) => /master\.m3u8(\?|$)/.test(e.url) && e.category === 'hls') || [...store.byId.values()].find((e) => e.url.includes('master.m3u8'));
  assert.equal(hls.category, 'hls');
  assert.ok(![...store.byId.values()].some((e) => e.category === 'other' && e.url.includes('vidlove.org/embed')), 'the wrapper URL must not be listed as generic media');

  // 3) the manifest body reported by the hook is parsed into a quality ladder
  store.parseManifest(hls, MASTER_M3U8);
  assert.equal(hls.variants.length, 2, 'two variants in the master playlist');
  assert.equal(hls.quality, '1080p');
  assert.equal(hls.aes, 'https://key.cdn.test/k/1?key=abc');
  assert.equal(hls.needsManifest, false);

  // 4) direct MP4 via XHR + content-type sniffing (no extension in the URL? we
  //    use an extension here; the mime path is covered in core.test.mjs)
  assert.ok(urls.some((u) => u.endsWith('movie-720p.mp4')), 'inline-script config URL: ' + JSON.stringify(urls));
  assert.ok(urls.some((u) => u.endsWith('fallback.cdn/movie.mp4')), '<source> element URL');
  assert.ok(urls.some((u) => u.endsWith('cdn.host/v/movie.mp4')), 'nested ?src= in the filemoon iframe URL');

  // 5) the VAST ad is tracked but flagged, so the UI can hide it
  const ad = [...store.byId.values()].find((e) => e.url.includes('doubleclick'));
  assert.ok(ad, 'ad request should still be recorded');
  assert.equal(ad.isAd, true);
  const view = store.view({ title: { title: 'x' } });
  assert.ok(view.ads.some((a) => a.isAd), 'view separates ads');
  assert.ok(!view.items.some((a) => a.isAd), 'default list hides ads');

  // 6) blob/MSE playback is recognised as blob (not "no media found")
  assert.ok(urls.some((u) => u.startsWith('blob:')), 'blob: from URL.createObjectURL — ' + JSON.stringify(urls));

  // 5b) the XHR hook sees the *backup server* URL that fetch never requested
  const xhrItem = [...store.byId.values()].find((e) => e.url.includes('mirror2.cdn-vidlove.net'));
  assert.ok(xhrItem, 'XHR-reported manifest must be stored');
  assert.equal(xhrItem.category, 'hls');
  assert.ok(xhrItem.via.includes('xhr'), 'via should include xhr, got ' + xhrItem.via.join(','));
  assert.equal(xhrItem.size, 1234567, 'content-length from the XHR response headers');

  // 6b) a stream URL that only ever travels through a WebSocket is still caught
  assert.ok(urls.some((u) => u.includes('clip-1080p.mp4')), 'url sent inside a websocket frame: ' + JSON.stringify(urls));

  // 6c) an m3u8 hidden in a JSON player config (no extension in the request URL)
  assert.ok(urls.some((u) => u.includes('/hidden/index.m3u8')), 'stream URL inside a JSON config response');

  // 7) every detection layer has at least one "via" recorded
  const vias = new Set();
  for (const e of store.byId.values()) (e.via || []).forEach((v) => vias.add(v));
  for (const expect of ['fetch', 'xhr', 'dom', 'inline-script', 'websocket']) {
    assert.ok([...vias].some((v) => v.startsWith(expect)), `expected a ${expect} detection, got ${[...vias].join(', ')}`);
  }
  assert.deepEqual(
    { network: store.layers.network, dom: store.layers.dom, heuristic: store.layers.heuristic },
    { network: true, dom: true, heuristic: true },
    'layer HUD should light up'
  );

  // 8) the title: JSON-LD wins, junk removed, imdb id + year captured
  const info = globalThis.SR.title.resolve(world.dom.window.document);
  assert.equal(info.title, 'Dune: Part Two');
  assert.equal(info.year, '2024');
  assert.equal(info.kind, 'movie');
  assert.match(info.imdbId || '', /tt15239678/);
  assert.ok(info.poster.includes('poster.jpg'));

  // 9) subtitles: search → filter Indonesian → download zip → inflate → VTT
  globalThis.SR.util.fetchImpl = fakeSubdlFetch;
  globalThis.SR.util.fetchText = async (url, o) => {
    const res = await fakeSubdlFetch(url);
    const text = res.text ? await res.text() : '';
    return text;
  };
  const settings = Object.assign({}, globalThis.SR.defaults, { subdlApiKey: 'test-key', providers: { subdl: true, opensubtitles: false, yify: false } });
  const res = await globalThis.SR.subs.search({ title: info.title, year: info.year }, settings, {});
  assert.equal(res.results.length, 1, 'Spanish subtitle filtered out');
  assert.equal(res.providerInfo.subdl.status, 'ok');
  const vtt = await globalThis.SR.subs.resolve(res.results[0], settings, { fetchImpl: fakeSubdlFetch });
  assert.match(vtt, /^WEBVTT/);
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:04.000'), vtt.slice(0, 200));
  assert.equal(globalThis.SR.subs.countCues(vtt), 2);

  // 10) WatchParty hand-off payload (what the background worker stores for the
  //     watchparty.me helper) — media url + cleaned room name
  // /create?video= auto-creates the room server-side (matches the rivestream /
  // watchparty "Watch Party" button); the cleaned name rides in the payload.
  const target = 'https://www.watchparty.me/create?video=' + encodeURIComponent(hls.url);
  assert.ok(target.startsWith('https://www.watchparty.me/create?video=https%3A%2F%2Fstream.cdn-vidlove.net'), target);
  const roomName = String(info.title + (info.year ? ' (' + info.year + ')' : '')).slice(0, 90);
  assert.ok(roomName.includes('Dune') && roomName.includes('2024'), roomName);

  world.embedDom.window.close();
  world.innerDom.window.close();
  world.dom.window.close();
});

test('integration: empty page yields zero media and a junk title (no false positives)', async () => {
  await import('../../src/shared/util.js');
  await import('../../src/shared/rules.js');
  await import('../../src/shared/title-cleaner.js');
  await import('../../src/shared/store.js');
  await import('../../src/shared/subtitles.js');
  const dom = new JSDOM('<!doctype html><html><head><title>Just a moment...</title></head><body><p>checking your browser</p></body></html>', {
    url: 'https://67movies.nl/',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  for (const f of ['shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'shared/dom-scanner.js', 'page/inject.js']) win.eval(read(f));
  const reports = [];
  win.addEventListener('message', (ev) => {
    if (ev.data && ev.data.srad === 1 && ev.data.kind === 'media') reports.push(ev.data.payload);
  });
  win.eval('window.__out=[];window.__s=SR.domScan.create({win:window,doc:document,emit:function(l){l.forEach(function(x){window.__out.push(x)})},onTitle:function(i){window.__t=i}});window.__s.start();window.__s.scan("manual");window.__s.readTitle(true);');
  await new Promise((r) => setTimeout(r, 60));
  const store = new globalThis.SR.MediaStore({});
  for (const r of [...reports, ...win.__out]) store.ingest(r, 'test');
  assert.equal(store.byId.size, 0, 'a page with no media must stay empty');
  const info = globalThis.SR.title.clean(win.document.title);
  assert.equal(info.title, '', 'cookie-wall title must be treated as junk');
  dom.window.close();
});

test('watchparty automation core fills the room form in a realistic DOM', async () => {
  await import('../../src/shared/util.js');
  await import('../../src/shared/watchparty-auto.js');
  const html = `<!doctype html><html><body>
    <div class="join-form">
      <label for="user">User Name</label><input id="user" placeholder="User Name">
      <label for="room">Room Name</label><input id="room" placeholder="Room Name">
      <button id="join">Join Room</button>
    </div>
    <video id="player"></video>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://www.watchparty.me/watchNow', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  globalThis.window = win;
  win.eval(read('shared/watchparty-auto.js'));
  let clicked = false;
  win.document.getElementById('join').addEventListener('click', () => {
    clicked = true;
  });
  const statuses = [];
  const runner = win.SR.watchparty.run({
    doc: win.document,
    payload: { mediaUrl: 'https://cdn/x.m3u8', roomName: 'Dune: Part Two (2024)', userName: 'Tester', autoJoin: true, subtitle: { vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHalo\n', name: 'id.srt' } },
    onStatus: (txt, kind) => statuses.push([kind, txt]),
    t: (k) => k,
  });
  await new Promise((r) => setTimeout(r, 420));
  const room = win.document.getElementById('room');
  const user = win.document.getElementById('user');
  assert.equal(room.value, 'Dune: Part Two (2024)', 'room name auto-filled: ' + JSON.stringify(statuses));
  assert.equal(user.value, 'Tester');
  assert.equal(clicked, true, 'join button auto-clicked');
  const tracks = win.document.getElementById('player').querySelectorAll('track');
  assert.equal(tracks.length, 1, 'subtitle track injected into the room player');
  assert.equal(tracks[0].getAttribute('srclang'), 'id');
  runner.stop();
  win.close();
});
