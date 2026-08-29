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
  SR.VERSION = '1.1.8';
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

    // WatchParty direct mode only plays a file it can fetch as media. Decide
    // whether a detected URL is directly playable there. Resolver/API links
    // (e.g. "/api?d=...") return a page/JSON and must NOT be sent.
    /**
     * Pull a direct media URL out of a resolver JSON/HTML/text body
     * (d.shows.st/api?d=… often returns `{file:"https://…m3u8"}`).
     */
    extractMediaUrl(input, depth) {
      const d = depth || 0;
      if (d > 6 || input == null) return '';
      if (typeof input === 'string') {
        const s = input.trim();
        if (/^https?:\/\//i.test(s) && /\.(m3u8|mpd|mp4|webm|mkv|m4v|m3u)(\?|#|$)/i.test(s)) return s;
        const m = s.match(/https?:\/\/[^\s"'<>\\)]{8,800}?\.(?:m3u8|mpd|mp4|webm|mkv|m4v)(?:\?[^\s"'<>\\)]{0,400})?/i);
        return m ? m[0] : '';
      }
      if (Array.isArray(input)) {
        for (let i = 0; i < input.length; i++) {
          const u = util.extractMediaUrl(input[i], d + 1);
          if (u) return u;
        }
        return '';
      }
      if (typeof input === 'object') {
        const keys = ['file', 'src', 'source', 'sources', 'url', 'video', 'stream', 'link', 'playlist', 'hls', 'file_url', 'videoUrl', 'fileUrl'];
        for (let i = 0; i < keys.length; i++) {
          if (input[keys[i]] == null) continue;
          const u = util.extractMediaUrl(input[keys[i]], d + 1);
          if (u) return u;
        }
        const vals = Object.keys(input);
        for (let i = 0; i < vals.length; i++) {
          const v = input[vals[i]];
          if (v && (typeof v === 'object' || typeof v === 'string')) {
            const u = util.extractMediaUrl(v, d + 1);
            if (u) return u;
          }
        }
      }
      return '';
    },

    /**
     * Sites like Valhalla wrap the real playlist:
     *   /m3u8-proxy?url=<encoded m3u8>&headers={"Origin":"…","Referer":"…"}
     * The wrapper IS the playable HLS URL (it rewrites segments). The headers
     * query is the Origin/Referer IDM would copy — use them if we play the inner url.
     */
    isHlsProxy(url) {
      if (!url || typeof url !== 'string') return false;
      let path = url;
      try {
        path = new URL(url).pathname;
      } catch (_) {}
      if (/(^|\/)(m3u8-proxy|hls-proxy|ts-proxy)(\/|$)/i.test(path)) return true;
      const q = util.query(url);
      return !!(q.headers && q.url && /\.m3u8/i.test(q.url));
    },

    parsePlayHeaders(url) {
      const q = util.query(url);
      let raw = q.headers || '';
      if (!raw) return { referer: '', origin: '' };
      try {
        raw = decodeURIComponent(raw);
      } catch (_) {}
      const obj = util.safeJSON(raw, null);
      if (!obj || typeof obj !== 'object') return { referer: '', origin: '' };
      const referer = String(obj.Referer || obj.referer || '');
      const origin = String(obj.Origin || obj.origin || '');
      return { referer: referer, origin: origin };
    },

    /** Local player can fetch with the page Referer; blob/segments still cannot. */
    localPlayable(url, category) {
      if (!url) return false;
      if (category === 'blob' || category === 'segment' || category === 'texttrack') return false;
      return /^https?:/i.test(url);
    },

    watchPartyPlayable(url, category) {
      if (!url) return false;
      if (category === 'blob' || category === 'segment' || category === 'texttrack') return false;
      let path = String(url);
      try { path = new URL(url).pathname; } catch (_) {}
      // 1) A media extension on the PATH is directly playable. This wins over
      //    everything: real HLS CDNs often serve .../api/playlist.m3u8, so a
      //    resolver-looking path must not veto an explicit manifest/file.
      if (/\.(m3u8|mpd|mp4|webm|mkv|mov|m4v|m3u)(\?|#|$)/i.test(path)) return true;
      if (util.isHlsProxy(url)) return true;
      // 2) Resolver/gateway endpoints return JSON/HTML (a2.shows.st/api?d=…).
      //    Even if webRequest labelled them HLS from a misleading content-type,
      //    WatchParty cannot play them — reject before the category shortcut.
      if (/(^|\/)(api|resolve|redirect|gateway|link|source|get|serve)(\/|$)/i.test(path)) return false;
      // 3) A classified direct-media category (content-type/parsed manifest,
      //    served without a clean extension) is playable too.
      if (category === 'hls' || category === 'dash' || category === 'mp4' || category === 'webm') {
        // Token CDNs like .../mpd/<id> are not a file WatchParty can fetch.
        if (/\/mpd\//i.test(path) && !/\.mpd(\?|#|$)/i.test(path)) return false;
        return true;
      }
      return false;
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
    providers: { wyzie: true, subdl: true, opensubtitles: true, yify: true },
    // Wyzie Subs requires a per-user key. It must NEVER be committed: Wyzie's
    // docs forbid shipping keys in browser extensions or public repos. The
    // user pastes their own key in Options; it is stored only in chrome.storage.
    wyzieApiKey: '',
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
