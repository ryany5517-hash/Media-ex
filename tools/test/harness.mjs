/**
 * Extension runtime harness.
 * ------------------------------------------------------------------
 * Boots the REAL src/background.js (in a Node vm context) together with the REAL
 * src/content/content.js + src/page/inject.js (in jsdom), sharing a chrome.*
 * mock. That makes it possible to assert feature wiring, not just functions:
 *
 *   hub.fireWebRequest({...})   → the actual webRequest.onHeadersReceived listener
 *   win.postMessage({srad:1,…)  → the actual page-hook → content bridge
 *   hub.tabs.created            → WatchParty hand-off
 *   hub.downloads.calls         → download naming + playlist fetching
 *   hub.badge                   → toolbar counter
 *
 * Anything the extension touches that isn't mocked throws loudly, so we can never
 * accidentally "pass" a code path that cannot run in a browser.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
export const readSrc = (rel) => readFileSync(path.join(SRC, rel), 'utf8');

/** modules the build inlines into background.js (must match tools/build.mjs) */
export const PRELUDE = ['shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'shared/subtitles.js', 'shared/i18n.js', 'shared/store.js'];

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function makeHub() {
  const hub = {
    storage: {},
    log: [],
    tabs: { created: [] },
    downloads: { calls: [], next: 1 },
    notifications: { calls: [] },
    contextMenus: { items: new Map() },
    commands: { handlers: [] },
    alarms: { handlers: [], jobs: new Map() },
    badge: new Map(),
    webRequest: { listeners: [] },
    bgListeners: [],
    contentListeners: [],
    contentTab: { id: 1, url: 'https://67movies.nl/watch/movie/1516698', active: true },
    contentWindow: null,
    menusClicked: [],
  };

  const storageChanged = [];
  const storageLocal = {
    async get(keys) {
      if (keys == null) return clone(hub.storage);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in hub.storage) out[k] = clone(hub.storage[k]);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: hub.storage[k], newValue: clone(v) };
        hub.storage[k] = clone(v);
      }
      hub.log.push(['storage.set', Object.keys(obj).join(',')]);
      queueMicrotask(() => storageChanged.forEach((cb) => cb(clone(changes), 'local')));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete hub.storage[k];
    },
    async getBytesInUse() {
      return JSON.stringify(hub.storage).length;
    },
  };

  const shared = {
    storage: { local: storageLocal, onChanged: { addListener: (cb) => storageChanged.push(cb) } },
    downloads: {
      async download(opts) {
        hub.downloads.calls.push(opts);
        return hub.downloads.next++;
      },
    },
    notifications: {
      create: (id, opts) => hub.notifications.calls.push([id, opts]),
      clear: () => {},
      onClicked: { addListener: (cb) => (hub.notificationClicked = cb) },
    },
    contextMenus: {
      create: (o) => hub.contextMenus.items.set(o.id, o),
      removeAll: (cb) => {
        hub.contextMenus.items.clear();
        cb && cb();
      },
      onClicked: { addListener: (cb) => hub.menusClicked.push(cb) },
    },
    commands: { onCommand: { addListener: (cb) => hub.commands.handlers.push(cb) } },
    alarms: {
      create: (name, info) => hub.alarms.jobs.set(name, info),
      onAlarm: { addListener: (cb) => hub.alarms.handlers.push(cb) },
    },
    windows: { async update() { return {}; }, async getCurrent() { return { id: 1 }; } },
    webRequest: {
      onHeadersReceived: { addListener: (cb, filter) => hub.webRequest.listeners.push({ cb, filter }) },
      onBeforeSendHeaders: { addListener: (cb, filter) => hub.webRequest.listeners.push({ cb, filter, kind: 'before' }) },
    },
    tabs: {
      async query() {
        return [hub.contentTab];
      },
      async get(id) {
        return { id, active: true, windowId: 1, url: hub.contentTab.url };
      },
      async create(props) {
        const tab = { id: 100 + hub.tabs.created.length, ...props };
        hub.tabs.created.push(tab);
        return tab;
      },
      async update(id, props) {
        hub.log.push(['tabs.update', id, props && props.url]);
        return {};
      },
      async sendMessage(tabId, msg) {
        hub.log.push(['tabs.sendMessage', tabId, msg && msg.type]);
        if (msg && msg.type === 'attach-subtitle') {
          // content answers asynchronously through its respond()
          hub.contentResponded = null;
          deliverContent(msg);
          return { ok: true, applied: 1 };
        }
        deliverContent(msg);
        return { ok: true };
      },
      onRemoved: { addListener: (cb) => (hub.tabRemoved = cb) },
      onUpdated: { addListener: (cb) => (hub.tabUpdated = cb) },
      onActivated: { addListener: (cb) => (hub.tabActivated = cb) },
    },
    action: {
      setBadgeText: ({ tabId, text }) => hub.badge.set(tabId, text),
      setBadgeBackgroundColor: () => {},
      setTitle: () => {},
      onClicked: { addListener: (cb) => (hub.actionClicked = cb) },
    },
  };

  function deliverContent(msg) {
    for (const cb of hub.contentListeners) {
      try {
        cb(msg, { tab: hub.contentTab, url: hub.contentTab.url }, (r) => (hub.contentResponded = r));
      } catch (e) {
        hub.log.push(['content listener error', String(e && e.message)]);
      }
    }
  }

  async function routeToBg(msg, sender) {
    for (const cb of hub.bgListeners) {
      const res = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => {
          if (settled) return;
          settled = true;
          resolve(v);
        };
        const out = cb(msg, sender || { tab: hub.contentTab, url: hub.contentTab.url }, done);
        if (out === true) setTimeout(() => done(undefined), 8000); // async channel: wait for respond()
        else if (out && typeof out.then === 'function') out.then((v) => done(v === undefined ? undefined : v), () => done(undefined));
        else done(out);
      });
      if (res !== undefined) return res;
    }
    return undefined;
  }

  /* -------- background-side API (its runtime.sendMessage broadcasts to views) -------- */
  hub.apiBg = {
    ...shared,
    id: 'stream-radar-test',
    runtime: {
      id: 'stream-radar-test',
      getURL: (p) => 'chrome-extension://stream-radar-test/' + p,
      openOptionsPage: () => hub.tabs.created.push({ url: 'options' }),
      onMessage: { addListener: (cb) => hub.bgListeners.push(cb) },
      sendMessage: async (msg) => {
        if (msg && msg.type === 'state-global') hub.lastBroadcast = msg.payload;
        if (msg && msg.type === 'toast' && msg.tabId != null) deliverContent({ type: 'toast', text: msg.text, kind: msg.kind, action: msg.action });
        return undefined;
      },
    },
  };

  /* -------- content-side API (its runtime.sendMessage goes to background) -------- */
  hub.apiContent = {
    ...shared,
    runtime: {
      id: 'stream-radar-test',
      getURL: (p) => 'chrome-extension://stream-radar-test/' + p,
      onMessage: { addListener: (cb) => hub.contentListeners.push(cb) },
      sendMessage: (msg) => routeToBg(msg, { tab: hub.contentTab, url: hub.contentTab.url }),
    },
  };

  // sender defaults to the audified tab's content script; tests can pass a
  // different `sender` (e.g. the freshly opened watchparty.me tab) to exercise
  // per-tab payloads exactly like the browser would.
  hub.sendFromContent = (msg, sender) =>
    routeToBg(msg, sender || { tab: hub.contentTab, url: hub.contentTab.url });
  hub.fireWebRequest = (details) => {
    const d = Object.assign({ tabId: 1, type: 'xmlhttprequest', frameId: 0, statusCode: 200, fromCache: false, initiator: 'https://67movies.nl' }, details);
    hub.webRequest.listeners.forEach(({ cb }) => cb(d));
  };
  hub.header = (map) => Object.entries(map).map(([name, value]) => ({ name, value }));
  hub.fireAlarm = (name) => Promise.all(hub.alarms.handlers.map((cb) => cb({ name })));
  hub.fireContext = (info, tab) => Promise.all(hub.menusClicked.map((cb) => cb(info, tab || hub.contentTab)));
  hub.fireCommand = (name) => Promise.all(hub.commands.handlers.map((cb) => cb(name)));
  return hub;
}

