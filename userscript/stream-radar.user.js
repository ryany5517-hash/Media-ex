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
    const pathHit = MEDIA_PATH_RE.test(pathname);
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
      isEmbed: EMBED_HOSTS.some((h) => host.indexOf(h) >= 0),
    };
  }

  function isAdUrl(url, host) {
    host = host || util.host(url);
    if (!host) return false;
    if (AD_HOSTS.some((h) => host === h || host.endsWith('.' + h) || host.indexOf(h) >= 0)) return true;
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

  function stripPhrases(text) {
    let out = ' ' + normalize(text) + ' ';
    for (const p of PHRASES) {
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
    const set = new Set(TOKENS.map((t) => t.toLowerCase()));
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
      const display = ep && ep.episodeTitle && pick.name ? pick.name + ' — ' + ep.episodeTitle : pick.name || pick.alternate || '';
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
      'panel.emptyHint': 'Play the video — Stream Radar watches network, DOM, MSE, Service Worker and player internals at once.',
      'panel.detecting': 'Watching…',
      'panel.paused': 'Auto-detect paused',
      'panel.ads': '{n} ad requests hidden',
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
      'label.segments': '{n} segments · {size}',
      'label.live': 'LIVE',
      'label.drm': 'DRM protected',
      'label.aes': 'AES-128 key',
      'label.mse': 'MediaSource (blob)',
      'label.mseHint': 'Blob streams cannot be downloaded directly — use Record buffer or open the source page.',
      'toast.found': '{n} media detected on this page',
      'toast.newmedia': 'New {type} stream detected',
      'toast.subs': 'Indonesian subtitle found: {name}',
      'toast.subsNone': 'No Indonesian subtitle found for “{title}”',
      'toast.copied': 'URL copied to clipboard',
      'toast.error': 'Error: {msg}',
      'toast.watchparty': 'Opening WatchParty…',
      'toast.paused': 'Detection paused on this site',
      'toast.resumed': 'Detection resumed',
      'toast.recording': 'Recording the MediaSource buffer…',
      'toast.recordSaved': 'Recording saved ({size})',
      'toast.recordEmpty': 'Nothing buffered yet — play the video first',
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
      'panel.emptyHint': 'Putar videonya — Stream Radar memantau jaringan, DOM, MSE, Service Worker dan internal player secara bersamaan.',
      'panel.detecting': 'Mendeteksi…',
      'panel.paused': 'Deteksi otomatis dijeda',
      'panel.ads': '{n} request iklan disembunyikan',
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
      'label.segments': '{n} segmen · {size}',
      'label.live': 'LIVE',
      'label.drm': 'Terproteksi DRM',
      'label.aes': 'Kunci AES-128',
      'label.mse': 'MediaSource (blob)',
      'label.mseHint': 'Stream blob tidak bisa diunduh langsung — pakai Rekam buffer atau buka halaman sumbernya.',
      'toast.found': '{n} media terdeteksi di halaman ini',
      'toast.newmedia': 'Stream {type} baru terdeteksi',
      'toast.subs': 'Subtitle Indonesia ditemukan: {name}',
      'toast.subsNone': 'Subtitle Indonesia tidak ditemukan untuk “{title}”',
      'toast.copied': 'URL disalin ke clipboard',
      'toast.error': 'Error: {msg}',
      'toast.watchparty': 'Membuka WatchParty…',
      'toast.paused': 'Deteksi dijeda di situs ini',
      'toast.resumed': 'Deteksi dilanjutkan',
      'toast.recording': 'Merekam buffer MediaSource…',
      'toast.recordSaved': 'Rekaman disimpan ({size})',
      'toast.recordEmpty': 'Belum ada buffer — putar dulu videonya',
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
            name: (util.host(dir) || 'segments') + ' · segment stream',
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
        if (!isTop || !doc || !SR.title) return null;
        const now = Date.now();
        if (!force && now - lastTitle < 900) return null;
        lastTitle = now;
        let info = null;
        try {
          info = SR.title.resolve(doc);
        } catch (_) {
          return null;
        }
        if (!info) return null;
        info.host = util.host(win.location.href);
        info.url = win.location.href;
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
            track.label = (name || 'Indonesian') + ' · Stream Radar';
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
            status(n ? t('panel.subs.found') + ' ×' + n : t('panel.subs.none'), n ? 'ok' : 'warn');
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

/* ═════════════════════════ src/content/ui-styles.js ═════════════════════════ */
/**
 * Stream Radar — UI stylesheet.
 * The string is injected into a *closed shadow root*, so none of these rules can
 * leak into the host page (no `!important` wars, no id collisions).
 * `srad-` prefixes are kept anyway so DevTools stay readable.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});

  SR.uiCss = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

/* ---------- tokens ---------- */
.srad-root {
  --bg: rgba(255,255,255,.72);
  --bg-solid: #ffffff;
  --bg-2: rgba(15,18,28,.04);
  --fg: #10131c;
  --fg-2: rgba(16,19,28,.62);
  --line: rgba(16,19,28,.12);
  --accent: #6d5efc;
  --accent-2: #00d1b2;
  --ok: #16a34a;
  --warn: #d97706;
  --err: #dc2626;
  --shadow: 0 18px 48px rgba(8,10,20,.22), 0 2px 8px rgba(8,10,20,.12);
  --radius: 18px;
  --blur: saturate(1.5) blur(18px);
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483000 !important;
  display: block;
  pointer-events: none;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--fg);
  font-size: 14px;
  line-height: 1.45;
}
.srad-root[data-theme="dark"] {
  --bg: rgba(19,22,33,.78);
  --bg-solid: #141726;
  --bg-2: rgba(255,255,255,.06);
  --fg: #e9edf7;
  --fg-2: rgba(233,237,247,.62);
  --line: rgba(233,237,247,.14);
  --accent: #8b7cff;
  --accent-2: #2ee6c5;
  --shadow: 0 18px 48px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.35);
}

/* ---------- floating action button ---------- */
.srad-fab {
  pointer-events: auto;
  position: absolute;
  right: 20px;
  bottom: 20px;
  width: 58px;
  height: 58px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,.28);
  background: linear-gradient(150deg, var(--accent) 0%, #4b3ff0 55%, var(--accent-2) 140%);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  transition: transform .18s cubic-bezier(.2,.9,.3,1.3), box-shadow .18s ease, opacity .2s ease;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  opacity: .96;
}
.srad-fab:hover { transform: translateY(-2px) scale(1.04); }
.srad-fab:active { transform: scale(.96); }
.srad-fab:focus-visible { outline: 3px solid var(--accent-2); outline-offset: 3px; }
.srad-fab[data-dragging="1"] { transition: none; transform: scale(1.08); cursor: grabbing; opacity: 1; }
.srad-fab svg { width: 26px; height: 26px; display: block; }
.srad-fab::after {
  content: "";
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid var(--accent-2);
  opacity: 0;
  pointer-events: none;
}
.srad-fab[data-pulse="1"]::after { animation: srad-pulse 1.25s ease-out 2; }
@keyframes srad-pulse {
  0%   { opacity: .85; transform: scale(.85); }
  100% { opacity: 0;   transform: scale(1.5); }
}
.srad-badge {
  position: absolute;
  top: -4px;
  right: -6px;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 11px;
  background: #ff3d5e;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 22px;
  text-align: center;
  box-shadow: 0 2px 10px rgba(255,61,94,.55);
  transform: scale(0);
  transition: transform .22s cubic-bezier(.2,.9,.3,1.4);
}
.srad-badge[data-show="1"] { transform: scale(1); }
.srad-fab[data-live="1"] { box-shadow: var(--shadow), 0 0 0 2px rgba(46,230,197,.6); }

/* ---------- panel ---------- */
.srad-panel {
  pointer-events: auto;
  position: absolute;
  width: min(430px, calc(100vw - 24px));
  max-height: min(78vh, 720px);
  right: 20px;
  bottom: 92px;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  color: var(--fg);
  overflow: hidden;
  transform-origin: bottom right;
  opacity: 0;
  transform: translateY(10px) scale(.97);
  transition: opacity .16s ease, transform .2s cubic-bezier(.2,.9,.3,1.2);
  visibility: hidden;
}
.srad-panel[data-open="1"] { opacity: 1; transform: none; visibility: visible; }
.srad-panel[data-anchor="tl"] { right: auto; left: 20px; top: 92px; bottom: auto; transform-origin: top left; }
.srad-panel[data-anchor="tr"] { right: 20px; top: 92px; bottom: auto; transform-origin: top right; }
.srad-panel[data-anchor="bl"] { right: auto; left: 20px; bottom: 92px; transform-origin: bottom left; }

.srad-head { display: flex; gap: 8px; align-items: center; padding: 12px 12px 10px; border-bottom: 1px solid var(--line); cursor: grab; }
.srad-head[data-drag="1"] { cursor: grabbing; }
.srad-title { font-weight: 700; font-size: 14px; letter-spacing: .2px; display: flex; align-items: center; gap: 8px; min-width: 0; }
.srad-title .srad-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 4px rgba(22,163,74,.16); flex: none; }
.srad-title .srad-dot[data-off="1"] { background: var(--warn); box-shadow: 0 0 0 4px rgba(217,119,6,.16); }
.srad-title small { font-weight: 500; color: var(--fg-2); font-size: 11.5px; display: block; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srad-spacer { flex: 1 1 auto; }

.srad-iconbtn {
  pointer-events: auto;
  width: 44px; height: 44px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 12px; border: 1px solid transparent; background: transparent;
  color: var(--fg); cursor: pointer; transition: background .15s ease, transform .15s ease;
  padding: 0;
}
.srad-iconbtn + .srad-iconbtn { margin-left: -4px; }
.srad-iconbtn:hover { background: var(--bg-2); }
.srad-iconbtn:active { transform: scale(.94); }
.srad-iconbtn:focus-visible { outline: 2px solid var(--accent-2); outline-offset: -2px; }
.srad-iconbtn svg { width: 20px; height: 20px; }

.srad-meta { padding: 10px 14px 0; display: flex; flex-wrap: wrap; gap: 6px; }
.srad-chip {
  font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
  background: var(--bg-2); border: 1px solid var(--line); color: var(--fg-2);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.srad-chip[data-kind="year"] { color: var(--fg); }
.srad-chip[data-kind="ep"] { background: rgba(109,94,252,.14); border-color: rgba(109,94,252,.35); color: var(--accent); }
.srad-chip[data-kind="junk"] { background: rgba(217,119,6,.14); border-color: rgba(217,119,6,.4); color: var(--warn); }

.srad-list { overflow: auto; padding: 8px 10px 4px; scroll-behavior: smooth; flex: 1 1 auto; overscroll-behavior: contain; }
.srad-list::-webkit-scrollbar { width: 10px; }
.srad-list::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; border: 3px solid transparent; background-clip: content-box; }

.srad-empty { padding: 26px 22px 30px; text-align: center; color: var(--fg-2); }
.srad-empty strong { display: block; color: var(--fg); font-size: 15px; margin-bottom: 6px; }
.srad-empty .srad-spin { width: 26px; height: 26px; margin: 0 auto 12px; border-radius: 50%; border: 2.5px solid var(--line); border-top-color: var(--accent); animation: srad-spin 1s linear infinite; }
@keyframes srad-spin { to { transform: rotate(360deg); } }

.srad-item {
  position: relative; display: grid; grid-template-columns: 54px 1fr; gap: 10px;
  padding: 10px; border-radius: 14px; border: 1px solid var(--line); background: var(--bg-solid);
  margin-bottom: 8px; animation: srad-in .26s cubic-bezier(.2,.9,.3,1.2);
}
@keyframes srad-in { from { opacity: 0; transform: translateY(8px); } }
.srad-item:focus-within, .srad-item[data-active="1"] { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(109,94,252,.18); }
.srad-item[data-ad="1"] { opacity: .72; }
.srad-thumb {
  width: 54px; height: 54px; border-radius: 11px; overflow: hidden; background: var(--bg-2);
  display: flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 800;
  letter-spacing: .4px; color: #fff; position: relative; flex: none;
}
.srad-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.srad-thumb[data-cat="hls"] { background: linear-gradient(140deg,#f97316,#c2410c); }
.srad-thumb[data-cat="dash"] { background: linear-gradient(140deg,#0ea5e9,#1d4ed8); }
.srad-thumb[data-cat="mp4"] { background: linear-gradient(140deg,#22c55e,#0f766e); }
.srad-thumb[data-cat="webm"] { background: linear-gradient(140deg,#a855f7,#6d28d9); }
.srad-thumb[data-cat="blob"] { background: linear-gradient(140deg,#64748b,#334155); }
.srad-thumb[data-cat="segment"] { background: linear-gradient(140deg,#eab308,#a16207); }
.srad-thumb[data-cat="texttrack"] { background: linear-gradient(140deg,#14b8a6,#0f766e); }

.srad-main { min-width: 0; }
.srad-row1 { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.srad-name { font-weight: 650; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.srad-url { color: var(--fg-2); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
.srad-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.srad-tag { font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 7px; background: var(--bg-2); border: 1px solid var(--line); color: var(--fg-2); }
.srad-tag[data-tone="q"] { background: rgba(109,94,252,.12); border-color: rgba(109,94,252,.3); color: var(--accent); }
.srad-tag[data-tone="ok"] { background: rgba(22,163,74,.13); border-color: rgba(22,163,74,.32); color: var(--ok); }
.srad-tag[data-tone="warn"] { background: rgba(217,119,6,.14); border-color: rgba(217,119,6,.34); color: var(--warn); }
.srad-tag[data-tone="err"] { background: rgba(220,38,38,.12); border-color: rgba(220,38,38,.3); color: var(--err); }
.srad-conf { display: inline-flex; gap: 3px; align-items: center; margin-left: auto; flex: none; }
.srad-conf i { width: 6px; height: 6px; border-radius: 50%; background: var(--line); display: block; }
.srad-conf i[data-on="1"] { background: var(--accent-2); }

.srad-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.srad-btn {
  pointer-events: auto; display: inline-flex; align-items: center; gap: 6px;
  min-height: 36px; padding: 0 11px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--line); background: var(--bg-2); color: var(--fg);
  font-size: 12px; font-weight: 600; font-family: inherit; transition: transform .12s ease, background .15s ease, border-color .15s ease;
}
.srad-btn:hover { background: var(--bg-solid); border-color: var(--accent); }
.srad-btn:active { transform: scale(.96); }
.srad-btn:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
.srad-btn[data-primary="1"] { background: linear-gradient(150deg,var(--accent),#4b3ff0); border-color: transparent; color: #fff; }
.srad-btn svg { width: 15px; height: 15px; flex: none; }
.srad-btn[disabled] { opacity: .5; cursor: progress; }
.srad-btn[data-done="1"] { border-color: var(--ok); color: var(--ok); }

.srad-variants { margin-top: 8px; border-top: 1px dashed var(--line); padding-top: 6px; display: none; }
.srad-item[data-expanded="1"] .srad-variants { display: block; animation: srad-in .2s ease; }
.srad-variant { display: flex; align-items: center; gap: 8px; padding: 4px 2px; font-size: 12px; color: var(--fg-2); }
.srad-variant b { color: var(--fg); font-weight: 650; }
.srad-variant .srad-vq { min-width: 52px; font-weight: 700; color: var(--fg); }
.srad-variant button { margin-left: auto; }

.srad-foot { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--line); background: var(--bg-2); flex-wrap: wrap; }
.srad-switch { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--fg-2); cursor: pointer; min-height: 36px; padding: 0 6px; border-radius: 9px; }
.srad-switch:hover { background: var(--bg-solid); }
.srad-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.srad-slider { width: 34px; height: 20px; border-radius: 999px; background: var(--line); position: relative; transition: background .18s ease; flex: none; }
.srad-slider::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35); transition: transform .18s cubic-bezier(.2,.9,.3,1.3); }
.srad-switch input:checked + .srad-slider { background: var(--accent); }
.srad-switch input:checked + .srad-slider::after { transform: translateX(14px); }
.srad-switch input:focus-visible + .srad-slider { outline: 2px solid var(--accent-2); outline-offset: 2px; }

/* ---------- settings popover ---------- */
.srad-pop {
  position: absolute; inset: 0; background: var(--bg-solid); color: var(--fg);
  transform: translateY(100%); transition: transform .24s cubic-bezier(.2,.9,.3,1.1);
  display: flex; flex-direction: column; z-index: 3;
}
.srad-pop[data-open="1"] { transform: none; }
.srad-pop .srad-popbody { overflow: auto; padding: 12px 14px 20px; }
.srad-field { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.srad-field label:first-child { flex: 1 1 auto; font-size: 13px; }
.srad-field .hint { color: var(--fg-2); font-size: 11.5px; display: block; }
.srad-seg { display: inline-flex; background: var(--bg-2); border: 1px solid var(--line); border-radius: 10px; padding: 2px; gap: 2px; }
.srad-seg button { border: 0; background: transparent; color: var(--fg-2); font: inherit; font-size: 12px; font-weight: 600; padding: 6px 10px; min-height: 32px; border-radius: 8px; cursor: pointer; }
.srad-seg button[data-on="1"] { background: var(--accent); color: #fff; }

/* ---------- toasts ---------- */
.srad-toasts {
  pointer-events: none; position: absolute; top: 14px; right: 14px;
  display: flex; flex-direction: column; gap: 8px; align-items: flex-end; width: min(360px, calc(100vw - 28px));
}
.srad-toast {
  pointer-events: auto; display: flex; align-items: center; gap: 9px; max-width: 100%;
  padding: 10px 13px; border-radius: 13px; background: var(--bg); border: 1px solid var(--line);
  box-shadow: var(--shadow); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
  color: var(--fg); font-size: 12.5px; font-weight: 550;
  animation: srad-toast-in .26s cubic-bezier(.2,.9,.3,1.2);
  position: relative; overflow: hidden;
}
.srad-toast[data-leaving="1"] { animation: srad-toast-out .22s ease forwards; }
@keyframes srad-toast-in { from { opacity: 0; transform: translateX(24px) scale(.96); } }
@keyframes srad-toast-out { to { opacity: 0; transform: translateX(24px) scale(.96); } }
.srad-toast .srad-tico { width: 20px; height: 20px; flex: none; display: flex; align-items: center; justify-content: center; border-radius: 7px; }
.srad-toast[data-kind="ok"] .srad-tico { background: rgba(22,163,74,.16); color: var(--ok); }
.srad-toast[data-kind="info"] .srad-tico { background: rgba(109,94,252,.16); color: var(--accent); }
.srad-toast[data-kind="warn"] .srad-tico { background: rgba(217,119,6,.18); color: var(--warn); }
.srad-toast[data-kind="err"] .srad-tico { background: rgba(220,38,38,.16); color: var(--err); }
.srad-toast .srad-tbar { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--accent); animation: srad-shrink 4s linear forwards; }
@keyframes srad-shrink { from { width: 100%; } to { width: 0%; } }
.srad-toast button { border: 0; background: var(--bg-2); border-radius: 8px; color: var(--fg); font: inherit; font-size: 11.5px; font-weight: 700; padding: 4px 8px; cursor: pointer; min-height: 28px; }
.srad-toast svg { width: 16px; height: 16px; }

/* ---------- mobile / touch ---------- */
@media (max-width: 720px), (coarse-pointer: coarse) and (max-width: 900px) {
  .srad-fab { width: 52px; height: 52px; right: 12px; bottom: 12px; }
  .srad-panel {
    right: 0 !important; left: 0 !important; top: auto !important; bottom: 0 !important;
    width: 100vw; max-width: 100vw; max-height: 82vh; border-radius: 20px 20px 0 0;
    transform-origin: bottom center; transform: translateY(16px);
  }
  .srad-panel .srad-actions { padding-bottom: env(safe-area-inset-bottom, 0); }
  .srad-btn { min-height: 44px; flex: 1 1 auto; justify-content: center; }
  .srad-toasts { top: 8px; left: 8px; right: 8px; width: auto; align-items: stretch; }
  .srad-list { padding-bottom: 12px; }
}
.srad-sr { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

@media (prefers-reduced-motion: reduce) {
  .srad-root *, .srad-root *::before, .srad-root *::after { animation-duration: .001s !important; transition-duration: .001s !important; }
}
`;
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ═════════════════════════ src/content/ui.js ═════════════════════════ */
/**
 * Stream Radar — the whole UI (FAB + panel + toasts + settings popover).
 * ------------------------------------------------------------------
 * Rendered inside a *closed shadow root* on every frame's document, so the
 * page cannot restyle it and it cannot restyle the page.
 * Pure view: it never fetches anything itself, it calls `onAction()` and the
 * content script relays that to the background worker, then re-renders us.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;

  const ICONS = {
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M7 4v16M17 4v16M2.5 9.3h4.5M2.5 14.7h4.5M17 9.3h4.5M17 14.7h4.5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15H4.5a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.06-.06A2 2 0 1 1 8.57 5.2l.06.06A1.7 1.7 0 0 0 10.5 4.6V4.5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.1a1.7 1.7 0 0 0 1.57 1.04h.14a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1.2z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.8 4.2v5h-5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M5 15.5A2.5 2.5 0 0 1 3.6 13V5.6A2.6 2.6 0 0 1 6.2 3h7.4A2.6 2.6 0 0 1 16 5.6"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 3.6v11M7.4 10.2 12 14.8l4.6-4.6M4.5 19.4h15"/></svg>',
    party: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20.5 8 9l8.5 3.5z"/><path d="M14.5 4.2a3 3 0 0 1 5.6 2M17.6 2.5l.9 1.7M21.4 5.4l-1.9.7"/></svg>',
    subs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2.6" y="4.6" width="18.8" height="14.8" rx="3"/><path d="M6.4 13.2h5M13.6 13.2h4M6.4 9.4h3.2M11.6 9.4h6"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14.5V18a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V8.5A2.5 2.5 0 0 1 6 6h3.6"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M20 14.4A8.4 8.4 0 0 1 9.6 4 8.6 8.6 0 1 0 20 14.4z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4.5 12.5 9.5 17.5 20 6.5"/></svg>',
    rec: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 10.5 12 14.5 16 10.5"/></svg>',
  };

  const t = (k, v) => SR.i18n.t(k, v);

  SR.ui = {
    /**
     * @param {{onAction:Function, getSettings:Function, isTopFrame?:boolean}} opts
     */
    create(opts) {
      const o = opts || {};
      const api = { open: false, lastCount: 0, items: [], ads: [], settings: {}, state: null, theme: 'system' };
      let host, shadow, rootEl, fab, badge, panel, listEl, toastsEl, popEl, liveEl;
      let drag = null;
      let mounted = false;

      /* ---------- mount ---------- */
      function mount() {
        if (mounted || !root.document || !root.document.documentElement) return false;
        mounted = true;
        host = root.document.createElement('div');
        host.id = 'stream-radar-host';
        host.setAttribute('data-srad', '1');
        // `closed` by default so the host page can never reach our UI.
        // (tests pass shadowMode:'open' to assert the generated markup)
        shadow = host.attachShadow({ mode: o.shadowMode === 'open' ? 'open' : 'closed', delegatesFocus: false });

        const style = root.document.createElement('style');
        style.textContent = SR.uiCss;
        shadow.appendChild(style);

        rootEl = root.document.createElement('div');
        rootEl.className = 'srad-root';
        rootEl.setAttribute('dir', 'ltr');
        rootEl.innerHTML =
          '<div class="srad-toasts" part="toasts" aria-live="polite" aria-atomic="false"></div>' +
          '<div class="srad-panel" role="dialog" aria-modal="false" aria-label="' + util.esc(t('panel.title')) + '" data-open="0"></div>' +
          '<div class="srad-fab" role="button" tabindex="0" aria-haspopup="dialog" aria-expanded="false"></div>' +
          '<div class="srad-sr" aria-live="polite"></div>';
        shadow.appendChild(rootEl);

        fab = rootEl.querySelector('.srad-fab');
        badge = root.document.createElement('div');
        badge.className = 'srad-badge';
        badge.setAttribute('aria-hidden', 'true');
        fab.appendChild(badge);
        fab.insertAdjacentHTML('afterbegin', ICONS.film);
        panel = rootEl.querySelector('.srad-panel');
        toastsEl = rootEl.querySelector('.srad-toasts');
        liveEl = rootEl.querySelector('.srad-sr');
        renderPanelShell();
        wireEvents();
        applyFabPos((o.getSettings && o.getSettings().fabPos) || null);
        applyTheme();
        const attach = () => {
          const target = root.document.body || root.document.documentElement;
          if (target && host.parentNode !== target) target.appendChild(host);
        };
        attach();
        if (!root.document.body) {
          root.document.addEventListener('DOMContentLoaded', attach, { once: true });
        }
        return true;
      }

      /* ---------- panel skeleton ---------- */
      function renderPanelShell() {
        panel.innerHTML =
          '<div class="srad-head">' +
          '<span class="srad-title"><span class="srad-dot"></span><span>' +
          '<span data-el="title">' + util.esc(t('panel.title')) + '</span>' +
          '<small data-el="subtitle">' + util.esc(t('app.tagline')) + '</small></span></span>' +
          '<span class="srad-spacer"></span>' +
          '<button class="srad-iconbtn" data-act="theme" title="theme" aria-label="' + util.esc(t('common.theme')) + '">' + ICONS.sun + '</button>' +
          '<button class="srad-iconbtn" data-act="refresh" aria-label="' + util.esc(t('panel.refresh')) + '" title="' + util.esc(t('panel.refresh')) + '">' + ICONS.refresh + '</button>' +
          '<button class="srad-iconbtn" data-act="settings" aria-label="' + util.esc(t('panel.settings')) + '" title="' + util.esc(t('panel.settings')) + '">' + ICONS.gear + '</button>' +
          '<button class="srad-iconbtn" data-act="close" aria-label="' + util.esc(t('common.close')) + '" title="' + util.esc(t('common.close')) + '">' + ICONS.close + '</button>' +
          '</div>' +
          '<div class="srad-meta" data-el="meta"></div>' +
          '<div class="srad-list" role="list" tabindex="-1" data-el="list"></div>' +
          '<div class="srad-foot">' +
          '<label class="srad-switch" title="' + util.esc(t('panel.detecting')) + '"><input type="checkbox" data-act="toggle-auto" checked><span class="srad-slider"></span><span>' + util.esc(t('panel.detecting')) + '</span></label>' +
          '<span class="srad-spacer"></span>' +
          '<button class="srad-btn" data-act="ads"><span data-el="adslabel"></span></button>' +
          '<button class="srad-btn" data-act="options" title="' + util.esc(t('panel.openPanel')) + '">' + ICONS.open + '<span>' + util.esc(t('panel.settings')) + '</span></button>' +
          '<button class="srad-btn" data-act="clear">' + util.esc(t('panel.clear')) + '</button>' +
          '</div>' +
          '<div class="srad-pop" data-el="pop" role="region" aria-label="' + util.esc(t('panel.settings')) + '">' +
          '<div class="srad-head"><span class="srad-title">' + util.esc(t('settings.title')) + '</span><span class="srad-spacer"></span>' +
          '<button class="srad-iconbtn" data-act="popclose" aria-label="' + util.esc(t('common.close')) + '">' + ICONS.close + '</button></div>' +
          '<div class="srad-popbody" data-el="popbody"></div></div>';
        listEl = panel.querySelector('[data-el="list"]');
      }

      /* ---------- events ---------- */
      function wireEvents() {
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

        panel.addEventListener('click', onPanelClick);
        panel.addEventListener('keydown', onPanelKey);
        panel.addEventListener('change', (e) => {
          const act = e.target.getAttribute('data-act');
          if (act === 'toggle-auto') fire('set-setting', { key: 'enabled', value: e.target.checked });
          else if (act && act.startsWith('set:')) fire('set-setting', { key: act.slice(4), value: e.target.checked });
        });
        root.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && api.open) {
            e.preventDefault();
            setOpen(false);
            fab.focus();
          }
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
        // re-clamp on resize
        root.addEventListener('resize', util.throttle(() => applyFabPos(currentFabPos()), 250));
      }

      function onPanelClick(e) {
        const btn = e.target.closest ? e.target.closest('[data-act],[data-variant-id]') : null;
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        const id = btn.getAttribute('data-id') || (btn.closest('[data-id]') ? btn.closest('[data-id]').getAttribute('data-id') : null);
        if (act === 'close') return setOpen(false);
        if (act === 'theme') return cycleTheme();
        if (act === 'settings') return openPop(true);
        if (act === 'popclose') return openPop(false);
        if (act === 'options') return fire('open-options');
        if (act === 'refresh') {
          btn.setAttribute('data-done', '1');
          fire('scan-now');
          setTimeout(() => btn.removeAttribute('data-done'), 900);
          return;
        }
        if (act === 'clear') return fire('clear');
        if (act === 'ads') {
          api.showAds = !api.showAds;
          fire('set-setting', { key: 'showAds', value: api.showAds });
          render(api.state);
          return;
        }
        if (act === 'toggle-expand') {
          const item = btn.closest('.srad-item');
          if (item) item.setAttribute('data-expanded', item.getAttribute('data-expanded') === '1' ? '0' : '1');
          return;
        }
        if (!act || !id) {
          const vbtn = e.target.closest ? e.target.closest('[data-variant-id]') : null;
          if (vbtn) {
            fire('variant', { id: id, index: Number(vbtn.getAttribute('data-variant-id')) });
          }
          return;
        }
        fire(act, { id: id, button: btn });
      }

      function onPanelKey(e) {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const items = [...panel.querySelectorAll('.srad-item')];
        if (!items.length) return;
        const cur = items.indexOf(e.target.closest('.srad-item'));
        const next = util.clamp((cur < 0 ? 0 : cur) + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1);
        e.preventDefault();
        const focusable = items[next].querySelector('.srad-btn, .srad-iconbtn');
        (focusable || items[next]).focus && items[next].scrollIntoView({ block: 'nearest' });
        if (focusable) focusable.focus();
        items.forEach((el, i) => el.setAttribute('data-active', i === next ? '1' : '0'));
      }

      function fire(action, payload) {
        try {
          if (o.onAction) o.onAction(action, payload || {});
        } catch (_) {}
      }

      /* ---------- FAB drag + position ---------- */
      let moved = false;
      function onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        drag = { x: e.clientX, y: e.clientY, ox: fab.offsetLeft, oy: fab.offsetTop, startLeft: rectLeft(), startTop: rectTop(), id: e.pointerId };
        moved = false;
        try {
          fab.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      function rectLeft() {
        const r = fab.getBoundingClientRect();
        return r.left;
      }
      function rectTop() {
        const r = fab.getBoundingClientRect();
        return r.top;
      }
      function onPointerMove(e) {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 7) return;
        moved = true;
        fab.setAttribute('data-dragging', '1');
        const w = fab.offsetWidth;
        const h = fab.offsetHeight;
        const left = util.clamp(drag.startLeft + dx, 6, Math.max(8, root.innerWidth - w - 6));
        const top = util.clamp(drag.startTop + dy, 6, Math.max(8, root.innerHeight - h - 6));
        fab.style.left = left + 'px';
        fab.style.top = top + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        positionPanel(left, top, w, h);
      }
      function onPointerUp() {
        if (!drag) return;
        fab.removeAttribute('data-dragging');
        const wasMoved = moved;
        drag = null;
        if (wasMoved) {
          const r = fab.getBoundingClientRect();
          fire('set-setting', { key: 'fabPos', value: { x: Math.round(r.left), y: Math.round(r.top) } });
          moved = false;
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
          fab.style.right = '20px';
          fab.style.bottom = '20px';
          if (root.innerWidth < 720) {
            fab.style.right = '12px';
            fab.style.bottom = '12px';
          }
          positionPanel();
          return;
        }
        const w = fab.offsetWidth || 58;
        const h = fab.offsetHeight || 58;
        const left = util.clamp(pos.x, 6, Math.max(8, root.innerWidth - w - 6));
        const top = util.clamp(pos.y, 6, Math.max(8, root.innerHeight - h - 6));
        fab.style.left = left + 'px';
        fab.style.top = top + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        positionPanel(left, top, w, h);
      }
      /** Keep the panel on the same side as the FAB (and below/below it). */
      function positionPanel(left, top, w, h) {
        if (!panel) return;
        if (left == null) {
          const r = fab.getBoundingClientRect();
          left = r.left;
          top = r.top;
          w = w || r.width;
          h = h || r.height;
        }
        const midX = left + (w || 58) / 2;
        const nearTop = top < root.innerHeight * 0.34;
        const anchor = (nearTop ? 't' : 'b') + (midX < root.innerWidth / 2 ? 'l' : 'r');
        panel.setAttribute('data-anchor', panel.getAttribute('data-anchor') === anchor ? anchor : anchor);
      }

      /* ---------- theme ---------- */
      let mq = null;
      function applyTheme() {
        if (!rootEl) return;
        const s = api.settings || {};
        let theme = s.theme || 'system';
        if (theme === 'system') {
          try {
            mq = mq || root.matchMedia('(prefers-color-scheme: dark)');
            theme = mq.matches ? 'dark' : 'light';
          } catch (_) {
            theme = 'light';
          }
        }
        rootEl.setAttribute('data-theme', theme);
        const btn = panel.querySelector('[data-act="theme"]');
        if (btn) btn.innerHTML = theme === 'dark' ? ICONS.moon : ICONS.sun;
        try {
          root.document.documentElement.setAttribute('data-srad-theme', theme);
        } catch (_) {}
      }
      function cycleTheme() {
        const order = ['system', 'dark', 'light'];
        const cur = (api.settings && api.settings.theme) || 'system';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        fire('set-setting', { key: 'theme', value: next });
      }
      if (root.matchMedia) {
        try {
          root.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (!api.settings || api.settings.theme === 'system') applyTheme();
          });
        } catch (_) {}
      }

      /* ---------- settings popover ---------- */
      function openPop(on) {
        const pop = panel.querySelector('[data-el="pop"]');
        if (!pop) return;
        if (on) renderPop();
        pop.setAttribute('data-open', on ? '1' : '0');
      }
      function renderPop() {
        const s = api.settings || {};
        const rows = [
          switchRow('enabled', 'Auto-detect (master)', 'Nyalakan/matikan deteksi di situs ini'),
          switchRow('layerNetwork', 'Layer 1 · Network intercept', 'fetch / XHR / WebSocket + webRequest'),
          switchRow('layerDom', 'Layer 2 · DOM deep scan', 'video, source, iframe, embed, object + MutationObserver'),
          switchRow('layerMse', 'Layer 3 · MSE / blob', 'MediaSource, SourceBuffer, createObjectURL'),
          switchRow('layerSw', 'Layer 4 · Service Worker & Cache API', 'scan caches for video responses'),
          switchRow('layerHeuristic', 'Layer 5 · Heuristics', 'inline scripts, resource timing, player configs'),
          switchRow('autoSubtitle', 'Auto subtitle search', 'Cari subtitle Indonesia otomatis'),
          switchRow('notify', 'Notifications', 'Toast + browser notification'),
          switchRow('recordMse', 'Allow MSE buffer recording', 'Beta: rekam stream blob menjadi file'),
          '<div class="srad-field"><label>' +
            util.esc(t('common.theme')) +
            '</label><span class="srad-seg">' +
            ['system', 'dark', 'light']
              .map((v) => '<button data-act="theme-' + v + '" data-on="' + (s.theme === v ? 1 : 0) + '">' + util.esc(t('theme.' + v)) + '</button>')
              .join('') +
            '</span></div>',
          '<div class="srad-field"><label>' + util.esc(t('common.language')) + '</label><span class="srad-seg">' +
            ['auto', 'en', 'id']
              .map((v) => '<button data-act="lang-' + v + '" data-on="' + (s.lang === v ? 1 : 0) + '">' + v.toUpperCase() + '</button>')
              .join('') +
            '</span></div>',
          '<div class="srad-field"><label>Simpan posisi FAB<div class="hint">Reset ke pojok kanan bawah</div></label>' +
            '<button class="srad-btn" data-act="reset-fab">Reset</button></div>',
        ].join('');
        const body = panel.querySelector('[data-el="popbody"]');
        if (body) body.innerHTML = rows;
        panel.querySelectorAll('[data-act^="theme-"]').forEach((b) => {
          b.addEventListener('click', () => fire('set-setting', { key: 'theme', value: b.getAttribute('data-act').slice(6) }));
        });
        panel.querySelectorAll('[data-act^="lang-"]').forEach((b) => {
          b.addEventListener('click', () => fire('set-setting', { key: 'lang', value: b.getAttribute('data-act').slice(5) }));
        });
        const rf = panel.querySelector('[data-act="reset-fab"]');
        if (rf) rf.addEventListener('click', () => fire('set-setting', { key: 'fabPos', value: null }));
      }
      function switchRow(key, label, hint) {
        const v = api.settings ? api.settings[key] : false;
        return (
          '<div class="srad-field"><label>' + util.esc(label) + (hint ? '<span class="hint">' + util.esc(hint) + '</span>' : '') + '</label>' +
          '<label class="srad-switch"><input type="checkbox" data-act="set:' + key + '"' + (v ? ' checked' : '') + ' aria-label="' + util.esc(label) + '"><span class="srad-slider"></span></label></div>'
        );
      }

      /* ---------- render ---------- */
      function render(state) {
        if (!mounted) return;
        api.state = state;
        api.settings = (state && state.settings) || api.settings || {};
        if (SR.i18n.get() === 'auto') SR.i18n.set(SR.i18n.detect(root.navigator));
        applyTheme();
        const items = (state && state.items) || [];
        const s = api.settings;
        const ads = (state && state.ads) || [];
        if (s.showAds) items.push(...ads);
        else api.showAds = false;

        // badge + pulse
        const count = items.filter((i) => !i.hidden).length;
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.setAttribute('data-show', count ? '1' : '0');
        fab.setAttribute('aria-label', t('fab.label', { n: count }));
        fab.setAttribute('data-live', state && state.settings && state.settings.enabled ? '1' : '0');
        if (count > api.lastCount && api.lastCount >= 0) pulse();
        api.lastCount = count;

        // header subtitle = cleaned title
        const info = (state && state.title) || null;
        const titleEl = panel.querySelector('[data-el="title"]');
        const subEl = panel.querySelector('[data-el="subtitle"]');
        if (info && info.title) {
          titleEl.textContent = info.title + (info.year ? ' (' + info.year + ')' : '');
          subEl.textContent = util.host(root.location.href) + ' · ' + t('panel.items', { n: count });
        } else {
          titleEl.textContent = t('panel.title');
          subEl.textContent = util.host(root.location.href);
        }
        renderMeta(state, count, ads.length);
        renderList(items, state);
        const auto = panel.querySelector('[data-act="toggle-auto"]');
        if (auto) auto.checked = !!(state && state.settings && state.settings.enabled);
        const adsLabel = panel.querySelector('[data-el="adslabel"]');
        if (adsLabel)
          adsLabel.textContent = ads.length ? (api.showAds ? t('panel.hideAds') : t('panel.ads', { n: ads.length })) : '';
        const adsBtn = panel.querySelector('[data-act="ads"]');
        if (adsBtn) adsBtn.style.display = ads.length ? '' : 'none';
      }

      function renderMeta(state, count, adCount) {
        const meta = panel.querySelector('[data-el="meta"]');
        if (!meta) return;
        const chips = [];
        const info = state && state.title;
        if (info && info.isJunk) chips.push('<span class="srad-chip" data-kind="junk">' + util.esc(t('popup.empty')) + '</span>');
        if (info && info.year) chips.push('<span class="srad-chip" data-kind="year">' + util.esc(info.year) + '</span>');
        const ep = info && SR.title.episodeLabel(info);
        if (ep) chips.push('<span class="srad-chip" data-kind="ep">' + util.esc(ep) + '</span>');
        if (info && info.kind === 'episode') chips.push('<span class="srad-chip" data-kind="ep">Series</span>');
        if (state && state.drm) chips.push('<span class="srad-chip" data-kind="ep">' + util.esc(t('label.drm')) + ' · ' + util.esc(state.drm) + '</span>');
        const layers = (state && state.layers) || {};
        const active = Object.keys(layers).filter((k) => layers[k]);
        if (active.length) chips.push('<span class="srad-chip" title="' + util.esc(active.join(', ')) + '">' + active.length + '/5 layers</span>');
        if (state && state.pagePaused) chips.push('<span class="srad-chip" data-kind="junk">' + util.esc(t('panel.paused')) + '</span>');
        meta.innerHTML = chips.join('');
        meta.style.display = chips.length ? '' : 'none';
      }

      function renderList(items, state) {
        if (!items.length) {
          listEl.innerHTML =
            '<div class="srad-empty"><div class="srad-spin"></div><strong>' + util.esc(t('panel.empty')) + '</strong>' + util.esc(t('panel.emptyHint')) + '</div>';
          return;
        }
        const sorted = items
          .slice()
          .sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || (SR.rules.CATEGORY_WEIGHT[b.category] || 0) - (SR.rules.CATEGORY_WEIGHT[a.category] || 0) || (b.ts || 0) - (a.ts || 0));
        listEl.innerHTML = sorted.map((it) => itemHtml(it, state)).join('');
      }

      function itemHtml(it, state) {
        const cat = it.category || 'other';
        const label = SR.rules.CATEGORY_LABEL[cat] || cat.toUpperCase();
        const name = it.name || it.file || urlName(it.url);
        const thumb = it.thumb ? '<img src="' + util.esc(it.thumb) + '" alt="" loading="lazy">' : util.esc(label.replace('SEGMENTS', 'SEG').slice(0, 5));
        const tags = [];
        if (it.quality) tags.push('<span class="srad-tag" data-tone="q">' + util.esc(it.quality) + '</span>');
        if (it.sizeLabel) tags.push('<span class="srad-tag">' + util.esc(it.sizeLabel) + '</span>');
        if (it.durationLabel) tags.push('<span class="srad-tag">' + util.esc(it.durationLabel) + '</span>');
        if (it.isLive) tags.push('<span class="srad-tag" data-tone="warn">' + util.esc(t('label.live')) + '</span>');
        if (it.aes) tags.push('<span class="srad-tag" data-tone="warn">' + util.esc(t('label.aes')) + '</span>');
        if (it.drm) tags.push('<span class="srad-tag" data-tone="err">' + util.esc(t('label.drm')) + '</span>');
        if (it.segmentCount) tags.push('<span class="srad-tag">' + util.esc(t('label.segments', { n: it.segmentCount, size: it.segmentBytesLabel || '' })) + '</span>');
        if (it.mseBytes) tags.push('<span class="srad-tag">' + util.esc(util.formatBytes(it.mseBytes)) + ' buffered</span>');
        if (it.isAd) tags.push('<span class="srad-tag" data-tone="err">AD</span>');
        const via = [].concat(it.via || []).filter(Boolean);
        if (via.length) tags.push('<span class="srad-tag" title="' + util.esc(t('label.via')) + ': ' + util.esc(via.join(', ')) + '">' + via.length + ' src</span>');

        const subs = it.sub || {};
        const subTone = subs.status === 'found' ? 'ok' : subs.status === 'none' ? 'warn' : subs.status === 'error' ? 'err' : '';
        if (subs.status) tags.push('<span class="srad-tag" data-tone="' + subTone + '">' + util.esc(subLabel(subs)) + '</span>');

        const conf = Math.min(3, via.length + (it.size ? 1 : 0) + (it.quality ? 1 : 0));
        const dots = [0, 1, 2].map((i) => '<i data-on="' + (i < conf ? 1 : 0) + '"></i>').join('');

        const variants = (it.variants || [])
          .slice(0, 12)
          .map(
            (v, i) =>
              '<div class="srad-variant"><span class="srad-vq">' + util.esc(v.quality || (v.height ? util.qualityLabel(v.height) : '?')) + '</span>' +
              '<b>' + util.esc(v.codecs || cat.toUpperCase()) + '</b><span>' + util.esc(v.bandwidthLabel || '') + '</span>' +
              '<button class="srad-btn" data-variant-id="' + i + '">' + util.esc(t('action.copy')) + '</button></div>'
          )
          .join('');

        return (
          '<div class="srad-item" role="listitem" data-id="' + util.esc(it.id) + '" data-ad="' + (it.isAd ? '1' : '0') + '" tabindex="0" aria-label="' + util.esc(label + ' ' + name) + '">' +
          '<div class="srad-thumb" data-cat="' + util.esc(cat) + '">' + thumb + '</div>' +
          '<div class="srad-main">' +
          '<div class="srad-row1"><span class="srad-name">' + util.esc(name) + '</span><span class="srad-conf" aria-hidden="true">' + dots + '</span></div>' +
          '<div class="srad-url" title="' + util.esc(it.url) + '">' + util.esc(it.url.length > 130 ? it.url.slice(0, 60) + '…' + it.url.slice(-52) : it.url) + '</div>' +
          '<div class="srad-tags">' + tags.join('') + '</div>' +
          '<div class="srad-actions">' +
          '<button class="srad-btn" data-act="watchparty" data-primary="1">' + ICONS.party + util.esc(t('action.watchparty')) + '</button>' +
          '<button class="srad-btn" data-act="copy">' + ICONS.copy + util.esc(t('action.copy')) + '</button>' +
          (cat === 'hls' || cat === 'dash' ? '<button class="srad-btn" data-act="download">' + ICONS.download + 'M3U8</button>' : '<button class="srad-btn" data-act="download">' + ICONS.download + util.esc(t('action.download')) + '</button>') +
          '<button class="srad-btn" data-act="subs">' + ICONS.subs + util.esc(t('action.subs')) + '</button>' +
          (cat === 'hls' || cat === 'dash' || cat === 'blob' ? '<button class="srad-btn" data-act="open">' + ICONS.open + util.esc(t('action.open')) + '</button>' : '') +
          '<button class="srad-btn" data-act="ffmpeg" title="' + util.esc(t('action.ffmpeg')) + '">' + ICONS.play + '</button>' +
          (variants ? '<button class="srad-btn" data-act="toggle-expand">' + ICONS.chevron + t('action.variants', { n: (it.variants || []).length }) + '</button>' : '') +
          (cat === 'blob' ? '<button class="srad-btn" data-act="record">' + ICONS.rec + util.esc(t('action.record')) + '</button>' : '') +
          '</div>' +
          (variants ? '<div class="srad-variants">' + variants + '</div>' : '') +
          (cat === 'blob' && it.mseBytes ? '<div class="srad-variants" style="display:block;border:0;padding-top:4px"><span class="srad-tag">' + util.esc(t('label.mseHint')) + '</span></div>' : '') +
          '</div></div>'
        );
      }

      function subLabel(subs) {
        if (subs.status === 'found') return '♪ ' + (subs.name || t('panel.subs.found'));
        if (subs.status === 'searching') return t('panel.subs.searching');
        if (subs.status === 'none') return t('panel.subs.none');
        if (subs.status === 'error') return t('panel.subs.error');
        if (subs.status === 'skipped') return t('panel.subs.skipped');
        return '';
      }

      function urlName(u) {
        try {
          const p = new URL(u).pathname.split('/').filter(Boolean).pop() || util.host(u);
          return decodeURIComponent(p).slice(0, 70);
        } catch (_) {
          return String(u).slice(0, 60);
        }
      }

      function pulse() {
        fab.setAttribute('data-pulse', '1');
        setTimeout(() => fab.removeAttribute('data-pulse'), 2600);
      }

      /* ---------- toasts ---------- */
      const liveToasts = [];
      function toast(msg, kind, action) {
        if (!mounted) mount();
        const el = root.document.createElement('div');
        el.className = 'srad-toast';
        el.setAttribute('data-kind', kind || 'info');
        el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
        el.innerHTML =
          '<span class="srad-tico">' + (kind === 'ok' ? ICONS.check : kind === 'err' ? ICONS.close : ICONS.film) + '</span>' +
          '<span style="flex:1 1 auto;min-width:0">' + util.esc(msg) + '</span>' +
          (action ? '<button data-toast-act="' + util.esc(action.id) + '">' + util.esc(action.label) + '</button>' : '') +
          '<span class="srad-tbar"></span>';
        toastsEl.appendChild(el);
        liveToasts.push(el);
        while (liveToasts.length > 4) dismiss(liveToasts.shift());
        if (action) {
          const b = el.querySelector('[data-toast-act]');
          if (b) b.addEventListener('click', () => { fire(action.id, action.payload || {}); dismiss(el); });
        }
        const timer = setTimeout(() => dismiss(el), 4000);
        el.addEventListener('pointerenter', () => clearTimeout(timer), { once: true });
        el.addEventListener('click', (e) => {
          if (!e.target.closest('button')) dismiss(el);
        });
        if (liveEl) liveEl.textContent = msg;
        return el;
      }
      function dismiss(el) {
        if (!el || el.getAttribute('data-leaving') === '1') return;
        el.setAttribute('data-leaving', '1');
        setTimeout(() => {
          el.remove();
          const i = liveToasts.indexOf(el);
          if (i >= 0) liveToasts.splice(i, 1);
        }, 240);
      }

      /* ---------- open/close ---------- */
      function setOpen(on) {
        api.open = on;
        panel.setAttribute('data-open', on ? '1' : '0');
        fab.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (on) {
          positionPanel();
          setTimeout(() => {
            const first = panel.querySelector('.srad-item .srad-btn');
            if (first && !root.document.activeElement?.closest?.('[data-act="close"]')) first.focus({ preventScroll: true });
            else if (!first) listEl.focus({ preventScroll: true });
          }, 60);
        }
      }
      function toggle() {
        if (!api.open && o.beforeOpen) o.beforeOpen();
        setOpen(!api.open);
      }

      /* ---------- public ---------- */
      return Object.assign(api, {
        mount,
        render,
        toast,
        dismissAll() {
          [...liveToasts].forEach(dismiss);
        },
        toggle,
        setOpen,
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
        toast(t('toast.newmedia', { type: label }) + (item.quality ? ' · ' + item.quality : ''), 'ok');
        if (settings.notify && (typeof GM_notification === 'function' || GM.notification)) {
          try {
            (GM_notification || GM.notification)({ title: 'Stream Radar · ' + label, text: (state.title && state.title.title ? state.title.title + ' — ' : '') + (item.url || '').slice(0, 90) });
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
    if (ev.source !== root && ev.source !== W) return;
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
    toast('✓ ' + name, 'ok');
  }

  function attachHere() {
    if (!pendingSub) return toast(t('panel.subs.none'), 'warn');
    let n = 0;
    const url = URL.createObjectURL(new Blob([pendingSub.vtt], { type: 'text/vtt' }));
    for (const video of doc.querySelectorAll('video')) {
      const track = doc.createElement('track');
      track.kind = 'subtitles';
      track.srclang = 'id';
      track.label = 'Indonesian · Stream Radar';
      track.default = true;
      track.src = url;
      video.appendChild(track);
      try {
        const tt = video.textTracks;
        for (let i = 0; i < tt.length; i++) if (/Stream Radar/.test(tt[i].label || '')) tt[i].mode = 'showing';
      } catch (_) {}
      n++;
    }
    toast(n ? t('panel.subs.found') + ' ×' + n : 'no <video> element found on this frame', n ? 'ok' : 'warn');
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
          toast('✓ ' + a.download, 'ok');
        })
        .catch((e) => toast(t('toast.error', { msg: String((e && e.message) || e) }), 'err'));
      return;
    }
    const name = ((state.title && state.title.title) || it.name || 'stream').replace(/[\\/:*?"<>|]/g, '.') + '.' + (it.ext || 'mp4');
    try {
      if (typeof GM_download === 'function') return GM_download({ url: it.url, name: name, onload: () => toast('✓ ' + name, 'ok'), onerror: (e) => toast(t('toast.error', { msg: e && e.error }), 'err') });
      if (GM.download) return GM.download(it.url, name);
    } catch (_) {}
    root.open(it.url, '_blank');
  }

  function openSettingsHelp() {
    const html = `<html><head><title>Stream Radar — settings</title><style>body{font:14px system-ui;background:#141726;color:#e9edf7;padding:26px;max-width:780px;margin:auto}input,textarea{width:100%;padding:9px;border-radius:8px;border:1px solid #333a55;background:#1d2236;color:#e9edf7;font-family:monospace}label{display:block;margin:14px 0 4px;font-weight:600}button{margin-top:16px;padding:10px 18px;border-radius:10px;border:0;background:#6d5efc;color:#fff;font-weight:700;cursor:pointer}.k{color:#2ee6c5}</style></head><body>
      <h2>Stream Radar (userscript) — settings</h2>
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
      if (!state.pageHooks) toast('Page hooks blocked by the site CSP — DOM/heuristic layers still active', 'warn');
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
