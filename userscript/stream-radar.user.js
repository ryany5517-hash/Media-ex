// ==UserScript==
// @name         Stream Radar — Ultra Media Detector + WatchParty + Subtitle Indonesia
// @namespace    https://github.com/ryany5517-hash/Media-ex
// @version      1.0.0
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
 *     src/shared/util.js
 *     src/shared/rules.js
 *     src/shared/title-cleaner.js
 *     src/shared/i18n.js
 *     src/shared/store.js
 *     src/shared/dom-scanner.js
 *     src/shared/subtitles.js
 *     src/shared/watchparty-auto.js
 *     src/shared/updater.js
 *     src/vendor/motion.min.js
 *     src/shared/icons.js
 *     src/content/ui-styles.js
 *     src/content/ui.js
 *     src/page/inject.js
 *     src/userscript/host.js
 *   regenerate with:  npm run userscript
 */

/* ═════════════════════════ src/shared/util.js ═════════════════════════ */
/**
 * Stream Radar — shared utilities
 * ------------------------------------------------------------------
 * This file is loaded in *three* different contexts and must therefore stay
 * context-agnostic:
 *   1. MAIN world of the page   (src/page/inject.js  — page hooks)
 *   2. ISOLATED world            (src/content/*.js   — DOM scan + UI)
 *   3. Service worker / popup / options (background.js, popup, options)
 *   4. Node (unit tests, userscript bundler)
 *
 * => no chrome.* / browser.* / DOM references here. Everything is exposed on
 *    the `SR` namespace object so that the other modules can piggy-back on it.
 */
(function (root) {
  'use strict';

  const SR = (root.SR = root.SR || {});
  SR.VERSION = '1.0.0';
  SR.NS = 'streamRadar'; // message channel id / storage prefix
  SR.PREFIX = 'srad'; // css class prefix

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  const util = (SR.util = {
    /** Feature-detect the browser-prefixed extension API. */
    api() {
      return root.browser && root.browser.runtime ? root.browser : root.chrome;
    },

    isExtensionContext() {
      try {
        return !!(
          (root.chrome && root.chrome.runtime && root.chrome.runtime.id) ||
          (root.browser && root.browser.runtime && root.browser.runtime.id)
        );
      } catch (_) {
        return false;
      }
    },

    uuid() {
      if (root.crypto && crypto.randomUUID) return crypto.randomUUID();
      return 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    },

    /** Fast, stable 32-bit hash (FNV-1a) used for de-duplication ids. */
    hash32(str) {
      let h = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(36);
    },

    safeJSON(text, fallback) {
      try {
        return JSON.parse(text);
      } catch (_) {
        return fallback === undefined ? null : fallback;
      }
    },

    /** JSON stringify that never throws on cycles / BigInt. */
    safeStringify(value, space) {
      const seen = new WeakSet();
      try {
        return JSON.stringify(
          value,
          function (k, v) {
            if (typeof v === 'object' && v !== null) {
              if (seen.has(v)) return '[Circular]';
              seen.add(v);
            }
            if (typeof v === 'bigint') return v.toString();
            return v;
          },
          space
        );
      } catch (_) {
        return 'null';
      }
    },

    clamp(n, min, max) {
      return n < min ? min : n > max ? max : n;
    },

    /** URLSearchParams wrapper that never throws on malformed urls. */
    query(url) {
      try {
        const u = new URL(url, 'http://invalid.');
        const out = {};
        for (const [k, v] of u.searchParams.entries()) out[k.toLowerCase()] = v;
        return out;
      } catch (_) {
        return {};
      }
    },

    /** Absolutise `rel` against `base`, returns '' when impossible. */
    abs(base, rel) {
      try {
        return new URL(rel, base).href;
      } catch (_) {
        return '';
      }
    },

    origin(url) {
      try {
        return new URL(url).origin;
      } catch (_) {
        return '';
      }
    },

    host(url) {
      try {
        return new URL(url).hostname.toLowerCase();
      } catch (_) {
        return String(url || '')
          .replace(/^[a-z]+:\/\//i, '')
          .split(/[/?#]/)[0]
          .toLowerCase();
      }
    },

    /** Registrable-ish domain: example.co.uk -> example.co.uk, a.b.c.com -> c.com */
    domain(url) {
      const h = util.host(url);
      if (!h || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
      const parts = h.split('.');
      if (parts.length <= 2) return h;
      const tldLen = /\.(co|com|net|org|gov|edu|ac|or)\.[a-z]{2}$/.test(parts.slice(-2).join('.')) ? 3 : 2;
      return parts.slice(-tldLen).join('.');
    },

    /** Directory part of a url path, used to bucket HLS/DASH segments. */
    dirOf(url) {
      try {
        const u = new URL(url);
        const p = u.pathname.split('/');
        p.pop();
        return u.origin + p.join('/');
      } catch (_) {
        return '';
      }
    },

    /**
     * De-dup key: origin + path (+ playlist index for m3u8) — query strings of
     * streaming urls are usually volatile tokens (expires/signature) and must
     * not create duplicates.
     */
    dedupKey(url, category) {
      try {
        const u = new URL(url);
        const path = u.pathname.replace(/\/index\.(m3u8|mpd)$/i, '.$1');
        return util.origin(url) + '|' + path + '|' + (category || '');
      } catch (_) {
        return String(url) + '|' + (category || '');
      }
    },

    formatBytes(bytes) {
      if (!bytes || !isFinite(bytes) || bytes <= 0) return '';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
      const v = bytes / Math.pow(1024, i);
      return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
    },

    formatBits(bps) {
      if (!bps || !isFinite(bps)) return '';
      const mbps = bps / 1_000_000;
      return (mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)) + ' Mb/s';
    },

    /** Human quality label for a vertical resolution. */
    qualityLabel(height) {
      const h = Number(height);
      if (!h || !isFinite(h)) return '';
      const named = {
        4320: '8K',
        2880: '5K',
        2160: '4K',
        1920: '1080p',
        1600: '1600p',
        1440: '1440p',
        1280: '720p',
        1080: '1080p',
        960: '960p',
        854: '480p',
        720: '720p',
        640: '360p',
        480: '480p',
        360: '360p',
        240: '240p',
      };
      if (named[h]) return named[h];
      const ladder = [4320, 2160, 1440, 1080, 720, 480, 360, 240];
      for (const l of ladder) if (h >= l) return (l === 4320 ? '8K' : l === 2160 ? '4K' : l + 'p');
      return h + 'p';
    },

    formatDuration(seconds) {
      const s = Math.max(0, Math.round(Number(seconds) || 0));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
    },

    timeAgo(ts) {
      if (!ts) return '';
      const d = Math.max(0, Date.now() - ts);
      if (d < 5e3) return 'just now';
      if (d < 6e4) return Math.floor(d / 1e3) + 's ago';
      if (d < 36e5) return Math.floor(d / 6e4) + 'm ago';
      if (d < 864e5) return Math.floor(d / 36e5) + 'h ago';
      return new Date(ts).toLocaleDateString();
    },

    throttle(fn, ms) {
      let last = 0,
        timer = null,
        lastArgs = null;
      const run = function () {
        timer = null;
        last = Date.now();
        fn.apply(null, lastArgs);
      };
      return function (...args) {
        lastArgs = args;
        const now = Date.now();
        if (now - last >= ms) {
          last = now;
          fn.apply(null, args);
        } else if (!timer) {
          timer = setTimeout(run, ms - (now - last));
        }
      };
    },

    debounce(fn, ms) {
      let timer = null;
      const wrapped = function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(null, args), ms);
      };
      wrapped.cancel = () => clearTimeout(timer);
      wrapped.flush = function (...args) {
        clearTimeout(timer);
        fn.apply(null, args);
      };
      return wrapped;
    },

    /** Compile "one pattern per line" text into a list of RegExp + globs. */
    compilePatterns(text) {
      const out = [];
      if (!text) return out;
      for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('/') && /\/[a-z]*$/.test(line) && line.length > 2) {
          const last = line.lastIndexOf('/');
          try {
            out.push({ re: new RegExp(line.slice(1, last), line.slice(last + 1) || 'i'), src: line });
            continue;
          } catch (_) {
            /* fall through to glob */
          }
        }
        // Host / glob pattern:  *.example.com  |  example.com/path  |  regex-free
        const escaped = line
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/([a-z0-9-]+)\.\*/gi, '$1.');
        try {
          out.push({ re: new RegExp('(' + escaped + ')', 'i'), src: line });
        } catch (_) {
          /* ignore broken user pattern */
        }
      }
      return out;
    },

    matchesAny(patterns, url) {
      if (!patterns || !patterns.length) return false;
      for (const p of patterns) {
        try {
          if (p.re.test(url)) return true;
        } catch (_) {}
      }
      return false;
    },

    /**
     * Truncated-text hash: cheap way to tell two manifests apart without
     * shipping megabytes over the message channel.
     */
    shortHash(text, len) {
      return util.hash32(String(text).slice(0, 65536)) + (len !== undefined ? ':' + len : '');
    },

    /** Split a list into chunks (used for batched UI rendering). */
    chunk(arr, size) {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    },

    /** Escape for innerHTML templates. */
    esc(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    /**
     * fetch() with timeout + byte cap. Used by the background worker for
     * manifest parsing and subtitle downloads.
     */
    /**
     * Overridable fetch (the userscript swaps in a GM_xmlhttpRequest shim so
     * cross-origin subtitle APIs work inside the sandbox).
     */
    fetchImpl(url, init) {
      const f = root.__sradFetch || (root.fetch && root.fetch.bind(root));
      if (!f) return Promise.reject(new Error('fetch unavailable'));
      return f(url, init);
    },

    async fetchText(url, opts) {
      const o = opts || {};
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), o.timeoutMs || 12000);
      try {
        const res = await util.fetchImpl(url, {
          signal: ctrl.signal,
          credentials: o.credentials || 'include',
          redirect: 'follow',
          headers: o.headers || undefined,
          method: o.method || 'GET',
          body: o.body,
        });
        if (!res.ok && res.status >= 400) throw new Error('HTTP ' + res.status + ' for ' + url);
        if (o.raw) return await res.arrayBuffer();
        const text = await res.text();
        return text.length > (o.maxBytes || 2_000_000) ? text.slice(0, o.maxBytes || 2_000_000) : text;
      } finally {
        clearTimeout(timer);
      }
    },

    async fetchBuffer(url, opts) {
      const o = opts || {};
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), o.timeoutMs || 20000);
      try {
        const res = await util.fetchImpl(url, {
          signal: ctrl.signal,
          credentials: 'include',
          headers: o.headers || undefined,
        });
        if (!res.ok && res.status >= 400) throw new Error('HTTP ' + res.status);
        return await res.arrayBuffer();
      } finally {
        clearTimeout(timer);
      }
    },
  });

  /* ------------------------------------------------------------------ *
   * Storage: settings with defaults, works in SW + content + popup.
   * Falls back to localStorage when no extension API exists (userscript /
   * unit tests).
   * ------------------------------------------------------------------ */
  const SETTINGS_KEY = 'srad:settings';

  SR.defaults = {
    enabled: true, // master switch
    layerNetwork: true, // layer 1 (+ background webRequest)
    layerDom: true, // layer 2
    layerMse: true, // layer 3
    layerSw: true, // layer 4
    layerHeuristic: true, // layer 5
    playerProbe: true, // extract urls from JWPlayer/Video.js/HLS.js/DASH.js
    scanScripts: true, // regex-scan inline scripts / document.write
    recordMse: false, // BETA: capture MSE buffer into a downloadable file
    recordCapMB: 256,
    autoSubtitle: true,
    notify: true,
    showAds: false, // hide VAST/pre-roll noise by default
    maxItems: 80,
    theme: 'system', // system | dark | light
    lang: 'auto', // auto | en | id
    fabPos: null, // {x,y} in vw/vh px, null = default bottom-right
    fabVisible: true,
    compactOnMobile: true,
    watchpartyAutoJoin: true,
    watchpartyName: '',
    providers: { subdl: true, opensubtitles: true, yify: true },
    subdlApiKey: '',
    osApiKey: '',
    osUserAgent: 'StreamRadar/1.0 (media detector extension)',
    subtitleLang: 'id',
    blockedHosts: {},
    allowPatterns: '',
    updateEnabled: true, // hot rule packs (data only, signed)
    updateUrl: 'https://raw.githubusercontent.com/ryany5517-hash/Media-ex/live/',
    updateCheckHours: 12,
    autoPatch: false, // opt-in: signed code patch for content-script fixes
    rulesVersion: 0,
    patchVersion: 0,
    lastUpdateCheck: 0,
    blockPatterns: '',
    debug: false,
  };

  SR.settings = {
    _cache: null,
    _listeners: [],

    async load(force) {
      if (this._cache && !force) return this._cache;
      const api = util.api();
      let stored = {};
      if (api && api.storage && api.storage.local) {
        try {
          stored = (await api.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
        } catch (_) {
          stored = {};
        }
      } else if (root.localStorage) {
        try {
          stored = util.safeJSON(localStorage.getItem(SR.NS + ':' + SETTINGS_KEY), {}) || {};
        } catch (_) {
          stored = {};
        }
      }
      this._cache = this.merge(stored);
      return this._cache;
    },

    merge(partial) {
      const out = Object.assign({}, SR.defaults);
      for (const k of Object.keys(partial || {})) {
        if (!(k in SR.defaults)) continue;
        const v = partial[k];
        if (k === 'providers' && v && typeof v === 'object') out.providers = Object.assign({}, SR.defaults.providers, v);
        else if (typeof SR.defaults[k] === typeof v || SR.defaults[k] === null) out[k] = v;
      }
      return out;
    },

    async save(patch) {
      const next = Object.assign({}, await this.load(), patch || {});
      this._cache = this.merge(next);
      const api = util.api();
      if (api && api.storage && api.storage.local) {
        await api.storage.local.set({ [SETTINGS_KEY]: this._cache });
      } else if (root.localStorage) {
        try {
          localStorage.setItem(SR.NS + ':' + SETTINGS_KEY, util.safeStringify(this._cache));
        } catch (_) {}
      }
      this._emit(this._cache);
      return this._cache;
    },

    onChange(cb) {
      this._listeners.push(cb);
    },
    _emit(s) {
      for (const cb of this._listeners) {
        try {
          cb(s);
        } catch (_) {}
      }
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

/* ═════════════════════════ src/shared/rules.js ═════════════════════════ */
/**
 * Stream Radar — media classification rules
 * ------------------------------------------------------------------
 * Pure data + pure functions (no DOM, no chrome.*): everything that decides
 * "is this URL a media stream, what kind, how heavy, is it an ad?" lives here
 * so that the page hooks, the content script, the background worker and the
 * unit tests all agree on one implementation.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;

  /* ---------------------------------------------------------------- *
   * 1. Extension / mime table
   * ---------------------------------------------------------------- */
  const EXT = {
    m3u8: 'hls',
    'm3u': 'hls',
    mov: 'hls', // rare .mov playlists on some CDNs — corrected by mime
    mpd: 'dash',
    mp4: 'mp4',
    m4v: 'mp4',
    mov_ext: 'mp4',
    webm: 'webm',
    mkv: 'webm',
    ogv: 'webm',
    m4s: 'segment',
    ts: 'segment',
    mp2t: 'segment',
    m2ts: 'segment',
    '444': 'segment',
    aac: 'segment',
    m4a: 'segment',
    mp3: 'segment',
    ac3: 'segment',
    eac3: 'segment',
    opus: 'segment',
    vtt: 'texttrack',
    srt: 'texttrack',
    ttml: 'texttrack',
    lrc: 'texttrack',
  };

  const MIME_CATEGORY = [
    [/application\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl)/i, 'hls'],
    [/application\/dash\+xml/i, 'dash'],
    [/application\/(?:mp2t|cue\+xml|xml)/i, 'dash'],
    [/video\/mp4|video\/m4v|video\/x-m4v|application\/mp4|video\/quicktime/i, 'mp4'],
    [/video\/webm|video\/x-webm|video\/x-matrosk/i, 'webm'],
    [/video\/(?:x-)?(?:mp2t|mpegts|mts|vnd\.davincimkv|divx|xvid)/i, 'segment'],
    [/video\/.*/i, 'other'],
    [/audio\/(?:mpegurl|aac|mp4a-latm|x-m4a|ac3|eac3|opus|ogg)/i, 'segment'],
  ];

  /** Extensions we treat as *segments*: noisy on their own, aggregated later. */
  const SEGMENT_EXT = ['m4s', 'ts', 'mp2t', 'm2ts', '444', 'aac', 'm4a', 'mp3', 'ac3', 'eac3', 'opus', 'wasm'];

  /**
   * Query-param names that carry a nested media URL. Embed providers
   * (vidlink/vidsrc/filemoon/111movies style) hide the real stream behind
   * such a param, so unwrapping them is what makes the detector "see"
   * through 3rd-party players.
   */
  const NESTED_KEYS = [
    'url', 'src', 'source', 'sources', 'file', 'files', 'play', 'player', 'video', 'videourl', 'media',
    'stream', 'playlist', 'manifest', 'm3u8', 'mpd', 'u', 's', 'f', 'v', 'link', 'href', 'data', 'q',
    'embed', 'id', 'auth', 'referer', 'to', 'target', 'redirect', 'cb', 'callback', 'json', 'p',
  ];

  /**
   * Rule packs (see src/shared/updater.js) can extend the static lists below at
   * runtime without shipping new code. Everything here is additive: a pack can
   * never *remove* a built-in rule, so a broken/old pack cannot blind us.
   */
  const dynamic = (SR.dynamic = {
    embedHosts: [],
    adHosts: [],
    mediaExt: new Set(),
    blocked: [],
    allow: [],
    loadedAt: 0,
    version: 0,
    signatureOk: null,
  });
  SR.dynamicLists = dynamic;

  function dynHas(list, needle) {
    if (!list || !list.length) return false;
    const n = String(needle || '').toLowerCase();
    if (!n) return false;
    return list.some((h) => n === h || n.endsWith('.' + h) || n.indexOf(h) >= 0);
  }

  /** Hosts that are almost never the movie the user wants (ads / trackers). */
  const AD_HOSTS = [
    'doubleclick.net', 'googlesyndication.com', 'googletagservices.com', 'adsafeprotected.com',
    'adnxs.com', 'amazon-adsystem.com', 'pubmatic.com', 'openx.net', 'criteo.com', 'taboola.com',
    'outbrain.com', 'moatads.com', 'scorecardresearch.com', 'adcolony.com', 'inmobi.com', 'rubiconproject.com',
    'casalemedia.com', 'yieldmo.com', 'smartadserver.com', 'admatix.io', 'omnitagjs.com', 'sharethrough.com',
    'sovrn.com', 'bidswitch.net', 'adscale.de', 'juicyads.com', 'exoclick.com', 'popads.net', 'propellerads.com',
    'google-analytics.com', 'googletagmanager.com', 'facebook.net', 'connect.facebook.net', 'analytics.tiktok.com',
    'sentry.io', 'browser-intake-datadoghq.com', 'newrelic.com', 'nr-data.net', 'hotjar.com', 'clarity.ms',
    'mparticle.com', 'segment.io', 'amplitude.com', 'mixpanel.com', 'chartbeat.com', 'quantserve.com',
  ];
  const AD_PATH_RE = /(\/|[-_.])(vast|vmap|adroll|preroll|midroll|postroll|ad-break|adbreak|bumper|ads?\/|ad-?server|advert)/i;

  /** Third-party hosts that are known embed players (used to rank + label). */
  const EMBED_HOSTS = [
    'vidlink.pro', 'vidsrc.to', 'vidsrc.me', 'vidsrc.xyz', 'vidsrc.cc', 'vidsrc-embed.ru', '111movies.com',
    'vidlove.org', 'vidlove.me', 'vidsuper.com', 'videasy.io', 'cinezo.com', 'vidup.me', 'vidup.io',
    'vsembed.ru', 'vidembed.cc', 'vidembed.net', 'filemoon.sx', 'filemoon.to', 'dl.filemoon', 'do0od.com',
    'dood.re', 'dood.sh', 'dood.watch', 'streamtape.com', 'streamhub.ink', 'mixdrop.co', 'mixdrop.ch',
    'upstream.to', 'uptobox.com', 'nbshare.co', 'sbplay.org', 'sbshare.tv', 'rapid-cloud.co', 'megacloud.blog',
    'megacloud.tv', 'vidstreaming.io', 'dosee.video', 'videovard.to', 'vks.video', 'api.soraembeds', 'smashystream',
    'vidsrc123.top', 'putlocker', 'flixier', 'vidproxy', 'autoembed.co', 'autoembed.ru', 'nobodywatch', '2embed',
    'vidsrc123', 'embedplayer', 'player-cdn', 'vidhide', 'vidhidepro', 'vidmo', 'kitsuplay', 'vidsource',
    'multiembed', 'nextembed', 'primecid', 'vidsrc.cc', 'whisperat', 'krakenfiles', 'streamsss', 'vidcore',
  ];

  /** Media-ish path markers used by the heuristic layers. */
  const MEDIA_PATH_RE =
    /\.(m3u8|mpd|mp4|webm|mkv|m4v|m4s|ts|mov|ogv|avi|flv|f4v|mpd|mp2t|m2ts|mpd)(\?|#|$)/i;

  const IGNORE_SCHEME = /^(data|javascript|about|chrome-extension|moz-extension|file):/i;

  /** URLs that are never interesting, no matter the extension. */
  const NOISE_RE =
    /(favicon|apple-touch-icon|\/icons?\/|\.svg($|\?)|\.png($|\?)|\.jpe?g($|\?)|\.webp($|\?)|\.gif($|\?)|\.css($|\?)|\.woff2?($|\?)|\.ttf($|\?)|\.ico($|\?)|googleads|gstatic|\/sdk\/|analytics|telemetry|hotjar|recaptcha|captcha|sentry|\/ping\b|beacon|beem\.io|adservice|pagead|googlesyndication|\/log\b|\/collect\b|\/gtm\.js|sockjs|webpack-hmr|hot-update|\.map($|\?))/i;

  /* ---------------------------------------------------------------- *
   * 2. Categorisation
   * ---------------------------------------------------------------- */
  function isMediaExt(ext) {
    if (!ext) return false;
    if (EXT[ext] || SEGMENT_EXT.indexOf(ext) >= 0) return true;
    return dynamic.mediaExt.has(String(ext).toLowerCase());
  }

  function extOf(url) {
    try {
      const p = new URL(url).pathname;
      const m = p.match(/\.([a-z0-9]{2,5})$/i);
      if (m) return m[1].toLowerCase();
    } catch (_) {
      const m = String(url).split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
      if (m) return m[1].toLowerCase();
    }
    return '';
  }

  function categoryFromExtension(ext) {
    if (!ext) return '';
    if (ext === 'mov') return 'mp4';
    return EXT[ext] || (SEGMENT_EXT.indexOf(ext) >= 0 ? 'segment' : '');
  }

  function categoryFromMime(mime) {
    if (!mime) return '';
    const m = String(mime).split(';')[0].trim().toLowerCase();
    if (!m || m === 'application/octet-stream' || m === 'binary/octet-stream') return '';
    for (const [re, cat] of MIME_CATEGORY) if (re.test(m)) return cat;
    return '';
  }

  function mimeLabel(mime) {
    if (!mime) return '';
    return String(mime).split(';')[0].trim().toLowerCase();
  }

  /**
   * @returns {null|{category,ext,mime,size,isSegment,isAd,isBlob,isTextTrack}}
   */
  function classify(url, opts) {
    const o = opts || {};
    if (!url || typeof url !== 'string') return null;
    const clean = url.trim();
    if (clean.length > 6000) return null;

    const isBlob = /^blob:/i.test(clean);
    if (IGNORE_SCHEME.test(clean) && !isBlob) return null;
    if (/^ws{2}s?:/i.test(clean)) return { category: 'websocket', ext: '', mime: '', isBlob: false };

    const host = util.host(clean);
    const ext = extOf(clean);
    let category = categoryFromExtension(ext);

    if (!category && o.mime) category = categoryFromMime(o.mime);
    if (!category && !isBlob && o.via === 'heuristic') return null; // heuristics must be extension-backed
    if (!category && NOISE_RE.test(clean)) return null;
    if (!category && isBlob) category = 'blob';

    let pathname = '';
    try {
      pathname = new URL(clean).pathname;
    } catch (_) {
      pathname = clean.split('?')[0];
    }
    const pathHit = MEDIA_PATH_RE.test(pathname) || (dynamic.mediaExt.size && new RegExp('\\.(' + [...dynamic.mediaExt].join('|') + ')(\\?|#|$)', 'i').test(pathname));
    if (!category || category === 'other') {
      // No extension and no helpful mime: accept only when the *path* looks like
      // a media file. A media-looking string inside ?query= belongs to the
      // wrapped URL, which unwrapUrl() reports separately (no double entry).
      if (!isBlob && !pathHit && !/video\//i.test(o.mime || '') && !o.force) return null;
      category = 'other';
    }

    // Explicitly configured content-type wins over a misleading extension.
    const mimeCat = categoryFromMime(o.mime);
    if (mimeCat && mimeCat !== 'other' && (category === 'other' || (mimeCat === 'hls' && category !== 'hls'))) {
      category = mimeCat;
    }

    if (NOISE_RE.test(clean) && category !== 'hls' && category !== 'dash' && !/video\//i.test(o.mime || '')) return null;

    const isSegment = category === 'segment' || SEGMENT_EXT.indexOf(ext) >= 0;
    const isAd = isAdUrl(clean, host);
    return {
      category,
      ext: ext || (isBlob ? 'blob' : ''),
      mime: mimeLabel(o.mime),
      size: Number(o.size) > 0 ? Number(o.size) : 0,
      isSegment,
      isAd,
      isBlob,
      isTextTrack: category === 'texttrack',
      isEmbed: EMBED_HOSTS.some((h) => host.indexOf(h) >= 0) || dynamic.embedHosts.indexOf(host) >= 0 || dynHas(dynamic.embedHosts, host),
    };
  }

  function isAdUrl(url, host) {
    host = host || util.host(url);
    if (!host) return false;
    if (AD_HOSTS.some((h) => host === h || host.endsWith('.' + h) || host.indexOf(h) >= 0)) return true;
    if (dynHas(dynamic.adHosts, host)) return true;
    return AD_PATH_RE.test(url);
  }

  /* ---------------------------------------------------------------- *
   * 3. Nested URL unwrapping (the trick that beats plain extension sniffing)
   * ---------------------------------------------------------------- */
  const BARE_MEDIA_RE = /https?:\/\/[^\s"'`)\\\]}<>"']{6,600}?\.(?:m3u8|mpd|mp4|webm|mkv|m4v|ts|m4s)(?:\?[^\s"'`)\\\]}<>"']{0,200})?/gi;
  const PROTO_LESS_RE = /(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s"'`<>)]{0,200}?\.(?:m3u8|mpd|mp4|webm)(?:\?[^\s"'`<>)]{0,120})?/gi;

  function b64decodeMaybe(s) {
    if (!s || s.length < 12 || s.length > 4000) return '';
    if (!/^[A-Za-z0-9+/_=-]+$/.test(s)) return '';
    try {
      const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
      const out = atob(s.replace(/[-_]/g, '+') + pad.replace(/=/g, ''));
      return /https?:\/\//i.test(out) || /\.(m3u8|mpd|mp4|webm)/i.test(out) ? decodeURIComponent(out) : '';
    } catch (_) {
      return '';
    }
  }

  /**
   * Pull media URLs out of an arbitrary blob of text (script source, JSON
   * payload, websocket frame, query-string value...).
   */
  function findUrlsInText(text, limit) {
    const out = [];
    if (!text || typeof text !== 'string') return out;
    const src = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
    const max = limit || 20;
    let m;
    BARE_MEDIA_RE.lastIndex = 0;
    while ((m = BARE_MEDIA_RE.exec(src)) && out.length < max) {
      const u = m[0].replace(/[\\'"]+$/, '');
      if (out.indexOf(u) < 0) out.push(u);
    }
    if (out.length < max) {
      PROTO_LESS_RE.lastIndex = 0;
      while ((m = PROTO_LESS_RE.exec(src)) && out.length < max) {
        const u = m[0].replace(/[\\'"]+$/, '');
        if (!/^https?:/i.test(u)) {
          const full = 'https://' + u;
          if (out.indexOf(full) < 0) out.push(full);
        }
      }
    }
    return out;
  }

  /**
   * Unwrap a request/iframe URL into candidate media URLs:
   *  - query params whose value contains an extension
   *  - double-encoded URLs (%3A%2F%2F)
   *  - base64 params
   *  - path suffix after `/proxy/https://host/file.m3u8`
   */
  function unwrapUrl(url) {
    const found = new Set();
    const isMediaUrl = (u) => /\.(m3u8|mpd|mp4|webm|mkv|m4v|ts|m4s)(\?|#|$)/i.test(String(u));
    const push = (u) => {
      if (!u) return;
      let cand = String(u).trim();
      if (!cand) return;
      if (/^\/\//.test(cand)) cand = 'https:' + cand;
      if (!/^https?:\/\//i.test(cand)) return;
      found.add(cand);
    };

    // The wrapper itself is only interesting if it *is* the media file; callers
    // already report the raw url through classify().
    try {
      if (isMediaUrl(url)) push(url);
    } catch (_) {}

    const q = util.query(url);
    for (const key of Object.keys(q)) {
      const val = q[key];
      if (!val || val.length > 3000) continue;
      if (/\.(m3u8|mpd|mp4|webm|mkv|m4v|ts|m4s)(\?|#|$)/i.test(val)) push(val);
      else if (/%3a%2f%2f|%2f|%3a/i.test(val)) {
        try {
          const dec = decodeURIComponent(val);
          if (/\.(m3u8|mpd|mp4|webm|mkv|ts|m4s)(\?|#|$)/i.test(dec)) push(dec);
          else for (const u of findUrlsInText(dec, 5)) push(u);
        } catch (_) {}
      } else if (NESTED_KEYS.indexOf(key) >= 0) {
        for (const u of findUrlsInText(val, 4)) push(u);
        const b = b64decodeMaybe(val);
        if (b) {
          if (/\.(m3u8|mpd|mp4|webm)(\?|#|$)/i.test(b)) push(b);
          else for (const u of findUrlsInText(b, 4)) push(u);
        }
      }
    }

    // /proxy/https://host/x.m3u8   |   /forward/https://...m3u8
    const tail = String(url).match(/https?:\/\/[^\s"'?#]+$/i);
    if (tail && tail[0] !== url) for (const u of findUrlsInText(tail[0], 2)) push(u);

    return [...found].filter(isMediaUrl);
  }

  /* ---------------------------------------------------------------- *
   * 4. Playlist / manifest parsing (HLS master + DASH MPD)
   * ---------------------------------------------------------------- */
  const manifest = (SR.manifest = {
    /**
     * Parse an HLS master playlist text into variants + security info.
     * Also accepts a *media* playlist (no EXT-X-STREAM-INF) and reports it as
     * a single implicit variant.
     */
    parseM3u8(text, baseUrl) {
      const out = {
        kind: 'unknown',
        variants: [],
        drm: null,
        aesKeyUrl: null,
        isLive: false,
        durationSec: 0,
        segmentCount: 0,
        codecs: '',
      };
      if (!text || typeof text !== 'string') return out;
      const body = text.slice(0, 1_500_000);
      if (!/#EXTM3U/.test(body)) return out;
      const lines = body.split(/\r?\n/);
      let pending = null;
      let totalDur = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (/^#EXT-X-STREAM-INF:/i.test(line)) {
          const attr = line.slice(line.indexOf(':') + 1);
          const res = (attr.match(/\bRESOLUTION=(\d{2,5})x(\d{2,5})/i) || []);
          pending = {
            bandwidth: numAttr(attr, 'BANDWIDTH') || numAttr(attr, 'AVERAGE-BANDWIDTH') || 0,
            height: res[2] ? parseInt(res[2], 10) : 0,
            width: res[1] ? parseInt(res[1], 10) : 0,
            codecs: strAttr(attr, 'CODECS'),
            name: strAttr(attr, 'NAME'),
            videoRange: strAttr(attr, 'VIDEO-RANGE'),
            frameRate: numAttr(attr, 'FRAME-RATE'),
          };
          out.kind = 'master';
          continue;
        }
        if (/^#EXT-X-MEDIA:/i.test(line)) {
          const g = strAttr(line, 'GROUP-ID');
          if (g && !out.variantGroups) out.variantGroups = new Set();
          if (g) out.variantGroups.add(g);
          continue;
        }
        if (/^#EXT-X-KEY:/i.test(line)) {
          const method = strAttr(line, 'METHOD') || 'NONE';
          if (/SAMPLE-AES/i.test(method)) out.drm = out.drm || 'SAMPLE-AES (encrypted / DRM-adjacent)';
          else if (method.toUpperCase() === 'AES-128') out.aesKeyUrl = out.aesKeyUrl || strAttr(line, 'URI');
          continue;
        }
        if (/^#EXT-X-SESSION-KEY/i.test(line)) out.drm = out.drm || 'SESSION-KEY (likely DRM)';
        if (/^#EXT-X-ENDLIST/i.test(line)) out.isLive = false;
        if (/^#EXT-X-PROGRAM-DATE-TIME/i.test(line) || /^#EXT-X-MEDIA-SEQUENCE/i.test(line)) out.isLive = true;
        if (/^#EXTINF:/i.test(line)) {
          out.segmentCount++;
          out.kind = out.kind === 'master' ? out.kind : 'media';
          const d = parseFloat(line.slice(line.indexOf(':') + 1));
          if (isFinite(d)) totalDur += d;
          continue;
        }
        if (line.startsWith('#')) continue;
        // URI line
        const uri = line;
        if (pending) {
          pending.uri = util.abs(baseUrl || '', uri);
          out.variants.push(pending);
          pending = null;
        }
      }
      out.durationSec = Math.round(totalDur);
      if (out.kind === 'media') {
        out.variants.push({
          uri: baseUrl || '',
          bandwidth: 0,
          height: 0,
          width: 0,
          codecs: out.codecs,
          name: 'media playlist',
        });
        out.segmentCount = out.segmentCount;
      }
      out.variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      const withH = out.variants.filter((v) => v.height);
      if (withH.length) out.bestHeight = withH[0].height;
      const codecHit = body.match(/CODECS="([^"]+)"/i);
      if (codecHit) out.codecs = codecHit[1];
      if (/#EXT-X-KEY:METHOD=NONE\s*$/.test(body) === false && out.aesKeyUrl) out.encrypt = 'AES-128';
      return out;

      function numAttr(attr, key) {
        const m = attr.match(new RegExp('\\b' + key + '=([0-9][0-9.]*)', 'i'));
        return m ? parseFloat(m[1]) || 0 : 0;
      }
      function strAttr(attr, key) {
        const m = attr.match(new RegExp('\\b' + key + '=(?:"([^"]*)"|([^",\\s]+))', 'i'));
        return m ? (m[1] || m[2] || '') : '';
      }
    },

    /**
     * Very small DASH MPD reader: collects Representation resolutions and the
     * adaptation sets, plus DRM signalling (ContentProtection).
     */
    parseMpd(text, baseUrl) {
      const out = { kind: 'dash', variants: [], drm: null, durationSec: 0, isLive: false };
      if (!text || typeof text !== 'string' || !/<MPD[\s>]/i.test(text)) return out;
      const body = text.slice(0, 1_500_000);
      const type = (body.match(/type\s*=\s*"(dynamic|static)"/i) || [])[1];
      out.isLive = type === 'dynamic';
      const dur = body.match(/mediaPresentationDuration\s*=\s*"PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/i);
      if (dur) out.durationSec = (+dur[1] || 0) * 3600 + (+dur[2] || 0) * 60 + Math.round(+dur[3] || 0);
      const cpTags = body.match(/<ContentProtection[\s\S]{0,400}?\/>/gi) || body.match(/<ContentProtection[^>]*>/gi) || [];
      if (cpTags.length) {
        const hay = cpTags.join(' ');
        out.drm = /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|widevine/i.test(hay)
          ? 'Widevine'
          : /1077efecc0b24d02ace33c1e52e2fb4b|playready/i.test(hay)
          ? 'PlayReady'
          : /9a04f07998404286ab92e65be0885f95|fairplay/i.test(hay)
          ? 'FairPlay'
          : 'DRM (system ID ' + ((hay.match(/schemeIdUri="[^"]*urn:uuid:([0-9a-f-]+)/i) || [])[1] || 'unknown').slice(0, 24) + ')';
      }
      const repRe = /<Representation\b[^>]*>/gi;
      let m;
      let base = '';
      const baseHit = body.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i);
      if (baseHit) base = util.abs(baseUrl || '', baseHit[1].trim());
      while ((m = repRe.exec(body))) {
        const tag = m[0];
        const width = +(tag.match(/\bwidth="(\d+)"/) || [])[1] || 0;
        const height = +(tag.match(/\bheight="(\d+)"/) || [])[1] || 0;
        const bw = +(tag.match(/\bbandwidth="(\d+)"/) || [])[1] || 0;
        const codecs = (tag.match(/codecs="([^"]+)"/) || [])[1] || '';
        const id = (tag.match(/\bid="([^"]+)"/) || [])[1] || '';
        if (!height && !bw) continue;
        out.variants.push({ uri: base, width, height, bandwidth: bw, codecs, id, mimeType: (tag.match(/mimeType="([^"]+)"/) || [])[1] || '' });
      }
      out.variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      if (out.variants[0]) out.bestHeight = out.variants[0].height;
      return out;
    },

    /** Quick header sniff used before we have the full body. */
    looksLikeM3u8Body(text) {
      return typeof text === 'string' && /^#EXTM3U/.test(text.trimStart());
    },
    looksLikeMpdBody(text) {
      return typeof text === 'string' && /<MPD[\s>]/i.test(text.slice(0, 4000));
    },
  });

  /* ---------------------------------------------------------------- *
   * 5. Quality hints straight from a URL string
   * ---------------------------------------------------------------- */
  function qualityFromUrl(url) {
    const u = String(url || '');
    let m = u.match(/(2160|1440|1080|720|480|360|240)[pP]?(?![0-9])/);
    if (!m) m = u.match(/[x*_](2160|1440|1080|720|480|360|240)(?![0-9])/);
    let q = m ? util.qualityLabel(m[1]) : '';
    if (/4k|uhd|2160/i.test(u) && !q) q = '4K';
    if (/hdr10\+|hdr/i.test(u)) q = (q ? q + ' ' : '') + 'HDR';
    return q;
  }

  function codecHint(url, mime) {
    const hay = String(url) + ' ' + (mime || '');
    if (/hvc1|hev1|hevc|x265|hdr/i.test(hay)) return 'HEVC';
    if (/av01|av1/i.test(hay)) return 'AV1';
    if (/avc1|x264|avc/i.test(hay)) return 'AVC';
    if (/vp9/i.test(hay)) return 'VP9';
    if (/vp0?8|opus/i.test(hay)) return 'VP8/Opus';
    return '';
  }

  /**
   * Human label for a media entry category, used in chips/badges.
   */
  const CATEGORY_LABEL = {
    mp4: 'MP4',
    webm: 'WEBM',
    hls: 'HLS',
    dash: 'DASH',
    segment: 'SEGMENTS',
    blob: 'BLOB/MSE',
    other: 'VIDEO',
    websocket: 'WS',
    texttrack: 'SUBTITLE',
  };

  /** Sort weight: most useful first. */
  const CATEGORY_WEIGHT = { mp4: 100, hls: 95, dash: 90, webm: 85, other: 70, blob: 60, segment: 30, texttrack: 20, websocket: 10 };

  SR.rules = {
    EXT,
    SEGMENT_EXT,
    EMBED_HOSTS,
    AD_HOSTS,
    AD_PATH_RE,
    MEDIA_PATH_RE,
    NOISE_RE,
    NESTED_KEYS,
    CATEGORY_LABEL,
    CATEGORY_WEIGHT,
    extOf,
    classify,
    categoryFromMime,
    categoryFromExtension,
    isAdUrl,
    findUrlsInText,
    unwrapUrl,
    qualityFromUrl,
    codecHint,
    BARE_MEDIA_RE,
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

/* ═════════════════════════ src/shared/title-cleaner.js ═════════════════════════ */
/**
 * Stream Radar — smart title extraction & deep cleansing
 * ------------------------------------------------------------------
 * Goal: turn SEO-spam page titles such as
 *   "Nonton The Last Sunrise (2024) Subtitle Indonesia | Layarkaca21"
 *   "Dune: Part Two (2024) 1080p WEBRip x265 - LookMovie"
 * into
 *   { title: "The Last Sunrise", year: "2024", episode: null }
 *
 * Priority order (see `SR.title.collect`):
 *   1. schema.org JSON-LD (Movie / TVEpisode / VideoObject)
 *   2. Open Graph meta
 *   3. Twitter Card meta
 *   4. first <h1>
 *   5. document.title
 * The first source that yields a confident, clean result wins; weaker sources
 * are kept as fallbacks and as a cross-check for the search query.
 *
 * `clean()` is pure (no DOM) so it is unit-testable in Node.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});

  /* ---- vocabulary -------------------------------------------------- */

  /** Multi-word junk phrases — removed before single tokens. */
  const PHRASES = [
    'nonton film', 'nonton movie', 'nonton gratis', 'nonton online', 'nonton bioskop', 'nobar film',
    'tonton filem', 'watch movie', 'watch films', 'watch full', 'watch online', 'full movie',
    'full movie gratis', 'full film', 'movies online', 'film gratis', 'film penuh', 'film action',
    'subtitle indonesia', 'subtitle indonesian', 'subtitle inggris', 'subtitle english', 'subtitle msia',
    'sub indonesia', 'sub indo', 'sub inggris', 'subtitle', 'sub indo', 'sub id', 'sub forced',
    'dual subtitle', 'dual audio', 'multi subtitle', 'takarasi', 'terjemahan', 'translate Indonesia',
    'kualitas tinggi', 'high quality', 'quality hd', 'quality cam', 'best quality', 'skip intro',
    'server 1', 'server 2', 'server backup', 'primary server', 'alternate server', 'main server',
    'release year', 'tahun rilis', 'tanggal rilis', 'durasi film', 'rating imdb', 'genre film',
    'pemain film', 'sutradara', 'directed by', 'starring', 'original title', 'also known as',
    'cinema eb1', 'cinema eb1', 'bioskop online', 'bioskop kekinian', 'jadwal bioskop', 'jam tayang',
    'recently updated', 'trending', 'trending movies', 'popular movies', 'terbaru', 'terpopuler',
    'free download', 'download movie', 'unduh film', 'download link', 'link download', 'gdrive',
    'watch now', 'now streaming', 'streaming online', 'streaming gratis', 'live streaming',
    'episod', 'episode', 'season', 'musim', 'series', 'mini series', 'tv series', 'drama Korea',
    'movie streaming', 'film streaming', 'layar lebar', 'layar kaca', 'nonton di', 'tonton online',
    'please try another server', 'finding the best source', 'best sync', 'ads free', 'alternative',
    'watch movies', 'watch movie', 'watch films online', 'tv shows', 'movies & tv shows', 'movies and tv shows',
    'hd online', 'in hd online', 'in hd', 'online hd', 'nonton film gratis', 'kualitas', 'kualitas film',
    '3d', '4k', '8k', 'uhd', 'dolby vision', 'dolby atmos', 'imax enhanced', 'remux',
  ];

  /** Single junk tokens. Deliberately excludes real title words. */
  const TOKENS = [
    'nonton', 'nonton21', 'nobar', 'streaming', 'streamhd', 'stream', 'gratis', 'kuy', 'rebase',
    'lk21', 'lk21indo', 'layarkaca21', 'layarkaca21online', 'layarkaca', 'ksater21', 'indoxxi',
    'idebeg', 'idlix', 'idxlink', 'indostream', 'indofilm', 'indomoviex', 'indoplkay', 'sinemaku',
    'sinema21', 'bioskopkeren', 'bioskopkerening', 'rebahin', 'samegame', 'kinoxx', 'kinohit',
    'drakula', 'drakor', 'kubikama', 'dutasinema', 'cinemaindo', 'minisub', 'desamovie', 'ngelag',
    'mexirivip', 'mexogo', 'opeha', 'wintrik', 'wintrick', 'movies7', 'fmovies', '123movies',
    '123miweb', 'lookmovie', 'gomun', 'xemphim', 'otakudesu', 'anisya', 'samehadaku', 'oploverz',
    'kuronime', 'megabox', 'megadonwload', 'm4ufree', 'flicky', 'cinovela', 'yts', 'yifysubtitles',
    'imdb', 'rottentomatoes', 'rottentomatoes', 'tomatoes', 'trakt', 'letterboxd', 'tmdb',
    'download', 'unduh', 'downlod', 'torrent', 'magnet', 'hdtv', 'webrip', 'web-dl', 'webdl',
    'bluray', 'blu-ray', 'bdrip', 'dvdrip', 'dvdscr', 'brrip', 'hdcam', 'hdrip', 'camrip',
    'tsrip', 'telesync', 'telesync', 'screener', 'dvdcam', 'vhsrip', 'hdts', 'ts', 'tc', 'cam',
    'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'aac', 'ac3', 'eac3', 'dts', 'dd5', 'ddp5',
    '10bit', '8bit', '10-bit', '12bit', 'hdr', 'hdr10', 'hdr10+', 'sdr', 'ntsc', 'pal',
    'dual', 'audio', 'eng', 'engsub', 'sub', 'subed', 'subs', 'subtitle', 'terjemahan',
    'episode', 'season', 'episod', 'part', 'bagian', 'chapter', 'full', 'movie', 'movies',
    'film', 'films', 'serial', 'series', 'tv', 'online', 'watch', 'free', 'new', 'latest',
    'unlimited', 'adfree', 'ads', 'ad', 'skip', 'intro', 'server', 'backup', 'vip', 'premium',
    'sigrip', 'usdx', 'ptclay', 'sctv', 'indosiar', 'trans7', 'transfilm', 'globaltv', 'rvii',
    'vidio', 'wevi', 'wetv', 'iqlimax', 'wetv', 'youku', 'bilibili', 'viki', 'viu', 'iflix',
    'netflix', 'disney', 'hotstar', 'hbo', 'amazon', 'prime', 'appletv', 'crunchyroll',
    'hd', 'uhd', 'fhd', 'qhd', 'sd', 'hq', 'lq', 'xxx', 'x-x', 'mp4', 'mkv', 'avi', 'flv',
    'gdrive', 'googledrive', 'drive', 'link', 'mirror', 'host', 'upload', 'mixdrop', 'upstream',
    'shows', 'show', 'katalog', 'katalogfilm', 'semua', 'filmfilm', 'lk21online', 'lk21movies', 'xemtrim',
    'phimle', 'phimbo', 'vigetool', 'hot', 'newest', 'trailer', 'official', 'teaser', 'remaster', 'uncut',
    'dood', 'streamtape', 'filemoon', 'autoembed', 'vidlink', 'vidsrc', 'vidplay', 'vidstream',
  ];

  const TLD_RE =
    /\.(com|net|org|online|site|xyz|cyou|icu|top|vip|fun|shop|store|buzz|live|tv|movie|film|watch|cloud|rest|wiki|link|life|world|pro|app|dev|io|co|me|id|my|sg|ph|in|uk|us|ca|au|nz|de|fr|es|it|nl|ru|br|mx|za|jp|kr|cn|hk|tw|th|vn|cc|ws|to|gg|ac|page|link|click|bid|date|download|stream|date|play|plus|one|space|website|tech|info|biz|club|zone|run|fyi|media|digital|network|site)$/i;

  /** Page titles that mean "the SPA has not rendered yet" / block pages. */
  const JUNK_EXACT = [
    'just a moment', 'attention required', 'checking your browser', 'please wait', 'loading', 'redirecting',
    'access denied', 'error', '404', '403', '500', 'not found', 'enable javascript', 'security verification',
    'polaris', 'cloudflare', 'verify you are human', 'one more step', 'unusual traffic',
  ];

  /** Words that are never a standalone movie title — used to flag junk. */
  const GENERIC_WORDS = new Set([
    'online', 'hd', '4k', 'full', 'movie', 'movies', 'film', 'films', 'watch', 'nonton', 'stream',
    'streaming', 'player', 'video', 'show', 'shows', 'tv', 'free', 'gratis', 'new', 'latest', 'home',
    'search', 'catalog', 'katalog', 'episode', 'season', 'series', 'download', 'subtitle', 'sub',
    'indo', 'indonesia', 'trailer', 'official', 'page', 'error', 'untitled', 'loading', 'player',
    'server', 'source', 'media', 'embed', 'live', 'now', 'today', 'popular', 'trending', 'semua',
    'in', 'the', 'a', 'an', 'of', 'and', 'to', 'for', 'on', 'at', 'with', 'part', 'ep', 'eps',
  ]);

  const YEAR_RE = /(?:\(|\[|\s)((?:19|20)\d{2})(?:\)|\]|\s|$)/;
  const EP_RE = /\b(?:s|season[\s._-]*|musim[\s._-]*)(\d{1,2})[\s._-]*(?:e|episod[ei]?\d*[\s._-]*|ep[\s._-]*|)(\d{1,3})\b/i;
  const EP_ALT_RE = /\b(\d{1,2})\s?[xX]\s?(\d{1,2})\b/;
  const EP_LOOSE_RE = /\b(?:episode|episod|ep|chapter|part|bagian)\.?\s*(?:no\.?\s*)?(\d{1,3})\b/i;

  /** Remove dangling separators / articles left behind by token stripping. */
  function fixTail(text) {
    let out = normalize(text);
    for (let i = 0; i < 4; i++) {
      const before = out;
      out = out
        .replace(/\s*[:\-–—|·]\s*$/, '')
        .replace(/\s+\b(the|a|an|of|and|to|in|on|for|with|part|no|n[o°])\s*$/i, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .trim();
      if (out === before) break;
    }
    return out;
  }

  /* ---- cleansing pipeline ------------------------------------------ */

  function normalize(input) {
    let raw = String(input == null ? '' : input);
    // Scene release names use dots as separators: "Inception.2010.720p.BluRay.x264-YTS"
    if (/\.(?:20\d{2}|19\d{2})\.|\.(?:720|1080|2160|480)\s?p?\.|\.(?:BluRay|WEBRip|WEB-DL|x26[45]|HEVC|AAC|DVDRip|HDRip)[.\-]/i.test(raw)) {
      raw = raw.replace(/[-_.]+/g, ' ');
    }
    return raw
      .replace(/\u00a0|\u2007|\u202f/g, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;|&#0?34;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&nbsp;/gi, ' ')
      .replace(/[\u2192\u21d2\u00bb\u203a]/g, '>')
      .replace(/[\u2013\u2014\u2015\u2500\u2502\u2551]/g, '-')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Remove leading bullets / emoji / zero-width chars. */
  function trimLead(seg) {
    return String(seg)
      .replace(/^[\s\-–—•·*•‣»|/\\>]+/, '')
      .replace(/[\s\-–—•·‣|/\\>]+$/, '')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .trim();
  }

  function splitSegments(raw) {
    const norm = normalize(raw);
    // Split on separators, but keep " - " only when it is surrounded by spaces
    // (so that "Dredd - Judge" style titles survive better) and keep ":" when
    // it looks like a subtitle separator ("Alien: Romulus").
    const parts = norm.split(/\s*[|»•·]|\s+\/\s+|\s+~\s+|\s+-\s+/);
    const out = [];
    for (let p of parts) {
      p = trimLead(p);
      if (p) out.push(p);
    }
    if (!out.length && norm) out.push(norm);
    return out;
  }

  function extras() {
    const d = (SR.dynamic || {}) && SR.dynamic;
    return d ? { phrases: d.junkPhrases || [], tokens: d.junkTokens || [] } : { phrases: [], tokens: [] };
  }

  function stripPhrases(text) {
    const ex = extras();
    let out = ' ' + normalize(text) + ' ';
    for (const p of PHRASES.concat(ex.phrases)) {
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      out = out.replace(new RegExp('\\b' + esc + '\\b', 'gi'), ' ');
    }
    // patterns
    out = out
      .replace(/\b\d{3,4}\s?[pP](?![0-9a-zA-Z])/g, ' ')
      .replace(/\b\d{3,4}\s?[xX*]\s?\d{3,4}\b/g, ' ')
      .replace(/\[[^\]\n]{1,40}\]/g, ' ')
      .replace(/\((?:HD|CAM|TS|TC|DVDSCR|WEBRIP|WEB-DL|BLURAY|REPACK|PROPER|LIMITED|EXTENDED|UNRATED)\)/gi, ' ')
      .replace(/\b\d{1,3}\s?(?:MB|GB)\b/gi, ' ')
      .replace(/\b\d{1,3}\s?fps\b/gi, ' ')
      .replace(/(?:^|\s)(?:\d{1,3}%|IMDb|IMDB|Rating|Rotten)\b[:\s]?\d?[\d.]*\s?(?:\/\s?10)?/gi, ' ')
      .replace(/\b\d+(?:\.\d+)?\s?(?:fps|kbps|mbps|mbit)\b/gi, ' ')
      .replace(/[«»‹›]/g, ' ');
    return out.replace(/\s+/g, ' ').trim();
  }

  function stripTokens(text) {
    const words = normalize(text).split(' ');
    const keep = [];
    const set = new Set(TOKENS.concat(extras().tokens).map((t) => String(t).toLowerCase()));
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const bare = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      const low = bare.toLowerCase();
      if (!bare) continue;
      if (set.has(low)) {
        // keep a lone "part" when it forms "Part Two" (real sequel marker)
        if (low === 'part' && /^(one|two|three|four|v|vi|[0-9]+)$/i.test(words[i + 1] || '')) {
          keep.push(w, words[++i]);
        }
        continue;
      }
      if (TLD_RE.test(low) && low.split('.').length <= 3) continue; // bare domain token
      if (/^(19|20)\d{2}$/.test(bare)) continue;
      keep.push(w);
    }
    return keep.join(' ').replace(/\s+/g, ' ').trim();
  }

  function scoreSegment(seg) {
    const s = seg.trim();
    if (!s) return -1e9;
    let score = 0;
    const letters = (s.match(/\p{L}/gu) || []).length;
    const words = s.split(/\s+/).filter(Boolean);
    score += Math.min(40, letters); // length reward, capped
    score += Math.min(12, words.length * 3); // multi-word reward
    if (letters / Math.max(1, s.length) < 0.55) score -= 25; // too many symbols
    if (/\.(com|net|org|online|xyz|site|cyou|top|tv|watch|live|fun|vip|icu|cloud|movie|film)\b/i.test(s)) score -= 40;
    if (/(nonton|sub indo|subtitle|streaming|download|hd\b|4k\b|1080p|720p)/i.test(s)) score -= 18;
    if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) score -= 45; // pure domain segment
    if (/^[^a-z]*$/i.test(s)) score -= 30; // no letters at all
    if (s.length > 90) score -= 10;
    if (/^(watch|nonton|stream|download|film|movie)\b/i.test(s)) score -= 6;
    if (/\b(19|20)\d{2}\b/.test(s)) score += 4; // year present => usually the real title
    return score;
  }

  function extractMeta(text) {
    const src = normalize(text);
    const info = { year: null, season: null, episode: null };
    const y = src.match(YEAR_RE);
    if (y) info.year = y[1];
    let m = src.match(EP_RE);
    if (m) {
      info.season = String(parseInt(m[1], 10)).padStart(2, '0');
      info.episode = String(parseInt(m[2], 10)).padStart(2, '0');
    } else if ((m = src.match(EP_ALT_RE))) {
      info.season = String(parseInt(m[1], 10)).padStart(2, '0');
      info.episode = String(parseInt(m[2], 10)).padStart(2, '0');
    } else if ((m = src.match(EP_LOOSE_RE))) {
      info.episode = String(parseInt(m[1], 10)).padStart(2, '0');
    }
    return info;
  }

  function stripMeta(text, info) {
    let out = ' ' + normalize(text) + ' ';
    if (info.year) out = out.replace(new RegExp('[(\\[\\s]' + info.year + '[\\])]'), ' ');
    out = out
      .replace(new RegExp('\\bs\\d{1,2}\\s?[eE]\\d{1,3}\\b', 'gi'), ' ')
      .replace(new RegExp('\\b\\d{1,2}\\s?[xX]\\s?\\d{1,2}\\b', 'g'), ' ')
      .replace(/\b(season|musim)\.?\s*\d{1,2}\b/gi, ' ')
      .replace(/\b(episode|episod|ep)\.?\s*\d{1,3}\b/gi, ' ');
    return out.replace(/\s+/g, ' ').trim();
  }

  function looksLikeSiteName(seg) {
    const s = seg.trim();
    if (/^(www\.)?[a-z0-9][a-z0-9-]*([.][a-z0-9-]+)+$/i.test(s)) return true;
    return TLD_RE.test(s.replace(/\s+/g, '')) && s.split(/\s+/).length === 1;
  }

  /**
   * Main entry.
   * @param {string} raw any candidate string (document.title, og:title, h1 …)
   * @param {{extra?:string}} [opts] extra context (canonical slug, meta desc)
   */
  function clean(raw, opts) {
    const o = opts || {};
    const original = normalize(raw);
    const meta = extractMeta(original || o.extra || '');
    const out = {
      raw: original,
      title: '',
      year: meta.year,
      season: meta.season,
      episode: meta.episode,
      kind: 'unknown',
      quality: '',
      isJunk: true,
      confidence: 0,
      source: o.source || 'title',
    };
    if (!original) return out;

    if (JUNK_EXACT.some((j) => original.toLowerCase().startsWith(j))) {
      out.title = '';
      return out;
    }

    out.quality = (original.match(/\b(2160p|1080p|720p|480p|4k|uhd|hd)\b/i) || [])[1] || '';

    const segs = splitSegments(original).filter((s) => !looksLikeSiteName(s));
    const pool = (segs.length ? segs : [original]).slice();
    // merge obvious continuations ("Dune" + ":" style splits are already safe)
    pool.sort((a, b) => scoreSegment(b) - scoreSegment(a));

    let best = '';
    let bestScore = -1e9;
    for (const seg of pool) {
      const withoutMeta = stripMeta(seg, meta);
      const noPhrases = stripPhrases(withoutMeta);
      const noTokens = stripTokens(noPhrases);
      let candidate = trimLead(noTokens).replace(/\s*[:\-|]\s*$/, '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
      candidate = candidate.replace(/\s{2,}/g, ' ');
      const sc = scoreSegment(candidate) + (candidate === seg ? 6 : 0);
      if (candidate && sc > bestScore) {
        bestScore = sc;
        best = candidate;
      }
    }

    if (!best) {
      // Second pass without token stripping (aggressive pass ate everything).
      for (const seg of pool) {
        const c = fixTail(stripPhrases(stripMeta(seg, meta)));
        if (c && c.length > best.length) best = c;
      }
    }
    if (!best) {
      // Last resort: slug from URL / canonical
      const slug = (o.extra || '').match(/\/([a-z0-9][a-z0-9-]{3,60})\/?(?:\?|$)/i);
      if (slug) best = slug[1].replace(/[-_]+/g, ' ').replace(/\b\d{6,}\b/g, '').trim();
    }
    if (!best) {
      best = fixTail(normalize(original).replace(/\s*[|»•·].*$/, ''));
    }
    if (!best) {
      out.title = '';
      return out;
    }

    // Title-case fix-up for ALL-CAPS / all-lower SEO titles
    const isFlat = best === best.toUpperCase() || best === best.toLowerCase();
    if (isFlat && best.length < 80) {
      best = best
        .toLowerCase()
        .replace(/\b(\p{L})/gu, (m, c) => c.toUpperCase())
        .replace(/\b(Of|The|And|A|An|In|On|To|For|vs|Vs)\b/gi, (m, c, i) => (i === 0 ? c : c))
        .replace(/\s+/g, ' ');
    }

    out.title = fixTail(
      best
        .replace(/\s*\(\s*(?:\d{4})\s*\)\s*/g, ' ')
        .replace(/["'`]+$/g, '')
        .replace(/^["'`]+/g, '')
        .trim()
    );
    const words = out.title.split(/\s+/).filter(Boolean);
    const allGeneric = words.length > 0 && words.every((w) => GENERIC_WORDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')));
    out.isJunk = out.title.length < 2 || !/\p{L}/u.test(out.title) || allGeneric || /\b(watch|nonton)\b.*\b(movies|film)\b/i.test(out.title);
    if (out.isJunk) out.title = '';
    out.kind = /\b(episode|s\d{1,2}e\d{1,2}|\d{1,2}x\d{1,2})\b/i.test(original) || out.episode ? 'episode' : 'movie';
    out.confidence = out.isJunk ? 0 : util_clamp(bestScore);
    return out;
  }

  function util_clamp(n) {
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n + 45)));
  }

  /* ---- DOM-driven collection --------------------------------------- */

  function firstMeta(doc, selectors) {
    for (const sel of selectors) {
      try {
        const el = doc.querySelector(sel);
        const v = el && (el.getAttribute('content') || el.getAttribute('data-content') || el.textContent);
        if (v && v.trim()) return v.trim();
      } catch (_) {}
    }
    return '';
  }

  function walkJsonLd(node, sink, depth) {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const n of node) walkJsonLd(n, sink, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const types = [].concat(node['@type'] || []).map((t) => String(t).toLowerCase());
    const wanted = ['movie', 'tvepisode', 'tvseries', 'videoobject', 'clip', 'tvseason', 'episode'];
    if (types.some((t) => wanted.indexOf(t) >= 0)) {
      sink.push({
        types,
        name: node.name || node.headline || '',
        alternate: node.alternateName || '',
        episodeTitle: node.episodeTitle || '',
        datePublished: node.datePublished || '',
        year: node.datePublished ? String(node.datePublished).slice(0, 4) : '',
        season: node.seasonNumber != null ? String(node.seasonNumber) : '',
        episode: node.episodeNumber != null ? String(node.episodeNumber) : '',
        partOf: (node.partOfTVSeries && (node.partOfTVSeries.name || node.partOfTVSeries.headline)) || (node.partOfSeries && node.partOfSeries.name) || '',
        sameAs: [].concat(node.sameAs || []).join(' '),
        identifier: JSON.stringify(node.identifier || ''),
        image: typeof node.image === 'string' ? node.image : (node.image && node.image.url) || '',
        thumbnail: (node.thumbnailUrl && (Array.isArray(node.thumbnailUrl) ? node.thumbnailUrl[0] : node.thumbnailUrl)) || '',
        contentUrl: node.contentUrl || '',
        embedUrl: node.embedUrl || '',
        duration: node.duration || '',
      });
    }
    for (const k of Object.keys(node)) {
      if (k === '@graph' || k === 'mainEntity' || k === 'itemListElement' || k === 'item' || k === 'about') walkJsonLd(node[k], sink, depth + 1);
    }
  }

  /**
   * Collect title candidates from a document (top frame).
   * @returns {{candidates: Array<{text:string, source:string}>, media: string[], poster: string, info: object}}
   */
  function collect(doc) {
    const res = { candidates: [], media: [], poster: '', info: {}, links: [] };
    if (!doc) return res;
    const push = (text, source) => {
      if (text && String(text).trim()) res.candidates.push({ text: String(text).trim(), source });
    };

    /* --- 1. JSON-LD ------------------------------------------------ */
    const ld = [];
    try {
      for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
        const parsed = SR.util.safeJSON(s.textContent.replace(/<!--|-->/g, ''), null);
        if (parsed) walkJsonLd(parsed, ld, 0);
      }
    } catch (_) {}
    if (ld.length) {
      const ep = ld.find((x) => x.types.includes('tvepisode') || x.types.includes('episode') || x.types.includes('clip'));
      const mv = ld.find((x) => x.types.includes('movie') || x.types.includes('videoobject') || x.types.includes('tvseries'));
      const pick = ep || mv || ld[0];
      const showName = pick.partOf || (ep && ep.name) || '';
      const display = ep && ep.episodeTitle && pick.name ? pick.name + ': ' + ep.episodeTitle : pick.name || pick.alternate || '';
      push(display, 'json-ld');
      if (showName && showName !== display) push(showName, 'json-ld-show');
      res.info = {
        year: pick.year || '',
        season: pick.season || '',
        episode: pick.episode || '',
        imdbId: ((pick.sameAs + ' ' + pick.identifier).match(/tt\d{6,10}/i) || [])[0] || '',
        tmdbId: ((pick.sameAs + ' ' + (pick.url || '')).match(/tmdb\.org\/(?:movie|tv)\/(\d+)/i) || [])[1] || '',
        poster: pick.image || pick.thumbnail || '',
        duration: pick.duration || '',
        kind: ep ? 'episode' : mv ? 'movie' : 'unknown',
        showName,
      };
    }

    /* --- 2. Open Graph -------------------------------------------- */
    const og = firstMeta(doc, ['meta[property="og:title"]', 'meta[name="og:title"]', 'meta[property="og:title:alt"]']);
    push(og, 'og:title');
    if (!res.info.poster) res.info.poster = firstMeta(doc, ['meta[property="og:image"]', 'meta[name="og:image"]', 'meta[property="og:image:secure_url"]']);
    if (!res.info.duration) res.info.duration = firstMeta(doc, ['meta[property="video:duration"]']);
    const kinds = firstMeta(doc, ['meta[property="og:type"]']);
    if (/\b(tv|episode|series|movie|video)/i.test(kinds)) res.info.kindHint = kinds;
    for (const sel of [
      'meta[property="og:video"]', 'meta[property="og:video:url"]', 'meta[property="og:video:secure_url"]',
      'meta[name="twitter:player:stream"]', 'meta[property="video:movie"]', 'meta[property="video:url"]',
    ]) {
      const v = firstMeta(doc, [sel]);
      if (v) res.media.push({ url: v, via: 'meta' });
    }
    for (const s of doc.querySelectorAll('meta[property^="og:video"], meta[name^="twitter:player"]')) {
      const v = s.getAttribute('content');
      if (v) res.media.push({ url: v, via: 'meta' });
    }

    /* --- 3. Twitter card ------------------------------------------ */
    push(firstMeta(doc, ['meta[name="twitter:title"]', 'meta[property="twitter:title"]']), 'twitter:title');

    /* --- 4. <h1> --------------------------------------------------- */
    let h1 = '';
    try {
      const heads = doc.querySelectorAll('h1');
      for (const el of heads) {
        const t = (el.textContent || '').trim();
        if (t && t.length > 1 && t.length < 160) {
          h1 = t;
          break;
        }
      }
      if (!h1) h1 = (doc.querySelector('h2[class*="title"], .title, [class*="movie-name"], [itemprop="name"]') || {}).textContent || '';
    } catch (_) {}
    push((h1 || '').trim(), 'h1');

    /* --- 5. document.title ---------------------------------------- */
    push(doc.title || '', 'document.title');

    /* --- extras: canonical slug + breadcrumbs + IMDb id ----------- */
    res.slug = firstMeta(doc, ['link[rel="canonical"]']).replace(/^https?:\/\//, '');
    try {
      const crumb = [...doc.querySelectorAll('a[rel="nofollow"], .breadcrumb a, [itemprop="itemListElement"]')].map((a) => a.textContent.trim()).filter(Boolean);
      if (crumb.length) res.crumbs = crumb.slice(0, 6).join(' > ');
      res.links = [...doc.querySelectorAll('a[href*="imdb.com/title/"], a[href*="themoviedb.org/"]')]
        .slice(0, 8)
        .map((a) => a.href);
    } catch (_) {}
    return res;
  }

  /**
   * Best-of-all-sources resolution.
   * @param {Document} doc
   */
  function resolve(doc) {
    const coll = collect(doc);
    let best = null;
    for (const c of coll.candidates) {
      const info = clean(c.text, { source: c.source, extra: coll.slug || '' });
      info.source = c.source;
      if (!info.title) continue;
      const bonus =
        c.source === 'json-ld' ? 45 : c.source === 'og:title' ? 26 : c.source === 'twitter:title' ? 14 : c.source === 'h1' ? 8 : 0;
      info.score = info.confidence + bonus;
      if (!best || info.score > best.score) best = info;
    }
    if (!best) best = clean(coll.slug ? coll.slug.replace(/-/g, ' ') : (doc && doc.title) || '', { source: 'fallback' });

    if (coll.info && Object.keys(coll.info).length) {
      best.year = best.year || coll.info.year || null;
      best.season = best.season || (coll.info.season ? String(coll.info.season).padStart(2, '0') : null);
      best.episode = best.episode || (coll.info.episode ? String(coll.info.episode).padStart(2, '0') : null);
      best.poster = coll.info.poster || coll.slug || '';
      best.imdbId = coll.info.imdbId || '';
      best.kind = coll.info.kind !== 'unknown' ? coll.info.kind : best.kind;
      const fromLinks = (coll.links.join(' ').match(/tt\d{6,10}/i) || [])[0];
      if (!best.imdbId && fromLinks) best.imdbId = fromLinks;
      const tmdb = (coll.links.join(' ').match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i) || [])[1];
      if (tmdb) best.tmdbId = tmdb;
    }
    best.mediaFromMeta = coll.media;
    return best;
  }

  /** Build a search-friendly query for subtitle providers. */
  function searchQuery(info) {
    if (!info || !info.title) return '';
    let q = info.title;
    return q.trim();
  }

  /** S01E02-style label used in the UI and by subtitle lookups. */
  function episodeLabel(info) {
    if (!info) return null;
    if (!info.episode) return null;
    return (info.season ? 'S' + info.season : '') + 'E' + info.episode;
  }

  SR.title = {
    clean,
    collect,
    resolve,
    normalize,
    searchQuery,
    episodeLabel,
    extractMeta,
    stripPhrases,
    _lists: { PHRASES, TOKENS, JUNK_EXACT, TLD_RE },
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

/* ═════════════════════════ src/shared/i18n.js ═════════════════════════ */
/**
 * Stream Radar — tiny i18n (English + Bahasa Indonesia).
 * Auto-detected from the browser locale, overridable in Settings.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});

  const DICT = {
    en: {
      'app.name': 'Stream Radar',
      'app.tagline': 'Ultra media detector',
      'fab.label': 'Stream Radar: {n} media found',
      'panel.title': 'Detected media',
      'panel.empty': 'No video found yet',
      'panel.emptyHint': 'Play the video, Stream Radar watches network, DOM, MSE, Service Worker and player internals at once.',
      'panel.detecting': 'Watching…',
      'panel.paused': 'Auto-detect paused',
      'panel.ads': '{n} ad requests hidden',
      'panel.toggleAds': 'Toggle ad and tracker requests',
      'panel.showAds': 'Show ads',
      'panel.hideAds': 'Hide ads',
      'panel.clear': 'Clear',
      'panel.refresh': 'Scan now',
      'panel.settings': 'Settings',
      'panel.openPanel': 'Open big panel',
      'panel.items': '{n} streams',
      'panel.subs.title': 'Indonesian subtitles',
      'panel.subs.searching': 'Searching subtitles…',
      'panel.subs.found': 'Subtitle found',
      'panel.subs.none': 'No subtitle found',
      'panel.subs.error': 'Subtitle search failed',
      'panel.subs.skipped': 'Add an API key in Settings',
      'panel.subs.attach': 'Attach here',
      'panel.subs.download': 'Download .vtt',
      'panel.subs.retry': 'Search again',
      'action.watchparty': 'Watch Party',
      'action.copy': 'Copy URL',
      'action.copied': 'Copied',
      'action.download': 'Download',
      'action.subs': 'Subtitles',
      'action.open': 'Open',
      'action.ffmpeg': 'Copy ffmpeg command',
      'action.variants': '{n} qualities',
      'action.record': 'Record buffer (beta)',
      'action.recordStop': 'Stop & save recording',
      'label.quality': 'Quality',
      'label.size': 'Size',
      'label.type': 'Type',
      'label.via': 'Detected by',
      'label.host': 'Host',
      'label.segments': '{n} segments {size}',
      'label.live': 'LIVE',
      'label.drm': 'DRM protected',
      'label.aes': 'AES-128 key',
      'label.mse': 'MediaSource (blob)',
      'label.mseHint': 'Blob streams cannot be downloaded directly, use Record buffer or open the source page.',
      'toast.found': '{n} media detected on this page',
      'toast.newmedia': 'New {type} stream detected',
      'toast.subs': 'Indonesian subtitle found: {name}',
      'toast.subsNone': 'No Indonesian subtitle found for {title}',
      'toast.copied': 'URL copied to clipboard',
      'toast.error': 'Error: {msg}',
      'toast.watchparty': 'Opening WatchParty…',
      'toast.paused': 'Detection paused on this site',
      'toast.resumed': 'Detection resumed',
      'toast.recording': 'Recording the MediaSource buffer…',
      'toast.recordSaved': 'Recording saved ({size})',
      'toast.recordEmpty': 'Nothing buffered yet, play the video first',
      'settings.title': 'Stream Radar settings',
      'settings.subtitle': 'Everything is stored locally in your browser. No account, no tracking.',
      'theme.system': 'System',
      'theme.dark': 'Dark',
      'theme.light': 'Light',
      'common.close': 'Close',
      'common.on': 'On',
      'common.off': 'Off',
      'common.save': 'Save',
      'common.saved': 'Saved',
      'common.cancel': 'Cancel',
      'common.language': 'Language',
      'common.theme': 'Theme',
      'common.tab': 'Tab',
      'common.search': 'Search',
      'popup.title': 'Stream Radar',
      'popup.tabMedia': 'Media in this tab',
      'popup.empty': 'Nothing detected yet in this tab.',
      'popup.disabled': 'Detection is disabled for this site',
      'popup.enableHere': 'Enable on this site',
      'popup.disableHere': 'Disable on this site',
      'popup.watchpartyNote': 'Watch Party opens watchparty.me in a new tab and fills the room for you.',
      'update.applied': 'Rule pack {v} applied',
      'update.current': 'Rule pack is up to date',
      'update.failed': 'Update check failed: {msg}',
      'update.off': 'Live updates are switched off',
      'update.title': 'Live updates',
      'update.hint': 'Fixes for broken detection rules arrive without reinstalling. Signed, data-only, additive.',
      'update.check': 'Check now',
      'update.state': 'Status',
      'update.pack': 'Rule pack',
      'update.patch': 'Code patch',
      'toast.title': 'Stream Radar notifications',
      'panel.tabMedia': 'Media',
      'panel.tabSubs': 'Subtitles',
      'panel.tabInfo': 'Diagnostics',
      'panel.noTitle': 'title not recognised',
      'panel.series': 'Series',
      'panel.layers': '{n} of 5 layers active',
      'panel.none': 'none reported yet',
      'panel.subs.hint': 'Add a SubDL or OpenSubtitles key in Settings to fetch Indonesian subtitles.',
      'action.use': 'Use',
      'action.pick': 'Pick',
      'action.downloadPlaylist': 'Save playlist',
      'label.ad': 'ad',
      'label.buffered': 'buffered',
      'label.frames': 'Frames seen',
      'label.players': 'Players detected',
      'label.sources': 'sources',
      'settings.autoDetect': 'Auto detect on this site',
      'settings.autoDetectHint': 'Master switch. Also stops the network observer.',
      'settings.network': 'Network (fetch, XHR, WebSocket, webRequest)',
      'settings.dom': 'DOM scan (video, source, iframe, observer + poll)',
      'settings.mse': 'MediaSource and blob interception',
      'settings.sw': 'Service worker and Cache API',
      'settings.heuristic': 'Heuristics (scripts, timing, player internals)',
      'settings.autosub': 'Search subtitles automatically',
      'settings.autosubHint': 'Runs once the title is recognised.',
      'settings.notify': 'Toasts and desktop notifications',
      'settings.record': 'Allow MSE buffer recording (beta)',
      'settings.recordHint': 'Collects appended segments into a downloadable file.',
      'settings.fab': 'Floating button position',
      'settings.fabHint': 'Drag it anywhere. Position is remembered.',
      'settings.reset': 'Reset position',
      'settings.openOptions': 'Full settings',
      'privacy.note': 'Detection stays on your device. Nothing is uploaded to us.',
      'label.type': 'Type',
      'action.recordStop': 'Stop and save recording',
      'update.hint': 'Signed, data-only rule packs.',
      'options.tabGeneral': 'General',
      'options.tabDetection': 'Detection layers',
      'options.tabSubs': 'Subtitles & API keys',
      'options.tabAdvanced': 'Advanced',
      'options.tabHelp': 'Help',
    },
    id: {
      'app.name': 'Stream Radar',
      'app.tagline': 'Detektor media ultra',
      'fab.label': 'Stream Radar: {n} media ditemukan',
      'panel.title': 'Media terdeteksi',
      'panel.empty': 'Belum ada video terdeteksi',
      'panel.emptyHint': 'Putar videonya, Stream Radar memantau jaringan, DOM, MSE, Service Worker dan internal player secara bersamaan.',
      'panel.detecting': 'Mendeteksi…',
      'panel.paused': 'Deteksi otomatis dijeda',
      'panel.ads': '{n} request iklan disembunyikan',
      'panel.toggleAds': 'Tampilkan atau sembunyikan request iklan dan tracker',
      'panel.showAds': 'Tampilkan iklan',
      'panel.hideAds': 'Sembunyikan iklan',
      'panel.clear': 'Bersihkan',
      'panel.refresh': 'Scan ulang',
      'panel.settings': 'Pengaturan',
      'panel.openPanel': 'Buka panel besar',
      'panel.items': '{n} stream',
      'panel.subs.title': 'Subtitle Indonesia',
      'panel.subs.searching': 'Mencari subtitle…',
      'panel.subs.found': 'Subtitle ditemukan',
      'panel.subs.none': 'Subtitle tidak ditemukan',
      'panel.subs.error': 'Pencarian subtitle gagal',
      'panel.subs.skipped': 'Isi API key di Pengaturan',
      'panel.subs.attach': 'Pasang di sini',
      'panel.subs.download': 'Unduh .vtt',
      'panel.subs.retry': 'Cari lagi',
      'action.watchparty': 'Nonton Bareng',
      'action.copy': 'Salin URL',
      'action.copied': 'Tersalin',
      'action.download': 'Unduh',
      'action.subs': 'Subtitle',
      'action.open': 'Buka',
      'action.ffmpeg': 'Salin perintah ffmpeg',
      'action.variants': '{n} kualitas',
      'action.record': 'Rekam buffer (beta)',
      'action.recordStop': 'Stop & simpan rekaman',
      'label.quality': 'Kualitas',
      'label.size': 'Ukuran',
      'label.type': 'Tipe',
      'label.via': 'Dideteksi oleh',
      'label.host': 'Host',
      'label.segments': '{n} segmen {size}',
      'label.live': 'LIVE',
      'label.drm': 'Terproteksi DRM',
      'label.aes': 'Kunci AES-128',
      'label.mse': 'MediaSource (blob)',
      'label.mseHint': 'Stream blob tidak bisa diunduh langsung, pakai Rekam buffer atau buka halaman sumbernya.',
      'toast.found': '{n} media terdeteksi di halaman ini',
      'toast.newmedia': 'Stream {type} baru terdeteksi',
      'toast.subs': 'Subtitle Indonesia ditemukan: {name}',
      'toast.subsNone': 'Subtitle Indonesia tidak ditemukan untuk {title}',
      'toast.copied': 'URL disalin ke clipboard',
      'toast.error': 'Error: {msg}',
      'toast.watchparty': 'Membuka WatchParty…',
      'toast.paused': 'Deteksi dijeda di situs ini',
      'toast.resumed': 'Deteksi dilanjutkan',
      'toast.recording': 'Merekam buffer MediaSource…',
      'toast.recordSaved': 'Rekaman disimpan ({size})',
      'toast.recordEmpty': 'Belum ada buffer, putar dulu videonya',
      'settings.title': 'Pengaturan Stream Radar',
      'settings.subtitle': 'Semua disimpan lokal di browser Anda. Tanpa akun, tanpa tracking.',
      'theme.system': 'Sistem',
      'theme.dark': 'Gelap',
      'theme.light': 'Terang',
      'common.close': 'Tutup',
      'common.on': 'Aktif',
      'common.off': 'Nonaktif',
      'common.save': 'Simpan',
      'common.saved': 'Tersimpan',
      'common.cancel': 'Batal',
      'common.language': 'Bahasa',
      'common.theme': 'Tema',
      'common.tab': 'Tab',
      'common.search': 'Cari',
      'popup.title': 'Stream Radar',
      'popup.tabMedia': 'Media di tab ini',
      'popup.empty': 'Belum ada yang terdeteksi di tab ini.',
      'popup.disabled': 'Deteksi dimatikan untuk situs ini',
      'popup.enableHere': 'Aktifkan di situs ini',
      'popup.disableHere': 'Matikan di situs ini',
      'popup.watchpartyNote': 'Watch Party membuka watchparty.me di tab baru dan mengisi room untuk Anda.',
      'update.applied': 'Paket rule {v} dipasang',
      'update.current': 'Paket rule sudah paling baru',
      'update.failed': 'Cek update gagal: {msg}',
      'update.off': 'Live update dimatikan',
      'update.title': 'Update otomatis',
      'update.hint': 'Perbaikan aturan deteksi masuk tanpa perlu install ulang. Ditandatangani, hanya data, sifatnya menambah.',
      'update.check': 'Cek sekarang',
      'update.state': 'Status',
      'update.pack': 'Paket rule',
      'update.patch': 'Code patch',
      'toast.title': 'Notifikasi Stream Radar',
      'panel.tabMedia': 'Media',
      'panel.tabSubs': 'Subtitle',
      'panel.tabInfo': 'Diagnostik',
      'panel.noTitle': 'judul belum dikenali',
      'panel.series': 'Seri',
      'panel.layers': '{n} dari 5 layer aktif',
      'panel.none': 'belum ada laporan',
      'panel.subs.hint': 'Isi API key SubDL atau OpenSubtitles di Pengaturan untuk mengambil subtitle Indonesia.',
      'action.use': 'Pakai',
      'action.pick': 'Ambil',
      'action.downloadPlaylist': 'Simpan playlist',
      'label.ad': 'iklan',
      'label.buffered': 'terbuffer',
      'label.frames': 'Frame terpantau',
      'label.players': 'Player terdeteksi',
      'label.sources': 'sumber',
      'settings.autoDetect': 'Deteksi otomatis di situs ini',
      'settings.autoDetectHint': 'Saklar utama. Sekalian menghentikan pengamat jaringan.',
      'settings.network': 'Jaringan (fetch, XHR, WebSocket, webRequest)',
      'settings.dom': 'Scan DOM (video, source, iframe, observer + polling)',
      'settings.mse': 'Intersep MediaSource dan blob',
      'settings.sw': 'Service Worker dan Cache API',
      'settings.heuristic': 'Heuristik (script, timing, internal player)',
      'settings.autosub': 'Cari subtitle otomatis',
      'settings.autosubHint': 'Jalan begitu judul dikenali.',
      'settings.notify': 'Toast dan notifikasi desktop',
      'settings.record': 'Izinkan perekaman buffer MSE (beta)',
      'settings.recordHint': 'Menyusun segmen yang lewat menjadi file yang bisa disimpan.',
      'settings.fab': 'Posisi tombol mengambang',
      'settings.fabHint': 'Seret ke mana saja. Posisinya diingat.',
      'settings.reset': 'Reset posisi',
      'settings.openOptions': 'Pengaturan lengkap',
      'privacy.note': 'Deteksi hanya terjadi di perangkatmu. Tidak ada yang diunggah ke kami.',
      'action.recordStop': 'Hentikan dan simpan rekaman',
      'update.hint': 'Paket rule bertanda tangan, hanya data.',
      'options.tabGeneral': 'Umum',
      'options.tabDetection': 'Layer deteksi',
      'options.tabSubs': 'Subtitle & API key',
      'options.tabAdvanced': 'Lanjutan',
      'options.tabHelp': 'Bantuan',
    },
  };

  let lang = 'en';
  SR.i18n = {
    set(l) {
      lang = DICT[l] ? l : 'en';
    },
    get() {
      return lang;
    },
    detect(nav) {
      const n = String((nav && (nav.language || (nav.languages && nav.languages[0]))) || 'en').toLowerCase();
      return n.startsWith('id') || n.startsWith('ms') ? 'id' : 'en';
    },
    t(key, vars) {
      const table = DICT[lang] || DICT.en;
      let s = table[key] != null ? table[key] : DICT.en[key] != null ? DICT.en[key] : key;
      if (vars) {
        s = String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
      }
      return s;
    },
    dict: DICT,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ═════════════════════════ src/shared/store.js ═════════════════════════ */
/**
 * Stream Radar — media store (shared by the background worker and the userscript)
 * ==================================================================
 * One implementation of "de-duplicate, classify, aggregate, enrich, rank" so the
 * extension and the userscript can never disagree about what a stream is.
 *
 *   const store = new SR.MediaStore({ maxItems: 80, blockPatterns: '' });
 *   const item  = store.ingest({ url, via, mime, size, manifestBody });
 *   store.view() // -> { items: [...], ads: [...], counts: {...} }
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;
  const rules = SR.rules;

  /** Which detection layer reported a given `via` (for the 5-layer HUD). */
  const LAYER_OF_VIA = {
    fetch: 'network', xhr: 'network', websocket: 'network', eventsource: 'network', network: 'network',
    'fetch-manifest': 'network', 'xhr-manifest': 'network', 'fetch-json': 'heuristic', 'xhr-json': 'heuristic',
    'fetch-body': 'heuristic', 'xhr-body': 'heuristic', 'document.write': 'heuristic', 'inline-script': 'heuristic',
    'script-added': 'heuristic', performance: 'heuristic', 'global-config': 'heuristic', player: 'heuristic',
    'hls-js': 'heuristic', 'hls-js-level': 'hls-js', 'hls-segment': 'mse', 'jwplayer-setup': 'heuristic',
    'videojs-setup': 'heuristic', 'websocket-frame': 'heuristic', 'websocket-send': 'heuristic',
    'eventsource-frame': 'heuristic', manual: 'heuristic',
    dom: 'dom', 'dom-source': 'dom', 'dom-currentsrc': 'dom', 'dom-poster': 'dom', 'dom-src': 'dom',
    meta: 'dom', 'iframe-added': 'dom', 'video-metadata': 'dom', 'source-tag': 'dom',
    'video-src': 'mse', 'mse-src': 'mse', blob: 'mse',
    'cache-api': 'sw',
  };

  class MediaStore {
    constructor(opts) {
      this.o = Object.assign({ maxItems: 80, blockPatterns: '', allowPatterns: '' }, opts || {});
      this.entries = new Map(); // dedupKey -> item
      this.byId = new Map();
      this.order = [];
      this.layers = { network: false, dom: false, mse: false, sw: false, heuristic: false };
      this.adCount = 0;
      this.block = util.compilePatterns(this.o.blockPatterns);
      this.allow = util.compilePatterns(this.o.allowPatterns);
      this.onChange = this.o.onChange || function () {};
    }

    configure(opts) {
      Object.assign(this.o, opts || {});
      if (opts && 'blockPatterns' in opts) this.block = util.compilePatterns(opts.blockPatterns);
      if (opts && 'allowPatterns' in opts) this.allow = util.compilePatterns(opts.allowPatterns);
    }

    layerOf(via) {
      return LAYER_OF_VIA[via] || null;
    }

    normalize(raw, origin) {
      if (!raw || !raw.url) return null;
      const url = String(raw.url).trim();
      let cls = rules.classify(url, { mime: raw.mime, size: raw.size, via: raw.via });
      if (!cls && !/^blob:/i.test(url) && /^https?:/i.test(url) && (url.indexOf('?') > 0 || /\/proxy\/|\/forward\/|\/embed\//i.test(url))) {
        // Embed providers wrap the real stream inside their own URL. Try to
        // unwrap it here so *every* layer benefits (DOM iframe src, XHR, perf…).
        const inner = rules.unwrapUrl(url).find((u) => u !== url && rules.classify(u, {}));
        if (inner) {
          const sub = this.normalize(Object.assign({}, raw, { url: inner, public: Object.assign({}, raw.public, { unwrappedFrom: url }) }), origin);
          if (sub) return sub;
        }
      }
      if (!cls) {
        if (!/^blob:/i.test(url)) return null;
        cls = { category: 'blob', ext: 'blob', mime: raw.mime || '', size: raw.size || 0, isSegment: false, isAd: false, isBlob: true, isEmbed: false };
      }
      return {
        key: util.dedupKey(url, cls.category),
        url: url,
        category: cls.category,
        ext: cls.ext,
        mime: cls.mime || raw.mime || '',
        size: Number(raw.size) > 0 ? Number(raw.size) : cls.size || 0,
        isAd: cls.isAd,
        isSegment: cls.isSegment,
        isBlob: cls.isBlob,
        isEmbed: cls.isEmbed,
        via: raw.via || origin || 'unknown',
        host: util.host(url),
        ts: raw.t || Date.now(),
        height: raw.height || 0,
        width: raw.width || 0,
        duration: raw.duration || 0,
        quality: raw.quality || rules.qualityFromUrl(url),
        codec: rules.codecHint(url, raw.mime),
        frame: raw.frame || 'top',
        frameUrl: raw.frameUrl || '',
        manifestBody: raw.manifestBody,
        public: raw.public || null,
      };
    }

    /**
     * @returns {object|null} the merged item (null when filtered out / duplicated)
     */
    ingest(raw, origin) {
      const n = this.normalize(raw, origin);
      if (!n) return null;
      const layer = this.layerOf(n.via);
      if (layer && this.layers.hasOwnProperty(layer)) this.layers[layer] = true;
      try {
        if (this.block.length && util.matchesAny(this.block, n.url) && !(this.allow.length && util.matchesAny(this.allow, n.url))) return null;
      } catch (_) {}

      // ---- segment noise → one aggregated row per folder ----
      if (n.isSegment) {
        const dir = util.dirOf(n.url) || util.origin(n.url);
        const key = 'seg:' + dir;
        let g = this.entries.get(key);
        if (!g) {
          g = {
            id: util.hash32(key),
            key: key,
            kind: 'segmentgroup',
            url: (dir || '') + '/',
            category: 'segment',
            ext: 'ts',
            host: util.host(dir),
            via: [],
            ts: Date.now(),
            segmentCount: 0,
            segmentBytes: 0,
            isSegment: true,
            sub: { status: 'idle' },
            name: (util.host(dir) || 'segments') + ' segment stream',
          };
          this.add(key, g);
        }
        g.segmentCount++;
        g.segmentBytes += n.size || 0;
        if (g.via.indexOf(n.via) < 0) g.via.push(n.via);
        g.updated = Date.now();
        // if a matching playlist exists, this group is just its payload
        for (const e of this.entries.values()) {
          if (e.category === 'hls' || e.category === 'dash') {
            if (util.dirOf(e.url) && (dir.startsWith(util.origin(e.url)) || util.origin(e.url) === util.origin(n.url))) {
              e.segmentBytes = (e.segmentBytes || 0) + (n.size || 0);
              e.segmentCount = (e.segmentCount || 0) + 1;
              g.coveredBy = e.id;
            }
          }
        }
        this.trim();
        this.onChange('segments', g);
        return g;
      }

      let item = this.entries.get(n.key);
      const isNew = !item;
      if (isNew) {
        item = {
          id: util.hash32(n.key),
          key: n.key,
          kind: 'media',
          url: n.url,
          category: n.category,
          ext: n.ext,
          mime: n.mime,
          size: n.size,
          host: n.host,
          isAd: n.isAd,
          isBlob: n.isBlob,
          isEmbed: n.isEmbed,
          via: [],
          ts: n.ts,
          updated: Date.now(),
          height: n.height,
          width: n.width,
          quality: n.quality,
          codec: n.codec,
          duration: n.duration,
          frame: n.frame,
          frameUrl: n.frameUrl,
          variants: null,
          drm: null,
          aes: null,
          sub: { status: 'idle' },
          name: nameFromUrl(n.url, n.category),
        };
        this.add(n.key, item);
        if (item.isAd) this.adCount++;
      } else {
        item.updated = Date.now();
        item.size = item.size || n.size;
        item.quality = item.quality || n.quality;
        item.codec = item.codec || n.codec;
        if (n.height > (item.height || 0)) {
          item.height = n.height;
          if (!item.quality) item.quality = util.qualityLabel(n.height);
        }
        if (n.duration > (item.duration || 0)) item.duration = n.duration;
        if (n.frame === 'top') item.frame = 'top';
        if (n.frameUrl && !item.frameUrl) item.frameUrl = n.frameUrl;
      }
      if (item.via.indexOf(n.via) < 0) item.via.push(n.via);
      item.confidence = Math.min(9, item.via.length * 2 + (item.size ? 1 : 0) + (item.quality ? 1 : 0) + (item.variants ? 2 : 0));
      if (n.public) {
        item.flags = Object.assign(item.flags || {}, n.public);
        if (n.public.fileName) item.fileName = n.public.fileName;
        if (n.public.download) item.isDownload = true;
      }

      // ---- MSE bookkeeping ----
      if (n.via === 'mse-src' || n.via === 'blob' || (raw && (raw.mimes || raw.bytes != null))) {
        item.mseBytes = Math.max(item.mseBytes || 0, Number(raw.bytes || raw.size || 0));
        if (raw.mimes && raw.mimes.length) item.mseMimes = raw.mimes;
        if (raw.duration) item.duration = Math.round(raw.duration);
        if (raw.recording) item.recording = true;
      }
      if (raw && raw.category === 'blob' && raw.public && raw.public.mse) item.mse = true;

      // ---- manifest bodies reported by the page hooks ----
      if (n.manifestBody) this.parseManifest(item, n.manifestBody);
      else if ((item.category === 'hls' || item.category === 'dash') && !item.variants && isNew) item.needsManifest = true;

      this.trim();
      this.onChange(isNew ? 'add' : 'update', item);
      return isNew ? item : item;
    }

    add(key, item) {
      this.entries.set(key, item);
      this.byId.set(item.id, item);
      this.order.unshift(item.id);
    }

    trim() {
      const max = this.o.maxItems || 80;
      while (this.order.length > max) {
        const dropId = this.order.pop();
        this.byId.delete(dropId);
        for (const [k, v] of this.entries) if (v.id === dropId) {
          this.entries.delete(k);
          break;
        }
      }
    }

    parseManifest(item, text) {
      try {
        const m = item.category === 'dash' || (SR.manifest && SR.manifest.looksLikeMpdBody(text)) ? SR.manifest.parseMpd(text, item.url) : SR.manifest.parseM3u8(text, item.url);
        applyManifest(item, m);
        if (m && m.aesKeyUrl) item.aes = m.aesKeyUrl;
        item.needsManifest = false;
        return m;
      } catch (_) {
        return null;
      }
    }

    /** All items in display order, with view-model sugar (labels + ranking). */
    view(opts) {
      const o = opts || {};
      const order = this.order.map((id) => this.byId.get(id)).filter(Boolean);
      const items = [];
      const ads = [];
      for (const it of order) {
        const v = decorate(it, o.title);
        if (it.isAd) ads.push(v);
        else items.push(v);
      }
      items.sort(rank);
      ads.sort(rank);
      return {
        items: items,
        ads: ads,
        layers: Object.assign({}, this.layers),
        counts: { total: items.length, ads: ads.length },
      };
    }

    best() {
      const v = this.view();
      return v.items[0] || null;
    }

    clear() {
      this.entries.clear();
      this.byId.clear();
      this.order = [];
      this.adCount = 0;
      this.onChange('clear');
    }

    serialize(limit) {
      return this.order
        .map((id) => this.byId.get(id))
        .filter(Boolean)
        .slice(0, limit || 40)
        .map((e) => ({
          key: e.key, url: e.url, category: e.category, ext: e.ext, mime: e.mime, size: e.size, host: e.host,
          isAd: e.isAd, via: e.via, ts: e.ts, quality: e.quality, height: e.height, duration: e.duration,
          name: e.name, kind: e.kind, segmentCount: e.segmentCount, segmentBytes: e.segmentBytes,
          drm: e.drm, aes: e.aes, variants: e.variants && e.variants.length <= 14 ? e.variants : null,
          mseBytes: e.mseBytes, mseMimes: e.mseMimes,
        }));
    }

    restore(list) {
      if (!Array.isArray(list)) return 0;
      let n = 0;
      for (const e of list) {
        if (!e || !e.url || this.entries.has(e.key)) continue;
        const item = Object.assign(
          {
            id: util.hash32(e.key || e.url),
            kind: 'media',
            via: [],
            confidence: 1,
            sub: { status: 'idle' },
            updated: e.ts || Date.now(),
          },
          e
        );
        this.add(e.key || util.dedupKey(e.url, e.category), item);
        n++;
      }
      return n;
    }
  }

  function nameFromUrl(url, category) {
    try {
      const u = new URL(url);
      const file = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
      return file.length > 3 ? file : (rules.CATEGORY_LABEL[category] || 'VIDEO');
    } catch (_) {
      return String(url).slice(0, 48);
    }
  }

  function applyManifest(item, m) {
    if (!m) return;
    const variants = (m.variants || []).map((v) => ({
      uri: v.uri || item.url,
      quality: v.height ? util.qualityLabel(v.height) : '',
      height: v.height || 0,
      width: v.width || 0,
      bandwidth: v.bandwidth || 0,
      bandwidthLabel: v.bandwidth ? util.formatBits(v.bandwidth) : '',
      codecs: (v.codecs || '').slice(0, 28),
      id: v.id || '',
    }));
    if (variants.length) {
      item.variants = variants;
      if (!item.quality && variants[0].quality) item.quality = variants[0].quality;
      if (!item.height && variants[0].height) item.height = variants[0].height;
    }
    if (m.drm) item.drm = m.drm;
    if (m.kind === 'media' && m.segmentCount) item.segmentCount = m.segmentCount;
    if (m.durationSec) item.duration = Math.max(item.duration || 0, m.durationSec);
    if (m.codecs && !item.codec) item.codec = String(m.codecs).slice(0, 24);
    if (m.isLive) item.isLive = true;
  }

  function decorate(it, title) {
    return Object.assign({}, it, {
      sizeLabel: it.size ? util.formatBytes(it.size) : '',
      segmentBytesLabel: it.segmentBytes ? util.formatBytes(it.segmentBytes) : '',
      durationLabel: it.duration && isFinite(it.duration) ? util.formatDuration(it.duration) : '',
      quality: it.quality || (it.height ? util.qualityLabel(it.height) : ''),
      thumb: it.poster || (title && title.poster) || '',
      showName: (title && title.title) || '',
    });
  }

  function rank(a, b) {
    return (
      (b.confidence || 0) - (a.confidence || 0) ||
      (rules.CATEGORY_WEIGHT[b.category] || 0) - (rules.CATEGORY_WEIGHT[a.category] || 0) ||
      (b.size || b.segmentBytes || 0) - (a.size || a.segmentBytes || 0) ||
      (b.ts || 0) - (a.ts || 0)
    );
  }

  SR.MediaStore = MediaStore;
  SR.MediaStore.LAYER_OF_VIA = LAYER_OF_VIA;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

/* ═════════════════════════ src/shared/dom-scanner.js ═════════════════════════ */
/**
 * Stream Radar — DOM / Service-Worker scanner (shared)
 * ==================================================================
 * LAYER 2 (DOM deep scan) and LAYER 4 (Service Worker + Cache API) live here so
 * that BOTH runtimes reuse one implementation:
 *   • the extension content script (src/content/content.js)
 *   • the userscript build for Tampermonkey / Violentmonkey (Android)
 *
 * Usage:
 *   SR.domScan.start({
 *     doc, win, isTop,
 *     emit: (entries, reason) => { …send to background / local store… },
 *     onTitle: (info) => { … },
 *     enabled: () => settings.layerDom,   // gates L2
 *     swEnabled: () => settings.layerSw,  // gates L4
 *   })
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;

  const SELECTOR =
    'video, audio, source, iframe, embed, object, link[rel="preload"][as="video"], link[rel="preload"][href], link[as="file"], a[download], img[src*=".m3u8"], img[src*=".mp4"]';

  function absUrl(win, doc, rel) {
    try {
      return new URL(rel, (doc && doc.baseURI) || win.location.href).href;
    } catch (_) {
      return /^(https?:|blob:)/i.test(rel) ? rel : '';
    }
  }

  SR.domScan = {
    create(opts) {
      const o = opts || {};
      const win = o.win || root;
      const doc = o.doc || win.document;
      const emit = o.emit || function () {};
      const isTop = o.isTop !== false;
      const seen = new Set();

      function entry(el, url, via, extra) {
        return {
          url: url,
          via: via,
          mime: (el && el.type) || '',
          tag: el && el.tagName,
          poster: (el && el.getAttribute && (el.getAttribute('poster') || '')) || '',
          frame: isTop ? 'top' : 'iframe',
          frameUrl: doc && doc.URL,
          height: extra && extra.height,
          width: extra && extra.width,
          duration: extra && extra.duration,
          size: (extra && extra.size) || 0,
        };
      }

      function scanTree(documentish, out, depth) {
        let nodes;
        try {
          nodes = documentish.querySelectorAll(SELECTOR);
        } catch (_) {
          return;
        }
        for (const el of nodes) {
          try {
            for (const attr of ['src', 'data', 'data-src', 'data-hls-url', 'data-mp4', 'data-file', 'href']) {
              const raw = el.getAttribute && el.getAttribute(attr);
              if (!raw) continue;
              const url = absUrl(win, documentish, raw);
              if (url) out.push(entry(el, url, attr === 'src' ? 'dom' : 'dom-' + attr));
            }
          } catch (_) {}
          try {
            for (const child of el.querySelectorAll ? el.querySelectorAll('source') : []) {
              const raw = child.getAttribute('src');
              if (raw) out.push(entry(child, absUrl(win, documentish, raw), 'dom-source'));
            }
          } catch (_) {}
          try {
            if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
              const cs = el.currentSrc || '';
              if (cs) out.push(entry(el, cs, 'dom-currentsrc', { height: el.videoHeight, width: el.videoWidth, duration: el.duration }));
            }
          } catch (_) {}
        }
        // recursive iframe walk — cross-origin frames throw and are simply
        // skipped here, because the extension/userscript runs inside them too.
        if (depth < 3) {
          try {
            for (const f of documentish.querySelectorAll('iframe')) {
              let cd = null;
              try {
                cd = f.contentDocument;
              } catch (_) {
                cd = null;
              }
              if (cd && cd !== documentish) scanTree(cd, out, depth + 1);
            }
          } catch (_) {}
        }
      }

      function scan(reason) {
        if (o.enabled && !o.enabled()) return;
        if (!doc || !doc.documentElement) return; // frame is being torn down
        const found = [];
        try {
          scanTree(doc, found, 0);
        } catch (_) {}
        const fresh = [];
        for (const f of found) {
          if (!f.url || seen.has(f.url)) continue;
          seen.add(f.url);
          fresh.push(f);
          if (fresh.length > 60) break;
        }
        if (fresh.length) emit(fresh, reason);
      }

      let mo = null;
      let timer = null;
      let cacheTimer = null;

      function startDom() {
        if (!doc) return;
        if (!doc.documentElement) {
          // document_start can run before the root element exists
          doc.addEventListener('readystatechange', function onRs() {
            if (doc.documentElement) {
              doc.removeEventListener('readystatechange', onRs);
              startDom();
            }
          });
          setTimeout(startDom, 200);
          return;
        }
        const throttled = util.throttle(() => scan('mutation'), 420);
        try {
          mo = new MutationObserver((muts) => {
            if (o.enabled && !o.enabled()) return;
            for (const m of muts) {
              if (m.type === 'attributes') return throttled();
              for (const n of m.addedNodes || []) if (n && n.nodeType === 1) return throttled();
            }
          });
          mo.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data', 'href', 'poster'] });
        } catch (_) {}
        try {
        } catch (_) {}
        scan('init');
        [500, 1500, 3500, 8000, 18000].forEach((ms) => setTimeout(() => scan('boot'), ms));
        timer = setInterval(() => scan('poll'), 2000);
        try {
          doc.addEventListener('loadedmetadata', () => scan('metadata'), true);
          doc.addEventListener('play', () => scan('play'), true);
          doc.addEventListener('seeked', util.throttle(() => scan('seek'), 2500), true);
        } catch (_) {}
      }

      /* -------- LAYER 4: Service Worker + CacheStorage -------- */
      const cacheSeen = new Set();
      async function scanCaches() {
        if (o.swEnabled && !o.swEnabled()) return;
        if (!win.caches || !isTop) return;
        try {
          const keys = await caches.keys();
          if (!keys.length) {
            o.onSw && o.onSw({ registered: false, caches: 0 });
            return;
          }
          const hits = [];
          let checked = 0;
          for (const name of keys.slice(0, 6)) {
            const cache = await caches.open(name);
            let reqs = [];
            try {
              reqs = await cache.keys();
            } catch (_) {}
            for (const req of reqs.slice(-500)) {
              const u = req && req.url;
              if (!u || cacheSeen.has(u)) continue;
              cacheSeen.add(u);
              checked++;
              if (/\.(m3u8|mpd|mp4|webm|mkv|m4v|ts|m4s)(\?|#|$)/i.test(u) || /video\//i.test(u)) {
                hits.push({ url: u, via: 'cache-api', cacheName: name, frame: isTop ? 'top' : 'iframe' });
              }
            }
            if (hits.length > 30) break;
          }
          o.onSw && o.onSw({ registered: true, caches: keys.length, names: keys.slice(0, 6), checked: checked });
          if (hits.length) emit(hits, 'cache');
        } catch (_) {}
      }

      /* -------- PART 2: title extraction -------- */
      let lastTitle = 0;
      function readTitle(force) {
        if (!isTop || !doc || !doc.documentElement || !SR.title) return null;
        if (!win || !win.location) return null; // document is gone
        const now = Date.now();
        if (!force && now - lastTitle < 900) return null;
        lastTitle = now;
        let info = null;
        try {
          info = SR.title.resolve(doc);
        } catch (_) {
          return null; // frame detached / document replaced: never throw out of a timer
        }
        if (!info) return null;
        if (!info) return null;
        const href = (win && win.location && win.location.href) || (doc && doc.URL) || '';
        info.host = util.host(href);
        info.url = href;
        if (!win || !win.location) return info;
        info.siteName = (doc.querySelector('meta[property="og:site_name"]') || {}).content || '';
        if (!info.poster) info.poster = (doc.querySelector('meta[property="og:image"]') || {}).content || '';
        if (!info.imdbId) {
          try {
            const m = doc.documentElement.innerHTML.slice(0, 500000).match(/tt\d{7,9}/);
            if (m) info.imdbId = m[0];
          } catch (_) {}
        }
        const meta = (info.mediaFromMeta || []).map((x) => ({ url: x.url, via: 'meta', frame: 'top' }));
        if (meta.length) emit(meta, 'og');
        o.onTitle && o.onTitle(info);
        return info;
      }

      return {
        start() {
          startDom();
          readTitle(true);
          [1200, 5000, 15000, 30000].forEach((ms) => setTimeout(() => readTitle(true), ms));
          if (win.MutationObserver) {
            // re-read the title when an SPA swaps the heading
            try {
              new MutationObserver(util.throttle(() => readTitle(false), 1500)).observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
            } catch (_) {}
          }
          setTimeout(scanCaches, 3500);
          cacheTimer = setInterval(scanCaches, 90000);
          win.addEventListener && win.addEventListener('focus', util.throttle(() => { scan('focus'); readTitle(false); }, 2000));
        },
        scan: scan,
        readTitle: readTitle,
        scanCaches: scanCaches,
        reset() {
          seen.clear();
        },
        stop() {
          try {
            mo && mo.disconnect();
          } catch (_) {}
          clearInterval(timer);
          clearInterval(cacheTimer);
        },
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* ═════════════════════════ src/shared/subtitles.js ═════════════════════════ */
/**
 * Stream Radar — subtitle engine (pure logic, no DOM)
 * ------------------------------------------------------------------
 * Providers (all optional, all fail-soft):
 *   1. SubDL          api.subdl.com          (needs a free API key)
 *   2. OpenSubtitles  api.opensubtitles.com  (needs a free API key)
 *   3. YIFY Subtitles best-effort (public endpoint, frequently offline)
 *
 * `opts.fetchImpl` lets unit tests inject a fake fetch. SRT→VTT conversion,
 * .gz and .zip unpacking are implemented in this file, so the extension ships
 * zero runtime dependencies for subtitles.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util || (SR.util = {});

  const ID_LANGS = new Set(['id', 'ind', 'indonesia', 'indonesian', 'bahasa indonesia', 'bahasa-indonesia']);
  const ID_RE = /(?:^|[\s._\-[(])(id|ind|indonesia|indonesian|bahasa[-_ ]?indonesia|sub[-_ ]?indo|subid)(?:$|[\s._\-)\]])/i;

  const subs = (SR.subs = {});

  /* ---------------------------------------------------------------- *
   * Decoding / unpacking
   * ---------------------------------------------------------------- */

  /** UTF-8 with latin-1 fallback (subtitle files are often cp1252). */
  subs.decodeSmart = function (buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
    let start = 0;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
    } catch (_) {
      for (const enc of ['windows-1252', 'windows-1250', 'latin1']) {
        try {
          const text = new TextDecoder(enc).decode(bytes.subarray(start));
          if (!/[ÃÂð][-¿]/.test(text)) return text;
        } catch (_) {}
      }
      return new TextDecoder('utf-8').decode(bytes.subarray(start));
    }
  };

  /** gunzip / raw-deflate using the platform DecompressionStream. */
  async function inflate(bytes, format) {
    if (!root.DecompressionStream) return bytes; // graceful: return raw
    try {
      const ds = new DecompressionStream(format);
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) {
      return null;
    }
  }
  subs.inflate = inflate;

  /** Minimal ZIP reader: returns every .srt/.vtt/.txt entry as text. */
  subs.readZip = async function (bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const out = [];
    if (u.length < 22) return out;

    // Locate End Of Central Directory (signature 0x06054b50) scanning backwards.
    let eocd = -1;
    const scanFrom = Math.max(0, u.length - 66000);
    for (let i = u.length - 22; i >= scanFrom; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return out;

    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);

    for (let n = 0; n < count && off + 46 <= u.length; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const uncompSize = dv.getUint32(off + 24, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = new TextDecoder().decode(u.subarray(off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;

      if (!/\.(srt|vtt|txt|sub)$/i.test(name)) continue;
      // Local file header: skip its own name/extra fields.
      if (localOff + 30 > u.length) continue;
      if (dv.getUint32(localOff, true) !== 0x04034b50) continue;
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      // Sizes in the central directory can be 0 for streamed zips → trust local header.
      const size = compSize || dv.getUint32(localOff + 18, true);
      const raw = u.subarray(dataStart, dataStart + size);
      let text = '';
      if (method === 0) text = subs.decodeSmart(raw);
      else if (method === 8) {
        const inflated = await inflate(raw, 'deflate-raw');
        if (inflated) text = subs.decodeSmart(inflated);
      }
      if (text && text.length > 20) out.push({ name, text });
      if (out.length >= 4) break;
    }
    return out;
  };

  /** Fetch an arbitrary subtitle URL (zip / gz / srt / vtt) → text. */
  subs.loadSubtitleFile = async function (url, opts) {
    const o = opts || {};
    const fetchImpl = o.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
    const headers = Object.assign({}, o.headers);
    const res = await fetchImpl(url, { headers, redirect: 'follow', credentials: o.credentials || 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' on subtitle file');
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const ctype = (res.headers && res.headers.get('content-type')) || '';
    const name = (res.headers && res.headers.get('content-disposition')) || url;

    if (/zip/i.test(ctype) || /\.zip(\?|$)/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      const entries = await subs.readZip(bytes);
      if (!entries.length) throw new Error('empty zip');
      entries.sort((a, b) => prefer(a.name, o.want) - prefer(b.name, o.want));
      return entries[0].text;
    }
    if (/gzip/i.test(ctype) || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      const inflated = await inflate(bytes, 'gzip');
      return subs.decodeSmart(inflated || bytes);
    }
    return subs.decodeSmart(bytes);

    function prefer(n, want) {
      const w = String(want || '').toLowerCase();
      let score = 0;
      if (w && n.toLowerCase().includes(w)) score -= 10;
      if (/id|ind|indonesia/i.test(n)) score -= 6;
      if (/\.srt$/i.test(n)) score -= 3;
      return score;
    }
  };

  /* ---------------------------------------------------------------- *
   * SRT → VTT
   * ---------------------------------------------------------------- */
  subs.srtToVtt = function (srt) {
    let src = String(srt || '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').trim();
    if (!src) return 'WEBVTT\n\n';
    if (/^WEBVTT/i.test(src)) return ensureCueIds(src);

    const lines = src.split('\n');
    const out = ['WEBVTT', '', ''];
    let inCue = false;
    let sawAnyTime = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const t = line.replace(/\s+$/, '');
      const time = t.match(/^\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*(?:-->|--?>>)\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}.*$/);
      if (time) {
        sawAnyTime = true;
        inCue = true;
        out.push(normaliseTiming(t));
        continue;
      }
      if (inCue && /^\s*$/.test(t)) {
        inCue = false;
        out.push('');
        continue;
      }
      if (!inCue && /^\d+$/.test(t.trim())) continue; // SRT numeric cue index
      if (inCue && /<\/?(?:i|b|u|font|c|ruby|rt)>/i.test(t)) {
        out.push(t.replace(/<font[^>]*>/gi, '<c>').replace(/<\/font>/gi, '</c>'));
        continue;
      }
      out.push(t.replace(/\\N/gi, '\n').replace(/\\h/gi, ' '));
    }
    if (!sawAnyTime) return 'WEBVTT\n\n<!-- not a parseable subtitle file -->\n';
    return ensureCueIds(out.join('\n').replace(/\n{3,}/g, '\n\n'));
  };

  function normaliseTiming(line) {
    return line
      .replace(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/g, (m, h, mi, s, ms) => pad(h, 2) + ':' + mi + ':' + s + '.' + pad(ms, 3))
      .replace(/(\d{2}):(\d{2})[.,](\d{1,3})\s*(-->|--?>>)\s*/g, '00:$1:$2.$3 --> ')
      .replace(/--?>>/g, '-->')
      .replace(/\s*-->\s*/, ' --> ')
      .replace(/[^\x20-\x7e\n]/g, (c) => c);
  }

  function pad(n, len) {
    return String(n).padStart(len, '0');
  }

  function ensureCueIds(text) {
    const body = text.replace(/^WEBVTT[^\n]*\n/, 'WEBVTT - Stream Radar\n');
    return body.replace(/\n{3,}/g, '\n\n');
  }

  /** Very small heuristic validation: how many cues does this file have? */
  subs.countCues = function (text) {
    return String(text || '').split('\n').filter((l) => /\d{1,2}:\d{2}:\d{2}([.,]\d{1,3})?\s*-->/.test(l)).length;
  };

  subs.looksLikeSubtitle = function (text) {
    const t = String(text || '');
    return /^WEBVTT/i.test(t.trim()) || /^\s*\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/.test(t) || /-->/.test(t);
  };

  /* ---------------------------------------------------------------- *
   * Matching helpers
   * ---------------------------------------------------------------- */
  subs.norm = function (s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  subs.isIndonesian = function (item) {
    const lang = String(item.langCode || item.lang || item.language || '').toLowerCase();
    if (lang && ID_LANGS.has(lang)) return true;
    const name = String(item.langName || item.languageName || '').toLowerCase();
    if (name && /indonesia/.test(name)) return true;
    if (!lang && !name) return ID_RE.test(String(item.filename || '') + ' ' + String(item.name || ''));
    return false;
  };

  subs.score = function (item, want) {
    const w = want || {};
    let s = 0;
    const name = subs.norm(item.name || item.filename || '');
    const title = subs.norm(w.title);
    if (title) {
      if (name === title) s += 60;
      else if (name.includes(title)) s += 40;
      else {
        const tokens = title.split(' ').filter((t) => t.length > 2);
        const hit = tokens.filter((t) => name.includes(t)).length;
        s += tokens.length ? Math.round((hit / tokens.length) * 30) : 0;
      }
    }
    if (w.year && String(item.year || '').includes(w.year)) s += 18;
    else if (w.year && item.year && String(item.year) !== String(w.year)) s -= 12;

    const ep = w.episode ? String(w.episode).replace(/^0+(?=\d)/, '') : '';
    const season = w.season ? String(w.season).replace(/^0+(?=\d)/, '') : '';
    const itemEp = item.episode ? String(item.episode).replace(/^0+(?=\d)/, '') : '';
    const itemSeason = item.season ? String(item.season).replace(/^0+(?=\d)/, '') : '';
    if (ep) {
      if (itemEp === ep && (!season || itemSeason === season)) s += 55;
      else if (itemEp === ep) s += 25;
      else if (itemEp) s -= 35; // clearly another episode
    } else if (itemEp) s -= 8; // series subs when we wanted a movie

    if (/srt/i.test(String(item.format || ''))) s += 8;
    if (item.verified) s += 6;
    if (item.downloads) s += Math.min(15, Math.log10(item.downloads + 1) * 6);
    if (item.aiTranslated) s -= 12;
    if (subs.isIndonesian(item)) s += 25;
    return s;
  };

  subs.filterIndonesian = function (list, strict) {
    const kept = list.filter((x) => subs.isIndonesian(x));
    return kept.length || strict ? kept : list;
  };

  /* ---------------------------------------------------------------- *
   * Providers
   * ---------------------------------------------------------------- */

  /** api.subdl.com — needs a free API key from https://subdl.com/panel/api */
  subs.subdl = {
    id: 'subdl',
    label: 'SubDL',
    needsKey: true,
    async search(want, settings, ctx) {
      const key = settings.subdlApiKey;
      if (!key) return { ok: false, skipped: true, reason: 'API key belum diisi' };
      const params = new URLSearchParams();
      params.set('api_key', key);
      params.set('query', want.title || '');
      if (want.year) params.set('year', String(want.year));
      if (want.imdbId) params.set('imdb_id', want.imdbId);
      if (want.tmdbId) params.set('tmdb_id', String(want.tmdbId));
      if (want.season) params.set('season_number', String(want.season));
      if (want.episode) params.set('episode_number', String(want.episode));
      params.set('formats', 'srt');
      if (settings.subtitleLang && settings.subtitleLang !== 'all') params.set('lang', settings.subtitleLang);
      params.set('pg', '1');
      const json = await getJson('https://api.subdl.com/api/v1/subtitles?' + params.toString(), {}, ctx);
      if (!json || !json.results) return { ok: false, reason: 'no results' };
      const items = json.results.map((r) => {
        const a = r.attributes || r;
        return {
          provider: 'subdl',
          providerLabel: 'SubDL',
          id: String(a.id || r.id || ''),
          name: a.name || a.movie || want.title,
          filename: a.filename || '',
          langCode: (a.lang && (a.lang.code || a.lang.locale)) || 'id',
          langName: (a.lang && a.lang.name) || 'Indonesian',
          format: (a.format || 'srt').toLowerCase(),
          year: a.year || '',
          season: a.seasonNumber || '',
          episode: a.episodeNumber || '',
          downloads: Number(a.downloadCount || a.downloads || 0),
          verified: !!a.verified,
          aiTranslated: !!a.ai,
          uploader: (a.uploader && (a.uploader.name || a.uploader.username)) || '',
          pageUrl: a.url || '',
          raw: a,
        };
      });
      return { ok: true, items };

      async function getJson(url, headers, c) {
        const fetchImpl = c.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
        const res = await fetchImpl(url, { headers: Object.assign({ Accept: 'application/json' }, headers) });
        if (!res.ok) throw new Error('SubDL HTTP ' + res.status);
        return await res.json();
      }
    },
    async fetchFile(item, settings, ctx) {
      const key = settings.subdlApiKey;
      const url = 'https://api.subdl.com/api/v1/subtitles/download?api_key=' + encodeURIComponent(key) + '&id=' + encodeURIComponent(item.id);
      const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('SubDL download HTTP ' + res.status);
      const json = await res.json();
      const link = json && json.results && json.results.attributes && json.results.attributes.link;
      if (!link) throw new Error('SubDL: no download link');
      return await subs.loadSubtitleFile(link, { fetchImpl, want: 'id' });
    },
  };

  /** api.opensubtitles.com — free "API key" (origin-bound) from the dev portal. */
  subs.opensubtitles = {
    id: 'opensubtitles',
    label: 'OpenSubtitles',
    needsKey: true,
    headers(settings) {
      const h = { Accept: 'application/json', 'User-Agent': settings.osUserAgent || 'StreamRadar/1.0' };
      if (settings.osApiKey) h.Authorization = (settings.osApiKey.indexOf('ApiKey ') === 0 ? '' : 'ApiKey ') + settings.osApiKey;
      return h;
    },
    async search(want, settings, ctx) {
      if (!settings.osApiKey) return { ok: false, skipped: true, reason: 'API key belum diisi' };
      const q = want.episode
        ? (want.show || want.title) + ' ' + (want.season ? 'S' + String(want.season).padStart(2, '0') + 'E' + String(want.episode).padStart(2, '0') : 'E' + want.episode)
        : want.title;
      const params = new URLSearchParams();
      params.set('query', q);
      if (settings.subtitleLang && settings.subtitleLang !== 'all') params.set('language_id', settings.subtitleLang);
      if (want.year) params.set('year', String(want.year));
      if (want.imdbId) params.set('imdb_id', want.imdbId);
      if (want.tmdbId) params.set('tmdb_id', String(want.tmdbId));
      if (want.season) params.set('season_number', String(want.season));
      if (want.episode) params.set('episode_number', String(want.episode));
      params.set('format', 'srt');
      params.set('featured_only', 'false');
      params.set('aggregated', 'false');
      const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const res = await fetchImpl('https://api.opensubtitles.com/api/v1/subtitles?' + params.toString(), { headers: this.headers(settings) });
      if (res.status === 401 || res.status === 403) throw new Error('OpenSubtitles: API key ditolak (401/403)');
      if (!res.ok) throw new Error('OpenSubtitles HTTP ' + res.status);
      const json = await res.json();
      const items = (json.data || []).map((d) => {
        const a = d.attributes || {};
        const files = ((d.relationships || {}).files || {}).data || [];
        const first = files[0] || {};
        return {
          provider: 'opensubtitles',
          providerLabel: 'OpenSubtitles',
          id: String(a.feature_id || (first.attributes && first.attributes.file_id) || d.id || ''),
          fileIds: files.map((f) => (f.attributes && f.attributes.file_id) || f.id).filter(Boolean),
          name: (a.movie || a.movie_name || a.caption || '').toString().trim() || q,
          filename: (first.attributes && first.attributes.cdn_url ? String(first.attributes.cdn_url).split('/').pop() : '') || '',
          langCode: a.language || '',
          langName: a.language || '',
          format: 'srt',
          year: a.year || '',
          season: a.season_number || '',
          episode: a.episode_number || '',
          downloads: Number(a.download_count || 0),
          verified: /verified|trusted/i.test(String((a.features || []).join(' '))),
          aiTranslated: /machine translated|ai/i.test(String((a.features || []).join(' '))),
          uploader: a.uploader_name || '',
          pageUrl: '',
          raw: a,
        };
      });
      return { ok: true, items, total: (json.data || []).length, infos: json.infos };
    },
    async fetchFile(item, settings, ctx) {
      const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const ids = (item.fileIds && item.fileIds.length ? item.fileIds : [item.id]).map((id) => ({ file_id: Number(id) || id }));
      const res = await fetchImpl('https://api.opensubtitles.com/api/v1/download', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, this.headers(settings)),
        body: JSON.stringify({ files: ids }),
      });
      if (!res.ok) throw new Error('OpenSubtitles download HTTP ' + res.status);
      const json = await res.json();
      const link = json && json.link;
      if (!link) throw new Error('OpenSubtitles: no download link');
      return await subs.loadSubtitleFile(link, { fetchImpl, headers: { 'User-Agent': settings.osUserAgent || '' }, want: 'id' });
    },
  };

  /**
   * YIFY Subtitles — legacy public endpoints. Kept as the third fallback:
   * no key required, but the service is intermittently offline; every failure
   * is swallowed and reported in the UI as "not available".
   */
  subs.yify = {
    id: 'yify',
    label: 'YIFY (fallback)',
    needsKey: false,
    bases: ['https://yifysubtitles.org', 'https://www.yifysubtitles.ch', 'https://yifysubtitles.ag'],
    async search(want, settings, ctx) {
      const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const lastErr = [];
      for (const base of this.bases) {
        try {
          const q = want.imdbId || want.title;
          const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const res = await fetchImpl(base + '/chrome-api?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const text = await res.text();
          const json = util.safeJSON ? util.safeJSON(text, null) : JSON.parse(text);
          if (!Array.isArray(json) || !json.length) throw new Error('no data');
          const items = json
            .map((r) => ({
              provider: 'yify',
              providerLabel: 'YIFY',
              id: String(r.id || r.subtitle_link || ''),
              name: r.movie_title || want.title,
              filename: String(r.subtitle_link || '').split('/').pop() || 'subtitle.srt',
              langCode: String(r.lang || '').slice(0, 2).toLowerCase(),
              langName: r.language || r.lang || '',
              format: 'srt',
              year: '',
              season: '',
              episode: '',
              downloads: Number(r.downloads || 0),
              verified: false,
              uploader: '',
              pageUrl: base + (r.yifysubtitles_link || ''),
              fileUrl: /^https?:/.test(String(r.subtitle_link || '')) ? r.subtitle_link : base + r.subtitle_link,
              raw: r,
            }))
            .filter((x) => subs.isIndonesian(x) || !settings.autoSubtitle);
          return { ok: true, items };
        } catch (e) {
          lastErr.push(base + ': ' + e.message);
        }
      }
      return { ok: false, skipped: true, reason: lastErr[0] || 'unreachable' };
    },
    async fetchFile(item, settings, ctx) {
      const f = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      return await subs.loadSubtitleFile(item.fileUrl, { fetchImpl: f, want: 'id' });
    },
  };

  subs.providers = [subs.subdl, subs.opensubtitles, subs.yify];

  /* ---------------------------------------------------------------- *
   * Orchestration
   * ---------------------------------------------------------------- */

  /**
   * Search every enabled provider in parallel, merge, filter Indonesian,
   * rank by `subs.score`.
   * @returns {{results: object[], providerInfo: object, errors: string[]}}
   */
  subs.search = async function (want, settings, opts) {
    const o = opts || {};
    const ctx = { fetchImpl: o.fetchImpl };
    const enabled = subs.providers.filter((p) => ((settings.providers || {})[p.id] !== false));
    const providerInfo = {};
    for (const p of subs.providers) if (enabled.indexOf(p) < 0) providerInfo[p.id] = { label: p.label, status: 'disabled' };
    const errors = [];
    const all = [];

    const settled = await Promise.allSettled(
      enabled.map(async (p) => {
        providerInfo[p.id] = { label: p.label, status: 'searching' };
        try {
          const r = await p.search(want, settings, ctx);
          if (r && r.skipped) {
            providerInfo[p.id] = { label: p.label, status: 'skipped', reason: r.reason };
            return [];
          }
          providerInfo[p.id] = { label: p.label, status: 'ok', count: r.items.length };
          return r.items || [];
        } catch (e) {
          providerInfo[p.id] = { label: p.label, status: 'error', reason: String((e && e.message) || e) };
          errors.push(p.label + ': ' + ((e && e.message) || e));
          return [];
        }
      })
    );
    for (const s of settled) if (s.status === 'fulfilled') all.push(...s.value);

    const seen = new Set();
    const deduped = all.filter((it) => {
      const k = subs.norm(it.name) + '|' + it.langCode + '|' + (it.filename || '') + '|' + it.provider;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const scored = deduped
      .map((it) => Object.assign(it, { score: subs.score(it, want) }))
      .sort((a, b) => b.score - a.score);

    const filtered = subs.filterIndonesian(scored, (settings.subtitleLang || 'id') !== 'all');
    const list = (filtered.length ? filtered : scored).slice(0, o.limit || 25);
    list.forEach((it, i) => (it.rank = i + 1));
    return { results: list, providerInfo, errors };
  };

  /** Download + convert the given result to WebVTT text. */
  subs.resolve = async function (item, settings, opts) {
    const o = opts || {};
    const provider = subs.providers.find((p) => p.id === item.provider);
    if (!provider) throw new Error('unknown provider ' + item.provider);
    const fetchImpl = o.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
    let text;
    if (item.fileUrl) text = await subs.loadSubtitleFile(item.fileUrl, { fetchImpl, want: 'id' });
    else text = await provider.fetchFile(item, settings, { fetchImpl });
    if (!subs.looksLikeSubtitle(text)) throw new Error('file is not a subtitle track');
    return subs.srtToVtt(text);
  };

  subs.buildVttFromScratch = subs.srtToVtt; // explicit alias for readers
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

/* ═════════════════════════ src/shared/watchparty-auto.js ═════════════════════════ */
/**
 * Stream Radar — WatchParty automation core (context-agnostic)
 * ------------------------------------------------------------------
 * Shared by:
 *   • the extension content script src/watchparty/watchparty.js
 *   • the userscript build (tools/build-userscript.mjs → host.js)
 *
 * WatchParty (github.com/howardchung/watchparty) exposes no REST API for room
 * creation, so this module drives its DOM. Matching is *semantic* (label /
 * placeholder / aria-label / name / id text) instead of selector-based, because
 * the React app is rebuilt often and class names are hashed.
 *
 * What it can do:
 *   • fill the room name and the user name on the landing / join form
 *   • fill the "media URL" field if the room was opened without ?url=
 *   • optionally click Join
 *   • attach a WebVTT subtitle track to the room's <video>, re-applying it after
 *     React re-renders (WatchParty natively plays direct files and .m3u8 HLS)
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;

  const NAME_HINT = /(room|party)\s*name|roomname|nama\s*room|^room$/i;
  const USER_HINT = /(user|display|nick)\s*name|username|nama\s*(pengguna|kamu)/i;
  const URL_HINT = /(media|video|url|link|src)\s*(url|link)?|paste.*(url|link)|url\s*(of|the)?\s*(video|media)/i;

  function labelOf(el) {
    const parts = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('name'), el.id];
    try {
      if (el.labels) for (const l of el.labels) parts.push(l.textContent);
      // Only use a wrapper's text when it wraps exactly this control, otherwise
      // a sibling's label leaks in and we fill the wrong field.
      const wrap = el.closest('label');
      if (wrap) parts.push(wrap.textContent);
      else {
        const box = el.closest('[class*="field"], [class*="row"], [class*="input"]');
        if (box && box.querySelectorAll('input, textarea').length === 1) parts.push(box.textContent);
      }
      const prev = el.previousElementSibling;
      if (prev && prev.children.length === 0) parts.push(prev.textContent);
    } catch (_) {}
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function hasLayout(el) {
    // offsetWidth/offsetHeight are 0 while the node is not laid out (and in
    // headless test DOMs) — that must not make us give up on a real form field.
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    if (w === 0 && h === 0) return null; // unknown → treat as "maybe visible"
    return w > 4 && h > 4;
  }

  function fields(doc) {
    const all = [...doc.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea')].filter(
      (el) => !el.disabled && !el.readOnly
    );
    const laid = all.filter((el) => hasLayout(el) !== false);
    return (laid.length ? laid : all).map((el) => ({ el, label: labelOf(el) }));
  }

  function setValue(el, value) {
    if (!el || value == null || value === '') return false;
    if (el.value && el.value.trim()) return false;
    try {
      const proto = el.tagName === 'TEXTAREA' ? root.HTMLTextAreaElement : root.HTMLInputElement;
      const desc = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, String(value));
      else el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (_) {
      el.value = String(value);
      return false;
    }
  }

  function findButton(doc, re) {
    const list = [...doc.querySelectorAll('button, [role="button"], input[type=submit], a[class*="button"]')];
    return list.find((b) => {
      const txt = (b.textContent || b.value || '').trim().replace(/\s+/g, ' ');
      return txt && txt.length < 44 && re.test(txt) && !b.disabled && b.offsetWidth !== 0 ? true : txt && txt.length < 44 && re.test(txt) && !b.disabled;
    });
  }

  SR.watchparty = {
    /**
     * @param {object} opts
     *   doc       Document
     *   payload   {mediaUrl, roomName, userName, autoJoin, subtitle:{vtt,name}}
     *   onStatus(text, kind)
     *   t(key, vars) optional translator
     * @returns {{cancel:Function}}
     */
    run(opts) {
      const doc = opts.doc || root.document;
      const p = opts.payload || {};
      const status = opts.onStatus || function () {};
      const t = opts.t || ((k) => k);
      const state = { done: false, joined: false, attached: false, blobUrls: [], timer: null, observers: [] };
      let attempts = 0;

      function tryForm() {
        if (state.done) return;
        attempts++;
        let touched = 0;
        const f = fields(doc);
        const room = f.find((x) => NAME_HINT.test(x.label));
        const user = f.find((x) => USER_HINT.test(x.label));
        const urlField = p.mediaUrl ? f.find((x) => URL_HINT.test(x.label) && !/search/i.test(x.label)) : null;
        const joinBtn = findButton(doc, /^(join|create|enter|make|gabung|masuk)\b/i);

        if (room) touched += setValue(room.el, p.roomName) ? 1 : 0;
        if (user) touched += setValue(user.el, p.userName || 'Stream Radar') ? 1 : 0;
        if (urlField) touched += setValue(urlField.el, p.mediaUrl) ? 1 : 0;

        if (touched) status('Stream Radar filled the room form (' + touched + ' field' + (touched > 1 ? 's' : '') + ')', 'ok');
        if (p.autoJoin !== false && joinBtn && !state.joined) {
          state.joined = true;
          setTimeout(() => {
            try {
              joinBtn.click();
              status('Joining room…', 'info');
            } catch (_) {}
          }, 320);
        }
        // landing page already gone → we are inside a room
        if (!room && !user && !urlField && (doc.querySelector('video') || /\/watch\/|watchNow/i.test(root.location.href))) state.done = true;
        if (attempts > 45) state.done = true;
      }

      // Object URLs can be patched/restricted by the host page; a data: URL is a
      // perfectly valid <track src> fallback and needs no revocation.
      function makeVttUrl(vtt) {
        try {
          if (root.URL && typeof root.URL.createObjectURL === 'function' && root.Blob) {
            return root.URL.createObjectURL(new root.Blob([vtt], { type: 'text/vtt' }));
          }
        } catch (_) {}
        try {
          return 'data:text/vtt;charset=utf-8,' + encodeURIComponent(vtt);
        } catch (_) {
          return '';
        }
      }

      function attachTracks(vtt, name, force) {
        if (!vtt) return 0;
        let url = state.blobUrl;
        if (!url || force) {
          url = makeVttUrl(vtt);
          if (!url) return 0;
          state.blobUrl = url;
          if (url.indexOf('blob:') === 0) state.blobUrls.push(url);
        }
        let n = 0;
        for (const video of doc.querySelectorAll('video')) {
          try {
            if (video.querySelector('track[data-srad="1"]')) {
              n++;
              continue;
            }
            const track = doc.createElement('track');
            track.kind = 'subtitles';
            track.srclang = 'id';
            track.label = (name || 'Indonesian') + ' (Stream Radar)';
            track.default = true;
            track.setAttribute('data-srad', '1');
            track.src = url;
            video.appendChild(track);
            try {
              const tt = video.textTracks;
              for (let i = 0; i < tt.length; i++) if (/Stream Radar/.test(tt[i].label || '')) tt[i].mode = 'showing';
            } catch (_) {}
            n++;
          } catch (_) {}
        }
        if (n) state.attached = true;
        return n;
      }

      function chip() {
        if (state.chip || !doc.body) return;
        const host = doc.createElement('div');
        host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;font-family:system-ui,sans-serif';
        const shadow = host.attachShadow({ mode: 'closed' });
        shadow.innerHTML =
          '<style>:host{all:initial}.wrap{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:14px;background:rgba(20,23,38,.86);backdrop-filter:blur(10px);color:#e9edf7}button{font:600 12px system-ui;padding:8px 11px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:#fff;cursor:pointer;min-height:36px}button:hover{border-color:#8b7cff}span{font:700 11px system-ui;opacity:.7}</style>' +
          '<div class="wrap"><span>STREAM RADAR</span><button data-a="subs">' + t('panel.subs.attach') + '</button><button data-a="copy">' + t('action.copy') + '</button><button data-a="dl">' + t('panel.subs.download') + '</button></div>';
        doc.body.appendChild(host);
        state.chip = host;
        shadow.addEventListener('click', (e) => {
          const b = e.target.closest && e.target.closest('[data-a]');
          if (!b) return;
          const a = b.getAttribute('data-a');
          if (a === 'subs') {
            const n = attachTracks((p.subtitle || {}).vtt, (p.subtitle || {}).name, true);
            status(n ? t('panel.subs.found') + ' x' + n : t('panel.subs.none'), n ? 'ok' : 'warn');
          } else if (a === 'copy') {
            try {
              navigator.clipboard.writeText(p.mediaUrl || '');
              status(t('toast.copied'), 'ok');
            } catch (_) {}
          } else if (a === 'dl') {
            const vtt = (p.subtitle || {}).vtt;
            if (!vtt) return status(t('panel.subs.none'), 'warn');
            const a2 = doc.createElement('a');
            a2.href = state.blobUrl || root.URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
            a2.download = String(p.roomName || 'subtitles').replace(/[\\/:*?"<>|]/g, '.') + '.id.vtt';
            doc.body.appendChild(a2);
            a2.click();
            a2.remove();
          }
        });
      }

      function tick() {
        try {
          tryForm();
          chip();
          if (!state.attached && p.subtitle && p.subtitle.vtt && doc.querySelector('video')) attachTracks(p.subtitle.vtt, p.subtitle.name, false);
        } catch (_) {}
      }

      state.timer = setInterval(tick, 900);
      tick();
      try {
        const mo = new MutationObserver(util.throttle(tick, 700));
        mo.observe(doc.documentElement, { childList: true, subtree: true });
        state.observers.push(mo);
      } catch (_) {}

      return {
        state: state,
        attach: (vtt, name) => attachTracks(vtt, name, true),
        stop() {
          clearInterval(state.timer);
          state.observers.forEach((o) => {
            try {
              o.disconnect();
            } catch (_) {}
          });
          state.blobUrls.forEach((u) => {
            try {
              URL.revokeObjectURL(u);
            } catch (_) {}
          });
          if (state.chip) state.chip.remove();
        },
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* ═════════════════════════ src/shared/updater.js ═════════════════════════ */
/**
 * Stream Radar — live rule packs + signed hot patches
 * ==================================================================
 * Goal: when something is broken (a new embed host, a new ad domain, a new SEO
 * junk word, a changed subtitle API) the fix ships from GitHub and the already
 * installed extension picks it up on its own. No uninstall, no reinstall, no
 * store review.
 *
 * Two channels, deliberately separated by risk:
 *
 *  1. RULE PACK (data only, enabled by default)
 *     `rules/rules.json` + `rules/rules.json.sig` on the `live` branch.
 *     Additive only: a pack may add hosts / extensions / junk words, it can
 *     never remove a built-in rule, so a stale or bad pack cannot blind us.
 *     Verified with an embedded ECDSA P-256 public key (WebCrypto).
 *
 *  2. CODE PATCH (JavaScript, OFF by default, opt-in in Options)
 *     `patch/patch.js` + `.sig` + `patch/meta.json`, same signature requirement.
 *     Executed with `new Function()` inside the *content script* isolated world
 *     (never in the page, never via innerHTML), versioned and revocable by
 *     deleting the file from the `live` branch.
 *
 * Verification happens ONLY in the background worker: it is always a secure
 * context, so `crypto.subtle` exists there. Content scripts simply receive the
 * already-verified payload, which also keeps http:// pages working.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;

  const PUBLIC_KEY_JWK = {
    kty: 'EC',
    crv: 'P-256',
    x: 'dAR-4Qdjs2zq0VFxBgyAimWA_TkwY3-pySuLXFnhp6c',
    y: 'UoJ_C4deba9gBFfxJA534F0V0OnSbUGei7XNRDaJyIY',
    ext: true,
    key_ops: ['verify'],
  };

  const LIMITS = { hosts: 400, ext: 40, phrases: 200, tokens: 400, patternChars: 4000, patchChars: 120000 };

  let keyPromise = null;
  function importKey() {
    if (!root.crypto || !root.crypto.subtle) return Promise.reject(new Error('WebCrypto unavailable in this context'));
    if (!keyPromise) {
      keyPromise = root.crypto.subtle.importKey('jwk', PUBLIC_KEY_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    }
    return keyPromise;
  }

  /** DER → raw r||s (WebCrypto wants the raw form; node's crypto.sign gives DER). */
  function normaliseSignature(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u.length === 64) return u;
    // ECDSA-Sig-Value: SEQUENCE { INTEGER r, INTEGER s }
    try {
      let i = 0;
      if (u[i++] !== 0x30) throw new Error('bad seq');
      i++; // total length
      const readInt = () => {
        if (u[i++] !== 0x02) throw new Error('bad int');
        const len = u[i++];
        const slice = u.subarray(i, i + len);
        i += len;
        return slice;
      };
      const r = readInt();
      const s = readInt();
      const out = new Uint8Array(64);
      out.set(r.slice(-64), 64 - Math.min(64, r.length));
      out.set(s.slice(-64), 128 - Math.min(64, s.length));
      return out;
    } catch (_) {
      return null;
    }
  }

  function b64ToBytes(s) {
    const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
    try {
      const bin = atob(t);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (_) {
      return null;
    }
  }

  const updater = (SR.updater = {
    PUBLIC_KEY_JWK,
    LIMITS,
    b64ToBytes,
    normaliseSignature,

    /** @returns {Promise<boolean>} */
    async verify(text, sigB64) {
      try {
        const key = await importKey();
        const sig = normaliseSignature(b64ToBytes(sigB64));
        if (!sig) return false;
        const data = new TextEncoder().encode(String(text));
        return await root.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
      } catch (e) {
        return false;
      }
    },

    /** Shape-check + clamp a raw pack so a malicious/typo payload can't DoS us. */
    sanitizePack(raw) {
      const out = {
        version: 0,
        minAppVersion: '0.0.0',
        embedHosts: [],
        adHosts: [],
        mediaExt: [],
        junkPhrases: [],
        junkTokens: [],
        blockPatterns: '',
        notes: '',
      };
      if (!raw || typeof raw !== 'object') return null;
      const strList = (v, max) =>
        Array.isArray(v)
          ? v
              .filter((x) => typeof x === 'string' && x.length > 1 && x.length < 120)
              .map((x) => x.toLowerCase().replace(/[^a-z0-9.*_\- ]/g, '').trim())
              .filter(Boolean)
              .slice(0, max)
          : [];
      out.version = Number(raw.version) || 0;
      out.minAppVersion = String(raw.minAppVersion || '0.0.0').slice(0, 20);
      out.embedHosts = strList(raw.embedHosts, LIMITS.hosts);
      out.adHosts = strList(raw.adHosts, LIMITS.hosts);
      out.mediaExt = strList(raw.mediaExt, LIMITS.ext).map((x) => x.replace(/[^a-z0-9]/g, '')).filter((x) => x.length >= 2 && x.length <= 5);
      out.junkPhrases = (Array.isArray(raw.junkPhrases) ? raw.junkPhrases : []).filter((x) => typeof x === 'string' && x.length > 1 && x.length < 80).slice(0, LIMITS.phrases);
      out.junkTokens = strList(raw.junkTokens, LIMITS.tokens);
      out.blockPatterns = typeof raw.blockPatterns === 'string' ? raw.blockPatterns.slice(0, LIMITS.patternChars) : '';
      out.notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 400) : '';
      return out;
    },

    /** Merge a pack into SR.dynamic (idempotent + additive). Returns counts. */
    applyPack(pack) {
      const dyn = SR.dynamic;
      if (!dyn || !pack) return null;
      const add = (list, items) => {
        let n = 0;
        for (const v of items || []) if (v && list.indexOf(v) < 0) (list.push(v), n++);
        return n;
      };
      const added = {
        embedHosts: add(dyn.embedHosts, pack.embedHosts),
        adHosts: add(dyn.adHosts, pack.adHosts),
        junkPhrases: add((dyn.junkPhrases = dyn.junkPhrases || []), pack.junkPhrases),
        junkTokens: add((dyn.junkTokens = dyn.junkTokens || []), pack.junkTokens),
        mediaExt: 0,
      };
      for (const e of pack.mediaExt || []) if (!dyn.mediaExt.has(e)) (dyn.mediaExt.add(e), added.mediaExt++);
      dyn.blockPatterns = pack.blockPatterns || '';
      dyn.version = pack.version || dyn.version || 0;
      dyn.loadedAt = Date.now();
      return added;
    },

    /** Compare a pack against the app version via semver-ish tuple. */
    compatible(pack, appVersion) {
      const cmp = (a, b) => {
        const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
        const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
        for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
        return 0;
      };
      return cmp(appVersion || SR.VERSION, pack.minAppVersion || '0.0.0') >= 0;
    },

    /**
     * Background only: fetch, verify, apply, persist.
     * @param {{settings:object, appVersion?:string, force?:boolean, log?:Function}} o
     */
    async checkForUpdates(o) {
      const opts = o || {};
      const settings = opts.settings || {};
      const log = opts.log || function () {};
      if (settings.updateEnabled === false) return { status: 'disabled' };
      const base = (settings.updateUrl || 'https://raw.githubusercontent.com/ryany5517-hash/Media-ex/live/').replace(/\/?$/, '/');
      const res = { status: 'error', at: Date.now() };
      try {
        const body = await util.fetchText(base + 'rules/rules.json', { timeoutMs: 15000, maxBytes: 400000, credentials: 'omit' });
        const pack = updater.sanitizePack(util.safeJSON(body, null));
        if (!pack) throw new Error('pack unreadable');
        let sigText = '';
        try {
          sigText = (await util.fetchText(base + 'rules/rules.json.sig', { timeoutMs: 10000, maxBytes: 4096, credentials: 'omit' })).trim();
        } catch (_) {
          sigText = '';
        }
        if (!sigText) throw new Error('no signature (refusing unsigned rules)');
        const ok = await updater.verify(body, sigText);
        if (!ok) throw new Error('bad signature');
        if (!updater.compatible(pack, opts.appVersion || SR.VERSION)) return Object.assign(res, { status: 'incompatible', version: pack.version });
        SR.dynamic.signatureOk = true;
        updater.applyPack(pack);
        res.status = pack.version > (settings.rulesVersion || 0) ? 'updated' : 'current';
        res.version = pack.version;
        res.notes = pack.notes;
        if (res.status === 'updated' && opts.persist) await opts.persist({ pack: pack, fetchedAt: Date.now(), version: pack.version });
        // optional code patch
        if (settings.autoPatch) {
          try {
            const meta = util.safeJSON(await util.fetchText(base + 'patch/meta.json', { timeoutMs: 10000, maxBytes: 4096, credentials: 'omit' }), null);
            if (meta && meta.file && Number(meta.version) > Number(settings.patchVersion || 0) && updater.compatible(meta, opts.appVersion || SR.VERSION)) {
              const code = await util.fetchText(base + 'patch/' + meta.file, { timeoutMs: 15000, maxBytes: LIMITS.patchChars, credentials: 'omit' });
              let psig = '';
              try {
                psig = (await util.fetchText(base + 'patch/' + meta.file + '.sig', { timeoutMs: 10000, maxBytes: 4096, credentials: 'omit' })).trim();
              } catch (_) {
                psig = '';
              }
              if (!psig) throw new Error('signature');
              if (code.length <= LIMITS.patchChars && (await updater.verify(code, psig))) {
                res.patch = { version: meta.version, code: code, changelog: String(meta.changelog || '').slice(0, 300) };
                if (opts.persistPatch) await opts.persistPatch(res.patch);
              } else {
                log('patch rejected: signature');
                res.patchError = 'signature';
              }
            }
          } catch (e) {
            res.patchError = String((e && e.message) || e);
          }
        }
        return res;
      } catch (e) {
        res.error = String((e && e.message) || e);
        log('update check failed', res.error);
        return res;
      }
    },

    /**
     * Content script side: apply the pack the background already verified.
     * Kept separate so no content script ever parses remote JSON directly.
     */
    applyRemote(pack, patch, settings) {
      const p = updater.sanitizePack(pack);
      if (p) {
        SR.dynamic.signatureOk = true;
        updater.applyPack(p);
      }
      const allowed = settings ? settings.autoPatch === true : true;
      if (allowed && patch && patch.code && typeof patch.code === 'string' && patch.code.length <= LIMITS.patchChars) {
        // The signature was verified by the background worker before storage.
        try {
          new Function('"use strict";\n' + patch.code)(root.SR, root);
          SR.patchApplied = patch.version || 0;
          return true;
        } catch (e) {
          SR.patchError = String((e && e.message) || e);
          return false;
        }
      }
      return false;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

/* ═════════════════════════ src/vendor/motion.min.js ═════════════════════════ */
!function(t,e){"object"==typeof exports&&"undefined"!=typeof module?e(exports):"function"==typeof define&&define.amd?define(["exports"],e):e((t="undefined"!=typeof globalThis?globalThis:t||self).Motion={})}(this,(function(t){"use strict";const e=t=>t;let n=e;function s(t){let e;return()=>(void 0===e&&(e=t()),e)}const i=(t,e,n)=>{const s=e-t;return 0===s?1:(n-t)/s},r=t=>1e3*t,o=t=>t/1e3,a=s(()=>void 0!==window.ScrollTimeline);class l extends class{constructor(t){this.stop=()=>this.runAll("stop"),this.animations=t.filter(Boolean)}get finished(){return Promise.all(this.animations.map(t=>"finished"in t?t.finished:t))}getAll(t){return this.animations[0][t]}setAll(t,e){for(let n=0;n<this.animations.length;n++)this.animations[n][t]=e}attachTimeline(t,e){const n=this.animations.map(n=>a()&&n.attachTimeline?n.attachTimeline(t):"function"==typeof e?e(n):void 0);return()=>{n.forEach((t,e)=>{t&&t(),this.animations[e].stop()})}}get time(){return this.getAll("time")}set time(t){this.setAll("time",t)}get speed(){return this.getAll("speed")}set speed(t){this.setAll("speed",t)}get startTime(){return this.getAll("startTime")}get duration(){let t=0;for(let e=0;e<this.animations.length;e++)t=Math.max(t,this.animations[e].duration);return t}runAll(t){this.animations.forEach(e=>e[t]())}flatten(){this.runAll("flatten")}play(){this.runAll("play")}pause(){this.runAll("pause")}cancel(){this.runAll("cancel")}complete(){this.runAll("complete")}}{then(t,e){return Promise.all(this.animations).then(t).catch(e)}}function u(t,e){return t?t[e]||t.default||t:void 0}function c(t){let e=0;let n=t.next(e);for(;!n.done&&e<2e4;)e+=50,n=t.next(e);return e>=2e4?1/0:e}function h(t,e=100,n){const s=n({...t,keyframes:[0,e]}),i=Math.min(c(s),2e4);return{type:"keyframes",ease:t=>s.next(i*t).value/e,duration:o(i)}}function d(t){return"function"==typeof t}function p(t,e){t.timeline=e,t.onfinish=null}const f=t=>Array.isArray(t)&&"number"==typeof t[0],m={linearEasing:void 0};function g(t,e){const n=s(t);return()=>{var t;return null!==(t=m[e])&&void 0!==t?t:n()}}const y=g(()=>{try{document.createElement("div").animate({opacity:0},{easing:"linear(0, 1)"})}catch(t){return!1}return!0},"linearEasing"),v=(t,e,n=10)=>{let s="";const r=Math.max(Math.round(e/n),2);for(let e=0;e<r;e++)s+=t(i(0,r-1,e))+", ";return`linear(${s.substring(0,s.length-2)})`};function w(t){return Boolean("function"==typeof t&&y()||!t||"string"==typeof t&&(t in x||y())||f(t)||Array.isArray(t)&&t.every(w))}const b=([t,e,n,s])=>`cubic-bezier(${t}, ${e}, ${n}, ${s})`,x={linear:"linear",ease:"ease",easeIn:"ease-in",easeOut:"ease-out",easeInOut:"ease-in-out",circIn:b([0,.65,.55,1]),circOut:b([.55,0,1,.45]),backIn:b([.31,.01,.66,-.59]),backOut:b([.33,1.53,.69,.99])};const T=!1;function S(t,e,n){var s;if(t instanceof Element)return[t];if("string"==typeof t){let i=document;e&&(i=e.current);const r=null!==(s=null==n?void 0:n[t])&&void 0!==s?s:i.querySelectorAll(t);return r?Array.from(r):[]}return Array.from(t)}const V=(t,e,n)=>n>e?e:n<t?t:n;function A(t,e){return e?t*(1e3/e):0}function M(t,e,n){const s=Math.max(e-5,0);return A(n-t(s),e-s)}const P=100,k=10,F=1,C=0,E=800,O=.3,I=.3,R={granular:.01,default:2},B={granular:.005,default:.5},D=.01,L=10,W=.05,N=1;function K({duration:t=E,bounce:e=O,velocity:n=C,mass:s=F}){let i,a,l=1-e;l=V(W,N,l),t=V(D,L,o(t)),l<1?(i=e=>{const s=e*l,i=s*t;return.001-(s-n)/j(e,l)*Math.exp(-i)},a=e=>{const s=e*l*t,r=s*n+n,o=Math.pow(l,2)*Math.pow(e,2)*t,a=Math.exp(-s),u=j(Math.pow(e,2),l);return(.001-i(e)>0?-1:1)*((r-o)*a)/u}):(i=e=>Math.exp(-e*t)*((e-n)*t+1)-.001,a=e=>Math.exp(-e*t)*(t*t*(n-e)));const u=function(t,e,n){let s=n;for(let n=1;n<12;n++)s-=t(s)/e(s);return s}(i,a,5/t);if(t=r(t),isNaN(u))return{stiffness:P,damping:k,duration:t};{const e=Math.pow(u,2)*s;return{stiffness:e,damping:2*l*Math.sqrt(s*e),duration:t}}}function j(t,e){return t*Math.sqrt(1-e*e)}const z=["duration","bounce"],$=["stiffness","damping","mass"];function U(t,e){return e.some(e=>void 0!==t[e])}function H(t=I,e=O){const n="object"!=typeof t?{visualDuration:t,keyframes:[0,1],bounce:e}:t;let{restSpeed:s,restDelta:i}=n;const a=n.keyframes[0],l=n.keyframes[n.keyframes.length-1],u={done:!1,value:a},{stiffness:h,damping:d,mass:p,duration:f,velocity:m,isResolvedFromDuration:g}=function(t){let e={velocity:C,stiffness:P,damping:k,mass:F,isResolvedFromDuration:!1,...t};if(!U(t,$)&&U(t,z))if(t.visualDuration){const n=t.visualDuration,s=2*Math.PI/(1.2*n),i=s*s,r=2*V(.05,1,1-(t.bounce||0))*Math.sqrt(i);e={...e,mass:F,stiffness:i,damping:r}}else{const n=K(t);e={...e,...n,mass:F},e.isResolvedFromDuration=!0}return e}({...n,velocity:-o(n.velocity||0)}),y=m||0,w=d/(2*Math.sqrt(h*p)),b=l-a,x=o(Math.sqrt(h/p)),T=Math.abs(b)<5;let S;if(s||(s=T?R.granular:R.default),i||(i=T?B.granular:B.default),w<1){const t=j(x,w);S=e=>{const n=Math.exp(-w*x*e);return l-n*((y+w*x*b)/t*Math.sin(t*e)+b*Math.cos(t*e))}}else if(1===w)S=t=>l-Math.exp(-x*t)*(b+(y+x*b)*t);else{const t=x*Math.sqrt(w*w-1);S=e=>{const n=Math.exp(-w*x*e),s=Math.min(t*e,300);return l-n*((y+w*x*b)*Math.sinh(s)+t*b*Math.cosh(s))/t}}const A={calculatedDuration:g&&f||null,next:t=>{const e=S(t);if(g)u.done=t>=f;else{let n=0;w<1&&(n=0===t?r(y):M(S,t,e));const o=Math.abs(n)<=s,a=Math.abs(l-e)<=i;u.done=o&&a}return u.value=u.done?l:e,u},toString:()=>{const t=Math.min(c(A),2e4),e=v(e=>A.next(t*e).value,t,30);return t+"ms "+e}};return A}const Y=(t,e,n)=>{const s=e-t;return((n-t)%s+s)%s+t},q=t=>Array.isArray(t)&&"number"!=typeof t[0];function X(t,e){return q(t)?t[Y(0,t.length,e)]:t}const G=(t,e,n)=>t+(e-t)*n;function Z(t,e){const n=t[t.length-1];for(let s=1;s<=e;s++){const r=i(0,e,s);t.push(G(n,1,r))}}function _(t){const e=[0];return Z(e,t.length-1),e}const J=t=>Boolean(t&&t.getVelocity);function Q(t){return"object"==typeof t&&!Array.isArray(t)}function tt(t,e,n,s){return"string"==typeof t&&Q(e)?S(t,n,s):t instanceof NodeList?Array.from(t):Array.isArray(t)?t:[t]}function et(t,e,n){return t*(e+1)}function nt(t,e,n,s){var i;return"number"==typeof e?e:e.startsWith("-")||e.startsWith("+")?Math.max(0,t+parseFloat(e)):"<"===e?n:null!==(i=s.get(e))&&void 0!==i?i:t}function st(t,e){const n=t.indexOf(e);n>-1&&t.splice(n,1)}function it(t,e,n,s,i,r){!function(t,e,n){for(let s=0;s<t.length;s++){const i=t[s];i.at>e&&i.at<n&&(st(t,i),s--)}}(t,i,r);for(let o=0;o<e.length;o++)t.push({value:e[o],at:G(i,r,s[o]),easing:X(n,o)})}function rt(t,e){for(let n=0;n<t.length;n++)t[n]=t[n]/(e+1)}function ot(t,e){return t.at===e.at?null===t.value?1:null===e.value?-1:0:t.at-e.at}function at(t,e){return!e.has(t)&&e.set(t,{}),e.get(t)}function lt(t,e){return e[t]||(e[t]=[]),e[t]}function ut(t){return Array.isArray(t)?t:[t]}function ct(t,e){return t&&t[e]?{...t,...t[e]}:{...t}}const ht=t=>"number"==typeof t,dt=t=>t.every(ht),pt=new WeakMap,ft=["transformPerspective","x","y","z","translateX","translateY","translateZ","scale","scaleX","scaleY","rotate","rotateX","rotateY","rotateZ","skew","skewX","skewY"],mt=new Set(ft),gt=new Set(["width","height","top","left","right","bottom",...ft]),yt=t=>(t=>Array.isArray(t))(t)?t[t.length-1]||0:t,vt=!1;const wt=["read","resolveKeyframes","update","preRender","render","postRender"];const{schedule:bt,cancel:xt,state:Tt,steps:St}=function(t,e){let n=!1,s=!0;const i={delta:0,timestamp:0,isProcessing:!1},r=()=>n=!0,o=wt.reduce((t,e)=>(t[e]=function(t){let e=new Set,n=new Set,s=!1,i=!1;const r=new WeakSet;let o={delta:0,timestamp:0,isProcessing:!1};function a(e){r.has(e)&&(l.schedule(e),t()),e(o)}const l={schedule:(t,i=!1,o=!1)=>{const a=o&&s?e:n;return i&&r.add(t),a.has(t)||a.add(t),t},cancel:t=>{n.delete(t),r.delete(t)},process:t=>{o=t,s?i=!0:(s=!0,[e,n]=[n,e],e.forEach(a),e.clear(),s=!1,i&&(i=!1,l.process(t)))}};return l}(r),t),{}),{read:a,resolveKeyframes:l,update:u,preRender:c,render:h,postRender:d}=o,p=()=>{const r=performance.now();n=!1,i.delta=s?1e3/60:Math.max(Math.min(r-i.timestamp,40),1),i.timestamp=r,i.isProcessing=!0,a.process(i),l.process(i),u.process(i),c.process(i),h.process(i),d.process(i),i.isProcessing=!1,n&&e&&(s=!1,t(p))};return{schedule:wt.reduce((e,r)=>{const a=o[r];return e[r]=(e,r=!1,o=!1)=>(n||(n=!0,s=!0,i.isProcessing||t(p)),a.schedule(e,r,o)),e},{}),cancel:t=>{for(let e=0;e<wt.length;e++)o[wt[e]].cancel(t)},state:i,steps:o}}("undefined"!=typeof requestAnimationFrame?requestAnimationFrame:e,!0);let Vt;function At(){Vt=void 0}const Mt={now:()=>(void 0===Vt&&Mt.set(Tt.isProcessing||vt?Tt.timestamp:performance.now()),Vt),set:t=>{Vt=t,queueMicrotask(At)}};class Pt{constructor(){this.subscriptions=[]}add(t){var e,n;return e=this.subscriptions,n=t,-1===e.indexOf(n)&&e.push(n),()=>st(this.subscriptions,t)}notify(t,e,n){const s=this.subscriptions.length;if(s)if(1===s)this.subscriptions[0](t,e,n);else for(let i=0;i<s;i++){const s=this.subscriptions[i];s&&s(t,e,n)}}getSize(){return this.subscriptions.length}clear(){this.subscriptions.length=0}}class kt{constructor(t,e={}){this.version="11.18.2",this.canTrackVelocity=null,this.events={},this.updateAndNotify=(t,e=!0)=>{const n=Mt.now();this.updatedAt!==n&&this.setPrevFrameValue(),this.prev=this.current,this.setCurrent(t),this.current!==this.prev&&this.events.change&&this.events.change.notify(this.current),e&&this.events.renderRequest&&this.events.renderRequest.notify(this.current)},this.hasAnimated=!1,this.setCurrent(t),this.owner=e.owner}setCurrent(t){var e;this.current=t,this.updatedAt=Mt.now(),null===this.canTrackVelocity&&void 0!==t&&(this.canTrackVelocity=(e=this.current,!isNaN(parseFloat(e))))}setPrevFrameValue(t=this.current){this.prevFrameValue=t,this.prevUpdatedAt=this.updatedAt}onChange(t){return this.on("change",t)}on(t,e){this.events[t]||(this.events[t]=new Pt);const n=this.events[t].add(e);return"change"===t?()=>{n(),bt.read(()=>{this.events.change.getSize()||this.stop()})}:n}clearListeners(){for(const t in this.events)this.events[t].clear()}attach(t,e){this.passiveEffect=t,this.stopPassiveEffect=e}set(t,e=!0){e&&this.passiveEffect?this.passiveEffect(t,this.updateAndNotify):this.updateAndNotify(t,e)}setWithVelocity(t,e,n){this.set(e),this.prev=void 0,this.prevFrameValue=t,this.prevUpdatedAt=this.updatedAt-n}jump(t,e=!0){this.updateAndNotify(t),this.prev=t,this.prevUpdatedAt=this.prevFrameValue=void 0,e&&this.stop(),this.stopPassiveEffect&&this.stopPassiveEffect()}get(){return this.current}getPrevious(){return this.prev}getVelocity(){const t=Mt.now();if(!this.canTrackVelocity||void 0===this.prevFrameValue||t-this.updatedAt>30)return 0;const e=Math.min(this.updatedAt-this.prevUpdatedAt,30);return A(parseFloat(this.current)-parseFloat(this.prevFrameValue),e)}start(t){return this.stop(),new Promise(e=>{this.hasAnimated=!0,this.animation=t(e),this.events.animationStart&&this.events.animationStart.notify()}).then(()=>{this.events.animationComplete&&this.events.animationComplete.notify(),this.clearAnimation()})}stop(){this.animation&&(this.animation.stop(),this.events.animationCancel&&this.events.animationCancel.notify()),this.clearAnimation()}isAnimating(){return!!this.animation}clearAnimation(){delete this.animation}destroy(){this.clearListeners(),this.stop(),this.stopPassiveEffect&&this.stopPassiveEffect()}}function Ft(t,e){return new kt(t,e)}function Ct(t){const e=[{},{}];return null==t||t.values.forEach((t,n)=>{e[0][n]=t.get(),e[1][n]=t.getVelocity()}),e}function Et(t,e,n,s){if("function"==typeof e){const[i,r]=Ct(s);e=e(void 0!==n?n:t.custom,i,r)}if("string"==typeof e&&(e=t.variants&&t.variants[e]),"function"==typeof e){const[i,r]=Ct(s);e=e(void 0!==n?n:t.custom,i,r)}return e}function Ot(t,e,n){t.hasValue(e)?t.getValue(e).set(n):t.addValue(e,Ft(n))}function It(t,e){const n=function(t,e,n){const s=t.getProps();return Et(s,e,void 0!==n?n:s.custom,t)}(t,e);let{transitionEnd:s={},transition:i={},...r}=n||{};r={...r,...s};for(const e in r){Ot(t,e,yt(r[e]))}}function Rt(t,e){const n=t.getValue("willChange");if(s=n,Boolean(J(s)&&s.add))return n.add(e);var s}const Bt=t=>t.replace(/([a-z])([A-Z])/gu,"$1-$2").toLowerCase(),Dt="data-"+Bt("framerAppearId");function Lt(t){return t.props[Dt]}const Wt=(t,e,n)=>(((1-3*n+3*e)*t+(3*n-6*e))*t+3*e)*t;function Nt(t,n,s,i){if(t===n&&s===i)return e;const r=e=>function(t,e,n,s,i){let r,o,a=0;do{o=e+(n-e)/2,r=Wt(o,s,i)-t,r>0?n=o:e=o}while(Math.abs(r)>1e-7&&++a<12);return o}(e,0,1,t,s);return t=>0===t||1===t?t:Wt(r(t),n,i)}const Kt=t=>e=>e<=.5?t(2*e)/2:(2-t(2*(1-e)))/2,jt=t=>e=>1-t(1-e),zt=Nt(.33,1.53,.69,.99),$t=jt(zt),Ut=Kt($t),Ht=t=>(t*=2)<1?.5*$t(t):.5*(2-Math.pow(2,-10*(t-1))),Yt=t=>1-Math.sin(Math.acos(t)),qt=jt(Yt),Xt=Kt(Yt),Gt=t=>/^0[^.\s]+$/u.test(t);const Zt={test:t=>"number"==typeof t,parse:parseFloat,transform:t=>t},_t={...Zt,transform:t=>V(0,1,t)},Jt={...Zt,default:1},Qt=t=>Math.round(1e5*t)/1e5,te=/-?(?:\d+(?:\.\d+)?|\.\d+)/gu;const ee=/^(?:#[\da-f]{3,8}|(?:rgb|hsl)a?\((?:-?[\d.]+%?[,\s]+){2}-?[\d.]+%?\s*(?:[,/]\s*)?(?:\b\d+(?:\.\d+)?|\.\d+)?%?\))$/iu,ne=(t,e)=>n=>Boolean("string"==typeof n&&ee.test(n)&&n.startsWith(t)||e&&!function(t){return null==t}(n)&&Object.prototype.hasOwnProperty.call(n,e)),se=(t,e,n)=>s=>{if("string"!=typeof s)return s;const[i,r,o,a]=s.match(te);return{[t]:parseFloat(i),[e]:parseFloat(r),[n]:parseFloat(o),alpha:void 0!==a?parseFloat(a):1}},ie={...Zt,transform:t=>Math.round((t=>V(0,255,t))(t))},re={test:ne("rgb","red"),parse:se("red","green","blue"),transform:({red:t,green:e,blue:n,alpha:s=1})=>"rgba("+ie.transform(t)+", "+ie.transform(e)+", "+ie.transform(n)+", "+Qt(_t.transform(s))+")"};const oe={test:ne("#"),parse:function(t){let e="",n="",s="",i="";return t.length>5?(e=t.substring(1,3),n=t.substring(3,5),s=t.substring(5,7),i=t.substring(7,9)):(e=t.substring(1,2),n=t.substring(2,3),s=t.substring(3,4),i=t.substring(4,5),e+=e,n+=n,s+=s,i+=i),{red:parseInt(e,16),green:parseInt(n,16),blue:parseInt(s,16),alpha:i?parseInt(i,16)/255:1}},transform:re.transform},ae=t=>({test:e=>"string"==typeof e&&e.endsWith(t)&&1===e.split(" ").length,parse:parseFloat,transform:e=>`${e}${t}`}),le=ae("deg"),ue=ae("%"),ce=ae("px"),he=ae("vh"),de=ae("vw"),pe={...ue,parse:t=>ue.parse(t)/100,transform:t=>ue.transform(100*t)},fe={test:ne("hsl","hue"),parse:se("hue","saturation","lightness"),transform:({hue:t,saturation:e,lightness:n,alpha:s=1})=>"hsla("+Math.round(t)+", "+ue.transform(Qt(e))+", "+ue.transform(Qt(n))+", "+Qt(_t.transform(s))+")"},me={test:t=>re.test(t)||oe.test(t)||fe.test(t),parse:t=>re.test(t)?re.parse(t):fe.test(t)?fe.parse(t):oe.parse(t),transform:t=>"string"==typeof t?t:t.hasOwnProperty("red")?re.transform(t):fe.transform(t)},ge=/(?:#[\da-f]{3,8}|(?:rgb|hsl)a?\((?:-?[\d.]+%?[,\s]+){2}-?[\d.]+%?\s*(?:[,/]\s*)?(?:\b\d+(?:\.\d+)?|\.\d+)?%?\))/giu;const ye=/var\s*\(\s*--(?:[\w-]+\s*|[\w-]+\s*,(?:\s*[^)(\s]|\s*\((?:[^)(]|\([^)(]*\))*\))+\s*)\)|#[\da-f]{3,8}|(?:rgb|hsl)a?\((?:-?[\d.]+%?[,\s]+){2}-?[\d.]+%?\s*(?:[,/]\s*)?(?:\b\d+(?:\.\d+)?|\.\d+)?%?\)|-?(?:\d+(?:\.\d+)?|\.\d+)/giu;function ve(t){const e=t.toString(),n=[],s={color:[],number:[],var:[]},i=[];let r=0;const o=e.replace(ye,t=>(me.test(t)?(s.color.push(r),i.push("color"),n.push(me.parse(t))):t.startsWith("var(")?(s.var.push(r),i.push("var"),n.push(t)):(s.number.push(r),i.push("number"),n.push(parseFloat(t))),++r,"${}")).split("${}");return{values:n,split:o,indexes:s,types:i}}function we(t){return ve(t).values}function be(t){const{split:e,types:n}=ve(t),s=e.length;return t=>{let i="";for(let r=0;r<s;r++)if(i+=e[r],void 0!==t[r]){const e=n[r];i+="number"===e?Qt(t[r]):"color"===e?me.transform(t[r]):t[r]}return i}}const xe=t=>"number"==typeof t?0:t;const Te={test:function(t){var e,n;return isNaN(t)&&"string"==typeof t&&((null===(e=t.match(te))||void 0===e?void 0:e.length)||0)+((null===(n=t.match(ge))||void 0===n?void 0:n.length)||0)>0},parse:we,createTransformer:be,getAnimatableNone:function(t){const e=we(t);return be(t)(e.map(xe))}},Se=new Set(["brightness","contrast","saturate","opacity"]);function Ve(t){const[e,n]=t.slice(0,-1).split("(");if("drop-shadow"===e)return t;const[s]=n.match(te)||[];if(!s)return t;const i=n.replace(s,"");let r=Se.has(e)?1:0;return s!==n&&(r*=100),e+"("+r+i+")"}const Ae=/\b([a-z-]*)\(.*?\)/gu,Me={...Te,getAnimatableNone:t=>{const e=t.match(Ae);return e?e.map(Ve).join(" "):t}},Pe={borderWidth:ce,borderTopWidth:ce,borderRightWidth:ce,borderBottomWidth:ce,borderLeftWidth:ce,borderRadius:ce,radius:ce,borderTopLeftRadius:ce,borderTopRightRadius:ce,borderBottomRightRadius:ce,borderBottomLeftRadius:ce,width:ce,maxWidth:ce,height:ce,maxHeight:ce,top:ce,right:ce,bottom:ce,left:ce,padding:ce,paddingTop:ce,paddingRight:ce,paddingBottom:ce,paddingLeft:ce,margin:ce,marginTop:ce,marginRight:ce,marginBottom:ce,marginLeft:ce,backgroundPositionX:ce,backgroundPositionY:ce},ke={rotate:le,rotateX:le,rotateY:le,rotateZ:le,scale:Jt,scaleX:Jt,scaleY:Jt,scaleZ:Jt,skew:le,skewX:le,skewY:le,distance:ce,translateX:ce,translateY:ce,translateZ:ce,x:ce,y:ce,z:ce,perspective:ce,transformPerspective:ce,opacity:_t,originX:pe,originY:pe,originZ:ce},Fe={...Zt,transform:Math.round},Ce={...Pe,...ke,zIndex:Fe,size:ce,fillOpacity:_t,strokeOpacity:_t,numOctaves:Fe},Ee={...Ce,color:me,backgroundColor:me,outlineColor:me,fill:me,stroke:me,borderColor:me,borderTopColor:me,borderRightColor:me,borderBottomColor:me,borderLeftColor:me,filter:Me,WebkitFilter:Me},Oe=t=>Ee[t];function Ie(t,e){let n=Oe(t);return n!==Me&&(n=Te),n.getAnimatableNone?n.getAnimatableNone(e):void 0}const Re=new Set(["auto","none","0"]);const Be=t=>t===Zt||t===ce,De=(t,e)=>parseFloat(t.split(", ")[e]),Le=(t,e)=>(n,{transform:s})=>{if("none"===s||!s)return 0;const i=s.match(/^matrix3d\((.+)\)$/u);if(i)return De(i[1],e);{const e=s.match(/^matrix\((.+)\)$/u);return e?De(e[1],t):0}},We=new Set(["x","y","z"]),Ne=ft.filter(t=>!We.has(t));const Ke={width:({x:t},{paddingLeft:e="0",paddingRight:n="0"})=>t.max-t.min-parseFloat(e)-parseFloat(n),height:({y:t},{paddingTop:e="0",paddingBottom:n="0"})=>t.max-t.min-parseFloat(e)-parseFloat(n),top:(t,{top:e})=>parseFloat(e),left:(t,{left:e})=>parseFloat(e),bottom:({y:t},{top:e})=>parseFloat(e)+(t.max-t.min),right:({x:t},{left:e})=>parseFloat(e)+(t.max-t.min),x:Le(4,13),y:Le(5,14)};Ke.translateX=Ke.x,Ke.translateY=Ke.y;const je=new Set;let ze=!1,$e=!1;function Ue(){if($e){const t=Array.from(je).filter(t=>t.needsMeasurement),e=new Set(t.map(t=>t.element)),n=new Map;e.forEach(t=>{const e=function(t){const e=[];return Ne.forEach(n=>{const s=t.getValue(n);void 0!==s&&(e.push([n,s.get()]),s.set(n.startsWith("scale")?1:0))}),e}(t);e.length&&(n.set(t,e),t.render())}),t.forEach(t=>t.measureInitialState()),e.forEach(t=>{t.render();const e=n.get(t);e&&e.forEach(([e,n])=>{var s;null===(s=t.getValue(e))||void 0===s||s.set(n)})}),t.forEach(t=>t.measureEndState()),t.forEach(t=>{void 0!==t.suspendedScrollY&&window.scrollTo(0,t.suspendedScrollY)})}$e=!1,ze=!1,je.forEach(t=>t.complete()),je.clear()}function He(){je.forEach(t=>{t.readKeyframes(),t.needsMeasurement&&($e=!0)})}class Ye{constructor(t,e,n,s,i,r=!1){this.isComplete=!1,this.isAsync=!1,this.needsMeasurement=!1,this.isScheduled=!1,this.unresolvedKeyframes=[...t],this.onComplete=e,this.name=n,this.motionValue=s,this.element=i,this.isAsync=r}scheduleResolve(){this.isScheduled=!0,this.isAsync?(je.add(this),ze||(ze=!0,bt.read(He),bt.resolveKeyframes(Ue))):(this.readKeyframes(),this.complete())}readKeyframes(){const{unresolvedKeyframes:t,name:e,element:n,motionValue:s}=this;for(let i=0;i<t.length;i++)if(null===t[i])if(0===i){const i=null==s?void 0:s.get(),r=t[t.length-1];if(void 0!==i)t[0]=i;else if(n&&e){const s=n.readValue(e,r);null!=s&&(t[0]=s)}void 0===t[0]&&(t[0]=r),s&&void 0===i&&s.set(t[0])}else t[i]=t[i-1]}setFinalKeyframe(){}measureInitialState(){}renderEndStyles(){}measureEndState(){}complete(){this.isComplete=!0,this.onComplete(this.unresolvedKeyframes,this.finalKeyframe),je.delete(this)}cancel(){this.isComplete||(this.isScheduled=!1,je.delete(this))}resume(){this.isComplete||this.scheduleResolve()}}const qe=t=>/^-?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(t),Xe=t=>e=>"string"==typeof e&&e.startsWith(t),Ge=Xe("--"),Ze=Xe("var(--"),_e=t=>!!Ze(t)&&Je.test(t.split("/*")[0].trim()),Je=/var\(--(?:[\w-]+\s*|[\w-]+\s*,(?:\s*[^)(\s]|\s*\((?:[^)(]|\([^)(]*\))*\))+\s*)\)$/iu,Qe=/^var\(--(?:([\w-]+)|([\w-]+), ?([a-zA-Z\d ()%#.,-]+))\)/u;function tn(t,e,n=1){const[s,i]=function(t){const e=Qe.exec(t);if(!e)return[,];const[,n,s,i]=e;return["--"+(null!=n?n:s),i]}(t);if(!s)return;const r=window.getComputedStyle(e).getPropertyValue(s);if(r){const t=r.trim();return qe(t)?parseFloat(t):t}return _e(i)?tn(i,e,n+1):i}const en=t=>e=>e.test(t),nn=[Zt,ce,ue,le,de,he,{test:t=>"auto"===t,parse:t=>t}],sn=t=>nn.find(en(t));class rn extends Ye{constructor(t,e,n,s,i){super(t,e,n,s,i,!0)}readKeyframes(){const{unresolvedKeyframes:t,element:e,name:n}=this;if(!e||!e.current)return;super.readKeyframes();for(let n=0;n<t.length;n++){let s=t[n];if("string"==typeof s&&(s=s.trim(),_e(s))){const i=tn(s,e.current);void 0!==i&&(t[n]=i),n===t.length-1&&(this.finalKeyframe=s)}}if(this.resolveNoneKeyframes(),!gt.has(n)||2!==t.length)return;const[s,i]=t,r=sn(s),o=sn(i);if(r!==o)if(Be(r)&&Be(o))for(let e=0;e<t.length;e++){const n=t[e];"string"==typeof n&&(t[e]=parseFloat(n))}else this.needsMeasurement=!0}resolveNoneKeyframes(){const{unresolvedKeyframes:t,name:e}=this,n=[];for(let e=0;e<t.length;e++)("number"==typeof(s=t[e])?0===s:null===s||"none"===s||"0"===s||Gt(s))&&n.push(e);var s;n.length&&function(t,e,n){let s=0,i=void 0;for(;s<t.length&&!i;){const e=t[s];"string"==typeof e&&!Re.has(e)&&ve(e).values.length&&(i=t[s]),s++}if(i&&n)for(const s of e)t[s]=Ie(n,i)}(t,n,e)}measureInitialState(){const{element:t,unresolvedKeyframes:e,name:n}=this;if(!t||!t.current)return;"height"===n&&(this.suspendedScrollY=window.pageYOffset),this.measuredOrigin=Ke[n](t.measureViewportBox(),window.getComputedStyle(t.current)),e[0]=this.measuredOrigin;const s=e[e.length-1];void 0!==s&&t.getValue(n,s).jump(s,!1)}measureEndState(){var t;const{element:e,name:n,unresolvedKeyframes:s}=this;if(!e||!e.current)return;const i=e.getValue(n);i&&i.jump(this.measuredOrigin,!1);const r=s.length-1,o=s[r];s[r]=Ke[n](e.measureViewportBox(),window.getComputedStyle(e.current)),null!==o&&void 0===this.finalKeyframe&&(this.finalKeyframe=o),(null===(t=this.removedTransforms)||void 0===t?void 0:t.length)&&this.removedTransforms.forEach(([t,n])=>{e.getValue(t).set(n)}),this.resolveNoneKeyframes()}}const on=(t,e)=>"zIndex"!==e&&(!("number"!=typeof t&&!Array.isArray(t))||!("string"!=typeof t||!Te.test(t)&&"0"!==t||t.startsWith("url(")));function an(t,e,n,s){const i=t[0];if(null===i)return!1;if("display"===e||"visibility"===e)return!0;const r=t[t.length-1],o=on(i,e),a=on(r,e);return!(!o||!a)&&(function(t){const e=t[0];if(1===t.length)return!0;for(let n=0;n<t.length;n++)if(t[n]!==e)return!0}(t)||("spring"===n||d(n))&&s)}const ln=t=>null!==t;function un(t,{repeat:e,repeatType:n="loop"},s){const i=t.filter(ln),r=e&&"loop"!==n&&e%2==1?0:i.length-1;return r&&void 0!==s?s:i[r]}class cn{constructor({autoplay:t=!0,delay:e=0,type:n="keyframes",repeat:s=0,repeatDelay:i=0,repeatType:r="loop",...o}){this.isStopped=!1,this.hasAttemptedResolve=!1,this.createdAt=Mt.now(),this.options={autoplay:t,delay:e,type:n,repeat:s,repeatDelay:i,repeatType:r,...o},this.updateFinishedPromise()}calcStartTime(){return this.resolvedAt&&this.resolvedAt-this.createdAt>40?this.resolvedAt:this.createdAt}get resolved(){return this._resolved||this.hasAttemptedResolve||(He(),Ue()),this._resolved}onKeyframesResolved(t,e){this.resolvedAt=Mt.now(),this.hasAttemptedResolve=!0;const{name:n,type:s,velocity:i,delay:r,onComplete:o,onUpdate:a,isGenerator:l}=this.options;if(!l&&!an(t,n,s,i)){if(!r)return a&&a(un(t,this.options,e)),o&&o(),void this.resolveFinishedPromise();this.options.duration=0}const u=this.initPlayback(t,e);!1!==u&&(this._resolved={keyframes:t,finalKeyframe:e,...u},this.onPostResolved())}onPostResolved(){}then(t,e){return this.currentFinishedPromise.then(t,e)}flatten(){this.options.type="keyframes",this.options.ease="linear"}updateFinishedPromise(){this.currentFinishedPromise=new Promise(t=>{this.resolveFinishedPromise=t})}}function hn(t,e,n){return n<0&&(n+=1),n>1&&(n-=1),n<1/6?t+6*(e-t)*n:n<.5?e:n<2/3?t+(e-t)*(2/3-n)*6:t}function dn(t,e){return n=>n>0?e:t}const pn=(t,e,n)=>{const s=t*t,i=n*(e*e-s)+s;return i<0?0:Math.sqrt(i)},fn=[oe,re,fe];function mn(t){const e=(n=t,fn.find(t=>t.test(n)));var n;if(!Boolean(e))return!1;let s=e.parse(t);return e===fe&&(s=function({hue:t,saturation:e,lightness:n,alpha:s}){t/=360,n/=100;let i=0,r=0,o=0;if(e/=100){const s=n<.5?n*(1+e):n+e-n*e,a=2*n-s;i=hn(a,s,t+1/3),r=hn(a,s,t),o=hn(a,s,t-1/3)}else i=r=o=n;return{red:Math.round(255*i),green:Math.round(255*r),blue:Math.round(255*o),alpha:s}}(s)),s}const gn=(t,e)=>{const n=mn(t),s=mn(e);if(!n||!s)return dn(t,e);const i={...n};return t=>(i.red=pn(n.red,s.red,t),i.green=pn(n.green,s.green,t),i.blue=pn(n.blue,s.blue,t),i.alpha=G(n.alpha,s.alpha,t),re.transform(i))},yn=(t,e)=>n=>e(t(n)),vn=(...t)=>t.reduce(yn),wn=new Set(["none","hidden"]);function bn(t,e){return n=>G(t,e,n)}function xn(t){return"number"==typeof t?bn:"string"==typeof t?_e(t)?dn:me.test(t)?gn:Vn:Array.isArray(t)?Tn:"object"==typeof t?me.test(t)?gn:Sn:dn}function Tn(t,e){const n=[...t],s=n.length,i=t.map((t,n)=>xn(t)(t,e[n]));return t=>{for(let e=0;e<s;e++)n[e]=i[e](t);return n}}function Sn(t,e){const n={...t,...e},s={};for(const i in n)void 0!==t[i]&&void 0!==e[i]&&(s[i]=xn(t[i])(t[i],e[i]));return t=>{for(const e in s)n[e]=s[e](t);return n}}const Vn=(t,e)=>{const n=Te.createTransformer(e),s=ve(t),i=ve(e);return s.indexes.var.length===i.indexes.var.length&&s.indexes.color.length===i.indexes.color.length&&s.indexes.number.length>=i.indexes.number.length?wn.has(t)&&!i.values.length||wn.has(e)&&!s.values.length?function(t,e){return wn.has(t)?n=>n<=0?t:e:n=>n>=1?e:t}(t,e):vn(Tn(function(t,e){var n;const s=[],i={color:0,var:0,number:0};for(let r=0;r<e.values.length;r++){const o=e.types[r],a=t.indexes[o][i[o]],l=null!==(n=t.values[a])&&void 0!==n?n:0;s[r]=l,i[o]++}return s}(s,i),i.values),n):dn(t,e)};function An(t,e,n){if("number"==typeof t&&"number"==typeof e&&"number"==typeof n)return G(t,e,n);return xn(t)(t,e)}function Mn({keyframes:t,velocity:e=0,power:n=.8,timeConstant:s=325,bounceDamping:i=10,bounceStiffness:r=500,modifyTarget:o,min:a,max:l,restDelta:u=.5,restSpeed:c}){const h=t[0],d={done:!1,value:h},p=t=>void 0===a?l:void 0===l||Math.abs(a-t)<Math.abs(l-t)?a:l;let f=n*e;const m=h+f,g=void 0===o?m:o(m);g!==m&&(f=g-h);const y=t=>-f*Math.exp(-t/s),v=t=>g+y(t),w=t=>{const e=y(t),n=v(t);d.done=Math.abs(e)<=u,d.value=d.done?g:n};let b,x;const T=t=>{var e;(e=d.value,void 0!==a&&e<a||void 0!==l&&e>l)&&(b=t,x=H({keyframes:[d.value,p(d.value)],velocity:M(v,t,d.value),damping:i,stiffness:r,restDelta:u,restSpeed:c}))};return T(0),{calculatedDuration:null,next:t=>{let e=!1;return x||void 0!==b||(e=!0,w(t),T(t)),void 0!==b&&t>=b?x.next(t-b):(!e&&w(t),d)}}}const Pn=Nt(.42,0,1,1),kn=Nt(0,0,.58,1),Fn=Nt(.42,0,.58,1),Cn={linear:e,easeIn:Pn,easeInOut:Fn,easeOut:kn,circIn:Yt,circInOut:Xt,circOut:qt,backIn:$t,backInOut:Ut,backOut:zt,anticipate:Ht},En=t=>{if(f(t)){n(4===t.length);const[e,s,i,r]=t;return Nt(e,s,i,r)}return"string"==typeof t?Cn[t]:t};function On(t,s,{clamp:r=!0,ease:o,mixer:a}={}){const l=t.length;if(n(l===s.length),1===l)return()=>s[0];if(2===l&&s[0]===s[1])return()=>s[1];const u=t[0]===t[1];t[0]>t[l-1]&&(t=[...t].reverse(),s=[...s].reverse());const c=function(t,n,s){const i=[],r=s||An,o=t.length-1;for(let s=0;s<o;s++){let o=r(t[s],t[s+1]);if(n){const t=Array.isArray(n)?n[s]||e:n;o=vn(t,o)}i.push(o)}return i}(s,o,a),h=c.length,d=e=>{if(u&&e<t[0])return s[0];let n=0;if(h>1)for(;n<t.length-2&&!(e<t[n+1]);n++);const r=i(t[n],t[n+1],e);return c[n](r)};return r?e=>d(V(t[0],t[l-1],e)):d}function In({duration:t=300,keyframes:e,times:n,ease:s="easeInOut"}){const i=q(s)?s.map(En):En(s),r={done:!1,value:e[0]},o=On(function(t,e){return t.map(t=>t*e)}(n&&n.length===e.length?n:_(e),t),e,{ease:Array.isArray(i)?i:(a=e,l=i,a.map(()=>l||Fn).splice(0,a.length-1))});var a,l;return{calculatedDuration:t,next:e=>(r.value=o(e),r.done=e>=t,r)}}const Rn=t=>{const e=({timestamp:e})=>t(e);return{start:()=>bt.update(e,!0),stop:()=>xt(e),now:()=>Tt.isProcessing?Tt.timestamp:Mt.now()}},Bn={decay:Mn,inertia:Mn,tween:In,keyframes:In,spring:H},Dn=t=>t/100;class Ln extends cn{constructor(t){super(t),this.holdTime=null,this.cancelTime=null,this.currentTime=0,this.playbackSpeed=1,this.pendingPlayState="running",this.startTime=null,this.state="idle",this.stop=()=>{if(this.resolver.cancel(),this.isStopped=!0,"idle"===this.state)return;this.teardown();const{onStop:t}=this.options;t&&t()};const{name:e,motionValue:n,element:s,keyframes:i}=this.options,r=(null==s?void 0:s.KeyframeResolver)||Ye;this.resolver=new r(i,(t,e)=>this.onKeyframesResolved(t,e),e,n,s),this.resolver.scheduleResolve()}flatten(){super.flatten(),this._resolved&&Object.assign(this._resolved,this.initPlayback(this._resolved.keyframes))}initPlayback(t){const{type:e="keyframes",repeat:n=0,repeatDelay:s=0,repeatType:i,velocity:r=0}=this.options,o=d(e)?e:Bn[e]||In;let a,l;o!==In&&"number"!=typeof t[0]&&(a=vn(Dn,An(t[0],t[1])),t=[0,100]);const u=o({...this.options,keyframes:t});"mirror"===i&&(l=o({...this.options,keyframes:[...t].reverse(),velocity:-r})),null===u.calculatedDuration&&(u.calculatedDuration=c(u));const{calculatedDuration:h}=u,p=h+s;return{generator:u,mirroredGenerator:l,mapPercentToKeyframes:a,calculatedDuration:h,resolvedDuration:p,totalDuration:p*(n+1)-s}}onPostResolved(){const{autoplay:t=!0}=this.options;this.play(),"paused"!==this.pendingPlayState&&t?this.state=this.pendingPlayState:this.pause()}tick(t,e=!1){const{resolved:n}=this;if(!n){const{keyframes:t}=this.options;return{done:!0,value:t[t.length-1]}}const{finalKeyframe:s,generator:i,mirroredGenerator:r,mapPercentToKeyframes:o,keyframes:a,calculatedDuration:l,totalDuration:u,resolvedDuration:c}=n;if(null===this.startTime)return i.next(0);const{delay:h,repeat:d,repeatType:p,repeatDelay:f,onUpdate:m}=this.options;this.speed>0?this.startTime=Math.min(this.startTime,t):this.speed<0&&(this.startTime=Math.min(t-u/this.speed,this.startTime)),e?this.currentTime=t:null!==this.holdTime?this.currentTime=this.holdTime:this.currentTime=Math.round(t-this.startTime)*this.speed;const g=this.currentTime-h*(this.speed>=0?1:-1),y=this.speed>=0?g<0:g>u;this.currentTime=Math.max(g,0),"finished"===this.state&&null===this.holdTime&&(this.currentTime=u);let v=this.currentTime,w=i;if(d){const t=Math.min(this.currentTime,u)/c;let e=Math.floor(t),n=t%1;!n&&t>=1&&(n=1),1===n&&e--,e=Math.min(e,d+1);Boolean(e%2)&&("reverse"===p?(n=1-n,f&&(n-=f/c)):"mirror"===p&&(w=r)),v=V(0,1,n)*c}const b=y?{done:!1,value:a[0]}:w.next(v);o&&(b.value=o(b.value));let{done:x}=b;y||null===l||(x=this.speed>=0?this.currentTime>=u:this.currentTime<=0);const T=null===this.holdTime&&("finished"===this.state||"running"===this.state&&x);return T&&void 0!==s&&(b.value=un(a,this.options,s)),m&&m(b.value),T&&this.finish(),b}get duration(){const{resolved:t}=this;return t?o(t.calculatedDuration):0}get time(){return o(this.currentTime)}set time(t){t=r(t),this.currentTime=t,null!==this.holdTime||0===this.speed?this.holdTime=t:this.driver&&(this.startTime=this.driver.now()-t/this.speed)}get speed(){return this.playbackSpeed}set speed(t){const e=this.playbackSpeed!==t;this.playbackSpeed=t,e&&(this.time=o(this.currentTime))}play(){if(this.resolver.isScheduled||this.resolver.resume(),!this._resolved)return void(this.pendingPlayState="running");if(this.isStopped)return;const{driver:t=Rn,onPlay:e,startTime:n}=this.options;this.driver||(this.driver=t(t=>this.tick(t))),e&&e();const s=this.driver.now();null!==this.holdTime?this.startTime=s-this.holdTime:this.startTime?"finished"===this.state&&(this.startTime=s):this.startTime=null!=n?n:this.calcStartTime(),"finished"===this.state&&this.updateFinishedPromise(),this.cancelTime=this.startTime,this.holdTime=null,this.state="running",this.driver.start()}pause(){var t;this._resolved?(this.state="paused",this.holdTime=null!==(t=this.currentTime)&&void 0!==t?t:0):this.pendingPlayState="paused"}complete(){"running"!==this.state&&this.play(),this.pendingPlayState=this.state="finished",this.holdTime=null}finish(){this.teardown(),this.state="finished";const{onComplete:t}=this.options;t&&t()}cancel(){null!==this.cancelTime&&this.tick(this.cancelTime),this.teardown(),this.updateFinishedPromise()}teardown(){this.state="idle",this.stopDriver(),this.resolveFinishedPromise(),this.updateFinishedPromise(),this.startTime=this.cancelTime=null,this.resolver.cancel()}stopDriver(){this.driver&&(this.driver.stop(),this.driver=void 0)}sample(t){return this.startTime=0,this.tick(t,!0)}}const Wn=new Set(["opacity","clipPath","filter","transform"]);function Nn(t,e,n,{delay:s=0,duration:i=300,repeat:r=0,repeatType:o="loop",ease:a="easeInOut",times:l}={}){const u={[e]:n};l&&(u.offset=l);const c=function t(e,n){return e?"function"==typeof e&&y()?v(e,n):f(e)?b(e):Array.isArray(e)?e.map(e=>t(e,n)||x.easeOut):x[e]:void 0}(a,i);return Array.isArray(c)&&(u.easing=c),t.animate(u,{delay:s,duration:i,easing:Array.isArray(c)?"linear":c,fill:"both",iterations:r+1,direction:"reverse"===o?"alternate":"normal"})}const Kn=s(()=>Object.hasOwnProperty.call(Element.prototype,"animate"));const jn={anticipate:Ht,backInOut:Ut,circInOut:Xt};class zn extends cn{constructor(t){super(t);const{name:e,motionValue:n,element:s,keyframes:i}=this.options;this.resolver=new rn(i,(t,e)=>this.onKeyframesResolved(t,e),e,n,s),this.resolver.scheduleResolve()}initPlayback(t,e){let{duration:n=300,times:s,ease:i,type:r,motionValue:o,name:a,startTime:l}=this.options;if(!o.owner||!o.owner.current)return!1;var u;if("string"==typeof i&&y()&&i in jn&&(i=jn[i]),d((u=this.options).type)||"spring"===u.type||!w(u.ease)){const{onComplete:e,onUpdate:o,motionValue:a,element:l,...u}=this.options,c=function(t,e){const n=new Ln({...e,keyframes:t,repeat:0,delay:0,isGenerator:!0});let s={done:!1,value:t[0]};const i=[];let r=0;for(;!s.done&&r<2e4;)s=n.sample(r),i.push(s.value),r+=10;return{times:void 0,keyframes:i,duration:r-10,ease:"linear"}}(t,u);1===(t=c.keyframes).length&&(t[1]=t[0]),n=c.duration,s=c.times,i=c.ease,r="keyframes"}const c=Nn(o.owner.current,a,t,{...this.options,duration:n,times:s,ease:i});return c.startTime=null!=l?l:this.calcStartTime(),this.pendingTimeline?(p(c,this.pendingTimeline),this.pendingTimeline=void 0):c.onfinish=()=>{const{onComplete:n}=this.options;o.set(un(t,this.options,e)),n&&n(),this.cancel(),this.resolveFinishedPromise()},{animation:c,duration:n,times:s,type:r,ease:i,keyframes:t}}get duration(){const{resolved:t}=this;if(!t)return 0;const{duration:e}=t;return o(e)}get time(){const{resolved:t}=this;if(!t)return 0;const{animation:e}=t;return o(e.currentTime||0)}set time(t){const{resolved:e}=this;if(!e)return;const{animation:n}=e;n.currentTime=r(t)}get speed(){const{resolved:t}=this;if(!t)return 1;const{animation:e}=t;return e.playbackRate}set speed(t){const{resolved:e}=this;if(!e)return;const{animation:n}=e;n.playbackRate=t}get state(){const{resolved:t}=this;if(!t)return"idle";const{animation:e}=t;return e.playState}get startTime(){const{resolved:t}=this;if(!t)return null;const{animation:e}=t;return e.startTime}attachTimeline(t){if(this._resolved){const{resolved:n}=this;if(!n)return e;const{animation:s}=n;p(s,t)}else this.pendingTimeline=t;return e}play(){if(this.isStopped)return;const{resolved:t}=this;if(!t)return;const{animation:e}=t;"finished"===e.playState&&this.updateFinishedPromise(),e.play()}pause(){const{resolved:t}=this;if(!t)return;const{animation:e}=t;e.pause()}stop(){if(this.resolver.cancel(),this.isStopped=!0,"idle"===this.state)return;this.resolveFinishedPromise(),this.updateFinishedPromise();const{resolved:t}=this;if(!t)return;const{animation:e,keyframes:n,duration:s,type:i,ease:o,times:a}=t;if("idle"===e.playState||"finished"===e.playState)return;if(this.time){const{motionValue:t,onUpdate:e,onComplete:l,element:u,...c}=this.options,h=new Ln({...c,keyframes:n,duration:s,type:i,ease:o,times:a,isGenerator:!0}),d=r(this.time);t.setWithVelocity(h.sample(d-10).value,h.sample(d).value,10)}const{onStop:l}=this.options;l&&l(),this.cancel()}complete(){const{resolved:t}=this;t&&t.animation.finish()}cancel(){const{resolved:t}=this;t&&t.animation.cancel()}static supports(t){const{motionValue:e,name:n,repeatDelay:s,repeatType:i,damping:r,type:o}=t;if(!(e&&e.owner&&e.owner.current instanceof HTMLElement))return!1;const{onUpdate:a,transformTemplate:l}=e.owner.getProps();return Kn()&&n&&Wn.has(n)&&!a&&!l&&!s&&"mirror"!==i&&0!==r&&"inertia"!==o}}const $n={type:"spring",stiffness:500,damping:25,restSpeed:10},Un={type:"keyframes",duration:.8},Hn={type:"keyframes",ease:[.25,.1,.35,1],duration:.3},Yn=(t,{keyframes:e})=>e.length>2?Un:mt.has(t)?t.startsWith("scale")?{type:"spring",stiffness:550,damping:0===e[1]?2*Math.sqrt(550):30,restSpeed:10}:$n:Hn;const qn=(t,e,n,s={},i,o)=>a=>{const c=u(s,t)||{},h=c.delay||s.delay||0;let{elapsed:d=0}=s;d-=r(h);let p={keyframes:Array.isArray(n)?n:[null,n],ease:"easeOut",velocity:e.getVelocity(),...c,delay:-d,onUpdate:t=>{e.set(t),c.onUpdate&&c.onUpdate(t)},onComplete:()=>{a(),c.onComplete&&c.onComplete()},name:t,motionValue:e,element:o?void 0:i};(function({when:t,delay:e,delayChildren:n,staggerChildren:s,staggerDirection:i,repeat:r,repeatType:o,repeatDelay:a,from:l,elapsed:u,...c}){return!!Object.keys(c).length})(c)||(p={...p,...Yn(t,p)}),p.duration&&(p.duration=r(p.duration)),p.repeatDelay&&(p.repeatDelay=r(p.repeatDelay)),void 0!==p.from&&(p.keyframes[0]=p.from);let f=!1;if((!1===p.type||0===p.duration&&!p.repeatDelay)&&(p.duration=0,0===p.delay&&(f=!0)),f&&!o&&void 0!==e.get()){const t=un(p.keyframes,c);if(void 0!==t)return bt.update(()=>{p.onUpdate(t),p.onComplete()}),new l([])}return!o&&zn.supports(p)?new zn(p):new Ln(p)};function Xn({protectedKeys:t,needsAnimating:e},n){const s=t.hasOwnProperty(n)&&!0!==e[n];return e[n]=!1,s}function Gn(t,e,{delay:n=0,transitionOverride:s,type:i}={}){var r;let{transition:o=t.getDefaultTransition(),transitionEnd:a,...l}=e;s&&(o=s);const c=[],h=i&&t.animationState&&t.animationState.getState()[i];for(const e in l){const s=t.getValue(e,null!==(r=t.latestValues[e])&&void 0!==r?r:null),i=l[e];if(void 0===i||h&&Xn(h,e))continue;const a={delay:n,...u(o||{},e)};let d=!1;if(window.MotionHandoffAnimation){const n=Lt(t);if(n){const t=window.MotionHandoffAnimation(n,e,bt);null!==t&&(a.startTime=t,d=!0)}}Rt(t,e),s.start(qn(e,s,i,t.shouldReduceMotion&&gt.has(e)?{type:!1}:a,t,d));const p=s.animation;p&&c.push(p)}return a&&Promise.all(c).then(()=>{bt.update(()=>{a&&It(t,a)})}),c}const Zn=()=>({x:{min:0,max:0},y:{min:0,max:0}}),_n={animation:["animate","variants","whileHover","whileTap","exit","whileInView","whileFocus","whileDrag"],exit:["exit"],drag:["drag","dragControls"],focus:["whileFocus"],hover:["whileHover","onHoverStart","onHoverEnd"],tap:["whileTap","onTap","onTapStart","onTapCancel"],pan:["onPan","onPanStart","onPanSessionStart","onPanEnd"],inView:["whileInView","onViewportEnter","onViewportLeave"],layout:["layout","layoutId"]},Jn={};for(const t in _n)Jn[t]={isEnabled:e=>_n[t].some(t=>!!e[t])};const Qn="undefined"!=typeof window,ts={current:null},es={current:!1};const ns=[...nn,me,Te];const ss=["initial","animate","whileInView","whileFocus","whileHover","whileTap","whileDrag","exit"];function is(t){return null!==(e=t.animate)&&"object"==typeof e&&"function"==typeof e.start||ss.some(e=>function(t){return"string"==typeof t||Array.isArray(t)}(t[e]));var e}const rs=["AnimationStart","AnimationComplete","Update","BeforeLayoutMeasure","LayoutMeasure","LayoutAnimationStart","LayoutAnimationComplete"];class os{scrapeMotionValuesFromProps(t,e,n){return{}}constructor({parent:t,props:e,presenceContext:n,reducedMotionConfig:s,blockInitialAnimation:i,visualState:r},o={}){this.current=null,this.children=new Set,this.isVariantNode=!1,this.isControllingVariants=!1,this.shouldReduceMotion=null,this.values=new Map,this.KeyframeResolver=Ye,this.features={},this.valueSubscriptions=new Map,this.prevMotionValues={},this.events={},this.propEventSubscriptions={},this.notifyUpdate=()=>this.notify("Update",this.latestValues),this.render=()=>{this.current&&(this.triggerBuild(),this.renderInstance(this.current,this.renderState,this.props.style,this.projection))},this.renderScheduledAt=0,this.scheduleRender=()=>{const t=Mt.now();this.renderScheduledAt<t&&(this.renderScheduledAt=t,bt.render(this.render,!1,!0))};const{latestValues:a,renderState:l,onUpdate:u}=r;this.onUpdate=u,this.latestValues=a,this.baseTarget={...a},this.initialValues=e.initial?{...a}:{},this.renderState=l,this.parent=t,this.props=e,this.presenceContext=n,this.depth=t?t.depth+1:0,this.reducedMotionConfig=s,this.options=o,this.blockInitialAnimation=Boolean(i),this.isControllingVariants=is(e),this.isVariantNode=function(t){return Boolean(is(t)||t.variants)}(e),this.isVariantNode&&(this.variantChildren=new Set),this.manuallyAnimateOnMount=Boolean(t&&t.current);const{willChange:c,...h}=this.scrapeMotionValuesFromProps(e,{},this);for(const t in h){const e=h[t];void 0!==a[t]&&J(e)&&e.set(a[t],!1)}}mount(t){this.current=t,pt.set(t,this),this.projection&&!this.projection.instance&&this.projection.mount(t),this.parent&&this.isVariantNode&&!this.isControllingVariants&&(this.removeFromVariantTree=this.parent.addVariantChild(this)),this.values.forEach((t,e)=>this.bindToMotionValue(e,t)),es.current||function(){if(es.current=!0,Qn)if(window.matchMedia){const t=window.matchMedia("(prefers-reduced-motion)"),e=()=>ts.current=t.matches;t.addListener(e),e()}else ts.current=!1}(),this.shouldReduceMotion="never"!==this.reducedMotionConfig&&("always"===this.reducedMotionConfig||ts.current),this.parent&&this.parent.children.add(this),this.update(this.props,this.presenceContext)}unmount(){pt.delete(this.current),this.projection&&this.projection.unmount(),xt(this.notifyUpdate),xt(this.render),this.valueSubscriptions.forEach(t=>t()),this.valueSubscriptions.clear(),this.removeFromVariantTree&&this.removeFromVariantTree(),this.parent&&this.parent.children.delete(this);for(const t in this.events)this.events[t].clear();for(const t in this.features){const e=this.features[t];e&&(e.unmount(),e.isMounted=!1)}this.current=null}bindToMotionValue(t,e){this.valueSubscriptions.has(t)&&this.valueSubscriptions.get(t)();const n=mt.has(t),s=e.on("change",e=>{this.latestValues[t]=e,this.props.onUpdate&&bt.preRender(this.notifyUpdate),n&&this.projection&&(this.projection.isTransformDirty=!0)}),i=e.on("renderRequest",this.scheduleRender);let r;window.MotionCheckAppearSync&&(r=window.MotionCheckAppearSync(this,t,e)),this.valueSubscriptions.set(t,()=>{s(),i(),r&&r(),e.owner&&e.stop()})}sortNodePosition(t){return this.current&&this.sortInstanceNodePosition&&this.type===t.type?this.sortInstanceNodePosition(this.current,t.current):0}updateFeatures(){let t="animation";for(t in Jn){const e=Jn[t];if(!e)continue;const{isEnabled:n,Feature:s}=e;if(!this.features[t]&&s&&n(this.props)&&(this.features[t]=new s(this)),this.features[t]){const e=this.features[t];e.isMounted?e.update():(e.mount(),e.isMounted=!0)}}}triggerBuild(){this.build(this.renderState,this.latestValues,this.props)}measureViewportBox(){return this.current?this.measureInstanceViewportBox(this.current,this.props):{x:{min:0,max:0},y:{min:0,max:0}}}getStaticValue(t){return this.latestValues[t]}setStaticValue(t,e){this.latestValues[t]=e}update(t,e){(t.transformTemplate||this.props.transformTemplate)&&this.scheduleRender(),this.prevProps=this.props,this.props=t,this.prevPresenceContext=this.presenceContext,this.presenceContext=e;for(let e=0;e<rs.length;e++){const n=rs[e];this.propEventSubscriptions[n]&&(this.propEventSubscriptions[n](),delete this.propEventSubscriptions[n]);const s=t["on"+n];s&&(this.propEventSubscriptions[n]=this.on(n,s))}this.prevMotionValues=function(t,e,n){for(const s in e){const i=e[s],r=n[s];if(J(i))t.addValue(s,i);else if(J(r))t.addValue(s,Ft(i,{owner:t}));else if(r!==i)if(t.hasValue(s)){const e=t.getValue(s);!0===e.liveStyle?e.jump(i):e.hasAnimated||e.set(i)}else{const e=t.getStaticValue(s);t.addValue(s,Ft(void 0!==e?e:i,{owner:t}))}}for(const s in n)void 0===e[s]&&t.removeValue(s);return e}(this,this.scrapeMotionValuesFromProps(t,this.prevProps,this),this.prevMotionValues),this.handleChildMotionValue&&this.handleChildMotionValue(),this.onUpdate&&this.onUpdate(this)}getProps(){return this.props}getVariant(t){return this.props.variants?this.props.variants[t]:void 0}getDefaultTransition(){return this.props.transition}getTransformPagePoint(){return this.props.transformPagePoint}getClosestVariantNode(){return this.isVariantNode?this:this.parent?this.parent.getClosestVariantNode():void 0}addVariantChild(t){const e=this.getClosestVariantNode();if(e)return e.variantChildren&&e.variantChildren.add(t),()=>e.variantChildren.delete(t)}addValue(t,e){const n=this.values.get(t);e!==n&&(n&&this.removeValue(t),this.bindToMotionValue(t,e),this.values.set(t,e),this.latestValues[t]=e.get())}removeValue(t){this.values.delete(t);const e=this.valueSubscriptions.get(t);e&&(e(),this.valueSubscriptions.delete(t)),delete this.latestValues[t],this.removeValueFromRenderState(t,this.renderState)}hasValue(t){return this.values.has(t)}getValue(t,e){if(this.props.values&&this.props.values[t])return this.props.values[t];let n=this.values.get(t);return void 0===n&&void 0!==e&&(n=Ft(null===e?void 0:e,{owner:this}),this.addValue(t,n)),n}readValue(t,e){var n;let s=void 0===this.latestValues[t]&&this.current?null!==(n=this.getBaseTargetFromProps(this.props,t))&&void 0!==n?n:this.readValueFromInstance(this.current,t,this.options):this.latestValues[t];var i;return null!=s&&("string"==typeof s&&(qe(s)||Gt(s))?s=parseFloat(s):(i=s,!ns.find(en(i))&&Te.test(e)&&(s=Ie(t,e))),this.setBaseTarget(t,J(s)?s.get():s)),J(s)?s.get():s}setBaseTarget(t,e){this.baseTarget[t]=e}getBaseTarget(t){var e;const{initial:n}=this.props;let s;if("string"==typeof n||"object"==typeof n){const i=Et(this.props,n,null===(e=this.presenceContext)||void 0===e?void 0:e.custom);i&&(s=i[t])}if(n&&void 0!==s)return s;const i=this.getBaseTargetFromProps(this.props,t);return void 0===i||J(i)?void 0!==this.initialValues[t]&&void 0===s?void 0:this.baseTarget[t]:i}on(t,e){return this.events[t]||(this.events[t]=new Pt),this.events[t].add(e)}notify(t,...e){this.events[t]&&this.events[t].notify(...e)}}class as extends os{constructor(){super(...arguments),this.KeyframeResolver=rn}sortInstanceNodePosition(t,e){return 2&t.compareDocumentPosition(e)?1:-1}getBaseTargetFromProps(t,e){return t.style?t.style[e]:void 0}removeValueFromRenderState(t,{vars:e,style:n}){delete e[t],delete n[t]}handleChildMotionValue(){this.childSubscription&&(this.childSubscription(),delete this.childSubscription);const{children:t}=this.props;J(t)&&(this.childSubscription=t.on("change",t=>{this.current&&(this.current.textContent=""+t)}))}}const ls=(t,e)=>e&&"number"==typeof t?e.transform(t):t,us={x:"translateX",y:"translateY",z:"translateZ",transformPerspective:"perspective"},cs=ft.length;function hs(t,e,n){const{style:s,vars:i,transformOrigin:r}=t;let o=!1,a=!1;for(const t in e){const n=e[t];if(mt.has(t))o=!0;else if(Ge(t))i[t]=n;else{const e=ls(n,Ce[t]);t.startsWith("origin")?(a=!0,r[t]=e):s[t]=e}}if(e.transform||(o||n?s.transform=function(t,e,n){let s="",i=!0;for(let r=0;r<cs;r++){const o=ft[r],a=t[o];if(void 0===a)continue;let l=!0;if(l="number"==typeof a?a===(o.startsWith("scale")?1:0):0===parseFloat(a),!l||n){const t=ls(a,Ce[o]);if(!l){i=!1;s+=`${us[o]||o}(${t}) `}n&&(e[o]=t)}}return s=s.trim(),n?s=n(e,i?"":s):i&&(s="none"),s}(e,t.transform,n):s.transform&&(s.transform="none")),a){const{originX:t="50%",originY:e="50%",originZ:n=0}=r;s.transformOrigin=`${t} ${e} ${n}`}}const ds={offset:"stroke-dashoffset",array:"stroke-dasharray"},ps={offset:"strokeDashoffset",array:"strokeDasharray"};function fs(t,e,n){return"string"==typeof t?t:ce.transform(e+n*t)}function ms(t,{attrX:e,attrY:n,attrScale:s,originX:i,originY:r,pathLength:o,pathSpacing:a=1,pathOffset:l=0,...u},c,h){if(hs(t,u,h),c)return void(t.style.viewBox&&(t.attrs.viewBox=t.style.viewBox));t.attrs=t.style,t.style={};const{attrs:d,style:p,dimensions:f}=t;d.transform&&(f&&(p.transform=d.transform),delete d.transform),f&&(void 0!==i||void 0!==r||p.transform)&&(p.transformOrigin=function(t,e,n){return`${fs(e,t.x,t.width)} ${fs(n,t.y,t.height)}`}(f,void 0!==i?i:.5,void 0!==r?r:.5)),void 0!==e&&(d.x=e),void 0!==n&&(d.y=n),void 0!==s&&(d.scale=s),void 0!==o&&function(t,e,n=1,s=0,i=!0){t.pathLength=1;const r=i?ds:ps;t[r.offset]=ce.transform(-s);const o=ce.transform(e),a=ce.transform(n);t[r.array]=`${o} ${a}`}(d,o,a,l,!1)}const gs=new Set(["baseFrequency","diffuseConstant","kernelMatrix","kernelUnitLength","keySplines","keyTimes","limitingConeAngle","markerHeight","markerWidth","numOctaves","targetX","targetY","surfaceScale","specularConstant","specularExponent","stdDeviation","tableValues","viewBox","gradientTransform","pathLength","startOffset","textLength","lengthAdjust"]);function ys(t,{style:e,vars:n},s,i){Object.assign(t.style,e,i&&i.getProjectionStyles(s));for(const e in n)t.style.setProperty(e,n[e])}const vs={};function ws(t,{layout:e,layoutId:n}){return mt.has(t)||t.startsWith("origin")||(e||void 0!==n)&&(!!vs[t]||"opacity"===t)}function bs(t,e,n){var s;const{style:i}=t,r={};for(const o in i)(J(i[o])||e.style&&J(e.style[o])||ws(o,t)||void 0!==(null===(s=null==n?void 0:n.getValue(o))||void 0===s?void 0:s.liveStyle))&&(r[o]=i[o]);return r}class xs extends as{constructor(){super(...arguments),this.type="svg",this.isSVGTag=!1,this.measureInstanceViewportBox=Zn}getBaseTargetFromProps(t,e){return t[e]}readValueFromInstance(t,e){if(mt.has(e)){const t=Oe(e);return t&&t.default||0}return e=gs.has(e)?e:Bt(e),t.getAttribute(e)}scrapeMotionValuesFromProps(t,e,n){return function(t,e,n){const s=bs(t,e,n);for(const n in t)if(J(t[n])||J(e[n])){s[-1!==ft.indexOf(n)?"attr"+n.charAt(0).toUpperCase()+n.substring(1):n]=t[n]}return s}(t,e,n)}build(t,e,n){ms(t,e,this.isSVGTag,n.transformTemplate)}renderInstance(t,e,n,s){!function(t,e,n,s){ys(t,e,void 0,s);for(const n in e.attrs)t.setAttribute(gs.has(n)?n:Bt(n),e.attrs[n])}(t,e,0,s)}mount(t){var e;this.isSVGTag="string"==typeof(e=t.tagName)&&"svg"===e.toLowerCase(),super.mount(t)}}class Ts extends as{constructor(){super(...arguments),this.type="html",this.renderInstance=ys}readValueFromInstance(t,e){if(mt.has(e)){const t=Oe(e);return t&&t.default||0}{const s=(n=t,window.getComputedStyle(n)),i=(Ge(e)?s.getPropertyValue(e):s[e])||0;return"string"==typeof i?i.trim():i}var n}measureInstanceViewportBox(t,{transformPagePoint:e}){return function(t,e){return function({top:t,left:e,right:n,bottom:s}){return{x:{min:e,max:n},y:{min:t,max:s}}}(function(t,e){if(!e)return t;const n=e({x:t.left,y:t.top}),s=e({x:t.right,y:t.bottom});return{top:n.y,left:n.x,bottom:s.y,right:s.x}}(t.getBoundingClientRect(),e))}(t,e)}build(t,e,n){hs(t,e,n.transformTemplate)}scrapeMotionValuesFromProps(t,e,n){return bs(t,e,n)}}class Ss extends os{constructor(){super(...arguments),this.type="object"}readValueFromInstance(t,e){if(function(t,e){return t in e}(e,t)){const n=t[e];if("string"==typeof n||"number"==typeof n)return n}}getBaseTargetFromProps(){}removeValueFromRenderState(t,e){delete e.output[t]}measureInstanceViewportBox(){return{x:{min:0,max:0},y:{min:0,max:0}}}build(t,e){Object.assign(t.output,e)}renderInstance(t,{output:e}){Object.assign(t,e)}sortInstanceNodePosition(){return 0}}function Vs(t){const e={presenceContext:null,props:{},visualState:{renderState:{transform:{},transformOrigin:{},style:{},vars:{},attrs:{}},latestValues:{}}},n=function(t){return t instanceof SVGElement&&"svg"!==t.tagName}(t)?new xs(e):new Ts(e);n.mount(t),pt.set(t,n)}function As(t){const e=new Ss({presenceContext:null,props:{},visualState:{renderState:{output:{}},latestValues:{}}});e.mount(t),pt.set(t,e)}function Ms(t,e,n,s){const i=[];if(function(t,e){return J(t)||"number"==typeof t||"string"==typeof t&&!Q(e)}(t,e))i.push(function(t,e,n){const s=J(t)?t:Ft(t);return s.start(qn("",s,e,n)),s.animation}(t,Q(e)&&e.default||e,n&&n.default||n));else{const r=tt(t,e,s),o=r.length;for(let t=0;t<o;t++){const s=r[t],a=s instanceof Element?Vs:As;pt.has(s)||a(s);const l=pt.get(s),u={...n};"delay"in u&&"function"==typeof u.delay&&(u.delay=u.delay(t,o)),i.push(...Gn(l,{...e,transition:u},{}))}}return i}function Ps(t,e,n){const s=[];return function(t,{defaultTransition:e={},...n}={},s,o){const a=e.duration||.3,l=new Map,u=new Map,c={},p=new Map;let f=0,m=0,g=0;for(let n=0;n<t.length;n++){const i=t[n];if("string"==typeof i){p.set(i,m);continue}if(!Array.isArray(i)){p.set(i.name,nt(m,i.at,f,p));continue}let[l,y,v={}]=i;void 0!==v.at&&(m=nt(m,v.at,f,p));let w=0;const b=(t,n,s,i=0,l=0)=>{const u=ut(t),{delay:c=0,times:p=_(u),type:f="keyframes",repeat:y,repeatType:v,repeatDelay:b=0,...x}=n;let{ease:T=e.ease||"easeOut",duration:S}=n;const V="function"==typeof c?c(i,l):c,A=u.length,M=d(f)?f:null==o?void 0:o[f];if(A<=2&&M){let t=100;if(2===A&&dt(u)){const e=u[1]-u[0];t=Math.abs(e)}const e={...x};void 0!==S&&(e.duration=r(S));const n=h(e,t,M);T=n.ease,S=n.duration}null!=S||(S=a);const P=m+V;1===p.length&&0===p[0]&&(p[1]=1);const k=p.length-u.length;if(k>0&&Z(p,k),1===u.length&&u.unshift(null),y){S=et(S,y);const t=[...u],e=[...p];T=Array.isArray(T)?[...T]:[T];const n=[...T];for(let s=0;s<y;s++){u.push(...t);for(let i=0;i<t.length;i++)p.push(e[i]+(s+1)),T.push(0===i?"linear":X(n,i-1))}rt(p,y)}const F=P+S;it(s,u,T,p,P,F),w=Math.max(V+S,w),g=Math.max(F,g)};if(J(l)){b(y,v,lt("default",at(l,u)))}else{const t=tt(l,y,s,c),e=t.length;for(let n=0;n<e;n++){y=y,v=v;const s=at(t[n],u);for(const t in y)b(y[t],ct(v,t),lt(t,s),n,e)}}f=m,m+=w}return u.forEach((t,s)=>{for(const r in t){const o=t[r];o.sort(ot);const a=[],u=[],c=[];for(let t=0;t<o.length;t++){const{at:e,value:n,easing:s}=o[t];a.push(n),u.push(i(0,g,e)),c.push(s||"easeOut")}0!==u[0]&&(u.unshift(0),a.unshift(a[0]),c.unshift("easeInOut")),1!==u[u.length-1]&&(u.push(1),a.push(null)),l.has(s)||l.set(s,{keyframes:{},transition:{}});const h=l.get(s);h.keyframes[r]=a,h.transition[r]={...e,duration:g,ease:c,times:u,...n}}}),l}(t,e,n,{spring:H}).forEach(({keyframes:t,transition:e},n)=>{s.push(...Ms(n,t,e))}),s}function ks(t){return function(e,n,s){let i=[];var r;r=e,i=Array.isArray(r)&&r.some(Array.isArray)?Ps(e,n,t):Ms(e,n,s,t);const o=new l(i);return t&&t.animations.push(o),o}}const Fs=ks();function Cs(t,e,n){t.style.setProperty("--"+e,n)}function Es(t,e,n){t.style[e]=n}const Os=s(()=>{try{document.createElement("div").animate({opacity:[1]})}catch(t){return!1}return!0}),Is=new WeakMap;function Rs(t){const e=Is.get(t)||new Map;return Is.set(t,e),Is.get(t)}class Bs extends class{constructor(t){this.animation=t}get duration(){var t,e,n;const s=(null===(e=null===(t=this.animation)||void 0===t?void 0:t.effect)||void 0===e?void 0:e.getComputedTiming().duration)||(null===(n=this.options)||void 0===n?void 0:n.duration)||300;return o(Number(s))}get time(){var t;return this.animation?o((null===(t=this.animation)||void 0===t?void 0:t.currentTime)||0):0}set time(t){this.animation&&(this.animation.currentTime=r(t))}get speed(){return this.animation?this.animation.playbackRate:1}set speed(t){this.animation&&(this.animation.playbackRate=t)}get state(){return this.animation?this.animation.playState:"finished"}get startTime(){return this.animation?this.animation.startTime:null}get finished(){return this.animation?this.animation.finished:Promise.resolve()}play(){this.animation&&this.animation.play()}pause(){this.animation&&this.animation.pause()}stop(){this.animation&&"idle"!==this.state&&"finished"!==this.state&&(this.animation.commitStyles&&this.animation.commitStyles(),this.cancel())}flatten(){var t;this.animation&&(null===(t=this.animation.effect)||void 0===t||t.updateTiming({easing:"linear"}))}attachTimeline(t){return this.animation&&p(this.animation,t),e}complete(){this.animation&&this.animation.finish()}cancel(){try{this.animation&&this.animation.cancel()}catch(t){}}}{constructor(t,e,s,i){const o=e.startsWith("--");n("string"!=typeof i.type);const a=Rs(t).get(e);a&&a.stop();if(Array.isArray(s)||(s=[s]),function(t,e,n){for(let s=0;s<e.length;s++)null===e[s]&&(e[s]=0===s?n():e[s-1]),"number"==typeof e[s]&&Pe[t]&&(e[s]=Pe[t].transform(e[s]));!Os()&&e.length<2&&e.unshift(n())}(e,s,()=>e.startsWith("--")?t.style.getPropertyValue(e):window.getComputedStyle(t)[e]),d(i.type)){const t=h(i,100,i.type);i.ease=y()?t.ease:"easeOut",i.duration=r(t.duration),i.type="keyframes"}else i.ease=i.ease||"easeOut";const l=()=>{this.setValue(t,e,un(s,i)),this.cancel(),this.resolveFinishedPromise()},u=()=>{this.setValue=o?Cs:Es,this.options=i,this.updateFinishedPromise(),this.removeAnimation=()=>{const n=Is.get(t);n&&n.delete(e)}};Kn()?(super(Nn(t,e,s,i)),u(),!1===i.autoplay&&this.animation.pause(),this.animation.onfinish=l,Rs(t).set(e,this)):(super(),u(),l())}then(t,e){return this.currentFinishedPromise.then(t,e)}updateFinishedPromise(){this.currentFinishedPromise=new Promise(t=>{this.resolveFinishedPromise=t})}play(){"finished"===this.state&&this.updateFinishedPromise(),super.play()}cancel(){this.removeAnimation(),super.cancel()}}const Ds=(t=>function(e,n,s){return new l(function(t,e,n,s){const i=S(t,s),o=i.length,a=[];for(let t=0;t<o;t++){const s=i[t],l={...n};"function"==typeof l.delay&&(l.delay=l.delay(t,o));for(const t in e){const n=e[t],i={...u(l,t)};i.duration=i.duration?r(i.duration):i.duration,i.delay=r(i.delay||0),a.push(new Bs(s,t,n,i))}}return a}(e,n,s,t))})();function Ls(t,e){let n;const s=()=>{const{currentTime:s}=e,i=(null===s?0:s.value)/100;n!==i&&t(i),n=i};return bt.update(s,!0),()=>xt(s)}const Ws=new WeakMap;let Ns;function Ks({target:t,contentRect:e,borderBoxSize:n}){var s;null===(s=Ws.get(t))||void 0===s||s.forEach(s=>{s({target:t,contentSize:e,get size(){return function(t,e){if(e){const{inlineSize:t,blockSize:n}=e[0];return{width:t,height:n}}return t instanceof SVGElement&&"getBBox"in t?t.getBBox():{width:t.offsetWidth,height:t.offsetHeight}}(t,n)}})})}function js(t){t.forEach(Ks)}function zs(t,e){Ns||"undefined"!=typeof ResizeObserver&&(Ns=new ResizeObserver(js));const n=S(t);return n.forEach(t=>{let n=Ws.get(t);n||(n=new Set,Ws.set(t,n)),n.add(e),null==Ns||Ns.observe(t)}),()=>{n.forEach(t=>{const n=Ws.get(t);null==n||n.delete(e),(null==n?void 0:n.size)||null==Ns||Ns.unobserve(t)})}}const $s=new Set;let Us;function Hs(t){return $s.add(t),Us||(Us=()=>{const t={width:window.innerWidth,height:window.innerHeight},e={target:window,size:t,contentSize:t};$s.forEach(t=>t(e))},window.addEventListener("resize",Us)),()=>{$s.delete(t),!$s.size&&Us&&(Us=void 0)}}const Ys={x:{length:"Width",position:"Left"},y:{length:"Height",position:"Top"}};function qs(t,e,n,s){const r=n[e],{length:o,position:a}=Ys[e],l=r.current,u=n.time;r.current=t["scroll"+a],r.scrollLength=t["scroll"+o]-t["client"+o],r.offset.length=0,r.offset[0]=0,r.offset[1]=r.scrollLength,r.progress=i(0,r.scrollLength,r.current);const c=s-u;r.velocity=c>50?0:A(r.current-l,c)}const Xs={start:0,center:.5,end:1};function Gs(t,e,n=0){let s=0;if(t in Xs&&(t=Xs[t]),"string"==typeof t){const e=parseFloat(t);t.endsWith("px")?s=e:t.endsWith("%")?t=e/100:t.endsWith("vw")?s=e/100*document.documentElement.clientWidth:t.endsWith("vh")?s=e/100*document.documentElement.clientHeight:t=e}return"number"==typeof t&&(s=e*t),n+s}const Zs=[0,0];function _s(t,e,n,s){let i=Array.isArray(t)?t:Zs,r=0,o=0;return"number"==typeof t?i=[t,t]:"string"==typeof t&&(i=(t=t.trim()).includes(" ")?t.split(" "):[t,Xs[t]?t:"0"]),r=Gs(i[0],n,s),o=Gs(i[1],e),r-o}const Js={Enter:[[0,1],[1,1]],Exit:[[0,0],[1,0]],Any:[[1,0],[0,1]],All:[[0,0],[1,1]]},Qs={x:0,y:0};function ti(t,e,n){const{offset:s=Js.All}=n,{target:i=t,axis:r="y"}=n,o="y"===r?"height":"width",a=i!==t?function(t,e){const n={x:0,y:0};let s=t;for(;s&&s!==e;)if(s instanceof HTMLElement)n.x+=s.offsetLeft,n.y+=s.offsetTop,s=s.offsetParent;else if("svg"===s.tagName){const t=s.getBoundingClientRect();s=s.parentElement;const e=s.getBoundingClientRect();n.x+=t.left-e.left,n.y+=t.top-e.top}else{if(!(s instanceof SVGGraphicsElement))break;{const{x:t,y:e}=s.getBBox();n.x+=t,n.y+=e;let i=null,r=s.parentNode;for(;!i;)"svg"===r.tagName&&(i=r),r=s.parentNode;s=i}}return n}(i,t):Qs,l=i===t?{width:t.scrollWidth,height:t.scrollHeight}:function(t){return"getBBox"in t&&"svg"!==t.tagName?t.getBBox():{width:t.clientWidth,height:t.clientHeight}}(i),u={width:t.clientWidth,height:t.clientHeight};e[r].offset.length=0;let c=!e[r].interpolate;const h=s.length;for(let t=0;t<h;t++){const n=_s(s[t],u[o],l[o],a[r]);c||n===e[r].interpolatorOffsets[t]||(c=!0),e[r].offset[t]=n}c&&(e[r].interpolate=On(e[r].offset,_(s),{clamp:!1}),e[r].interpolatorOffsets=[...e[r].offset]),e[r].progress=V(0,1,e[r].interpolate(e[r].current))}function ei(t,e,n,s={}){return{measure:()=>function(t,e=t,n){if(n.x.targetOffset=0,n.y.targetOffset=0,e!==t){let s=e;for(;s&&s!==t;)n.x.targetOffset+=s.offsetLeft,n.y.targetOffset+=s.offsetTop,s=s.offsetParent}n.x.targetLength=e===t?e.scrollWidth:e.clientWidth,n.y.targetLength=e===t?e.scrollHeight:e.clientHeight,n.x.containerLength=t.clientWidth,n.y.containerLength=t.clientHeight}(t,s.target,n),update:e=>{!function(t,e,n){qs(t,"x",e,n),qs(t,"y",e,n),e.time=n}(t,n,e),(s.offset||s.target)&&ti(t,n,s)},notify:()=>e(n)}}const ni=new WeakMap,si=new WeakMap,ii=new WeakMap,ri=t=>t===document.documentElement?window:t;function oi(t,{container:e=document.documentElement,...n}={}){let s=ii.get(e);s||(s=new Set,ii.set(e,s));const i=ei(e,t,{time:0,x:{current:0,offset:[],progress:0,scrollLength:0,targetOffset:0,targetLength:0,containerLength:0,velocity:0},y:{current:0,offset:[],progress:0,scrollLength:0,targetOffset:0,targetLength:0,containerLength:0,velocity:0}},n);if(s.add(i),!ni.has(e)){const t=()=>{for(const t of s)t.measure()},n=()=>{for(const t of s)t.update(Tt.timestamp)},i=()=>{for(const t of s)t.notify()},a=()=>{bt.read(t,!1,!0),bt.read(n,!1,!0),bt.update(i,!1,!0)};ni.set(e,a);const l=ri(e);window.addEventListener("resize",a,{passive:!0}),e!==document.documentElement&&si.set(e,(o=a,"function"==typeof(r=e)?Hs(r):zs(r,o))),l.addEventListener("scroll",a,{passive:!0})}var r,o;const a=ni.get(e);return bt.read(a,!1,!0),()=>{var t;xt(a);const n=ii.get(e);if(!n)return;if(n.delete(i),n.size)return;const s=ni.get(e);ni.delete(e),s&&(ri(e).removeEventListener("scroll",s),null===(t=si.get(e))||void 0===t||t(),window.removeEventListener("resize",s))}}const ai=new Map;function li({source:t,container:e=document.documentElement,axis:n="y"}={}){t&&(e=t),ai.has(e)||ai.set(e,{});const s=ai.get(e);return s[n]||(s[n]=a()?new ScrollTimeline({source:e,axis:n}):function({source:t,container:e,axis:n="y"}){t&&(e=t);const s={value:0},i=oi(t=>{s.value=100*t[n].progress},{container:e,axis:n});return{currentTime:s,cancel:i}}({source:e,axis:n})),s[n]}function ui(t){return t&&(t.target||t.offset)}const ci={some:0,all:1};const hi=(t,e)=>Math.abs(t-e);const di=bt,pi=wt.reduce((t,e)=>(t[e]=t=>xt(t),t),{});t.MotionValue=kt,t.animate=Fs,t.animateMini=Ds,t.anticipate=Ht,t.backIn=$t,t.backInOut=Ut,t.backOut=zt,t.cancelFrame=xt,t.cancelSync=pi,t.circIn=Yt,t.circInOut=Xt,t.circOut=qt,t.clamp=V,t.createScopedAnimate=ks,t.cubicBezier=Nt,t.delay=function(t,e){return function(t,e){const n=Mt.now(),s=({timestamp:i})=>{const r=i-n;r>=e&&(xt(s),t(r-e))};return bt.read(s,!0),()=>xt(s)}(t,r(e))},t.distance=hi,t.distance2D=function(t,e){const n=hi(t.x,e.x),s=hi(t.y,e.y);return Math.sqrt(n**2+s**2)},t.easeIn=Pn,t.easeInOut=Fn,t.easeOut=kn,t.frame=bt,t.frameData=Tt,t.frameSteps=St,t.inView=function(t,e,{root:n,margin:s,amount:i="some"}={}){const r=S(t),o=new WeakMap,a=new IntersectionObserver(t=>{t.forEach(t=>{const n=o.get(t.target);if(t.isIntersecting!==Boolean(n))if(t.isIntersecting){const n=e(t);"function"==typeof n?o.set(t.target,n):a.unobserve(t.target)}else"function"==typeof n&&(n(t),o.delete(t.target))})},{root:n,rootMargin:s,threshold:"number"==typeof i?i:ci[i]});return r.forEach(t=>a.observe(t)),()=>a.disconnect()},t.inertia=Mn,t.interpolate=On,t.invariant=n,t.isDragActive=function(){return T},t.keyframes=In,t.mirrorEasing=Kt,t.mix=An,t.motionValue=Ft,t.noop=e,t.pipe=vn,t.progress=i,t.reverseEasing=jt,t.scroll=function(t,{axis:n="y",...s}={}){const i={axis:n,...s};return"function"==typeof t?function(t,e){return function(t){return 2===t.length}(t)||ui(e)?oi(n=>{t(n[e.axis].progress,n)},e):Ls(t,li(e))}(t,i):function(t,n){if(t.flatten(),ui(n))return t.pause(),oi(e=>{t.time=t.duration*e[n.axis].progress},n);{const s=li(n);return t.attachTimeline?t.attachTimeline(s,t=>(t.pause(),Ls(e=>{t.time=t.duration*e},s))):e}}(t,i)},t.scrollInfo=oi,t.spring=H,t.stagger=function(t=.1,{startDelay:e=0,from:n=0,ease:s}={}){return(i,r)=>{const o="number"==typeof n?n:function(t,e){if("first"===t)return 0;{const n=e-1;return"last"===t?n:n/2}}(n,r),a=Math.abs(o-i);let l=t*a;if(s){const e=r*t;l=En(s)(l/e)*e}return e+l}},t.steps=function(t,e="end"){return n=>{const s=(n="end"===e?Math.min(n,.999):Math.max(n,.001))*t,i="end"===e?Math.floor(s):Math.ceil(s);return V(0,1,i/t)}},t.sync=di,t.time=Mt,t.transform=function(...t){const e=!Array.isArray(t[0]),n=e?0:-1,s=t[0+n],i=t[1+n],r=t[2+n],o=t[3+n],a=On(i,r,{mixer:(l=r[0],(t=>t&&"object"==typeof t&&t.mix)(l)?l.mix:void 0),...o});var l;return e?a(s):a},t.wrap=Y}));

/* ═════════════════════════ src/shared/icons.js ═════════════════════════ */
/**
 * Icons: generated from the lucide-static package (MIT, https://lucide.dev).
 * Do not edit by hand — run `node tools/gen-icons.mjs` after changing the list.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const defs = [
   {
    "name": "radar",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M19.07 4.93A10 10 0 0 0 6.99 3.34\" /> <path d=\"M4 6h.01\" /> <path d=\"M2.29 9.62A10 10 0 1 0 21.31 8.35\" /> <path d=\"M16.24 7.76A6 6 0 1 0 8.23 16.67\" /> <path d=\"M12 18h.01\" /> <path d=\"M17.99 11.66A6 6 0 0 1 15.77 16.67\" /> <circle cx=\"12\" cy=\"12\" r=\"2\" /> <path d=\"m13.41 10.59 5.66-5.66\" />"
   },
   {
    "name": "clapperboard",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z\" /> <path d=\"m6.2 5.3 3.1 3.9\" /> <path d=\"m12.4 3.4 3.1 4\" /> <path d=\"M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z\" />"
   },
   {
    "name": "settings",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z\" /> <circle cx=\"12\" cy=\"12\" r=\"3\" />"
   },
   {
    "name": "settings-2",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M20 7h-9\" /> <path d=\"M14 17H5\" /> <circle cx=\"17\" cy=\"17\" r=\"3\" /> <circle cx=\"7\" cy=\"7\" r=\"3\" />"
   },
   {
    "name": "x",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M18 6 6 18\" /> <path d=\"m6 6 12 12\" />"
   },
   {
    "name": "copy",
    "vb": "0 0 24 24",
    "inner": "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\" /> <path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\" />"
   },
   {
    "name": "download",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" /> <polyline points=\"7 10 12 15 17 10\" /> <line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\" />"
   },
   {
    "name": "file-down",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\" /> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\" /> <path d=\"M12 18v-6\" /> <path d=\"m9 15 3 3 3-3\" />"
   },
   {
    "name": "users",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\" /> <circle cx=\"9\" cy=\"7\" r=\"4\" /> <path d=\"M22 21v-2a4 4 0 0 0-3-3.87\" /> <path d=\"M16 3.13a4 4 0 0 1 0 7.75\" />"
   },
   {
    "name": "captions",
    "vb": "0 0 24 24",
    "inner": "<rect width=\"18\" height=\"14\" x=\"3\" y=\"5\" rx=\"2\" ry=\"2\" /> <path d=\"M7 15h4M15 15h2M7 11h2M13 11h4\" />"
   },
   {
    "name": "external-link",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M15 3h6v6\" /> <path d=\"M10 14 21 3\" /> <path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\" />"
   },
   {
    "name": "sun",
    "vb": "0 0 24 24",
    "inner": "<circle cx=\"12\" cy=\"12\" r=\"4\" /> <path d=\"M12 2v2\" /> <path d=\"M12 20v2\" /> <path d=\"m4.93 4.93 1.41 1.41\" /> <path d=\"m17.66 17.66 1.41 1.41\" /> <path d=\"M2 12h2\" /> <path d=\"M20 12h2\" /> <path d=\"m6.34 17.66-1.41 1.41\" /> <path d=\"m19.07 4.93-1.41 1.41\" />"
   },
   {
    "name": "moon",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\" />"
   },
   {
    "name": "refresh-cw",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\" /> <path d=\"M21 3v5h-5\" /> <path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\" /> <path d=\"M8 16H3v5\" />"
   },
   {
    "name": "check",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M20 6 9 17l-5-5\" />"
   },
   {
    "name": "chevron-down",
    "vb": "0 0 24 24",
    "inner": "<path d=\"m6 9 6 6 6-6\" />"
   },
   {
    "name": "play",
    "vb": "0 0 24 24",
    "inner": "<polygon points=\"6 3 20 12 6 21 6 3\" />"
   },
   {
    "name": "search",
    "vb": "0 0 24 24",
    "inner": "<circle cx=\"11\" cy=\"11\" r=\"8\" /> <path d=\"m21 21-4.3-4.3\" />"
   },
   {
    "name": "bell",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M10.268 21a2 2 0 0 0 3.464 0\" /> <path d=\"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326\" />"
   },
   {
    "name": "eye",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\" /> <circle cx=\"12\" cy=\"12\" r=\"3\" />"
   },
   {
    "name": "keyboard",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M10 8h.01\" /> <path d=\"M12 12h.01\" /> <path d=\"M14 8h.01\" /> <path d=\"M16 12h.01\" /> <path d=\"M18 8h.01\" /> <path d=\"M6 8h.01\" /> <path d=\"M7 16h10\" /> <path d=\"M8 12h.01\" /> <rect width=\"20\" height=\"16\" x=\"2\" y=\"4\" rx=\"2\" />"
   },
   {
    "name": "palette",
    "vb": "0 0 24 24",
    "inner": "<circle cx=\"13.5\" cy=\"6.5\" r=\".5\" fill=\"currentColor\" /> <circle cx=\"17.5\" cy=\"10.5\" r=\".5\" fill=\"currentColor\" /> <circle cx=\"8.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\" /> <circle cx=\"6.5\" cy=\"12.5\" r=\".5\" fill=\"currentColor\" /> <path d=\"M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z\" />"
   },
   {
    "name": "link-2",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M9 17H7A5 5 0 0 1 7 7h2\" /> <path d=\"M15 7h2a5 5 0 1 1 0 10h-2\" /> <line x1=\"8\" x2=\"16\" y1=\"12\" y2=\"12\" />"
   },
   {
    "name": "list-filter",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M3 6h18\" /> <path d=\"M7 12h10\" /> <path d=\"M10 18h4\" />"
   },
   {
    "name": "loader",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M12 2v4\" /> <path d=\"m16.2 7.8 2.9-2.9\" /> <path d=\"M18 12h4\" /> <path d=\"m16.2 16.2 2.9 2.9\" /> <path d=\"M12 18v4\" /> <path d=\"m4.9 19.1 2.9-2.9\" /> <path d=\"M2 12h4\" /> <path d=\"m4.9 4.9 2.9 2.9\" />"
   },
   {
    "name": "shield-check",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\" /> <path d=\"m9 12 2 2 4-4\" />"
   },
   {
    "name": "sparkles",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z\" /> <path d=\"M20 3v4\" /> <path d=\"M22 5h-4\" /> <path d=\"M4 17v2\" /> <path d=\"M5 18H3\" />"
   },
   {
    "name": "trash-2",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M3 6h18\" /> <path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\" /> <path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\" /> <line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\" /> <line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\" />"
   },
   {
    "name": "info",
    "vb": "0 0 24 24",
    "inner": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M12 16v-4\" /> <path d=\"M12 8h.01\" />"
   },
   {
    "name": "monitor-smartphone",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8\" /> <path d=\"M10 19v-3.96 3.15\" /> <path d=\"M7 19h5\" /> <rect width=\"6\" height=\"10\" x=\"16\" y=\"12\" rx=\"2\" />"
   },
   {
    "name": "plug-zap",
    "vb": "0 0 24 24",
    "inner": "<path d=\"M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z\" /> <path d=\"m2 22 3-3\" /> <path d=\"M7.5 13.5 10 11\" /> <path d=\"M10.5 16.5 13 14\" /> <path d=\"m18 3-4 4h6l-4 4\" />"
   },
   {
    "name": "video",
    "vb": "0 0 24 24",
    "inner": "<path d=\"m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5\" /> <rect x=\"2\" y=\"6\" width=\"14\" height=\"12\" rx=\"2\" />"
   },
   {
    "name": "circle",
    "vb": "0 0 24 24",
    "inner": "<circle cx=\"12\" cy=\"12\" r=\"10\" />"
   }
  ];
  function icon(name, cls) {
    const d = defs.find((x) => x.name === name) || defs[0];
    return (
      '<svg class="' + (cls || '') + '" viewBox="' +
      d.vb +
      '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      d.inner +
      '</svg>'
    );
  }
  icon.raw = (name) => (defs.find((x) => x.name === name) || defs[0]).inner;
  icon.names = defs.map((d) => d.name);
  SR.icons = icon;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

/* ═════════════════════════ src/content/ui-styles.js ═════════════════════════ */
/**
 * Stream Radar — UI stylesheet (design system)
 * ------------------------------------------------------------------
 * Injected into a closed shadow root, so nothing leaks in or out.
 * Conventions:
 *   • tokens only, no magic numbers in rules
 *   • motion: 120/180/260 ms springs, always paired with prefers-reduced-motion
 *   • every interactive element is ≥ 40 px (44 px on touch) and has a visible
 *     focus ring; press feedback comes from Motion (JS) plus :active here
 *   • no emoji, no decorative glyphs: icons are Lucide SVG (src/shared/icons.js)
 * The `srad-` prefix is kept for readable DevTools output.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});

  SR.uiCss = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.srad-root {
  /* palette */
  --c-bg: rgba(255,255,255,.78);
  --c-bg-2: rgba(12,16,28,.04);
  --c-bg-3: #ffffff;
  --c-fg: #101320;
  --c-fg-2: rgba(16,19,32,.6);
  --c-line: rgba(16,19,32,.12);
  --c-line-2: rgba(16,19,32,.07);
  --c-accent: #5b5bf0;
  --c-accent-soft: rgba(91,91,240,.12);
  --c-mint: #0f9e88;
  --c-ok: #157f3d;
  --c-warn: #99610a;
  --c-err: #b42318;
  --c-shadow: 0 24px 60px -12px rgba(9,12,25,.28), 0 4px 14px -6px rgba(9,12,25,.16);
  --c-shadow-soft: 0 2px 10px -4px rgba(9,12,25,.18);
  --c-inset-hi: inset 0 1px 0 rgba(255,255,255,.7);

  /* geometry */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 22px;
  --r-sm: 9px; --r-md: 14px; --r-lg: 20px; --r-pill: 999px;

  /* motion */
  --t-fast: 120ms; --t-mid: 190ms; --t-slow: 280ms;
  --ease-out: cubic-bezier(.22,.72,.24,1);
  --ease-spring: cubic-bezier(.2,.9,.28,1.24);

  /* type */
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  position: fixed !important; inset: 0 !important; z-index: 2147483000 !important;
  pointer-events: none; display: block;
  font-family: var(--font); font-size: 14px; line-height: 1.45; color: var(--c-fg);
  font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

.srad-root[data-theme="dark"] {
  --c-bg: rgba(20,23,36,.82);
  --c-bg-2: rgba(255,255,255,.05);
  --c-bg-3: #151a2b;
  --c-fg: #e8ecf8;
  --c-fg-2: rgba(232,236,248,.58);
  --c-line: rgba(232,236,248,.13);
  --c-line-2: rgba(232,236,248,.07);
  --c-accent: #7d7bff;
  --c-accent-soft: rgba(125,123,255,.16);
  --c-mint: #34e0c0;
  --c-ok: #46c96e;
  --c-warn: #e5a53a;
  --c-err: #ff6b62;
  --c-shadow: 0 28px 70px -14px rgba(0,0,0,.62), 0 4px 16px -6px rgba(0,0,0,.45);
  --c-shadow-soft: 0 2px 10px -4px rgba(0,0,0,.6);
  --c-inset-hi: inset 0 1px 0 rgba(255,255,255,.06);
}

/* ── floating action button ─────────────────────────────── */
.srad-fab {
  pointer-events: auto; position: absolute; right: 20px; bottom: 20px;
  width: 56px; height: 56px; border-radius: 19px; border: 1px solid var(--c-line);
  background: var(--c-bg-3); color: var(--c-fg);
  box-shadow: var(--c-shadow-soft), var(--c-inset-hi);
  display: grid; place-items: center; cursor: pointer; touch-action: none;
  user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
  transition: box-shadow var(--t-mid) var(--ease-out), background var(--t-mid) var(--ease-out), border-color var(--t-mid);
  backdrop-filter: saturate(1.4) blur(20px); -webkit-backdrop-filter: saturate(1.4) blur(20px);
  isolation: isolate;
}
.srad-fab::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; opacity: 0;
  background: radial-gradient(120% 120% at 20% 0%, var(--c-accent-soft), transparent 60%);
  transition: opacity var(--t-mid) var(--ease-out);
}
.srad-fab:hover { border-color: var(--c-accent); box-shadow: var(--c-shadow), var(--c-inset-hi); }
.srad-fab:hover::before { opacity: 1; }
.srad-fab:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 3px; }
.srad-fab svg { width: 24px; height: 24px; position: relative; color: var(--c-fg); }
.srad-fab[data-live="1"] svg { color: var(--c-accent); }
.srad-fab[data-dragging="1"] { cursor: grabbing; box-shadow: var(--c-shadow); }
.srad-fab[data-dragging="1"]::after { opacity: 0; }
.srad-fab::after {
  content: ""; position: absolute; inset: -3px; border-radius: 22px; border: 1.5px solid var(--c-accent);
  opacity: 0; pointer-events: none;
}
.srad-fab[data-pulse="1"]::after { animation: srad-ring 1.5s var(--ease-out) 2; }
@keyframes srad-ring { 0% { opacity: .55; transform: scale(.9); } 100% { opacity: 0; transform: scale(1.28); } }
.srad-badge {
  position: absolute; top: -6px; right: -6px; min-width: 21px; height: 21px; padding: 0 6px;
  border-radius: var(--r-pill); background: var(--c-accent); color: #fff;
  font-size: 11.5px; font-weight: 700; line-height: 21px; text-align: center;
  border: 2px solid var(--c-bg-3); transform: scale(0); transition: transform var(--t-mid) var(--ease-spring);
}
.srad-badge[data-show="1"] { transform: scale(1); }
.srad-badge[data-empty="1"] { background: var(--c-fg-2); }

/* ── panel shell ────────────────────────────────────────── */
.srad-panel {
  pointer-events: auto; position: absolute; right: 20px; bottom: 88px;
  width: min(444px, calc(100vw - 28px)); max-height: min(78vh, 760px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-lg);
  box-shadow: var(--c-shadow); color: var(--c-fg);
  backdrop-filter: saturate(1.6) blur(22px); -webkit-backdrop-filter: saturate(1.6) blur(22px);
  transform-origin: bottom right; visibility: hidden; opacity: 0;
  transition: opacity var(--t-mid) var(--ease-out), transform var(--t-slow) var(--ease-spring), visibility var(--t-mid);
}
.srad-panel[data-open="1"] { opacity: 1; visibility: visible; transform: none; }
.srad-panel[data-anchor="tr"] { top: 88px; bottom: auto; transform-origin: top right; }
.srad-panel[data-anchor="tl"] { right: auto; left: 20px; top: 88px; bottom: auto; transform-origin: top left; }
.srad-panel[data-anchor="bl"] { right: auto; left: 20px; bottom: 88px; transform-origin: bottom left; }

.srad-head { display: flex; align-items: center; gap: var(--sp-2); padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--c-line-2); }
.srad-brand { display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1 1 auto; cursor: grab; }
.srad-head[data-drag="1"] .srad-brand { cursor: grabbing; }
.srad-mark { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; flex: none;
  background: linear-gradient(150deg, var(--c-accent), #3d3ac9 62%, var(--c-mint)); color: #fff;
  box-shadow: 0 4px 14px -4px var(--c-accent); }
.srad-mark svg { width: 15px; height: 15px; }
.srad-headtxt { min-width: 0; }
.srad-headtxt b { display: block; font-size: 13px; font-weight: 650; letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 210px; }
.srad-headtxt small { display: block; font-size: 11px; color: var(--c-fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 210px; }
.srad-spacer { flex: 1 1 auto; min-width: 0; }

.srad-iconbtn {
  pointer-events: auto; position: relative; overflow: hidden; flex: none;
  width: 40px; height: 40px; display: grid; place-items: center; padding: 0;
  border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--c-fg-2);
  cursor: pointer; -webkit-tap-highlight-color: transparent;
  transition: background var(--t-fast) var(--ease-out), color var(--t-fast), border-color var(--t-fast), transform var(--t-fast);
}
.srad-iconbtn:hover { background: var(--c-bg-2); color: var(--c-fg); }
.srad-iconbtn:active { transform: scale(.93); }
.srad-iconbtn:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 1px; }
.srad-iconbtn svg { width: 18px; height: 18px; }
.srad-iconbtn[data-on="1"] { color: var(--c-accent); border-color: var(--c-line); background: var(--c-accent-soft); }

/* ── tabs ───────────────────────────────────────────────── */
.srad-tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--c-line-2); }
.srad-tab {
  position: relative; border: 0; background: transparent; color: var(--c-fg-2); cursor: pointer;
  font: 600 12.5px/1 var(--font); padding: 10px 11px; min-height: 38px; border-radius: 8px 8px 0 0;
  display: inline-flex; align-items: center; gap: 6px; -webkit-tap-highlight-color: transparent;
}
.srad-tab svg { width: 15px; height: 15px; }
.srad-tab:hover { color: var(--c-fg); }
.srad-tab[aria-selected="true"] { color: var(--c-fg); }
.srad-tab[aria-selected="true"]::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--c-accent); }
.srad-tab:focus-visible { outline: 2px solid var(--c-accent); outline-offset: -2px; }
.srad-tab i { font-style: normal; font-size: 11px; font-weight: 700; color: var(--c-fg-2); background: var(--c-bg-2); border-radius: var(--r-pill); padding: 1px 6px; }

/* ── meta strip ─────────────────────────────────────────── */
.srad-meta { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 14px 0; }
.srad-meta:empty { display: none; }
.srad-chip {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600;
  padding: 3px 9px; border-radius: var(--r-pill); background: var(--c-bg-2);
  border: 1px solid var(--c-line-2); color: var(--c-fg-2); max-width: 100%;
}
.srad-chip svg { width: 12px; height: 12px; }
.srad-chip[data-kind="ep"], .srad-chip[data-kind="year"] { color: var(--c-accent); background: var(--c-accent-soft); border-color: transparent; }
.srad-chip[data-kind="warn"] { color: var(--c-warn); }
.srad-chip[data-kind="err"] { color: var(--c-err); }
.srad-chip[data-kind="ok"] { color: var(--c-ok); }

/* ── list ───────────────────────────────────────────────── */
.srad-body { flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; padding: var(--sp-2) 10px 4px; scrollbar-width: thin; }
.srad-body::-webkit-scrollbar { width: 10px; }
.srad-body::-webkit-scrollbar-thumb { background: var(--c-line); border-radius: 8px; border: 3px solid transparent; background-clip: content-box; }
.srad-pane[hidden] { display: none; }

.srad-empty { text-align: center; color: var(--c-fg-2); padding: 30px 22px 34px; }
.srad-empty svg { width: 26px; height: 26px; opacity: .55; margin-bottom: 10px; animation: srad-spin 2.4s linear infinite; }
.srad-empty b { display: block; color: var(--c-fg); font-size: 14px; margin-bottom: 5px; }
.srad-empty p { margin: 0; font-size: 12.5px; }
@keyframes srad-spin { to { transform: rotate(360deg); } }

.srad-item {
  position: relative; display: grid; grid-template-columns: 50px minmax(0,1fr); gap: 10px;
  padding: 10px; margin-bottom: var(--sp-2); border-radius: var(--r-md);
  background: var(--c-bg-3); border: 1px solid var(--c-line-2); box-shadow: var(--c-shadow-soft);
  transition: border-color var(--t-fast) var(--ease-out), transform var(--t-fast) var(--ease-out), box-shadow var(--t-mid);
  will-change: transform;
}
.srad-item:hover { border-color: var(--c-line); }
.srad-item:focus-visible, .srad-item[data-active="1"] { outline: 2px solid var(--c-accent); outline-offset: 1px; border-color: transparent; }
.srad-item[data-ad="1"] { opacity: .78; }
.srad-thumb {
  width: 50px; height: 50px; border-radius: 11px; overflow: hidden; position: relative; flex: none;
  display: grid; place-items: center; background: var(--c-bg-2); color: #fff;
  font-size: 9px; font-weight: 800; letter-spacing: .04em;
}
.srad-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.srad-thumb svg { width: 20px; height: 20px; opacity: .95; }
.srad-thumb[data-cat="hls"] { background: linear-gradient(145deg,#f97316,#b83a08); }
.srad-thumb[data-cat="dash"] { background: linear-gradient(145deg,#0ea5e9,#1746b8); }
.srad-thumb[data-cat="mp4"] { background: linear-gradient(145deg,#22c55e,#0c6b63); }
.srad-thumb[data-cat="webm"] { background: linear-gradient(145deg,#a855f7,#5b21b6); }
.srad-thumb[data-cat="blob"] { background: linear-gradient(145deg,#64748b,#2c3547); }
.srad-thumb[data-cat="segment"] { background: linear-gradient(145deg,#eab308,#8a5a06); }
.srad-thumb[data-cat="texttrack"] { background: linear-gradient(145deg,#14b8a6,#0f6b63); }
.srad-main { min-width: 0; }
.srad-row1 { display: flex; align-items: baseline; gap: 8px; }
.srad-name { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 640; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srad-conf { flex: none; display: inline-flex; gap: 3px; align-items: center; }
.srad-conf i { width: 5px; height: 5px; border-radius: 50%; background: var(--c-line); }
.srad-conf i[data-on="1"] { background: var(--c-mint); }
.srad-url { margin-top: 2px; font: 10.5px/1.4 var(--mono); color: var(--c-fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srad-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.srad-tag {
  font-size: 10.5px; font-weight: 650; padding: 2px 7px; border-radius: 7px;
  background: var(--c-bg-2); border: 1px solid var(--c-line-2); color: var(--c-fg-2);
  display: inline-flex; align-items: center; gap: 4px;
}
.srad-tag svg { width: 11px; height: 11px; }
.srad-tag[data-tone="q"] { color: var(--c-accent); background: var(--c-accent-soft); border-color: transparent; }
.srad-tag[data-tone="ok"] { color: var(--c-ok); }
.srad-tag[data-tone="warn"] { color: var(--c-warn); }
.srad-tag[data-tone="err"] { color: var(--c-err); }
.srad-tag[data-busy="1"] { color: var(--c-accent); }
.srad-tag[data-busy="1"] svg { animation: srad-spin 1.1s linear infinite; }

.srad-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.srad-btn {
  position: relative; overflow: hidden; pointer-events: auto; -webkit-tap-highlight-color: transparent;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 34px; padding: 0 11px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--c-line); background: transparent; color: var(--c-fg);
  font: 620 12px/1 var(--font); transition: background var(--t-fast) var(--ease-out), border-color var(--t-fast), transform var(--t-fast), color var(--t-fast);
}
.srad-btn svg { width: 15px; height: 15px; flex: none; }
.srad-btn:hover { background: var(--c-bg-2); border-color: var(--c-accent); }
.srad-btn:active { transform: scale(.96); }
.srad-btn:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }
.srad-btn[data-primary="1"] { color: #fff; border-color: transparent; background: linear-gradient(150deg, var(--c-accent), #3d3ac9); box-shadow: 0 6px 18px -8px var(--c-accent); }
.srad-btn[data-primary="1"]:hover { filter: brightness(1.07); }
.srad-btn[data-done="1"] { color: var(--c-ok); border-color: var(--c-ok); background: transparent; }
.srad-btn[disabled] { opacity: .55; cursor: progress; }
.srad-ripple { position: absolute; border-radius: 50%; transform: scale(0); background: currentColor; opacity: .22; pointer-events: none; }

.srad-variants { display: none; margin-top: 9px; padding-top: 8px; border-top: 1px dashed var(--c-line); }
.srad-item[data-expanded="1"] .srad-variants { display: block; }
.srad-variant { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--c-fg-2); padding: 3px 2px; }
.srad-variant b { color: var(--c-fg); font-weight: 620; }
.srad-vq { min-width: 48px; font-weight: 700; color: var(--c-fg); }
.srad-variant .srad-btn { margin-left: auto; min-height: 28px; }
.srad-note { margin-top: 8px; font-size: 11.5px; color: var(--c-fg-2); display: flex; gap: 6px; align-items: flex-start; }
.srad-note svg { width: 13px; height: 13px; flex: none; margin-top: 2px; }

/* ── subtitles pane ─────────────────────────────────────── */
.srad-sub-card { padding: 10px 12px; border-radius: var(--r-md); background: var(--c-bg-3); border: 1px solid var(--c-line-2); margin-bottom: var(--sp-2); }
.srad-sub-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 640; }
.srad-sub-head .srad-state { margin-left: auto; font-size: 11px; font-weight: 700; color: var(--c-fg-2); display: inline-flex; align-items: center; gap: 5px; }
.srad-sub-head .srad-state[data-s="found"] { color: var(--c-ok); }
.srad-sub-head .srad-state[data-s="error"], .srad-sub-head .srad-state[data-s="none"] { color: var(--c-warn); }
.srad-sub-head .srad-state[data-s="searching"] { color: var(--c-accent); }
.srad-sub-head .srad-state[data-s="searching"] svg { width: 12px; height: 12px; animation: srad-spin 1.1s linear infinite; }
.srad-providers { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px; }
.srad-pv { font-size: 10.5px; padding: 2px 7px; border-radius: 7px; border: 1px solid var(--c-line-2); color: var(--c-fg-2); }
.srad-pv[data-s="ok"] { color: var(--c-ok); border-color: var(--c-ok); }
.srad-pv[data-s="error"], .srad-pv[data-s="skipped"] { color: var(--c-warn); border-color: var(--c-warn); }
.srad-sub-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; padding: 6px 8px; border-radius: 10px; background: var(--c-bg-2); }
.srad-sub-row span { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srad-sub-row em { font-style: normal; color: var(--c-fg-2); font-size: 11px; }
.srad-sub-row[data-picked="1"] { outline: 1px solid var(--c-accent); }
.srad-sub-actions { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }

/* ── settings sheet ─────────────────────────────────────── */
.srad-pop {
  position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column;
  background: var(--c-bg-3); color: var(--c-fg); transform: translateY(101%);
  transition: transform var(--t-slow) var(--ease-out);
}
.srad-pop[data-open="1"] { transform: none; }
.srad-popbody { overflow: auto; padding: 4px 14px 16px; }
.srad-field { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--c-line-2); min-height: 46px; }
.srad-field > label, .srad-field > .lab { flex: 1 1 auto; font-size: 12.5px; font-weight: 600; }
.srad-field .hint { display: block; color: var(--c-fg-2); font-weight: 400; font-size: 11.5px; margin-top: 1px; }
.srad-seg { display: inline-flex; background: var(--c-bg-2); border: 1px solid var(--c-line-2); border-radius: 10px; padding: 2px; gap: 2px; }
.srad-seg button { border: 0; background: transparent; color: var(--c-fg-2); font: 600 11.5px/1 var(--font); padding: 7px 10px; min-height: 32px; border-radius: 8px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.srad-seg button[data-on="1"] { background: var(--c-accent); color: #fff; }
.srad-switch { position: relative; display: inline-flex; align-items: center; flex: none; width: 40px; height: 24px; border-radius: var(--r-pill); background: var(--c-line); border: 0; cursor: pointer; padding: 0; transition: background var(--t-mid) var(--ease-out); }
.srad-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.32); transition: transform var(--t-mid) var(--ease-spring); }
.srad-switch[aria-checked="true"] { background: var(--c-accent); }
.srad-switch[aria-checked="true"]::after { transform: translateX(16px); }
.srad-switch:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }

/* ── footer ─────────────────────────────────────────────── */
.srad-foot { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--c-line-2); background: var(--c-bg-2); flex-wrap: wrap; }
.srad-count { font-size: 11.5px; color: var(--c-fg-2); font-weight: 600; }

/* ── toasts ─────────────────────────────────────────────── */
.srad-toasts { pointer-events: none; position: absolute; top: 14px; right: 14px; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; width: min(360px, calc(100vw - 28px)); }
.srad-toast {
  pointer-events: auto; position: relative; overflow: hidden; display: flex; align-items: center; gap: 9px;
  max-width: 100%; padding: 10px 12px; border-radius: var(--r-md);
  background: var(--c-bg); border: 1px solid var(--c-line); box-shadow: var(--c-shadow); color: var(--c-fg);
  backdrop-filter: saturate(1.5) blur(18px); -webkit-backdrop-filter: saturate(1.5) blur(18px);
  font-size: 12.5px; font-weight: 550;
}
.srad-toast .srad-tico { width: 22px; height: 22px; flex: none; display: grid; place-items: center; border-radius: 7px; background: var(--c-accent-soft); color: var(--c-accent); }
.srad-toast .srad-tico svg { width: 13px; height: 13px; }
.srad-toast[data-kind="ok"] .srad-tico { background: rgba(21,127,61,.14); color: var(--c-ok); }
.srad-toast[data-kind="warn"] .srad-tico { background: rgba(153,97,10,.14); color: var(--c-warn); }
.srad-toast[data-kind="err"] .srad-tico { background: rgba(180,35,24,.12); color: var(--c-err); }
.srad-toast > span:nth-child(2) { flex: 1 1 auto; min-width: 0; }
.srad-toast button { flex: none; border: 1px solid var(--c-line); background: transparent; color: var(--c-fg); border-radius: 8px; font: 650 11.5px var(--font); padding: 5px 8px; cursor: pointer; min-height: 28px; }
.srad-toast .srad-tbar { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: var(--c-accent); transform-origin: left; opacity: .85; }

.srad-sr { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ── responsive / touch ─────────────────────────────────── */
@media (max-width: 720px), (pointer: coarse) and (max-width: 900px) {
  .srad-fab { width: 52px; height: 52px; right: 12px; bottom: 12px; border-radius: 17px; }
  .srad-panel {
    right: 0 !important; left: 0 !important; top: auto !important; bottom: 0 !important;
    width: 100vw; max-width: 100vw; max-height: 84vh; border-radius: var(--r-lg) var(--r-lg) 0 0;
    border-bottom: 0; transform-origin: bottom center; padding-bottom: env(safe-area-inset-bottom, 0);
  }
  .srad-panel::before { content: ""; position: absolute; top: 6px; left: 50%; transform: translateX(-50%); width: 38px; height: 4px; border-radius: 2px; background: var(--c-line); }
  .srad-iconbtn, .srad-btn { min-height: 44px; }
  .srad-btn { flex: 1 1 auto; }
  .srad-toasts { top: 8px; left: 8px; right: 8px; width: auto; align-items: stretch; }
}
@media (prefers-reduced-motion: reduce) {
  .srad-root *, .srad-root *::before, .srad-root *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
}
@media (prefers-contrast: more) {
  .srad-root { --c-line: currentColor; --c-bg: ButtonFace; --c-bg-3: Canvas; --c-fg: CanvasText; }
}
`;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ═════════════════════════ src/content/ui.js ═════════════════════════ */
/**
 * Stream Radar — the UI (FAB, panel, tabs, toasts, settings sheet)
 * ------------------------------------------------------------------
 * View only. It never fetches and never decides what counts as media; it renders
 * `state` from the background worker and reports intent through `onAction`.
 *
 * Polish details, all deliberate:
 *   • Motion (vendored, src/vendor/motion.min.js) drives entrance, exit, FLIP
 *     list reordering and press springs; when it is unavailable (older browser,
 *     userscript) every effect degrades to CSS and nothing breaks.
 *   • pointerdown ripple on every button + optional haptic tick on touch devices,
 *     so each click has a visible, immediate answer.
 *   • Icons are Lucide SVG (src/shared/icons.js). No emoji, no decorative glyphs.
 *   • Closed shadow root: the host page cannot restyle us and we cannot restyle it.
 *   • Keyboard: Tab/Shift+Tab, Enter/Space on the FAB, ↑↓ between rows, E to
 *     expand, Esc to close. Focus is trapped while the panel is open.
 *   • All durations honour prefers-reduced-motion (see ui-styles.js).
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;
  const ico = (n, cls) => (SR.icons ? SR.icons(n, cls) : '');

  /* ---------------- motion bridge (safe when Motion is missing) ---------------- */
  const reduced = () => {
    try {
      return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {
      return false;
    }
  };
  function animate(el, frames, opts) {
    if (!el || reduced()) return null;
    const M = root.Motion;
    try {
      if (M && M.animate) return M.animate(el, frames, Object.assign({ duration: 0.24, easing: [0.22, 0.72, 0.24, 1] }, opts || {}));
      if (el.animate) return el.animate(frames, { duration: ((opts && opts.duration) || 0.24) * 1000, easing: 'cubic-bezier(.22,.72,.24,1)', fill: 'both' });
    } catch (_) {}
    return null;
  }
  const spring = { duration: 0.34, easing: [0.2, 0.9, 0.28, 1.24] };
  function vibrate(ms) {
    try {
      if (root.navigator && root.navigator.vibrate && matchMedia('(pointer: coarse)').matches) root.navigator.vibrate(ms);
    } catch (_) {}
  }

  /* ---------------- ripples ---------------- */
  function attachRipples(shadow) {
    shadow.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest && e.target.closest('.srad-btn, .srad-iconbtn, .srad-tab, .srad-switch');
      if (!btn || reduced()) return;
      const r = btn.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 1.9;
      const span = root.document.createElement('span');
      span.className = 'srad-ripple';
      span.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
      btn.appendChild(span);
      const anim = animate(span, { transform: ['scale(0)', 'scale(1)'], opacity: [0.24, 0] }, { duration: 0.5 });
      const kill = () => span.remove();
      if (anim && anim.finished) anim.finished.then(kill, kill);
      else setTimeout(kill, 480);
    });
  }

  SR.ui = {
    create(opts) {
      const o = opts || {};
      const t = (k, v) => SR.i18n.t(k, v);
      const api = {
        open: false,
        tab: 'media',
        lastCount: -1,
        items: [],
        ads: [],
        showAds: false,
        settings: {},
        state: null,
        popOpen: false,
      };
      let host, shadow, rootEl, fab, badge, panel, bodyEl, toastsEl, footEl, metaEl, tabsEl;
      let drag = null,
        moved = false,
        lastFocused = null,
        mounted = false,
        rowRects = new Map();

      /* ================= mount ================= */
      function mount() {
        if (mounted || !root.document || !root.document.documentElement) return false;
        mounted = true;
        host = root.document.createElement('div');
        host.id = 'stream-radar-host';
        host.setAttribute('data-srad', '1');
        // closed by default: the page must not be able to read or poke our UI.
        // Tests opt into an open root to assert generated markup (see content.js).
        shadow = host.attachShadow({ mode: o.shadowMode === 'open' ? 'open' : 'closed' });
        const style = root.document.createElement('style');
        style.textContent = SR.uiCss;
        shadow.appendChild(style);

        rootEl = root.document.createElement('div');
        rootEl.className = 'srad-root';
        rootEl.setAttribute('dir', 'ltr');
        rootEl.innerHTML =
          '<div class="srad-toasts" role="region" aria-live="polite" aria-label="' + esc(t('toast.title', {})) + '"></div>' +
          '<section class="srad-panel" role="dialog" aria-modal="false" aria-label="' + esc(t('panel.title')) + '" data-open="0">' +
          header() +
          '<div class="srad-tabs" role="tablist"></div>' +
          '<div class="srad-meta" data-el="meta"></div>' +
          '<div class="srad-body" role="region" tabindex="-1" data-el="body"></div>' +
          footer() +
          '<div class="srad-pop" data-el="pop" role="region" aria-label="' + esc(t('panel.settings')) + '"></div>' +
          '</section>' +
          '<div class="srad-fab" role="button" tabindex="0" aria-haspopup="dialog" aria-expanded="false"></div>' +
          '<div class="srad-sr" role="status" aria-live="polite" data-el="live"></div>';
        shadow.appendChild(rootEl);

        panel = rootEl.querySelector('.srad-panel');
        bodyEl = panel.querySelector('[data-el="body"]');
        metaEl = panel.querySelector('[data-el="meta"]');
        tabsEl = panel.querySelector('.srad-tabs');
        footEl = panel.querySelector('.srad-foot');
        toastsEl = rootEl.querySelector('.srad-toasts');
        fab = rootEl.querySelector('.srad-fab');
        badge = root.document.createElement('div');
        badge.className = 'srad-badge';
        badge.setAttribute('data-empty', '1');
        badge.setAttribute('data-show', '0');
        badge.setAttribute('aria-hidden', 'true');
        fab.appendChild(badge);
        fab.insertAdjacentHTML('afterbegin', ico('radar'));
        fab.setAttribute('aria-label', t('fab.label', { n: 0 }));

        renderTabs();
        renderBody();
        renderFooter();
        wire();
        applyFabPos((o.getSettings && o.getSettings().fabPos) || null);
        applyTheme();
        const attach = () => {
          const target = root.document.body || root.document.documentElement;
          if (target && host.parentNode !== target) target.appendChild(host);
          animate(fab, { transform: ['scale(.6) translateY(14px)', 'scale(1) translateY(0)'], opacity: [0, 1] }, spring);
        };
        attach();
        if (!root.document.body) root.document.addEventListener('DOMContentLoaded', attach, { once: true });
        return true;
      }

      function header() {
        return (
          '<header class="srad-head">' +
          '<div class="srad-brand" data-el="grip">' +
          '<span class="srad-mark">' + ico('clapperboard') + '</span>' +
          '<span class="srad-headtxt"><span data-el="title"><b>' + esc(t('panel.title')) + '</b><small>' + esc(t('app.tagline')) + '</small></span></span>' +
          '</div>' +
          '<span class="srad-spacer"></span>' +
          iconBtn('theme', t('common.theme')) +
          iconBtn('refresh', t('panel.refresh')) +
          iconBtn('settings', t('panel.settings')) +
          iconBtn('x', t('common.close')) +
          '</header>'
        );
      }
      function iconBtn(act, label) {
        return '<button class="srad-iconbtn" data-act="' + act + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + ico(act === 'x' ? 'x' : act === 'theme' ? 'moon' : act) + '</button>';
      }
      function footer() {
        return (
          '<div class="srad-foot">' +
          '<span class="srad-count" data-el="count"></span>' +
          '<span class="srad-spacer"></span>' +
          '<button class="srad-btn" data-act="ads" data-el="ads" aria-label="' + esc(t('panel.toggleAds')) + '" title="' + esc(t('panel.toggleAds')) + '"><span data-el="adslabel"></span></button>' +
          '<button class="srad-btn" data-act="clear">' + ico('trash-2') + esc(t('panel.clear')) + '</button>' +
          '<button class="srad-btn" data-act="options" title="' + esc(t('panel.openPanel')) + '">' + ico('settings-2') + '</button>' +
          '</div>'
        );
      }

      function renderTabs() {
        if (!tabsEl) return;
        const sub = (api.state && api.state.sub) || {};
        const badge = sub.status === 'found' ? (sub.items || []).length : 0;
        tabsEl.innerHTML = [
          ['media', t('panel.tabMedia'), 'video', ((api.state && api.state.items) || []).length],
          ['subs', t('panel.tabSubs'), 'captions', badge],
          ['info', t('panel.tabInfo'), 'info', 0],
        ]
          .map(
            ([id, label, icon, count]) =>
              '<button class="srad-tab" role="tab" id="srad-tab-' + id + '" aria-controls="srad-pane-' + id + '" aria-selected="' +
              (api.tab === id ? 'true' : 'false') +
              '" data-act="tab" data-tab="' + id + '">' + ico(icon) + esc(label) + (count ? '<i>' + count + '</i>' : '') + '</button>'
          )
          .join('');
      }

      /* ================= render ================= */
      function render(state) {
        if (!mounted && !mount()) return;
        if (state) api.state = state;
        const s = (api.state && api.state.settings) || api.settings || {};
        api.settings = s;
        applyTheme();
        renderTabs();
        renderMeta();
        renderBody();
        renderFooter();
        updateBadge();
      }

      function updateBadge() {
        const items = visible();
        const n = items.length;
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.setAttribute('data-show', n ? '1' : '0');
        badge.setAttribute('data-empty', n ? '0' : '1');
        fab.setAttribute('aria-label', t('fab.label', { n: n }));
        fab.setAttribute('data-live', api.settings.enabled === false ? '0' : '1');
        if (api.lastCount >= 0 && n > api.lastCount) pulse();
        api.lastCount = n;
      }

      function pulse() {
        fab.setAttribute('data-pulse', '1');
        animate(fab, { transform: ['scale(1)', 'scale(1.12)', 'scale(1)'] }, spring);
        setTimeout(() => fab.removeAttribute('data-pulse'), 3100);
      }

      function visible() {
        const items = ((api.state && api.state.items) || []).slice();
        if (api.showAds || (api.settings && api.settings.showAds)) items.push(...((api.state && api.state.ads) || []));
        return items.sort(rankItems);
      }
      function rankItems(a, b) {
        const w = (x) => (SR.rules && SR.rules.CATEGORY_WEIGHT[x.category]) || 0;
        return (b.confidence || 0) - (a.confidence || 0) || w(b) - w(a) || (b.ts || 0) - (a.ts || 0);
      }

      function renderMeta() {
        const st = api.state || {};
        const info = st.title;
        const titleEl = panel.querySelector('[data-el="title"]');
        if (titleEl) {
          titleEl.innerHTML =
            '<b>' + esc(info && info.title ? info.title + (info.year ? ' (' + info.year + ')' : '') : t('panel.title')) + '</b>' +
            '<small>' + esc(util.host((info && info.url) || root.location.href)) + '</small>';
        }
        const chips = [];
        if (info && info.isJunk) chips.push(chip('warn', 'search', t('panel.noTitle')));
        if (info && info.year) chips.push(chip('year', 'calendar', info.year));
        const ep = info && SR.title && SR.title.episodeLabel ? SR.title.episodeLabel(info) : null;
        if (ep) chips.push(chip('ep', 'captions', ep));
        if (info && info.kind === 'episode') chips.push(chip('ep', 'monitor-smartphone', t('panel.series')));
        if (st.drm) chips.push(chip('err', 'shield-check', t('label.drm') + ' ' + st.drm));
        const layers = st.layers || {};
        const on = Object.keys(layers).filter((k) => layers[k]).length;
        if (on) chips.push(chip('', 'list-filter', t('panel.layers', { n: on })));
        if (st.pagePaused) chips.push(chip('warn', 'eye', t('panel.paused')));
        const dyn = st.rulesVersion ? chip('', 'sparkles', t('update.pack') + ' ' + st.rulesVersion) : '';
        if (dyn) chips.push(dyn);
        metaEl.innerHTML = chips.join('');
      }
      function chip(kind, icon, text) {
        return '<span class="srad-chip"' + (kind ? ' data-kind="' + kind + '"' : '') + '>' + (icon ? ico(icon) : '') + esc(text) + '</span>';
      }

      function renderBody() {
        if (!bodyEl) return;
        if (api.tab === 'subs') return renderSubs();
        if (api.tab === 'info') return renderInfo();
        const items = visible();
        const before = captureRects();
        if (!items.length) {
          bodyEl.innerHTML =
            '<div class="srad-empty">' + ico('loader') + '<b>' + esc(t('panel.empty')) + '</b><p>' + esc(t('panel.emptyHint')) + '</p></div>';
          rowRects = new Map();
          return;
        }
        bodyEl.innerHTML = '<div role="list" data-el="list">' + items.map(itemHtml).join('') + '</div>';
        flipRows(before);
        const rows = [...bodyEl.querySelectorAll('.srad-item')];
        rows.forEach((el, i) => {
          if (i > 7) return;
          animate(el, { opacity: [0, 1], transform: ['translateY(8px) scale(.99)', 'none'] }, { duration: 0.26, delay: i * 0.022 });
        });
      }

      function captureRects() {
        const map = new Map();
        for (const el of bodyEl.querySelectorAll('.srad-item')) map.set(el.getAttribute('data-id'), el.getBoundingClientRect().top);
        return map;
      }
      /** FLIP: when the ranking changes, rows glide instead of jumping. */
      function flipRows(before) {
        if (reduced() || !before.size) return;
        for (const el of bodyEl.querySelectorAll('.srad-item')) {
          const prev = before.get(el.getAttribute('data-id'));
          if (prev == null) continue;
          const dy = prev - el.getBoundingClientRect().top;
          if (Math.abs(dy) > 1) animate(el, { transform: ['translateY(' + dy + 'px)', 'translateY(0)'] }, { duration: 0.3 });
        }
      }

      function itemHtml(it) {
        const cat = it.category || 'other';
        const label = (SR.rules && SR.rules.CATEGORY_LABEL && SR.rules.CATEGORY_LABEL[cat]) || cat.toUpperCase();
        const name = it.name || urlName(it.url);
        const tags = [];
        if (it.quality) tags.push('<span class="srad-tag" data-tone="q">' + esc(it.quality) + '</span>');
        if (it.sizeLabel) tags.push('<span class="srad-tag">' + esc(it.sizeLabel) + '</span>');
        if (it.durationLabel) tags.push('<span class="srad-tag">' + esc(it.durationLabel) + '</span>');
        if (it.isLive) tags.push('<span class="srad-tag" data-tone="warn">' + esc(t('label.live')) + '</span>');
        if (it.aes) tags.push('<span class="srad-tag" data-tone="warn">' + ico('shield-check') + esc(t('label.aes')) + '</span>');
        if (it.drm) tags.push('<span class="srad-tag" data-tone="err">' + ico('shield-check') + esc(t('label.drm')) + '</span>');
        if (it.segmentCount) tags.push('<span class="srad-tag">' + esc(t('label.segments', { n: it.segmentCount, size: it.segmentBytesLabel || '' })) + '</span>');
        if (it.mseBytes) tags.push('<span class="srad-tag">' + esc(util.formatBytes(it.mseBytes)) + ' ' + esc(t('label.buffered')) + '</span>');
        if (it.isAd) tags.push('<span class="srad-tag" data-tone="err">' + esc(t('label.ad')) + '</span>');
        if (it.via && it.via.length) tags.push('<span class="srad-tag" title="' + esc(t('label.via') + ': ' + it.via.join(', ')) + '">' + it.via.length + ' ' + esc(t('label.sources')) + '</span>');
        const subs = it.sub || {};
        if (subs.status && subs.status !== 'idle') tags.push('<span class="srad-tag" data-tone="' + subTone(subs.status) + '"' + (subs.status === 'searching' ? ' data-busy="1"' : '') + '>' + (subs.status === 'searching' ? ico('loader') : ico('captions')) + esc(subLabel(subs)) + '</span>');

        const via = [].concat(it.via || []);
        const conf = Math.min(3, via.length + (it.size ? 1 : 0) + (it.quality ? 1 : 0));
        const dots = [0, 1, 2].map((i) => '<i data-on="' + (i < conf ? 1 : 0) + '"></i>').join('');
        const thumb = it.thumb ? '<img src="' + esc(it.thumb) + '" alt="" loading="lazy">' : ico(cat === 'segment' ? 'list-filter' : cat === 'blob' ? 'video' : cat === 'hls' ? 'play' : 'video');
        const variants = (it.variants || [])
          .slice(0, 14)
          .map(
            (v, i) =>
              '<div class="srad-variant"><span class="srad-vq">' + esc(v.quality || (v.height ? util.qualityLabel(v.height) : '?')) + '</span><b>' + esc(v.codecs || label) + '</b>' +
              '<span>' + esc(v.bandwidthLabel || '') + '</span><button class="srad-btn" data-act="variant" data-id="' + esc(it.id) + '" data-variant-id="' + i + '">' + ico('copy') + esc(t('action.copy')) + '</button></div>'
          )
          .join('');
        const canRecord = cat === 'blob';
        return (
          '<article class="srad-item" role="listitem" tabindex="0" data-id="' + esc(it.id) + '" data-ad="' + (it.isAd ? 1 : 0) + '" aria-label="' + esc(label + ' ' + name) + '">' +
          '<div class="srad-thumb" data-cat="' + esc(cat) + '">' + thumb + '</div>' +
          '<div class="srad-main">' +
          '<div class="srad-row1"><span class="srad-name">' + esc(name) + '</span><span class="srad-conf" aria-hidden="true">' + dots + '</span></div>' +
          '<div class="srad-url" title="' + esc(it.url) + '">' + esc(shortenUrl(it.url)) + '</div>' +
          '<div class="srad-tags">' + tags.join('') + '</div>' +
          '<div class="srad-actions">' +
          '<button class="srad-btn" data-act="watchparty" data-primary="1">' + ico('users') + esc(t('action.watchparty')) + '</button>' +
          '<button class="srad-btn" data-act="copy">' + ico('copy') + esc(t('action.copy')) + '</button>' +
          '<button class="srad-btn" data-act="download">' + ico('download') + esc(it.category === 'hls' || it.category === 'dash' ? t('action.downloadPlaylist') : t('action.download')) + '</button>' +
          '<button class="srad-btn" data-act="subs">' + ico('captions') + esc(t('action.subs')) + '</button>' +
          '<button class="srad-btn" data-act="ffmpeg" title="' + esc(t('action.ffmpeg')) + '" aria-label="' + esc(t('action.ffmpeg')) + '">' + ico('link-2') + '</button>' +
          (variants ? '<button class="srad-btn" data-act="toggle-expand" aria-expanded="false">' + ico('chevron-down') + esc(t('action.variants', { n: (it.variants || []).length })) + '</button>' : '') +
          (canRecord ? '<button class="srad-btn" data-act="record">' + ico('circle') + esc(t('action.record')) + '</button>' : '') +
          '</div>' +
          (variants ? '<div class="srad-variants">' + variants + '</div>' : '') +
          (cat === 'blob' ? '<div class="srad-note">' + ico('info') + '<span>' + esc(t('label.mseHint')) + '</span></div>' : '') +
          '</div></article>'
        );
      }

      function subTone(s) {
        return s === 'found' ? 'ok' : s === 'searching' ? 'q' : s === 'error' ? 'err' : 'warn';
      }
      function subLabel(subs) {
        if (subs.status === 'found') return subs.name || t('panel.subs.found');
        if (subs.status === 'searching') return t('panel.subs.searching');
        if (subs.status === 'none') return t('panel.subs.none');
        if (subs.status === 'error') return t('panel.subs.error');
        if (subs.status === 'skipped') return t('panel.subs.skipped');
        return '';
      }
      function shortenUrl(u) {
        u = String(u || '');
        return u.length > 118 ? u.slice(0, 56) + '…' + u.slice(-46) : u;
      }
      function urlName(u) {
        try {
          const p = new URL(u).pathname.split('/').filter(Boolean).pop() || util.host(u);
          return decodeURIComponent(p).slice(0, 70);
        } catch (_) {
          return String(u).slice(0, 60);
        }
      }

      /* ================= subtitles pane ================= */
      function renderSubs() {
        const sub = (api.state && api.state.sub) || { status: 'idle', items: [] };
        const st = {
          idle: t('action.subs'),
          searching: t('panel.subs.searching'),
          found: t('panel.subs.found'),
          none: t('panel.subs.none'),
          error: t('panel.subs.error'),
          skipped: t('panel.subs.skipped'),
        };
        const providers = sub.providers || {};
        bodyEl.innerHTML =
          '<div class="srad-sub-card">' +
          '<div class="srad-sub-head">' + ico('captions') + '<span>' + esc(t('panel.subs.title')) + '</span>' +
          '<span class="srad-state" data-s="' + esc(sub.status) + '">' + (sub.status === 'searching' ? ico('loader') : '') + esc(st[sub.status] || sub.status) + '</span></div>' +
          (sub.query ? '<div class="srad-url" style="margin-top:6px">' + esc(sub.query) + (sub.year ? ' (' + esc(String(sub.year)) + ')' : '') + '</div>' : '') +
          '<div class="srad-providers">' +
          Object.keys(providers)
            .map((k) => '<span class="srad-pv" data-s="' + esc(providers[k].status || '') + '" title="' + esc(providers[k].reason || '') + '">' + esc(providers[k].label || k) + ' ' + (providers[k].count != null ? providers[k].count : '') + '</span>')
            .join('') +
          '</div>' +
          ((sub.items || []).length
            ? '<div style="margin-top:9px">' +
              sub.items
                .slice(0, 6)
                .map(
                  (it, i) =>
                    '<div class="srad-sub-row" data-picked="' + ((sub.chosen && sub.chosen.index === i) || (i === 0 && sub.chosen) ? 1 : 0) + '">' +
                    '<span title="' + esc(it.name || it.filename || '') + '">' + esc(it.name || it.filename || t('panel.subs.found')) + '</span>' +
                    '<em>' + esc((it.providerLabel || it.provider || '') + ' ' + (it.format || 'srt')) + '</em>' +
                    '<button class="srad-btn" data-act="sub-pick" data-index="' + i + '">' + esc(i === 0 ? t('action.use') : t('action.pick')) + '</button></div>'
                )
                .join('') +
              '</div>'
            : '<div class="srad-note">' + ico('info') + '<span>' + esc(sub.error || t('panel.subs.hint')) + '</span></div>') +
          '<div class="srad-sub-actions">' +
          '<button class="srad-btn" data-act="subs" data-primary="1">' + ico('search') + esc(t('panel.subs.retry')) + '</button>' +
          '<button class="srad-btn" data-act="sub-attach">' + ico('captions') + esc(t('panel.subs.attach')) + '</button>' +
          '<button class="srad-btn" data-act="sub-download">' + ico('file-down') + esc(t('panel.subs.download')) + '</button>' +
          '</div></div>';
      }

      /* ================= info pane ================= */
      function renderInfo() {
        const st = api.state || {};
        const rows = [
          [t('panel.layers'), Object.keys(st.layers || {}).filter((k) => st.layers[k]).join(', ') || t('panel.none')],
          [t('label.frames'), (st.frames || []).map((f) => util.host(f.url)).filter(Boolean).slice(0, 6).join(', ') || '-'],
          [t('label.players'), (st.players || []).join(', ') || '-'],
          ['Service worker', st.sw && st.sw.caches ? st.sw.caches + ' cache' + (st.sw.caches > 1 ? 'es' : '') + (st.sw.checked ? ', ' + st.sw.checked + ' checked' : '') : '-'],
          ['Diagnostics', st.health && st.health.kind ? st.health.kind : '-'],
          [t('update.state'), st.update && st.update.status ? st.update.status + (st.update.version ? ' v' + st.update.version : '') : 'idle'],
        ];
        bodyEl.innerHTML =
          '<div class="srad-sub-card">' +
          rows.map(([k, v]) => '<div class="srad-field"><span class="lab">' + esc(k) + '</span><span style="color:var(--c-fg-2);font-size:12px;text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(v) + '</span></div>').join('') +
          '</div>' +
          '<div class="srad-note" style="padding:0 2px">' + ico('shield-check') + '<span>' + esc(t('privacy.note')) + '</span></div>';
      }

      function renderFooter() {
        if (!footEl) return;
        const st = api.state || {};
        const n = ((st.items || []).length) || 0;
        footEl.querySelector('[data-el="count"]').textContent = t('panel.items', { n: n });
        const ads = (st.ads || []).length;
        const adsBtn = footEl.querySelector('[data-act="ads"]');
        const label = adsBtn.querySelector('[data-el="adslabel"]');
        if (ads) {
          adsBtn.hidden = false;
          label.textContent = api.showAds ? t('panel.hideAds') : t('panel.ads', { n: ads });
        } else {
          adsBtn.hidden = true;
        }
      }

      /* ================= settings sheet ================= */
      function openPop(on) {
        const pop = panel.querySelector('[data-el="pop"]');
        if (!pop) return;
        api.popOpen = !!on;
        if (on) {
          pop.innerHTML =
            '<header class="srad-head"><div class="srad-brand"><span class="srad-mark">' + ico('settings') + '</span>' +
            '<span class="srad-headtxt"><b>' + esc(t('settings.title')) + '</b><small>' + esc(t('settings.subtitle')) + '</small></span></div>' +
            '<span class="srad-spacer"></span>' + iconBtn('x', t('common.close')) + '</header>' +
            '<div class="srad-popbody">' +
            swField('enabled', t('settings.autoDetect'), t('settings.autoDetectHint')) +
            swField('layerNetwork', 'L1 ' + t('settings.network')) +
            swField('layerDom', 'L2 ' + t('settings.dom')) +
            swField('layerMse', 'L3 ' + t('settings.mse')) +
            swField('layerSw', 'L4 ' + t('settings.sw')) +
            swField('layerHeuristic', 'L5 ' + t('settings.heuristic')) +
            swField('autoSubtitle', t('settings.autosub'), t('settings.autosubHint')) +
            swField('notify', t('settings.notify')) +
            swField('recordMse', t('settings.record'), t('settings.recordHint')) +
            '<div class="srad-field"><span class="lab">' + esc(t('common.theme')) + '</span><span class="srad-seg">' +
            ['system', 'dark', 'light'].map((v) => '<button data-act="theme-' + v + '" data-on="' + ((api.settings.theme || 'system') === v ? 1 : 0) + '">' + esc(t('theme.' + v)) + '</button>').join('') +
            '</span></div>' +
            '<div class="srad-field"><span class="lab">' + esc(t('common.language')) + '</span><span class="srad-seg">' +
            ['auto', 'en', 'id'].map((v) => '<button data-act="lang-' + v + '" data-on="' + ((api.settings.lang || 'auto') === v ? 1 : 0) + '">' + v.toUpperCase() + '</button>').join('') +
            '</span></div>' +
            '<div class="srad-field"><span class="lab">' + esc(t('settings.fab')) + '<span class="hint">' + esc(t('settings.fabHint')) + '</span></span>' +
            '<button class="srad-btn" data-act="reset-fab">' + esc(t('settings.reset')) + '</button></div>' +
            '<div class="srad-sub-actions" style="margin-top:12px"><button class="srad-btn" data-act="update-check">' + ico('refresh-cw') + esc(t('update.check')) + '</button>' +
            '<button class="srad-btn" data-act="options">' + ico('keyboard') + esc(t('settings.openOptions')) + '</button></div>' +
            (api.state && api.state.update ? '<div class="srad-note" style="margin-top:10px">' + ico('info') + '<span>' + esc(t('update.state') + ': ' + api.state.update.status + (api.state.update.notes ? ', ' + api.state.update.notes : '')) + '</span></div>' : '') +
            '</div>';
          panel.querySelectorAll('[data-act^="theme-"]').forEach((b) => b.addEventListener('click', () => fire('set-setting', { key: 'theme', value: b.getAttribute('data-act').slice(6) })));
          panel.querySelectorAll('[data-act^="lang-"]').forEach((b) => b.addEventListener('click', () => fire('set-setting', { key: 'lang', value: b.getAttribute('data-act').slice(5) })));
        }
        pop.setAttribute('data-open', on ? '1' : '0');
        if (on) setTimeout(() => pop.querySelector('.srad-iconbtn') && pop.querySelector('.srad-iconbtn').focus(), 80);
      }
      function swField(key, label, hint) {
        const on = api.settings[key] !== false;
        return (
          '<div class="srad-field"><span class="lab">' + esc(label) + (hint ? '<span class="hint">' + esc(hint) + '</span>' : '') + '</span>' +
          '<button class="srad-switch" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" data-act="set:' + key + '" aria-label="' + esc(label) + '"></button></div>'
        );
      }

      /* ================= events ================= */
      function wire() {
        attachRipples(shadow);
        fab.addEventListener('click', () => toggle());
        fab.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        });
        fab.addEventListener('pointerdown', onPointerDown);
        root.addEventListener('pointermove', onPointerMove, { passive: true });
        root.addEventListener('pointerup', onPointerUp);
        root.addEventListener('pointercancel', onPointerUp);
        root.addEventListener('resize', util.throttle(() => applyFabPos(currentFabPos()), 260));

        panel.addEventListener('click', onPanelClick);
        panel.addEventListener('keydown', onPanelKey);
        root.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && api.open) {
            e.preventDefault();
            setOpen(false);
            try {
              fab.focus();
            } catch (_) {}
          }
          if (api.open && e.key === 'Tab') trapFocus(e);
        }, true);
        root.addEventListener(
          'pointerdown',
          (e) => {
            if (!api.open || !root.document) return;
            const path = e.composedPath ? e.composedPath() : [e.target];
            if (path.indexOf(host) >= 0) return;
            if (e.target === root.document.documentElement || e.target === root.document.body) setOpen(false);
          },
          true
        );
      }

      function trapFocus(e) {
        const f = [...shadow.querySelectorAll('.srad-panel button:not([disabled]), .srad-panel [role="switch"], .srad-panel [tabindex="0"]')].filter((el) => el.offsetParent !== null || el.getClientRects().length);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        const active = shadow.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }

      function onPanelClick(e) {
        const btn = e.target.closest ? e.target.closest('[data-act]') : null;
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        const holder = btn.closest('[data-id]');
        const id = btn.getAttribute('data-id') || (holder ? holder.getAttribute('data-id') : null);
        const vbtn = e.target.closest ? e.target.closest('[data-variant-id]') : null;
        if (vbtn) return fire('variant', { id: holder ? holder.getAttribute('data-id') : id, index: Number(vbtn.getAttribute('data-variant-id')) });

        if (act === 'close') return setOpen(false);
        if (act === 'theme') return cycleTheme(btn);
        if (act === 'settings') return openPop(true);
        if (act === 'tab') return setTab(btn.getAttribute('data-tab'));
        if (act === 'toggle-auto') return fire('set-setting', { key: 'enabled', value: !(api.settings.enabled !== false) });
        if (act.indexOf('set:') === 0) {
          const key = act.slice(4);
          return fire('set-setting', { key: key, value: api.settings[key] === false });
        }
        if (act === 'refresh') {
          btn.setAttribute('data-done', '1');
          fire('scan-now');
          setTimeout(() => btn.removeAttribute('data-done'), 900);
          return;
        }
        if (act === 'update-check') {
          fire('update-check');
          return;
        }
        if (act === 'clear' || act === 'options') {
          fire(act);
          return;
        }
        if (act === 'ads') {
          api.showAds = !api.showAds;
          fire('set-setting', { key: 'showAds', value: api.showAds });
          render();
          return;
        }
        if (act === 'toggle-expand') {
          const item = btn.closest('.srad-item');
          const open = item.getAttribute('data-expanded') === '1' ? '0' : '1';
          item.setAttribute('data-expanded', open);
          btn.setAttribute('aria-expanded', open === '1' ? 'true' : 'false');
          const panelEl = item.querySelector('.srad-variants');
          if (panelEl) animate(panelEl, { opacity: [0, 1], transform: ['translateY(-4px)', 'none'] }, { duration: 0.2 });
          return;
        }
        if (!id && ['copy', 'download', 'watchparty', 'subs', 'ffmpeg', 'record', 'open'].indexOf(act) >= 0) return;
        if (act === 'copy') {
          btn.setAttribute('data-done', '1');
          const original = btn.innerHTML;
          btn.innerHTML = ico('check') + esc(t('action.copied'));
          setTimeout(() => {
            btn.innerHTML = original;
            btn.removeAttribute('data-done');
          }, 1400);
        }
        if (act === 'record') vibrate(12);
        fire(act, { id: id, index: Number(btn.getAttribute('data-index') || 0), button: btn });
      }

      function onPanelKey(e) {
        const row = e.target.closest && e.target.closest('.srad-item');
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const rows = [...bodyEl.querySelectorAll('.srad-item')];
          if (!rows.length) return;
          e.preventDefault();
          const i = rows.indexOf(row);
          const next = util.clamp((i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1);
          rows[next].focus();
          rows[next].scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
          rows.forEach((el, k) => el.setAttribute('data-active', k === next ? '1' : '0'));
          return;
        }
        if (!row) return;
        if (e.key === 'e' || e.key === 'Enter') {
          const toggle = row.querySelector('[data-act="toggle-expand"]');
          if (toggle) {
            e.preventDefault();
            toggle.click();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            row.querySelector('[data-act="watchparty"]').click();
          }
        }
        if (e.key === 'c') {
          e.preventDefault();
          row.querySelector('[data-act="copy"]').click();
        }
        if (e.key === 's') {
          e.preventDefault();
          row.querySelector('[data-act="subs"]').click();
        }
      }

      function fire(action, payload) {
        try {
          if (o.onAction) o.onAction(action, payload || {});
        } catch (_) {}
      }
      function setTab(id) {
        if (api.tab === id) return;
        api.tab = id;
        animate(bodyEl, { opacity: [0.35, 1], transform: ['translateY(4px)', 'none'] }, { duration: 0.2 });
        renderTabs();
        renderBody();
      }

      /* ---------------- FAB drag + anchor ---------------- */
      function rect(which) {
        const r = fab.getBoundingClientRect();
        return which === 'left' ? r.left : r.top;
      }
      function onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        const r = fab.getBoundingClientRect();
        drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height, id: e.pointerId };
        moved = false;
        try {
          fab.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      function onPointerMove(e) {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 7) return;
        if (!moved) {
          moved = true;
          fab.setAttribute('data-dragging', '1');
          vibrate(6);
        }
        const left = util.clamp(drag.left + dx, 6, Math.max(8, root.innerWidth - drag.w - 6));
        const top = util.clamp(drag.top + dy, 6, Math.max(8, root.innerHeight - drag.h - 6));
        fab.style.left = left + 'px';
        fab.style.top = top + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        positionPanel(left, top, drag.w, drag.h);
      }
      function onPointerUp() {
        if (!drag) return;
        fab.removeAttribute('data-dragging');
        const wasMoved = moved;
        drag = null;
        if (wasMoved) {
          moved = false;
          fire('set-setting', { key: 'fabPos', value: currentFabPos() });
        }
      }
      function currentFabPos() {
        const r = fab.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top) };
      }
      function applyFabPos(pos) {
        if (!fab) return;
        if (!pos || typeof pos.x !== 'number') {
          fab.style.left = fab.style.top = 'auto';
          fab.style.right = fab.style.bottom = '';
          positionPanel();
          return;
        }
        const w = fab.offsetWidth || 56;
        const h = fab.offsetHeight || 56;
        const left = util.clamp(pos.x, 6, Math.max(8, root.innerWidth - w - 6));
        const top = util.clamp(pos.y, 6, Math.max(8, root.innerHeight - h - 6));
        fab.style.left = left + 'px';
        fab.style.top = top + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        positionPanel(left, top, w, h);
      }
      function positionPanel(left, top, w, h) {
        if (!panel) return;
        if (left == null) {
          const r = fab.getBoundingClientRect();
          left = r.left;
          top = r.top;
          w = w || r.width;
          h = h || r.height;
        }
        const nearTop = top < root.innerHeight * 0.34;
        const anchor = (nearTop ? 't' : 'b') + (left + (w || 56) / 2 < root.innerWidth / 2 ? 'l' : 'r');
        panel.setAttribute('data-anchor', anchor);
      }

      /* ---------------- theme ---------------- */
      let mq = null;
      function applyTheme() {
        if (!rootEl) return;
        let theme = api.settings.theme || 'system';
        if (theme === 'system') {
          try {
            mq = mq || root.matchMedia('(prefers-color-scheme: dark)');
            theme = mq.matches ? 'dark' : 'light';
          } catch (_) {
            theme = 'light';
          }
        }
        rootEl.setAttribute('data-theme', theme);
        const btn = panel && panel.querySelector('[data-act="theme"]');
        if (btn) btn.innerHTML = theme === 'dark' ? ico('sun') : ico('moon');
        try {
          root.document.documentElement.setAttribute('data-srad-theme', theme);
        } catch (_) {}
      }
      function cycleTheme(btn) {
        const order = ['system', 'dark', 'light'];
        const cur = api.settings.theme || 'system';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        if (btn) animate(btn, { transform: ['rotate(0deg) scale(1)', 'rotate(-28deg) scale(1.14)', 'rotate(0deg) scale(1)'] }, { duration: 0.36 });
        fire('set-setting', { key: 'theme', value: next });
      }
      try {
        if (root.matchMedia) root.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (api.settings.theme || 'system') === 'system' && applyTheme());
      } catch (_) {}

      /* ---------------- toasts ---------------- */
      const live = [];
      function toast(msg, kind, action, ms) {
        if (!mounted && !mount()) return null;
        const life = ms || 4000;
        const el = root.document.createElement('div');
        el.className = 'srad-toast';
        el.setAttribute('data-kind', kind || 'info');
        el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
        el.innerHTML =
          '<span class="srad-tico">' + ico(kind === 'ok' ? 'check' : kind === 'err' ? 'info' : kind === 'warn' ? 'info' : 'sparkles') + '</span>' +
          '<span>' + esc(msg) + '</span>' +
          (action ? '<button data-toast-act="' + esc(action.id) + '">' + esc(action.label) + '</button>' : '') +
          '<span class="srad-tbar"></span>';
        toastsEl.appendChild(el);
        live.push(el);
        while (live.length > 4) dismiss(live[0]);
        animate(el, { opacity: [0, 1], transform: ['translateX(16px) scale(.97)', 'none'] }, spring);
        const bar = el.querySelector('.srad-tbar');
        animate(bar, { transform: ['scaleX(1)', 'scaleX(0)'] }, { duration: life / 1000, easing: 'linear' });
        const timer = setTimeout(() => dismiss(el), life);
        el.addEventListener('pointerenter', () => clearTimeout(timer), { once: true });
        el.addEventListener('pointerleave', () => setTimeout(() => dismiss(el), 1200), { once: true });
        const b = el.querySelector('[data-toast-act]');
        if (b) b.addEventListener('click', () => {
          fire(action.id, action.payload || {});
          dismiss(el);
        });
        const sr = rootEl.querySelector('[data-el="live"]');
        if (sr) sr.textContent = String(msg);
        return el;
      }
      function dismiss(el) {
        if (!el || el.getAttribute('data-leaving') === '1') return;
        el.setAttribute('data-leaving', '1');
        const anim = animate(el, { opacity: [1, 0], transform: ['none', 'translateX(18px) scale(.97)'] }, { duration: 0.2 });
        const rm = () => {
          el.remove();
          const i = live.indexOf(el);
          if (i >= 0) live.splice(i, 1);
        };
        if (anim && anim.finished) anim.finished.then(rm, rm);
        else setTimeout(rm, 220);
      }

      /* ---------------- open / close ---------------- */
      function setOpen(on) {
        api.open = !!on;
        panel.setAttribute('data-open', on ? '1' : '0');
        fab.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (on) {
          lastFocused = root.document.activeElement;
          positionPanel();
          render();
          setTimeout(() => {
            const first = panel.querySelector('.srad-item') || bodyEl;
            try {
              first.focus({ preventScroll: true });
            } catch (_) {}
          }, 70);
        } else {
          openPop(false);
          if (lastFocused && lastFocused.focus) {
            try {
              lastFocused.focus({ preventScroll: true });
            } catch (_) {}
          }
        }
      }
      function toggle() {
        if (!api.open && o.beforeOpen) o.beforeOpen();
        vibrate(8);
        setOpen(!api.open);
      }

      function esc(v) {
        return util.esc ? util.esc(v) : String(v == null ? '' : v);
      }

      return Object.assign(api, {
        mount,
        render,
        toast,
        dismissAll() {
          live.slice().forEach(dismiss);
        },
        toggle,
        setOpen,
        setTab,
        destroy() {
          try {
            host.remove();
          } catch (_) {}
          mounted = false;
        },
        setFabPos: applyFabPos,
        applyTheme,
        isMounted() {
          return mounted && host && host.isConnected;
        },
      });
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* ═════════════════════════ src/page/inject.js ═════════════════════════ */
/**
 * Stream Radar — page-level hooks (MAIN world)
 * ==================================================================
 * LAYER 1  Network intercept   : fetch / XHR / WebSocket / EventSource
 * LAYER 3  MSE intercept       : MediaSource.addSourceBuffer, SourceBuffer.appendBuffer,
 *                                URL.createObjectURL, HTMLMediaElement.src setter
 * LAYER 5  Heuristic fallback  : inline <script> regex scan, document.write(),
 *                                performance resource timing, player probing
 *                                (JWPlayer, Video.js, Plyr, HLS.js, DASH.js, Clappr…)
 *
 * Design notes
 *  • This file runs *inside the page*, so it can see `window.fetch`, the player's
 *    own objects and the blob URLs that a content script (isolated world) cannot.
 *  • It never touches chrome.* APIs. It only postMessage()s findings to the
 *    extension's content script, which forwards them to the background worker.
 *  • Every hook is wrapped in try/catch: breaking a site is never acceptable.
 *  • Loaded in all frames — that is what makes detection work on sites whose
 *    player lives in a 3rd-party iframe (67movies / vidlink / filemoon style),
 *    where a userscript running only in the top frame sees nothing.
 */
(function (root) {
  'use strict';
  var SR = root.SR || (root.SR = {});
  if (root.__streamRadarPage) return; // already installed (double injection guard)
  if (SR.util && SR.util.isExtensionContext() && !root.__streamRadarForceMain) return; // isolated world → content script will re-inject us

  root.__streamRadarPage = { version: SR.VERSION || '1.0.0', reports: 0 };

  var doc = root.document;
  var CH = 'srad';
  var rules = SR.rules;
  var util = SR.util;

  /* ------------------------------------------------------------------ *
   * 0. transport
   * ------------------------------------------------------------------ */
  var config = {
    recordMse: false,
    recordCapMB: 256,
    scanScripts: true,
    playerProbe: true,
    maxReports: 400,
  };
  var seen = new Map(); // dedupKey -> lastReportTs
  var blobIndex = new Map(); // blob: url -> {mse, bytes, mime[]}
  var mediaSources = new Set();
  var lastDrmReport = 0;

  function post(kind, payload) {
    try {
      root.postMessage({ srad: 1, kind: kind, payload: payload, ts: Date.now() }, '*');
    } catch (_) {}
  }

  function report(url, via, extra) {
    try {
      if (!url) return null;
      var info = rules.classify(url, extra || {});
      if (!info) {
        // Blob urls are only interesting for MSE/live capture.
        if (/^blob:/i.test(url) && (extra && extra.force)) {
          info = { category: 'blob', ext: 'blob', mime: '', size: 0, isSegment: false, isAd: false, isBlob: true };
        } else return null;
      }
      var key = util.dedupKey(url, info.category);
      var now = Date.now();
      // Burst suppression only for *identical* payloads: a later report of the
      // same URL that carries new facts (content-length, mime, manifest body)
      // must still reach the store so size/quality get enriched.
      var sig = [info.category, info.mime, info.size || 0, (extra && extra.height) || 0, extra && extra.manifestBody ? util.hash32(extra.manifestBody) : 0].join('|');
      var prev = seen.get(key);
      if (prev && prev.sig === sig && now - prev.ts < 8000 && !extra.force) return null;
      seen.set(key, { ts: now, sig: sig, count: ((prev && prev.count) || 0) + 1 });
      if (seen.size > 3000) {
        var firstKey = seen.keys().next().value;
        seen.delete(firstKey);
      }
      root.__streamRadarPage.reports++;
      post('media', {
        url: url,
        category: info.category,
        ext: info.ext,
        mime: info.mime,
        size: info.size || 0,
        isSegment: info.isSegment,
        isAd: info.isAd,
        isBlob: info.isBlob,
        isEmbed: info.isEmbed,
        via: via || 'unknown',
        frame: root === root.top ? 'top' : 'iframe',
        frameUrl: root.location.href,
        pageUrl: doc && doc.URL,
        extra: extra && extra.public ? extra.public : undefined,
        manifestBody: extra && extra.manifestBody ? extra.manifestBody : undefined,
        quality: extra && extra.quality,
        height: extra && extra.height,
        duration: extra && extra.duration,
        t: now,
      });
      return key;
    } catch (_) {
      return null;
    }
  }

  function reportAll(urls, via, extra) {
    if (!urls || !urls.length) return;
    for (var i = 0; i < urls.length; i++) report(urls[i], via, extra);
  }

  /** Unwrap "proxy" urls and report both the outer + inner stream urls. */
  function noteUrl(url, via, extra) {
    try {
      if (!url || typeof url !== 'string') return;
      if (url.length > 6000 || NOISE_URL.test(url)) return;
      var unwrapped = rules.unwrapUrl(url);
      if (unwrapped.length) reportAll(unwrapped, via, extra);
      report(url, via, extra);
    } catch (_) {}
  }
  var NOISE_URL = /^(https?:)?\/\/[^/]*(favicon|analytics|googletagmanager|doubleclick|sentry|hotjar|captcha)/i;

  function noteText(text, via, extra) {
    try {
      if (!text || typeof text !== 'string') return;
      var urls = rules.findUrlsInText(text, 12);
      if (urls && urls.length) {
        var hit = urls.map(function (u) {
          var inner = rules.unwrapUrl(u);
          return inner.length ? inner : [u];
        });
        var flat = [];
        for (var i = 0; i < hit.length; i++) flat = flat.concat(hit[i]);
        reportAll(flat, via, extra);
        post('heuristic-hit', { via: via, count: flat.length, sample: flat.slice(0, 3) });
      }
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * 1. LAYER 1 — fetch / XHR / WebSocket / EventSource
   * ------------------------------------------------------------------ */
  var MAX_MANIFEST = 400 * 1024;

  function patchFetch() {
    var orig = root.fetch;
    if (typeof orig !== 'function' || orig.__srad) return;
    var wrapped = function (input, init) {
      var url = '';
      try {
        if (typeof input === 'string' || input instanceof String) url = String(input);
        else if (input && input.url) url = input.url;
        else if (input && typeof input.toString === 'function') url = String(input);
      } catch (_) {}
      var promise;
      try {
        promise = orig.apply(this, arguments);
      } catch (e) {
        throw e;
      }
      try {
        observeFetch(promise, url, init, orig, this, arguments);
      } catch (_) {}
      return promise;
    };
    wrapped.__srad = 1;
    try {
      root.fetch = wrapped;
    } catch (_) {
      try {
        Object.defineProperty(root, 'fetch', { value: wrapped, configurable: true, writable: true });
      } catch (_2) {}
    }

    async function observeFetch(promise, url, init, origFetch, thisArg, args) {
      // (a) the request URL itself often already hides the stream
      noteUrl(url, 'fetch', { method: (init && init.method) || (url && 'GET') });
      if (init && init.body && typeof init.body === 'string' && init.body.length < 500000 && config.scanScripts) {
        noteText(init.body, 'fetch-body');
      }
      var res;
      try {
        res = await promise;
      } catch (_) {
        return;
      }
      if (!res) return;
      var headers = res.headers || { get: function () { return null; } };
      var mime = headers.get('content-type') || '';
      var size = parseInt(headers.get('content-length') || '0', 10) || 0;
      var finalUrl = res.url || url;
      var cls = rules.classify(finalUrl, { mime: mime, size: size }) || rules.classify(url, { mime: mime, size: size });
      if (cls) {
        var key = report(finalUrl, 'fetch', {
          mime: mime,
          size: size,
          public: { redirected: !!res.redirected, status: res.status },
        });
        if (key) {
          // report the pre-redirect url too: some players redirect to a token url
          if (finalUrl && url && finalUrl !== url) report(url, 'fetch', { mime: mime, size: size });
        }
      }
      // (b) manifest bodies — parsed later by the background worker
      try {
        if (cls && (cls.category === 'hls' || cls.category === 'dash') && res.ok && !res.bodyUsed && res.clone) {
          res.clone()
            .text()
            .then(function (text) {
              if (!text || text.length > MAX_MANIFEST) return;
              report(finalUrl || url, 'fetch-manifest', {
                mime: mime,
                size: size,
                manifestBody: text,
                manifestHash: util.hash32(text),
              });
            })
            .catch(function () {});
        } else if (/json|javascript|xml|html|text/i.test(mime) && size < 1500000 && res.ok && !res.bodyUsed && res.clone && config.scanScripts) {
          // (c) JSON player configs that embed the real stream URL
          var looksConfigish = /(config|source|playlist|getvid|embed|api|play|video|manifest|hash|token)/i.test(url);
          if (looksConfigish || cls === null) {
            res
              .clone()
              .text()
              .then(function (text) {
                if (text && text.length < 1500000 && text.indexOf('.m3u8') + text.indexOf('.mpd') + text.indexOf('.mp4') > -3) noteText(text, 'fetch-json');
              })
              .catch(function () {});
          }
        }
      } catch (_) {}
    }
  }

  function patchXhr() {
    var XHR = root.XMLHttpRequest;
    if (!XHR || !XHR.prototype || XHR.prototype.__sradOpen) return;
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    var origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      try {
        this.__srad = { method: method, url: String(url || ''), t0: Date.now(), headers: {} };
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (k, v) {
      try {
        if (this.__srad) this.__srad.headers[String(k).toLowerCase()] = v;
      } catch (_) {}
      return origSetHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      var self = this;
      var meta = self.__srad || {};
      try {
        noteUrl(meta.url, 'xhr', { method: meta.method });
        if (body && typeof body === 'string' && body.length < 300000 && config.scanScripts) noteText(body, 'xhr-body');
        self.addEventListener(
          'loadend',
          function () {
            try {
              var mime = '', len = 0;
              try {
                mime = self.getResponseHeader('content-type') || '';
                len = parseInt(self.getResponseHeader('content-length') || '0', 10) || 0;
              } catch (_) {}
              var url = meta.url || self.responseURL;
              var cls = rules.classify(url, { mime: mime, size: len });
              if (cls) {
                report(url, 'xhr', { mime: mime, size: len, public: { status: self.status, durationMs: meta.t0 ? Date.now() - meta.t0 : 0 } });
              }
              if (cls && (cls.category === 'hls' || cls.category === 'dash')) {
                var text = '';
                try {
                  text = typeof self.responseText === 'string' ? self.responseText : '';
                } catch (_) {}
                if (text && text.length <= MAX_MANIFEST) report(url, 'xhr-manifest', { mime: mime, size: len, manifestBody: text, manifestHash: util.hash32(text) });
              } else if (/json|javascript|xml|html|text/i.test(mime) && config.scanScripts) {
                var t2 = '';
                try {
                  t2 = typeof self.responseText === 'string' ? self.responseText : self.response ? String(self.response) : '';
                } catch (_) {}
                if (t2 && t2.length < 1500000 && (t2.indexOf('.m3u8') > -1 || t2.indexOf('.mpd') > -1 || /\.mp4/.test(t2))) noteText(t2, 'xhr-json');
              }
            } catch (_) {}
          },
          false
        );
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
    XHR.prototype.__sradOpen = 1;
  }

  function patchWebSocket() {
    var WS = root.WebSocket;
    if (!WS || WS.__srad) return;
    var Wrapped = new Proxy(WS, {
      construct: function (target, args) {
        var inst = Reflect.construct(target, args);
        try {
          var url = String(args[0] || '');
          noteUrl(url, 'websocket');
          if (/\.(m3u8|mpd|mp4|webm)/i.test(url)) report(url, 'websocket', { force: true });
          var onData = function (ev) {
            try {
              if (typeof ev.data === 'string' && ev.data.length < 400000 && config.scanScripts) noteText(ev.data, 'websocket-frame');
            } catch (_) {}
          };
          inst.addEventListener('message', onData, true);
          var origSend = inst.send.bind(inst);
          inst.send = function (data) {
            try {
              if (typeof data === 'string' && data.length < 100000) noteText(data, 'websocket-send');
            } catch (_) {}
            return origSend.apply(null, arguments);
          };
        } catch (_) {}
        return inst;
      },
      apply: function (target, thisArg, args) {
        try {
          noteUrl(String(args[0] || ''), 'websocket');
        } catch (_) {}
        return Reflect.apply(target, thisArg, args);
      },
    });
    // NOTE: do not copy `prototype` onto the wrapper — native interface
    // prototypes are read-only and assigning would throw. The Proxy forwards it.
    try {
      root.WebSocket = Wrapped;
      Wrapped.__srad = 1;
    } catch (_) {}
  }

  function patchEventSource() {
    var ES = root.EventSource;
    if (!ES || ES.__srad) return;
    var Wrapped = new Proxy(ES, {
      construct: function (target, args) {
        var inst = Reflect.construct(target, args);
        try {
          noteUrl(String(args[0] || ''), 'eventsource');
          inst.addEventListener('message', function (ev) {
            try {
              if (typeof ev.data === 'string' && ev.data.length < 400000) noteText(ev.data, 'eventsource-frame');
            } catch (_) {}
          });
        } catch (_) {}
        return inst;
      },
    });
    try {
      root.EventSource = Wrapped;
      Wrapped.__srad = 1;
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * 2. LAYER 3 — MSE / blob / media element
   * ------------------------------------------------------------------ */
  function patchCreateObjectURL() {
    if (!root.URL || !root.URL.createObjectURL || root.URL.createObjectURL.__srad) return;
    var orig = root.URL.createObjectURL.bind(root.URL);
    var wrapped = function (obj) {
      var url = orig(obj);
      try {
        var rec = {
          bytes: obj && obj.size ? obj.size : 0,
          mime: (obj && obj.type) || '',
          kind: obj && obj.constructor ? String(obj.constructor.name) : '',
          buffers: [],
          buffered: 0,
          mimes: [],
          url: url,
        };
        if (/MediaSource/i.test(rec.kind)) {
          blobIndex.set(url, rec);
          mediaSources.add(obj);
          watchMediaSource(obj, rec);
        } else if (obj && obj.size) {
          // direct Blob src (progressive download / webm capture)
          report(url, 'blob', { size: obj.size, mime: obj.type || '', force: true, public: { blobType: rec.kind } });
        }
      } catch (_) {}
      return url;
    };
    wrapped.__srad = 1;
    try {
      root.URL.createObjectURL = wrapped;
    } catch (_) {}
  }

  function watchMediaSource(ms, rec) {
    try {
      var fire = util.throttle(function () {
        try {
          post('mse', {
            url: rec.url,
            bytes: rec.buffered,
            mimes: rec.mimes.slice(0, 6),
            duration: ms.duration && isFinite(ms.duration) ? ms.duration : 0,
            state: ms.readyState,
            recording: rec.buffering || false,
            recordedBytes: rec.buffered,
          });
        } catch (_) {}
      }, 1500);
      ms.addEventListener('sourceopen', fire);
      ms.addEventListener('sourcebufferended', fire);
      ms.addEventListener('durationchange', fire);
      fire();
    } catch (_) {}
  }

  function patchMediaSource() {
    var MS = root.MediaSource;
    var instRefs = new WeakMap(); // MediaSource instance -> capture record
    if (!MS || !MS.prototype || MS.__srad) return;
    try {
      var origAdd = MS.prototype.addSourceBuffer;
      MS.prototype.addSourceBuffer = function (mimeType) {
        var sb = origAdd.apply(this, arguments);
        try {
          var rec = findRec(this);
          if (rec && rec.mimes.indexOf(mimeType) < 0) rec.mimes.push(String(mimeType || ''));
          if (sb && !sb.__srad) {
            var origAppend = sb.appendBuffer;
            sb.appendBuffer = function (data) {
              try {
                var size = data ? (data.byteLength || data.length || 0) : 0;
                if (rec) {
                  rec.buffered += size;
                  if (config.recordMse && rec.buffered < config.recordCapMB * 1024 * 1024) {
                    rec.buffering = true;
                    try {
                      rec.buffers.push(new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer));
                    } catch (_) {}
                  }
                }
              } catch (_) {}
              return origAppend.apply(this, arguments);
            };
            sb.__srad = 1;
          }
        } catch (_) {}
        return sb;
      };
      var Wrapped = new Proxy(MS, {
        construct: function (target, args) {
          var inst = Reflect.construct(target, args);
          try {
            if (!instRefs.get(inst)) {
              var rec = { bytes: 0, buffered: 0, buffers: [], mimes: [], url: 'mse:' + util.uuid(), mse: inst };
              instRefs.set(inst, rec);
            }
          } catch (_) {}
          return inst;
        },
      });
      root.__sradFindRec = function (obj) {
        try {
          return instRefs.get(obj);
        } catch (_) {
          return null;
        }
      };
      try {
        root.MediaSource = Wrapped;
        Wrapped.__srad = 1;
      } catch (_) {}

      function findRecFallback(obj) {
        for (var kv of blobIndex) if (kv[1].mse === obj) return kv[1];
        return null;
      }
      function findRec(obj) {
        var r = root.__sradFindRec && root.__sradFindRec(obj);
        return r || findRecFallback(obj);
      }
    } catch (_) {}
  }

  /** Record the final MSE buffer so the user can save a fragmented mp4/webm. */
  function dumpRecording() {
    try {
      var best = null;
      blobIndex.forEach(function (r) {
        if (r.buffers && r.buffers.length && (!best || r.buffered > best.buffered)) best = r;
      });
      if (!best) {
        post('record-error', { reason: 'no buffered media yet' });
        return;
      }
      var type = (best.mimes[0] || 'video/mp4').split(';')[0];
      var blob = new Blob(best.buffers, { type: type });
      var url = root.URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url;
      a.download = safeFileName((doc.title || 'recording') + (type.indexOf('webm') > -1 ? '.webm' : '.m4v'));
      a.rel = 'noopener';
      (doc.body || doc.documentElement).appendChild(a);
      a.click();
      setTimeout(function () {
        a.remove();
        root.URL.revokeObjectURL(url);
      }, 4000);
      post('record-done', { bytes: blob.size, type: type, name: a.download });
    } catch (e) {
      post('record-error', { reason: String((e && e.message) || e) });
    }
  }

  function safeFileName(s) {
    return String(s)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s{2,}/g, ' ')
      .slice(0, 120);
  }

  function patchMediaElement() {
    var proto = root.HTMLMediaElement && root.HTMLMediaElement.prototype;
    if (!proto || proto.__sradSrc) return;
    var desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (desc && desc.set) {
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (value) {
          try {
            var v = typeof value === 'string' ? value : String(value);
            if (/^blob:/i.test(v)) {
              var rec = blobIndex.get(v);
              report(v, 'mse-src', { force: true, size: rec ? rec.bytes : 0, public: { mse: !!rec, mimes: rec ? rec.mimes : [] } });
            } else if (/\.(m3u8|mpd|mp4|webm|mkv|m4v|m4s|ts)/i.test(v) || /^https?:/i.test(v)) {
              noteUrl(v, 'video-src');
            }
          } catch (_) {}
          return desc.set.call(this, value);
        },
      });
      proto.__sradSrc = 1;
    }
    // <source src="…">
    try {
      var sdesc = Object.getOwnPropertyDescriptor(root.HTMLSourceElement.prototype, 'src');
      if (sdesc && sdesc.set && !root.HTMLSourceElement.prototype.__sradSrc) {
        Object.defineProperty(root.HTMLSourceElement.prototype, 'src', {
          configurable: true,
          enumerable: sdesc.enumerable,
          get: sdesc.get,
          set: function (value) {
            try {
              noteUrl(String(value || ''), 'source-tag');
            } catch (_) {}
            return sdesc.set.call(this, value);
          },
        });
        root.HTMLSourceElement.prototype.__sradSrc = 1;
      }
    } catch (_) {}

    // metadata of playing media gives the *real* resolution + the resolved src
    var onMeta = function (e) {
      try {
        var el = e.target;
        var url = el.currentSrc || el.src || '';
        if (!url || /^blob:/i.test(url)) return;
        report(url, 'video-metadata', {
          height: el.videoHeight || 0,
          width: el.videoWidth || 0,
          duration: el.duration && isFinite(el.duration) ? Math.round(el.duration) : 0,
          force: true,
          public: { videoWidth: el.videoWidth, videoHeight: el.videoHeight },
        });
      } catch (_) {}
    };
    if (doc) {
      doc.addEventListener('loadedmetadata', onMeta, true);
      doc.addEventListener('error', function (e) {
        try {
          var el2 = e.target;
          if (el2 && (el2.tagName === 'VIDEO' || el2.tagName === 'AUDIO')) {
            post('media-error', { url: el2.currentSrc || el2.src || '', code: el2.error ? el2.error.code : 0 });
          }
        } catch (_) {}
      }, true);
    }
  }

  function patchEme() {
    try {
      if (!root.navigator || !navigator.requestMediaKeySystemAccess || navigator.requestMediaKeySystemAccess.__srad) return;
      var orig = navigator.requestMediaKeySystemAccess.bind(navigator);
      var wrapped = function (keySystem, configs) {
        try {
          if (Date.now() - lastDrmReport > 30000) {
            lastDrmReport = Date.now();
            post('drm', { keySystem: String(keySystem), configs: [].concat(configs || []).slice(0, 3).map(function (c) { return { name: c && c.name, initDataTypes: c && c.initDataTypes }; }) });
          }
        } catch (_) {}
        return orig(keySystem, configs);
      };
      wrapped.__srad = 1;
      Object.defineProperty(navigator, 'requestMediaKeySystemAccess', { value: wrapped, configurable: true });
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * 3. LAYER 5 — document.write + inline script scan + perf entries
   * ------------------------------------------------------------------ */
  function patchDocumentWrite() {
    try {
      var orig = Document.prototype.write;
      if (!orig || orig.__srad) return;
      var wrapped = function () {
        try {
          for (var i = 0; i < arguments.length; i++) {
            var s = String(arguments[i] || '');
            if (s.length < 900000 && (s.indexOf('.m3u8') > -1 || s.indexOf('.mpd') > -1 || s.indexOf('.mp4') > -1 || s.indexOf('<video') > -1)) noteText(s, 'document.write');
          }
        } catch (_) {}
        return orig.apply(doc, arguments);
      };
      wrapped.__srad = 1;
      Document.prototype.write = wrapped;
    } catch (_) {}
  }

  function scanInlineScripts(reason) {
    if (!config.scanScripts || !doc) return;
    try {
      var nodes = doc.querySelectorAll('script:not([src]), script[type="application/json"], script[type="text/json"], template');
      var budget = 1400000;
      var checked = 0;
      for (var i = 0; i < nodes.length && budget > 0; i++) {
        var n = nodes[i];
        var txt = n.textContent || n.innerHTML || '';
        if (!txt || txt.length > 900000) continue;
        budget -= txt.length;
        checked++;
        if (txt.indexOf('.m3u8') > -1 || txt.indexOf('.mpd') > -1 || txt.indexOf('.mp4') > -1 || txt.indexOf('filemoon') > -1 || txt.indexOf('.webm') > -1) noteText(txt, 'inline-script');
      }
      if (checked) post('scan-info', { reason: reason, checked: checked });
    } catch (_) {}
  }

  function scanPerformance(reason) {
    try {
      if (!performance || !performance.getEntriesByType) return;
      var list = performance.getEntriesByType('resource');
      if (!list || !list.length) return;
      var start = Math.max(0, list.length - 1200);
      var hits = 0;
      for (var i = start; i < list.length; i++) {
        var e = list[i];
        var u = e.name;
        if (!u || u.length > 3000) continue;
        if (NOISE_URL.test(u)) continue;
        var isMedia = /\.(m3u8|mpd|mp4|webm|mkv|m4v|mov|ts|m4s)(\?|#|$)/i.test(u) || e.initiatorType === 'video' || e.initiatorType === 'audio';
        if (!isMedia) {
          var nested = rules.unwrapUrl(u);
          if (!nested.length) continue;
          reportAll(nested, 'performance');
          hits++;
          continue;
        }
        var unwrapped = rules.unwrapUrl(u);
        if (unwrapped.length) reportAll(unwrapped, 'performance');
        report(u, 'performance', { size: e.encodedBodySize || 0, public: { initiator: e.initiatorType, durationMs: Math.round(e.duration) } });
        hits++;
      }
      if (hits) post('perf-info', { reason: reason, hits: hits });
    } catch (_) {}
  }

  function scanDomEmbeds() {
    try {
      var sel = 'iframe[src], embed[src], object[data], video[src], audio[src], source[src], link[as="video"], link[rel="preload"][href], a[download], a[href]';
      var nodes = doc.querySelectorAll(sel);
      var urls = [];
      for (var i = 0; i < nodes.length && i < 1500; i++) {
        var n = nodes[i];
        var u = n.getAttribute('src') || n.getAttribute('data') || n.getAttribute('href') || '';
        if (!u) continue;
        if (/\.(m3u8|mpd|mp4|webm|mkv|m4v|ts|m4s)(\?|#|$)/i.test(u) || /^blob:/i.test(u)) urls.push(util.abs(doc.baseURI || root.location.href, u));
      }
      for (var v of doc.querySelectorAll('video')) {
        try {
          if (v.currentSrc) urls.push(v.currentSrc);
        } catch (_) {}
      }
      reportAll(urls, 'dom');
      if (urls.length) post('dom-info', { count: urls.length });
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * 4. Player probing (JWPlayer / Video.js / Plyr / HLS.js / DASH.js / Clappr)
   * ------------------------------------------------------------------ */
  var tracked = []; // player instances we wrapped

  function trackPlayer(obj, kind) {
    try {
      if (!obj || tracked.length > 40) return obj;
      obj.__sradKind = kind;
      tracked.push(obj);
      readPlayer(obj, kind);
      return obj;
    } catch (_) {
      return obj;
    }
  }

  function readPlayer(p, kind) {
    try {
      if (!p) return;
      var urls = [];
      var extra = { public: { player: kind } };
      // HLS.js
      if (kind === 'hls') {
        if (p.url) urls.push(p.url);
        var levels = p.levels || [];
        for (var i = 0; i < levels.length; i++) {
          var lv = levels[i];
          if (lv && lv.url) urls.push(lv.url);
          if (lv && lv.attrs && lv.attrs.RESOLUTION) {
            var h = parseInt(String(lv.attrs.RESOLUTION).split('x')[1], 10);
            if (h) extra.height = Math.max(extra.height || 0, h);
          }
        }
        var mb = p.media && p.media.currentSrc;
        if (mb) urls.push(mb);
      }
      // Video.js / Plyr / generic
      if (typeof p.src === 'function') {
        try {
          var s = p.src();
          if (typeof s === 'string') urls.push(s);
          else if (s && s.src) urls.push(String(s.src));
        } catch (_) {}
      }
      if (typeof p.currentSource === 'function') {
        try {
          var cs = p.currentSource();
          if (cs && cs.src) urls.push(String(cs.src));
        } catch (_) {}
      }
      if (typeof p.getVideoSrc === 'function') {
        try {
          urls.push(String(p.getVideoSrc()));
        } catch (_) {}
      }
      if (typeof p.getPlaylist === 'function') {
        try {
          var pl = p.getPlaylist();
          [].concat(pl || []).forEach(function (item) {
            [].concat((item && item.sources) || []).forEach(function (src) {
              if (src && src.file) urls.push(String(src.file));
            });
            if (item && item.file) urls.push(String(item.file));
          });
        } catch (_) {}
      }
      if (typeof p.getConfig === 'function') {
        try {
          var cfg = p.getConfig() || {};
          [].concat(cfg.sources || []).forEach(function (src) {
            if (src && src.file) urls.push(String(src.file));
          });
          if (cfg.file) urls.push(String(cfg.file));
          if (cfg.sources && cfg.sources[0] && cfg.sources[0].file) urls.push(String(cfg.sources[0].file));
        } catch (_) {}
      }
      if (typeof p.getSources === 'function') {
        try {
          [].concat(p.getSources() || []).forEach(function (src) {
            if (src && (src.src || src.file)) urls.push(String(src.src || src.file));
          });
        } catch (_) {}
      }
      if (p.options && p.options.source) {
        try {
          urls.push(String(p.options.source.type === 'hls' ? p.options.source.src : p.options.source));
        } catch (_) {}
      }
      if (p.media && p.media.src) urls.push(String(p.media.src));
      if (p._options && p._options.video && p._options.video.src) urls.push(String(p._options.video.src));
      reportAll(urls, 'player', extra);
      // dash.js
      if (kind === 'dash' && typeof p.getSource === 'function') {
        try {
          var su = p.getSource();
          if (su) report(String(su), 'player', { public: { player: 'dashjs' } });
        } catch (_) {}
      }
    } catch (_) {}
  }

  function hookHlsJs() {
    try {
      var H = root.Hls || root.hls;
      if (!H || !H.prototype) {
        if (!root.Hls) {
          var pending = undefined;
          try {
            Object.defineProperty(root, 'Hls', {
              configurable: true,
              get: function () { return pending; },
              set: function (v) { pending = v; hookHlsJs(); },
            });
          } catch (_) {}
        }
        return;
      }
      if (H.prototype.__sradTrigger) return;
      var proto = H.prototype;
      proto.__sradTrigger = 1;
      var origTrigger = proto.trigger || proto.emit;
      if (origTrigger) {
        proto.trigger = function (ev, data) {
          try {
            handleEvent(ev, data, this);
          } catch (_) {}
          return origTrigger.apply(this, arguments);
        };
        if (proto.emit && proto.emit !== origTrigger) {
          var origEmit = proto.emit;
          proto.emit = function (ev, data) {
            try {
              handleEvent(ev, data, this);
            } catch (_) {}
            return origEmit.apply(this, arguments);
          };
        }
      }
      var origLoad = proto.loadSource;
      if (origLoad) {
        proto.loadSource = function (src) {
          try {
            noteUrl(String(src || ''), 'hls-js');
          } catch (_) {}
          trackPlayer(this, 'hls');
          return origLoad.apply(this, arguments);
        };
      }
      post('player', { name: 'hls.js', hooked: true });

      function handleEvent(ev, data, inst) {
        if (!ev) return;
        if (ev === 'hlsManifestParsed' || ev === 'MANIFEST_PARSED') {
          readPlayer(inst, 'hls');
          var lv = (data && data.levels) || inst.levels || [];
          var best = 0;
          var urls = [];
          for (var i = 0; i < lv.length; i++) {
            if (lv[i] && lv[i].url) urls.push(lv[i].url);
            if (lv[i] && lv[i].height) best = Math.max(best, lv[i].height);
          }
          reportAll(urls, 'hls-js', { height: best, public: { levels: lv.length } });
        } else if (ev === 'hlsLevelSwitched' || ev === 'LEVEL_SWITCHED') {
          var idx = data && data.level;
          var l = inst.levels && idx != null ? inst.levels[idx] : null;
          if (l) {
            if (l.url) report(l.url, 'hls-js-level', { height: l.height || 0, quality: l.height ? util.qualityLabel(l.height) : '', force: true });
            post('active-level', { height: l.height || 0, bandwidth: l.bitrate || 0, codecs: l.attrs && l.attrs.CODECS });
          }
        } else if (ev === 'hlsFragLoading' || ev === 'FRAG_LOADING') {
          inst.__sradSegs = (inst.__sradSegs || 0) + 1;
          if (data && data.frag && data.frag.url) report(data.frag.url, 'hls-segment', { isSegmentHint: true });
        } else if (ev === 'hlsError' || ev === 'ERROR') {
          var err = data && data.details;
          if (err && /manifest|load|network/i.test(String(err))) scanDomEmbeds();
        }
      }
    } catch (_) {}
  }

  function hookDashJs() {
    try {
      var d = root.dashjs;
      if (!d) return;
      if (!d.MediaPlayer || !d.MediaPlayer.prototype || d.MediaPlayer.prototype.__sradDash) return;
      var proto = d.MediaPlayer.prototype;
      proto.__sradDash = 1;
      ['initialize', 'attachSource'].forEach(function (fn) {
        var orig = proto[fn];
        if (typeof orig !== 'function') return;
        proto[fn] = function (arg) {
          try {
            if (typeof arg === 'string' && arg) noteUrl(arg, 'dash-js');
            else if (arg && arg.src) noteUrl(String(arg.src), 'dash-js');
            if (this.getDebug && this.getDebug()) readPlayer(this, 'dash');
          } catch (_) {}
          return orig.apply(this, arguments);
        };
      });
      var origCreate = d.MediaPlayer;
      if (typeof origCreate === 'function' && !d.__sradFactory) {
        d.__sradFactory = 1;
        var factory = function () {
          var inst = origCreate.apply(this, arguments);
          try {
            if (inst && typeof inst.on === 'function') {
              inst.on('manifestLoaded', function (e) {
                try {
                  var pd = (e && e.data && e.data.period) || [];
                  post('player', { name: 'dash.js', manifest: true, periods: pd.length });
                  readPlayer(inst, 'dash');
                } catch (_) {}
              });
            }
          } catch (_) {}
          return inst;
        };
        try {
          d.MediaPlayer = factory;
        } catch (_) {}
      }
      post('player', { name: 'dash.js', hooked: true });
    } catch (_) {}
  }

  function hookGlobalFactories() {
    // videojs / jwplayer / Plyr / Clappr — wrap so we can observe instances.
    var specs = [
      ['videojs', 'videojs'],
      ['jwplayer', 'jwplayer'],
      ['Plyr', 'plyr'],
      ['Clappr', 'clappr'],
      ['BitmovinPlayer', 'bitmovin'],
      ['Flowplayer', 'flowplayer'],
      ['KVideoPlayer', 'kvs'],
    ];
    specs.forEach(function (sp) {
      try {
        var name = sp[0], kind = sp[1];
        var current = root[name];
        if (!current) {
          // Player not loaded yet: install a lazy trap so we wrap it on assignment.
          try {
            Object.defineProperty(root, name, {
              configurable: true,
              get: function () {
                return current;
              },
              set: function (v) {
                current = v;
                try {
                  defineWrapper(v);
                } catch (_) {}
                // restore a plain property for the next players that load
                try {
                  Object.defineProperty(root, name, { value: current, configurable: true, writable: true });
                } catch (_) {}
              },
            });
          } catch (_) {}
          return;
        }
        defineWrapper(current);

        function defineWrapper(orig) {
          if (!orig || typeof orig !== 'function' || orig.__sradWrapped) return;
          orig.__sradWrapped = 1;
          var wrapped = new Proxy(orig, {
            apply: function (target, thisArg, args) {
              var r = Reflect.apply(target, thisArg, args);
              try {
                if (r && typeof r === 'object') {
                  trackPlayer(r, kind);
                  if (typeof r.on === 'function') {
                    r.on('ready', function () {
                      readPlayer(r, kind);
                    });
                    r.on('play', function () {
                      readPlayer(r, kind);
                    });
                  }
                }
                if (kind === 'clappr' && args[0]) noteUrl(String((args[0] && (args[0].source || args[0].file)) || ''), 'player');
                if (kind === 'jwplayer' && args[0] && args[0].file) noteUrl(String(args[0].file), 'jwplayer-setup');
                if (kind === 'videojs' && args[1] && args[1].sources && args[1].sources[0]) noteUrl(String(args[1].sources[0].file || ''), 'videojs-setup');
              } catch (_) {}
              return r;
            },
            construct: function (target, args) {
              var inst = Reflect.construct(target, args);
              try {
                trackPlayer(inst, kind);
              } catch (_) {}
              return inst;
            },
          });
          try {
            Object.defineProperty(root, name, { value: wrapped, configurable: true, writable: true });
          } catch (_) {}
          post('player', { name: name, hooked: true });
        }
      } catch (_) {}
    });
  }

  /** Shallow window scan: catches `var file = "…/x.m3u8"` style configs. */
  function scanGlobals() {
    try {
      var keys = Object.keys(root);
      var urls = [];
      var visited = 0;
      for (var i = 0; i < keys.length && visited < 500; i++) {
        var k = keys[i];
        if (/^(window|self|top|parent|frames|document|location|localStorage|sessionStorage|indexedDB)$/.test(k)) continue;
        var v;
        try {
          v = root[k];
        } catch (_) {
          continue;
        }
        if (typeof v === 'string') {
          visited++;
          if (/\.(m3u8|mpd|mp4|webm)(\?|#|$)/i.test(v) && /^https?:/i.test(v)) urls.push(v);
        } else if (v && typeof v === 'object' && !v.nodeType && visited < 260) {
          visited++;
          try {
            var sub = [v.file, v.src, v.url, v.source, v.video, v.playlist, v.hls, v.mp4];
            for (var j = 0; j < sub.length; j++) {
              var s = sub[j];
              if (typeof s === 'string' && /\.(m3u8|mpd|mp4|webm)(\?|#|$)/i.test(s)) urls.push(s);
              else if (Array.isArray(s)) s.forEach(function (x) { if (x && typeof x === 'object' && typeof (x.file || x.src) === 'string') urls.push(x.file || x.src); });
            }
          } catch (_) {}
        }
      }
      reportAll(urls, 'global-config');
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * 5. lifecycle
   * ------------------------------------------------------------------ */
  function startScanning() {
    // staggered first scans: cheap, then slower
    var steps = [250, 900, 2000, 4000, 8000, 15000, 30000, 60000];
    steps.forEach(function (ms, i) {
      setTimeout(function () {
        scanInlineScripts('step' + i);
        scanPerformance('step' + i);
        scanDomEmbeds();
        hookHlsJs();
        hookDashJs();
        readTracked();
      }, ms);
    });
    if (config.playerProbe) {
      // window globals scan only when a media element exists on this document
      setInterval(function () {
        try {
          var hasMedia = doc && doc.querySelectorAll('video,audio').length > 0;
          if (hasMedia) {
            scanGlobals();
            readTracked();
          }
        } catch (_) {}
      }, 5000);
    }
    setInterval(function () {
      scanPerformance('poll');
      scanDomEmbeds();
    }, 6000);
  }

  var readTracked = util.throttle(function () {
    for (var i = 0; i < tracked.length; i++) {
      try {
        readPlayer(tracked[i], tracked[i].__sradKind);
      } catch (_) {}
    }
  }, 3000);

  /** Every hook is installed independently: one failure must not disable L1-L5. */
  function installAll() {
    const steps = [
      ['fetch', patchFetch], ['xhr', patchXhr], ['websocket', patchWebSocket], ['eventsource', patchEventSource],
      ['createObjectURL', patchCreateObjectURL], ['mediasource', patchMediaSource], ['media-element', patchMediaElement],
      ['eme', patchEme], ['document.write', patchDocumentWrite], ['factories', hookGlobalFactories],
      ['hls.js', hookHlsJs], ['dash.js', hookDashJs],
    ];
    const failed = [];
    for (const [name, fn] of steps) {
      try {
        fn();
      } catch (e) {
        failed.push(name + ': ' + ((e && e.message) || e));
      }
    }
    if (failed.length) post('hook-error', { failed: failed });
  }

  function init() {
    installAll();
    startScanning();

    if (doc) {
      var kick = function () {
        scanInlineScripts('ready');
        scanDomEmbeds();
      };
      if (doc.readyState === 'interactive' || doc.readyState === 'complete') kick();
      else doc.addEventListener('DOMContentLoaded', kick);
      // documentElement can still be null at document-start (about:blank frames)
      if (!doc.documentElement) {
        doc.addEventListener('readystatechange', function onRs() {
          if (doc.documentElement) {
            doc.removeEventListener('readystatechange', onRs);
            observeDom();
          }
        });
        return;
      }
      observeDom();
    }

    function observeDom() {
      var mo = new MutationObserver(util.throttle(function (muts) {
        try {
          for (var m of muts) {
            for (var n of m.addedNodes || []) {
              if (!n || n.nodeType !== 1) continue;
              if (n.tagName === 'SCRIPT' && !n.src && n.textContent && n.textContent.length < 800000) noteText(n.textContent, 'script-added');
              if (n.tagName === 'IFRAME' && n.src) noteUrl(n.src, 'iframe-added');
              if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO') {
                scanDomEmbeds();
                hookHlsJs();
                hookDashJs();
              }
              if (n.querySelectorAll) {
                var vs = n.querySelectorAll('video,iframe,source');
                if (vs.length) scanDomEmbeds();
              }
            }
          }
        } catch (_) {}
      }, 600));
      try {
        mo.observe(doc.documentElement, { childList: true, subtree: true });
      } catch (_) {}
    }

    post('hello', {
      isTop: root === root.top,
      href: root.location.href,
      world: 'MAIN',
      version: SR.VERSION,
      hooks: ['fetch', 'xhr', 'websocket', 'eventsource', 'mse', 'media-element', 'eme', 'document.write', 'perf', 'players'],
    });
  }

  root.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.srad !== 1 || d.to !== 'page') return;
    try {
      if (d.cmd === 'config') Object.assign(config, d.payload || {});
      else if (d.cmd === 'scan') {
        scanInlineScripts('manual');
        scanPerformance('manual');
        scanDomEmbeds();
        scanGlobals();
        readTracked();
      } else if (d.cmd === 'record-start') {
        config.recordMse = true;
        post('record-state', { recording: true });
      } else if (d.cmd === 'record-stop') {
        config.recordMse = false;
        dumpRecording();
      } else if (d.cmd === 'ping') {
        post('pong', { version: SR.VERSION, reports: root.__streamRadarPage.reports });
      }
    } catch (_) {}
  });

  // Also expose a tiny programmatic API (useful for power users + debugging).
  root.streamRadar = {
    version: SR.VERSION,
    config: config,
    report: function (url) {
      noteUrl(String(url), 'manual');
    },
    scan: function () {
      scanInlineScripts('api');
      scanDomEmbeds();
      scanPerformance('api');
      scanGlobals();
      return root.__streamRadarPage.reports;
    },
    detected: function () {
      return [...seen.keys()];
    },
  };

  init();
})(
  // In a userscript (Tampermonkey/Violentmonkey) the real page globals live on
  // `unsafeWindow`; patching the sandbox copy would be useless. Inside the
  // extension's MAIN world `window` already IS the page world.
  typeof unsafeWindow !== 'undefined' ? unsafeWindow : typeof window !== 'undefined' ? window : globalThis
);

/* ═════════════════════════ src/userscript/host.js ═════════════════════════ */
/**
 * Stream Radar — USERSRIPT HOST (Tampermonkey / Violentmonkey / Greasemonkey)
 * ==================================================================
 * This file turns the same shared modules into a single .user.js for browsers
 * where you cannot install an unpacked extension — most importantly **Firefox
 * for Android**, which only accepts signed add-ons.
 *
 * What differs from the extension (honest limitations, also in the header):
 *   • no webRequest observer  → LAYER 1 works only through the page hooks
 *     (fetch / XHR / WebSocket). Cross-origin iframe traffic that never touches
 *     JS (plain <video src> in a 3rd-party frame) is found by the DOM layer
 *     *inside that frame* instead — which still needs the script to run there.
 *   • no service worker access, no browser notifications beyond GM_notification
 *   • settings live in GM storage (per script), not chrome.storage
 *
 * The rest — 5 layers, title cleansing, SubDL/OpenSubtitles/YIFY, SRT→VTT,
 * WatchParty hand-off, the shadow-DOM UI — is the exact same code as the
 * extension (see tools/build-userscript.mjs).
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;
  const rules = SR.rules;
  const doc = root.document;
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : root;
  const GM = root.GM || {};
  const t = (k, v) => SR.i18n.t(k, v);

  if (root.__streamRadarUserscript) return;
  root.__streamRadarUserscript = { version: SR.VERSION };

  const isTop = (function () {
    try {
      return root.top === root;
    } catch (_) {
      return false;
    }
  })();
  const onWatchParty = /(^|\.)watchparty\.me$/i.test(root.location.hostname);

  /* ------------------------------------------------------------------ *
   * storage (GM_setValue when available, localStorage otherwise)
   * ------------------------------------------------------------------ */
  const store = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const raw = GM_getValue(key, null);
          return raw == null ? fallback : util.safeJSON(raw, fallback);
        }
        const raw = root.localStorage.getItem('srad:' + key);
        return raw == null ? fallback : util.safeJSON(raw, fallback);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        const raw = util.safeStringify(value);
        if (typeof GM_setValue === 'function') GM_setValue(key, raw);
        else root.localStorage.setItem('srad:' + key, raw);
      } catch (_) {}
    },
  };

  /* ---- cross-origin requests through GM_xmlhttpRequest ---- */
  function gmFetch(url, init) {
    const fn = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : GM.xmlHttpRequest;
    if (!fn) return fetch(url, init);
    init = init || {};
    return new Promise((resolve, reject) => {
      let response = null;
      const req = fn({
        method: init.method || 'GET',
        url: String(url),
        headers: init.headers || undefined,
        data: typeof init.body === 'string' ? init.body : undefined,
        responseType: 'arraybuffer',
        timeout: init.__timeoutMs || 20000,
        anonymous: false,
        onload(res) {
          const status = res.status || 0;
          const headers = new HeadersProxy(res.responseHeaders || '');
          const buf = res.response instanceof ArrayBuffer ? new Uint8Array(res.response) : new TextEncoder().encode(String(res.responseText || ''));
          resolve({
            ok: status >= 200 && status < 400,
            status: status,
            headers,
            url: res.finalUrl || String(url),
            redirected: !!res.responseHeaders && false,
            async text() {
              return new TextDecoder().decode(buf);
            },
            async json() {
              return util.safeJSON(new TextDecoder().decode(buf), null);
            },
            async arrayBuffer() {
              return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            },
          });
        },
        onerror(e) {
          reject(new Error('GM_xmlhttpRequest failed: ' + ((e && e.error) || 'network')));
        },
        ontimeout() {
          reject(new Error('GM_xmlhttpRequest timeout'));
        },
        onabort() {
          reject(new Error('aborted'));
        },
      });
      if (init.signal) init.signal.addEventListener('abort', () => { try { req.abort(); } catch (_) {} });
    });
  }
  class HeadersProxy {
    constructor(raw) {
      this.map = {};
      for (const line of String(raw).split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) this.map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
    }
    get(k) {
      return this.map[String(k).toLowerCase()] || null;
    }
  }
  root.__sradFetch = gmFetch;
  util.fetchImpl = (url, init) => gmFetch(url, init);
  util.fetchText = async (url, opts) => {
    const o = opts || {};
    const res = await gmFetch(url, { headers: o.headers, __timeoutMs: o.timeoutMs || 12000 });
    if (!res.ok && res.status >= 400) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return text.length > (o.maxBytes || 2000000) ? text.slice(0, o.maxBytes || 2000000) : text;
  };

  /* ------------------------------------------------------------------ *
   * settings (override the extension's storage adapter)
   * ------------------------------------------------------------------ */
  SR.settings.load = async function (force) {
    if (this._cache && !force) return this._cache;
    this._cache = SR.settings.merge(store.get('settings', {}));
    return this._cache;
  };
  SR.settings.save = async function (patch) {
    const next = Object.assign({}, await SR.settings.load(), patch || {});
    this._cache = SR.settings.merge(next);
    store.set('settings', this._cache);
    this._emit(this._cache);
    return this._cache;
  };

  /* ------------------------------------------------------------------ *
   * state
   * ------------------------------------------------------------------ */
  let settings = Object.assign({}, SR.defaults);
  const state = { items: [], ads: [], counts: { total: 0, ads: 0 }, layers: {}, title: null, settings: settings, sub: { status: 'idle', items: [] }, frames: [], players: [], drm: null };
  const store_$ = new SR.MediaStore({});
  let ui = null;
  let lastNotify = 0;

  function notifyListeners() {
    try {
      for (const cb of stateListeners) cb();
    } catch (_) {}
  }
  const stateListeners = [];

  const push = util.throttle(function () {
    const v = store_$.view({ title: state.title });
    state.items = v.items.slice(0, 60);
    state.ads = v.ads.slice(0, 30);
    state.counts = v.counts;
    state.layers = v.layers;
    store.set('last:' + util.host(root.location.href), { entries: store_$.serialize(25), title: state.title, savedAt: Date.now() });
    if (ui) ui.render(state);
    notifyListeners();
  }, 220);

  function ingest(raw, origin) {
    if (!settings.enabled) return null;
    if (!raw || !raw.url) return null;
    if (rules.NOISE_RE.test(raw.url) && !/m3u8|mpd/i.test(raw.url)) return null;
    const before = store_$.order.length;
    const item = store_$.ingest(raw, origin);
    if (!item) return null;
    const isNew = store_$.order.length > before;
    if (isNew && !item.isAd) {
      if (isTop) {
        const label = rules.CATEGORY_LABEL[item.category] || 'MEDIA';
        toast(t('toast.newmedia', { type: label }) + (item.quality ? ', ' + item.quality : ''), 'ok');
        if (settings.notify && (typeof GM_notification === 'function' || GM.notification)) {
          try {
            (GM_notification || GM.notification)({ title: 'Stream Radar, ' + label, text: (state.title && state.title.title ? state.title.title + ' — ' : '') + (item.url || '').slice(0, 90) });
          } catch (_) {}
        }
      }
    }
    push();
    return item;
  }

  /* ------------------------------------------------------------------ *
   * page-hook bridge (same protocol as the extension)
   * ------------------------------------------------------------------ */
  function postCmd(cmd, payload) {
    try {
      W.postMessage(Object.assign({ srad: 1, to: 'page', cmd: cmd, payload: payload }), '*');
    } catch (_) {}
  }

  root.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.srad !== 1 || d.to === 'page') return;
    // no ev.source identity check: see the note in src/content/content.js
    switch (d.kind) {
      case 'hello':
        state.pageHooks = true;
        postCmd('config', config());
        if (!state.frames.some((f) => f.url === root.location.href)) {
          state.frames.push({ url: root.location.href, top: isTop, version: d.version, hooks: (d.payload && d.payload.hooks) || [] });
          push();
        }
        return;
      case 'media':
        return void ingest(d.payload, 'page');
      case 'mse':
        return void ingest({ url: d.payload.url, via: 'mse-src', size: d.payload.bytes, bytes: d.payload.bytes, mimes: d.payload.mimes, duration: d.payload.duration, recording: d.payload.recording }, 'mse');
      case 'drm':
        state.drm = d.payload.keySystem;
        return void push();
      case 'player':
        if (d.payload && d.payload.name && state.players.indexOf(d.payload.name) < 0) state.players.push(d.payload.name);
        return void push();
      case 'active-level':
        state.activeLevel = d.payload;
        return;
      case 'record-done':
        return void toast(t('toast.recordSaved', { size: util.formatBytes(d.payload.bytes) }), 'ok');
      case 'record-error':
        return void toast(t('toast.recordEmpty'), 'warn');
    }
  });

  function config() {
    return { recordMse: !!settings.recordMse, recordCapMB: settings.recordCapMB, scanScripts: settings.scanScripts !== false, playerProbe: settings.playerProbe !== false };
  }

  /* ------------------------------------------------------------------ *
   * subtitles
   * ------------------------------------------------------------------ */
  let pendingSub = null;
  const scheduleSubs = util.debounce(async function () {
    if (!settings.autoSubtitle || !isTop) return;
    await searchSubs(false);
  }, 2200);

  async function searchSubs(force) {
    if (!state.title || (!state.title.title && !state.title.imdbId)) return;
    state.sub = { status: 'searching', items: state.sub.items || [], at: Date.now() };
    push();
    try {
      const res = await SR.subs.search(
        { title: state.title.title, show: state.title.showName || state.title.title, year: state.title.year, season: state.title.season, episode: state.title.episode, imdbId: state.title.imdbId, tmdbId: state.title.tmdbId },
        settings,
        {}
      );
      state.sub = { status: res.results.length ? 'found' : 'none', items: res.results.slice(0, 10), providers: res.providerInfo, errors: res.errors, at: Date.now() };
      if (res.results.length) {
        try {
          const vtt = await SR.subs.resolve(res.results[0], settings, {});
          pendingSub = { vtt: vtt, name: res.results[0].filename || res.results[0].name };
          state.sub.chosen = { index: 0, name: res.results[0].name };
          toast(t('toast.subs', { name: String(res.results[0].name || '').slice(0, 40) }), 'ok', { id: 'sub-attach', label: t('panel.subs.attach') });
        } catch (e) {
          state.sub.resolveError = String((e && e.message) || e);
        }
      } else if (force) toast(t('toast.subsNone', { title: state.title.title || '?' }), 'warn');
    } catch (e) {
      state.sub = { status: 'error', items: [], error: String((e && e.message) || e), at: Date.now() };
      if (force) toast(t('toast.error', { msg: String((e && e.message) || e) }), 'err');
    }
    push();
  }

  async function saveVtt() {
    if (!pendingSub) {
      toast(t('panel.subs.none'), 'warn');
      return;
    }
    const name = ((state.title && state.title.title) || 'subtitles').replace(/[\\/:*?"<>|]/g, '.') + '.id.vtt';
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(new Blob([pendingSub.vtt], { type: 'text/vtt' }));
    a.download = name;
    (doc.body || doc.documentElement).appendChild(a);
    a.click();
    a.remove();
    toast(name + ' saved', 'ok');
  }

  function attachHere() {
    if (!pendingSub) return toast(t('panel.subs.none'), 'warn');
    let n = 0;
    const url = URL.createObjectURL(new Blob([pendingSub.vtt], { type: 'text/vtt' }));
    for (const video of doc.querySelectorAll('video')) {
      const track = doc.createElement('track');
      track.kind = 'subtitles';
      track.srclang = 'id';
      track.label = 'Indonesian (Stream Radar)';
      track.default = true;
      track.src = url;
      video.appendChild(track);
      try {
        const tt = video.textTracks;
        for (let i = 0; i < tt.length; i++) if (/Stream Radar/.test(tt[i].label || '')) tt[i].mode = 'showing';
      } catch (_) {}
      n++;
    }
    toast(n ? t('panel.subs.found') + ' x' + n : 'no <video> element found on this frame', n ? 'ok' : 'warn');
  }

  /* ------------------------------------------------------------------ *
   * WatchParty hand-off
   * ------------------------------------------------------------------ */
  function watchParty(item) {
    const url = item && item.url;
    if (!url) return toast(t('panel.empty'), 'warn');
    if (item.category === 'blob') return toast(t('label.mseHint'), 'warn');
    const room = String((state.title && (state.title.title || state.title.raw)) || util.domain(root.location.href)).slice(0, 90);
    store.set('party', { mediaUrl: url, roomName: room, autoJoin: settings.watchpartyAutoJoin !== false, subtitle: pendingSub, createdAt: Date.now() });
    const target = 'https://www.watchparty.me/watchNow?url=' + encodeURIComponent(url) + '&name=' + encodeURIComponent(room);
    try {
      if (typeof GM_openInTab === 'function') GM_openInTab(target, { active: true, insert: true, setParent: true });
      else if (GM.openInTab) GM.openInTab(target, true);
      else root.open(target, '_blank');
      toast(t('toast.watchparty'), 'info');
    } catch (e) {
      root.location.href = target;
    }
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  function toast(text, kind, action) {
    if (ui) ui.toast(text, kind, action);
    else if (settings.notify && (GM_notification || GM.notification)) {
      try {
        (GM_notification || GM.notification)({ title: 'Stream Radar', text: String(text).slice(0, 120) });
      } catch (_) {}
    }
  }

  function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') return GM_setClipboard(text, 'text'), toast(t('toast.copied'), 'ok');
      if (GM.setClipboard) return GM.setClipboard(text), toast(t('toast.copied'), 'ok');
    } catch (_) {}
    try {
      navigator.clipboard.writeText(text);
      toast(t('toast.copied'), 'ok');
    } catch (_) {
      const ta = doc.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      (doc.body || doc.documentElement).appendChild(ta);
      ta.select();
      doc.execCommand('copy');
      ta.remove();
      toast(t('toast.copied'), 'ok');
    }
  }

  function ensureUi() {
    if (ui || !isTop || !SR.ui) return;
    ui = SR.ui.create({
      shadowMode: root.__sradOpenShadow ? 'open' : 'closed',
      getSettings: () => settings,
      onAction: (action, payload) => {
        const it = state.items.find((x) => x.id === payload.id) || state.ads.find((x) => x.id === payload.id) || {};
        switch (action) {
          case 'copy':
            return copyText(it.url || '');
          case 'ffmpeg':
            return copyText(ffmpegFor(it));
          case 'variant': {
            const v = (it.variants || [])[payload.index];
            return v ? copyText(v.uri) : undefined;
          }
          case 'download':
            return download(it);
          case 'watchparty':
            return watchParty(it);
          case 'subs':
            return searchSubs(true);
          case 'sub-attach':
            return attachHere();
          case 'sub-download':
            return saveVtt();
          case 'open':
            return void root.open(it.url, '_blank');
          case 'record':
            return void postCmd(settings.recordMse ? 'record-stop' : 'record-start');
          case 'scan-now':
            postCmd('scan');
            scanner && scanner.scan('manual');
            scanner && scanner.readTitle(true);
            return;
          case 'clear':
            store_$.clear();
            return push();
          case 'open-options':
            return void openSettingsHelp();
          case 'set-setting': {
            settings[payload.key] = payload.key === 'providers' ? Object.assign({}, settings.providers, payload.value) : payload.value;
            SR.settings.save(settings);
            if (payload.key === 'fabPos' && ui) ui.setFabPos(payload.value);
            if (payload.key === 'theme' || payload.key === 'lang') {
              applyLang();
              ui && ui.applyTheme();
            }
            postCmd('config', config());
            store_$.configure({ maxItems: settings.maxItems, blockPatterns: settings.blockPatterns, allowPatterns: settings.allowPatterns });
            return push();
          }
        }
      },
    });
    ui.mount();
    ui.render(state);
    stateListeners.push(() => ui && ui.render(state));
  }

  function ffmpegFor(it) {
    if (!it || !it.url) return '';
    const out = ((state.title && state.title.title) || 'stream').replace(/[\\/:*?"<>|]/g, '.') + (it.category === 'hls' || it.category === 'dash' ? '.mp4' : '.' + (it.ext || 'mp4'));
    const tail = it.category === 'hls' || it.category === 'dash' ? '-c copy -bsf:a aac_adtstoasc -movflags +faststart' : '-c copy';
    return `ffmpeg -hide_banner -user_agent "Mozilla/5.0" -headers "Referer: ${root.location.origin}/" -i "${it.url}" ${tail} "${out}"`;
  }

  function download(it) {
    if (!it || !it.url) return toast(t('panel.empty'), 'warn');
    if (it.category === 'hls' || it.category === 'dash') {
      util
        .fetchText(it.url, { maxBytes: 1200000 })
        .then((text) => {
          const a = doc.createElement('a');
          a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
          a.download = (((state.title && state.title.title) || 'stream').replace(/[\\/:*?"<>|]/g, '.') + (it.category === 'hls' ? '.m3u8' : '.mpd'));
          (doc.body || doc.documentElement).appendChild(a);
          a.click();
          a.remove();
          toast(a.download + ' saved', 'ok');
        })
        .catch((e) => toast(t('toast.error', { msg: String((e && e.message) || e) }), 'err'));
      return;
    }
    const name = ((state.title && state.title.title) || it.name || 'stream').replace(/[\\/:*?"<>|]/g, '.') + '.' + (it.ext || 'mp4');
    try {
      if (typeof GM_download === 'function') return GM_download({ url: it.url, name: name, onload: () => toast(name + ' saved', 'ok'), onerror: (e) => toast(t('toast.error', { msg: e && e.error }), 'err') });
      if (GM.download) return GM.download(it.url, name);
    } catch (_) {}
    root.open(it.url, '_blank');
  }

  function openSettingsHelp() {
    const html = `<html><head><title>Stream Radar settings</title><style>body{font:14px system-ui;background:#141726;color:#e9edf7;padding:26px;max-width:780px;margin:auto}input,textarea{width:100%;padding:9px;border-radius:8px;border:1px solid #333a55;background:#1d2236;color:#e9edf7;font-family:monospace}label{display:block;margin:14px 0 4px;font-weight:600}button{margin-top:16px;padding:10px 18px;border-radius:10px;border:0;background:#6d5efc;color:#fff;font-weight:700;cursor:pointer}.k{color:#2ee6c5}</style></head><body>
      <h2>Stream Radar settings (userscript)</h2>
      <p class="k">Saved with GM_setValue; applies after a page reload.</p>
      <label>SubDL API key</label><input id="subdl" value="${esc(settings.subdlApiKey)}" placeholder="from https://subdl.com/panel/api">
      <label>OpenSubtitles API key</label><input id="os" value="${esc(settings.osApiKey)}">
      <label>OpenSubtitles User-Agent</label><input id="ua" value="${esc(settings.osUserAgent)}">
      <label>Theme (system|dark|light)</label><input id="theme" value="${esc(settings.theme)}">
      <label>Block patterns (one per line)</label><textarea id="block" rows="4">${esc(settings.blockPatterns)}</textarea>
      <button id="save">Save</button>
      <p style="opacity:.7;margin-top:22px">Toggles available from the panel: auto-detect (master), layers, subtitles, notifications — use the ⚙ icon on the floating panel.</p>
      <script>document.getElementById('save').onclick=()=>{const v=(id)=>document.getElementById(id).value;GM_setValue('settings',JSON.stringify(Object.assign({},JSON.parse(GM_getValue('settings','{}')||'{}'),{subdlApiKey:v('subdl'),osApiKey:v('os'),osUserAgent:v('ua'),theme:v('theme'),blockPatterns:v('block')})));close();};<\/script>
      </body></html>`;
    try {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      if (typeof GM_openInTab === 'function') GM_openInTab(url, { active: true });
      else root.open(url, '_blank');
    } catch (_) {
      alert('SubDL key: ' + (settings.subdlApiKey || '(empty)'));
    }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function applyLang() {
    SR.i18n.set(settings.lang && settings.lang !== 'auto' ? settings.lang : SR.i18n.detect(root.navigator));
  }

  /* ------------------------------------------------------------------ *
   * watchparty.me automation (userscript can inject into any page)
   * ------------------------------------------------------------------ */
  async function runWatchPartyAutomation() {
    const payload = store.get('party', null);
    if (!payload || Date.now() - (payload.createdAt || 0) > 6 * 60 * 1000) return;
    store.set('party', null);
    if (!SR.watchparty) return;
    SR.watchparty.run({ doc: doc, payload: payload, onStatus: (txt, kind) => toast(txt, kind), t });
  }

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */
  let scanner = null;
  async function boot() {
    settings = await SR.settings.load(true);
    state.settings = settings;
    applyLang();
    store_$.configure({ maxItems: settings.maxItems, blockPatterns: settings.blockPatterns, allowPatterns: settings.allowPatterns });

    // restore what we saw on this host earlier (a reload must not forget)
    const prev = store.get('last:' + util.host(root.location.href), null);
    if (prev && Date.now() - (prev.savedAt || 0) < 6 * 3600 * 1000) {
      store_$.restore(prev.entries);
      if (prev.title) state.title = prev.title;
    }

    if (onWatchParty) runWatchPartyAutomation();
    if (!isTop) return void setTimeout(() => postCmd('config', config()), 100);

    ensureUi();
    scanner = SR.domScan.create({
      win: root,
      doc: doc,
      isTop: true,
      enabled: () => settings.layerDom !== false,
      swEnabled: () => settings.layerSw !== false,
      emit: (entries) => {
        for (const e of entries) ingest(Object.assign({}, e, { frame: 'top' }), e.via || 'dom');
      },
      onTitle: (info) => {
        state.title = info;
        push();
        scheduleSubs();
      },
      onSw: () => {
        store_$.layers.sw = true;
      },
    });
    scanner.start();
    postCmd('config', config());
    setTimeout(() => postCmd('scan'), 2500);
    setTimeout(() => {
      if (!state.pageHooks) toast('Page hooks blocked by the site CSP. DOM and heuristic layers still run.', 'warn');
    }, 3000);
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Toggle panel', () => ui && ui.toggle());
      GM_registerMenuCommand('Search Indonesian subtitles now', () => searchSubs(true));
      GM_registerMenuCommand('Attach subtitle to this page', attachHere);
      GM_registerMenuCommand('Save .vtt', saveVtt);
      GM_registerMenuCommand('Settings', openSettingsHelp);
      GM_registerMenuCommand('Clear this page', () => {
        store_$.clear();
        push();
      });
    }
    root.addEventListener('visibilitychange', () => {
      if (!doc.hidden) scanner && scanner.scan('visible');
    });
    push();
  }

  boot().catch((e) => console.debug('[StreamRadar] userscript boot failed', e));
})(typeof window !== 'undefined' ? window : globalThis);