/* ------------------------------------------------------------------ *
 * network stub that behaves like a 67movies-ish CDN + SubDL
 * ------------------------------------------------------------------ */
export const MASTER_M3U8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-KEY:METHOD=AES-128,URI="https://key.cdn.test/k/1?key=abc"
#EXT-X-ENDLIST
`;
export const SRT_TEXT = `1
00:00:01,000 --> 00:00:04,000
Halo, ini subtitle Indonesia

2
00:00:05,000 --> 00:00:08,000
Baris kedua
`;

export function makeNetStub(extra = {}) {
  const calls = [];
  const zip = buildZip('movie.id.srt', SRT_TEXT);
  const routes = {
    'master.m3u8': { body: MASTER_M3U8, type: 'application/vnd.apple.mpegurl' },
    '1080/index.m3u8': { body: MASTER_M3U8, type: 'application/vnd.apple.mpegurl' },
    '4242.zip': { buffer: zip, type: 'application/zip' },
    'live.json': { body: JSON.stringify(extra.rulesPack || {}), type: 'application/json' },
    ...extra,
  };
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push([u, (init && init.method) || 'GET']);
    for (const [needle, r] of Object.entries(routes)) {
      if (u.includes(needle)) {
        const buf = r.buffer ? Buffer.from(r.buffer) : Buffer.from(r.body == null ? '' : String(r.body), 'utf8');
        return {
          ok: true,
          status: 200,
          url: u,
          headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? r.type || 'text/plain' : null) },
          async text() {
            return r.buffer ? new TextDecoder().decode(buf) : String(r.body);
          },
          async json() {
            return r.json !== undefined ? r.json : JSON.parse(String(r.body || 'null'));
          },
          async arrayBuffer() {
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          },
        };
      }
    }
    if (u.includes('subdl.com/api/v1/subtitles/download')) {
      return { ok: true, status: 200, async json() { return { results: { attributes: { link: 'https://dl.subdl.com/get/4242.zip' } } }; } };
    }
    if (u.includes('subdl.com')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { results: [{ attributes: { id: 4242, name: 'Dune Part Two', filename: 'Dune.2024.id.srt', lang: { code: 'id', name: 'Indonesian' }, format: 'srt', year: '2024', downloadCount: 1500, verified: true } }] };
        },
      };
    }
    if (u.includes('v2.sg.media-imdb.com') || u.includes('cinemeta.strem.io')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ d: [], metas: [] });
        },
        async json() {
          return { d: [], metas: [] };
        },
      };
    }
    throw new Error('net stub: unexpected ' + u);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function buildZip(name, text) {
  const data = Buffer.from(text, 'utf8');
  const comp = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(8, 8);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(comp.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  const local = Buffer.concat([lfh, nameBuf, comp]);
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(8, 10);
  cdh.writeUInt32LE(crc, 16);
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
function crc32(buf) {
  if (!crc32.t) {
    crc32.t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.t[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crc32.t[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */
export async function bootExtension({ html = DEFAULT_PAGE, url = 'https://67movies.nl/watch/movie/1516698', net, settings, extraBgFiles = [], pageWorld = true, openShadow = true } = {}) {
  const { JSDOM } = await import('jsdom');
  const hub = makeHub();
  const fetchImpl = net || makeNetStub();

  // settings pre-seeded exactly like the options page would write them
  if (settings) hub.storage['srad:settings'] = settings;

  /* ---------- background in a vm context ---------- */
  const bgGlobal = {
    chrome: hub.apiBg,
    importScripts() {
      throw new Error('prelude must be inlined by the build');
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    fetch: (u, i) => fetchImpl(u, i),
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int32Array,
    Float64Array,
    ArrayBuffer,
    URL,
    URLSearchParams,
    Blob: globalThis.Blob,
    File: globalThis.File,
    stream: undefined,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    AbortController,
    AbortSignal,
    EventTarget,
    Event,
    MessageChannel,
    CustomEvent,
    crypto: globalThis.crypto,
    DecompressionStream: globalThis.DecompressionStream,
    Response: globalThis.Response,
    structuredClone,
  };
  const ctx = vm.createContext(bgGlobal);
  const files = [...PRELUDE, ...extraBgFiles, 'background.js'];
  const source = files.map((f) => `\n;${readSrc(f)}\n`).join('\n');
  vm.runInContext(source, ctx, { filename: 'background+prelude.js' });
  const SR = ctx.SR;
  if (!SR || !SR.MediaStore) throw new Error('background context did not expose SR');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(10); // let boot() resolve its storage reads

  /* ---------- content + page world in jsdom ---------- */
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(win) {
      win.chrome = hub.apiContent;
      win.browser = undefined;
      if (openShadow) win.__sradOpenShadow = true;
      win.fetch = (u, i) => fetchImpl(u, i);
      win.__sradFetch = fetchImpl;
      win.XMLHttpRequest = makeFakeXhr(win);
      win.URL.createObjectURL = () => 'blob:https://67movies.nl/' + Math.random().toString(36).slice(2);
      win.URL.revokeObjectURL = () => {};
      win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      if (pageWorld) {
        // inject.js refuses to run in an extension context (isolated world); this
        // flag is the same escape hatch the userscript build uses.
        win.__streamRadarForceMain = true;
        for (const f of ['shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'page/inject.js']) win.eval(readSrc(f));
      }
      for (const f of ['shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'shared/i18n.js', 'shared/dom-scanner.js', 'content/ui-styles.js', 'content/ui.js', 'content/content.js']) win.eval(readSrc(f));
    } });
  hub.contentWindow = dom.window;

  await wait(80); // document_start → handshake → scanners
  return { hub, dom, win: dom.window, SR, ctx, wait, fetchImpl };
}

function makeFakeXhr(win) {
  class FakeXHR {
    constructor() {
      this._l = [];
      this.status = 0;
    }
    open(method, url) {
      this.__url = url;
      this.__method = method;
    }
    setRequestHeader() {}
    getResponseHeader(n) {
      return { 'content-type': 'video/mp4', 'content-length': '2147483648' }[String(n).toLowerCase()] || null;
    }
    getAllResponseHeaders() {
      return 'content-type: video/mp4\r\ncontent-length: 2147483648\r\n';
    }
    addEventListener(t, cb) {
      this._l.push(cb);
    }
    send() {
      (win.__xhrCalls || (win.__xhrCalls = [])).push(this.__url);
      this.status = 200;
      this.responseURL = this.__url;
      this.responseText = '';
      const self = this;
      setTimeout(() => self._l.forEach((cb) => cb({ type: 'loadend' })), 0);
    }
  }
  return FakeXHR;
}

export const DEFAULT_PAGE = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<title>Nonton Dune: Part Two (2024) Subtitle Indonesia | 67movies.net, Watch Movies in HD Online</title>
<meta property="og:title" content="Nonton Dune: Part Two (2024) Sub Indo">
<meta property="og:image" content="https://image.tmdb.org/t/p/w500/poster.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Movie","name":"Dune: Part Two","datePublished":"2024-02-28","image":"https://image.tmdb.org/t/p/w500/poster.jpg","sameAs":["https://www.imdb.com/title/tt15239678/"]}</` + `script>
</head><body>
<h1>Nonton Dune: Part Two (2024) Subtitle Indonesia</h1>
<video id="player" controls poster="https://img/teaser.jpg"></video>
<iframe id="embed" src="https://vidlink.pro/movie/1516698?theme=light"></iframe>
</body></html>`;
