/* ===== inlined: src/shared/util.js ===== */
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

/* ===== inlined: src/shared/rules.js ===== */
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

/* ===== inlined: src/shared/title-cleaner.js ===== */
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

/* ===== inlined: src/shared/subtitles.js ===== */
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

  // Self-registering: never assume another module ran, and never clobber a
  // namespace a previous load (or another provider script) already built.
  const subs = (SR.subs = SR.subs || {});
  subs.providers = Array.isArray(subs.providers) ? subs.providers : [];

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

  /** sub.wyzie.io - free/libre subtitle API, searches by IMDb/TMDB id.
   * Needs a per-user key (store.wyzie.io/redeem). The key is read from the
   * user's settings only; it is never committed because Wyzie forbids keys in
   * browser extensions/public repos. Returns an array of subtitle objects
   * whose `url` is a direct SRT/ASS download. */
  subs.wyzie = {
    id: 'wyzie',
    label: 'Wyzie Subs',
    needsKey: true,
    base: 'https://sub.wyzie.io',
    async search(want, settings, ctx) {
      const key = settings.wyzieApiKey;
      if (!key) return { ok: false, skipped: true, reason: 'API key belum diisi' };
      // Wyzie searches by IMDb (tt...) or TMDB numeric id, never by title text.
      const id = want.imdbId || want.tmdbId;
      if (!id) return { ok: false, skipped: true, reason: 'butuh id IMDb/TMDB' };
      const params = new URLSearchParams();
      params.set('id', String(id));
      if (want.season && want.episode) {
        params.set('season', String(want.season));
        params.set('episode', String(want.episode));
      }
      const lang = settings.subtitleLang && settings.subtitleLang !== 'all' ? settings.subtitleLang : 'id';
      params.set('language', lang);
      params.set('format', 'srt');
      params.set('encoding', 'utf-8');
      params.set('source', 'all');
      params.set('key', key);
      const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const res = await fetchImpl(this.base + '/search?' + params.toString(), { headers: { Accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) throw new Error('Wyzie key ditolak (HTTP ' + res.status + ')');
      if (!res.ok) throw new Error('Wyzie HTTP ' + res.status);
      const text = await res.text();
      const json = util.safeJSON ? util.safeJSON(text, null) : JSON.parse(text);
      const rows = Array.isArray(json) ? json : Array.isArray(json && json.subtitles) ? json.subtitles : [];
      const items = rows
        .map((r) => ({
          provider: 'wyzie',
          providerLabel: 'Wyzie Subs',
          id: String(r.id || r.url || ''),
          name: r.media || want.title,
          filename: r.fileName || (r.media ? r.media + '.srt' : 'subtitle.srt'),
          langCode: String(r.language || 'id').slice(0, 2).toLowerCase(),
          langName: r.display || r.language || 'Indonesian',
          format: String(r.format || 'srt').toLowerCase(),
          year: want.year || '',
          season: want.season ? String(want.season) : '',
          episode: want.episode ? String(want.episode) : '',
          downloads: Number(r.downloadCount || 0),
          verified: !r.ai,
          aiTranslated: !!r.ai,
          uploader: r.source || '',
          pageUrl: r.url || '',
          fileUrl: r.url || '',
          hearingImpaired: !!r.isHearingImpaired,
          release: r.release || r.matchedRelease || '',
          raw: r,
        }))
        .filter((x) => /^https?:/.test(x.fileUrl));
      return { ok: true, items };
    },
    async fetchFile(item, settings, ctx) {
      const f = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const key = settings.wyzieApiKey;
      let url = item.fileUrl;
      // Wyzie download URLs are direct; attach the key only if it was not embedded.
      if (key && url.indexOf('key=') < 0) {
        url += (url.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(key);
      }
      return await subs.loadSubtitleFile(url, { fetchImpl: f, want: 'id' });
    },
  };

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

  // Register built-ins additively so a re-load neither wipes an externally
  // added provider nor pushes the same built-in twice. Wyzie first: it searches
  // by IMDb/TMDB id and gives the best Indonesian results.
  for (const p of [subs.wyzie, subs.subdl, subs.opensubtitles, subs.yify]) {
    if (p && !subs.providers.some(x => x && x.id === p.id)) subs.providers.push(p);
  }

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

/* ===== inlined: src/shared/i18n.js ===== */
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
      'panel.detecting': 'Watching...',
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
      'panel.subs.searching': 'Searching subtitles...',
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
      'watchparty.noBlob': 'No Watch Party: blob stream has no shareable URL',
      'watchparty.opening': 'Opening room',
      'watchparty.fallback': 'The room could not open. The tab may not be ready yet. Try reloading the tab then press Watch Party again.',
      'watchparty.reattach': 'Re-detect this tab',
      'watchparty.reloadTab': 'Reload tab',
      'toast.found': '{n} media detected on this page',
      'toast.newmedia': 'New {type} stream detected',
      'toast.subs': 'Indonesian subtitle found: {name}',
      'toast.subsNone': 'No Indonesian subtitle found for {title}',
      'toast.copied': 'URL copied to clipboard',
      'toast.error': 'Error: {msg}',
      'toast.watchparty': 'Opening WatchParty...',
      'toast.paused': 'Detection paused on this site',
      'toast.resumed': 'Detection resumed',
      'toast.recording': 'Recording the MediaSource buffer...',
      'toast.recordSaved': 'Recording saved ({size})',
      'toast.recordEmpty': 'Nothing buffered yet, play the video first',
      'settings.title': 'Stream Radar settings',
      'settings.subtitle': 'Everything is stored locally in your browser. No account, no tracking.',
      'theme.system': 'System',
      'theme.nextSystem': 'Switch to system (follow device)',
      'theme.nextLight': 'Switch to light',
      'theme.nextDark': 'Switch to dark',
      'theme.nowLight': 'light',
      'theme.nowDark': 'dark',
      'theme.btnLabel': 'Theme: {pref}, showing {effective}. {next}',
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
      'popup.history': 'Recent streams in this browser',
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
      'update.stateIdle': 'Idle',
      'update.stateChecking': 'Checking...',
      'update.stateCurrent': 'Up to date',
      'update.stateUpdated': 'Rule pack updated',
      'update.stateError': 'Update failed',
      'update.stateDisabled': 'Automatic updates off',
      'update.stateIncompat': 'Pack incompatible with this build',
      'update.packVersion': 'Rule pack v{v}',
      'update.hostsAdded': '+{n} hosts',
      'update.adsAdded': '+{n} ad rules',
      'update.sigOk': 'Signature verified',
      'update.sigNone': 'No pack yet',
      'update.patchVersion': 'Code patch v{v}',
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
      'options.tabGeneral': 'General',
      'options.tabDetection': 'Detection layers',
      'options.tabSubs': 'Subtitles & API keys',
      'options.tabAdvanced': 'Advanced',
      'options.tabHelp': 'Help',
      'common.all': 'All',
      'options.interface': 'Interface',
      'options.langAuto': 'Auto',
      'options.showFab': 'Show the floating button on pages',
      'options.showAds': 'List ad and tracker video requests too',
      'options.detection': 'Detection',
      'options.maxItems': 'Maximum items kept per tab',
      'options.layersLead': 'Five independent layers. Keep all on for maximum coverage.',
      'options.colLayer': 'Layer',
      'options.colHooks': 'What it hooks',
      'options.colNeeds': 'Needs',
      'options.layer1': '1. Network',
      'options.layer2': '2. DOM',
      'options.layer3': '3. MSE',
      'options.layer4': '4. Service worker',
      'options.layer5': '5. Heuristics',
      'options.scanScripts': 'Regex-scan scripts and JSON for hidden stream URLs',
      'options.recordCap': 'Recording cap (MB)',
      'options.subsLead': 'Wyzie, SubDL and OpenSubtitles need a free key; YIFY works without one. Keys stay in your browser.',
      'options.providers': 'Providers',
      'options.wyzieNote': '(Indonesian, needs IMDb/TMDB id)',
      'options.yifyNote': '(no key, often offline)',
      'options.wyzieHint': 'Free key at store.wyzie.io/redeem. Paste it below; never commit or share it.',
      'options.subdlHint': 'subdl.com then Account then API. Paste the key below.',
      'options.osHint': 'api.opensubtitles.com, Developers, Create App.',
      'options.langFilter': 'Language filter',
      'options.langIdOnly': 'Indonesian only',
      'options.langEn': 'English',
      'options.testSearch': 'Test the search',
      'options.fTitle': 'Title',
      'options.fYear': 'Year',
      'options.fSeason': 'Season',
      'options.fEpisode': 'Episode',
      'options.updateAuto': 'Fetch the rule pack automatically',
      'options.updatePatch': 'Allow signed code patches (advanced)',
      'options.updateUrl': 'Update source',
      'options.updateHours': 'Check every (hours)',
      'options.perSiteOpt': 'Per-site opt-out',
      'options.perSiteHint': 'Hosts listed here are fully skipped.',
      'options.export': 'Export settings',
      'options.import': 'Import settings',
      'options.resetAll': 'Reset everything',
      'options.debugLog': 'Debug logging in the console',
      'options.storage': 'Storage',
      'options.wipeHistory': 'Clear recent-streams list',
      'options.setupTitle': 'First-time setup',
      'options.help1': 'Load <code>dist/chrome</code> or <code>dist/firefox</code> as unpacked or temporary add-on.',
      'options.help2': 'Paste a free <b>Wyzie</b> or <b>SubDL</b> key in <em>Subtitles and API keys</em>.',
      'options.help3': 'Open a video, press play, then use the floating button or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>.',
      'options.help4': 'Click <b>Watch Party</b> on a stream to open watchparty.me with your title as the room name.',
      'options.shortcuts': 'Shortcuts',
      'options.shortcutList': '<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> panel, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> re-scan, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> subtitles, <kbd>Esc</kbd> close panel',
      'options.privacy': 'Privacy',
    },
    id: {
      'app.name': 'Stream Radar',
      'app.tagline': 'Detektor media ultra',
      'fab.label': 'Stream Radar: {n} media ditemukan',
      'panel.title': 'Media terdeteksi',
      'panel.empty': 'Belum ada video terdeteksi',
      'panel.emptyHint': 'Putar videonya, Stream Radar memantau jaringan, DOM, MSE, Service Worker dan internal player secara bersamaan.',
      'panel.detecting': 'Mendeteksi...',
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
      'panel.subs.searching': 'Mencari subtitle...',
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
      'watchparty.noBlob': 'Tidak bisa Nonton Bareng: stream blob tidak punya URL yang bisa dibagikan',
      'watchparty.opening': 'Membuka room',
      'watchparty.fallback': 'Room gagal dibuka. Tab mungkin belum siap. Coba muat ulang tab lalu tekan Nonton Bareng lagi.',
      'watchparty.reattach': 'Deteksi ulang tab ini',
      'watchparty.reloadTab': 'Muat ulang tab',
      'toast.found': '{n} media terdeteksi di halaman ini',
      'toast.newmedia': 'Stream {type} baru terdeteksi',
      'toast.subs': 'Subtitle Indonesia ditemukan: {name}',
      'toast.subsNone': 'Subtitle Indonesia tidak ditemukan untuk {title}',
      'toast.copied': 'URL disalin ke clipboard',
      'toast.error': 'Error: {msg}',
      'toast.watchparty': 'Membuka WatchParty...',
      'toast.paused': 'Deteksi dijeda di situs ini',
      'toast.resumed': 'Deteksi dilanjutkan',
      'toast.recording': 'Merekam buffer MediaSource...',
      'toast.recordSaved': 'Rekaman disimpan ({size})',
      'toast.recordEmpty': 'Belum ada buffer, putar dulu videonya',
      'settings.title': 'Pengaturan Stream Radar',
      'settings.subtitle': 'Semua disimpan lokal di browser Anda. Tanpa akun, tanpa tracking.',
      'theme.system': 'Sistem',
      'theme.nextSystem': 'Beralih ke sistem (ikut perangkat)',
      'theme.nextLight': 'Beralih ke terang',
      'theme.nextDark': 'Beralih ke gelap',
      'theme.nowLight': 'terang',
      'theme.nowDark': 'gelap',
      'theme.btnLabel': 'Tema: {pref}, tampil {effective}. {next}',
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
      'popup.history': 'Stream terbaru di browser ini',
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
      'update.stateIdle': 'Siaga',
      'update.stateChecking': 'Memeriksa...',
      'update.stateCurrent': 'Terbaru',
      'update.stateUpdated': 'Pak aturan diperbarui',
      'update.stateError': 'Pembaruan gagal',
      'update.stateDisabled': 'Pembaruan otomatis mati',
      'update.stateIncompat': 'Pak tidak cocok dengan build ini',
      'update.packVersion': 'Pak aturan v{v}',
      'update.hostsAdded': '+{n} host',
      'update.adsAdded': '+{n} aturan iklan',
      'update.sigOk': 'Tanda tangan terverifikasi',
      'update.sigNone': 'Belum ada pak',
      'update.patchVersion': 'Tambalan kode v{v}',
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
      'options.tabGeneral': 'Umum',
      'options.tabDetection': 'Layer deteksi',
      'options.tabSubs': 'Subtitle & API key',
      'options.tabAdvanced': 'Lanjutan',
      'options.tabHelp': 'Bantuan',
      'common.all': 'Semua',
      'options.interface': 'Antarmuka',
      'options.langAuto': 'Otomatis',
      'options.showFab': 'Tampilkan tombol mengambang di halaman',
      'options.showAds': 'Tampilkan juga request video iklan dan tracker',
      'options.detection': 'Deteksi',
      'options.maxItems': 'Maksimal item yang disimpan per tab',
      'options.layersLead': 'Lima layer terpisah. Biarkan semua aktif untuk jangkauan maksimal.',
      'options.colLayer': 'Layer',
      'options.colHooks': 'Yang di-hook',
      'options.colNeeds': 'Butuh',
      'options.layer1': '1. Jaringan',
      'options.layer2': '2. DOM',
      'options.layer3': '3. MSE',
      'options.layer4': '4. Service worker',
      'options.layer5': '5. Heuristik',
      'options.scanScripts': 'Pindai script dan JSON dengan regex untuk URL stream tersembunyi',
      'options.recordCap': 'Batas rekam (MB)',
      'options.subsLead': 'Wyzie, SubDL dan OpenSubtitles butuh kunci gratis; YIFY tanpa kunci. Kunci hanya tersimpan di browsermu.',
      'options.providers': 'Penyedia',
      'options.wyzieNote': '(Indonesia, butuh id IMDb/TMDB)',
      'options.yifyNote': '(tanpa kunci, sering mati)',
      'options.wyzieHint': 'Kunci gratis di store.wyzie.io/redeem. Tempel di bawah; jangan di-commit atau dibagikan.',
      'options.subdlHint': 'subdl.com lalu Account lalu API. Tempel kuncinya di bawah.',
      'options.osHint': 'api.opensubtitles.com, Developers, Create App.',
      'options.langFilter': 'Filter bahasa',
      'options.langIdOnly': 'Hanya Indonesia',
      'options.langEn': 'Inggris',
      'options.testSearch': 'Uji pencarian',
      'options.fTitle': 'Judul',
      'options.fYear': 'Tahun',
      'options.fSeason': 'Musim',
      'options.fEpisode': 'Episode',
      'options.updateAuto': 'Ambil paket aturan otomatis',
      'options.updatePatch': 'Izinkan code patch bertanda tangan (lanjutan)',
      'options.updateUrl': 'Sumber update',
      'options.updateHours': 'Cek tiap (jam)',
      'options.perSiteOpt': 'Opt-out per situs',
      'options.perSiteHint': 'Host di sini dilewati total.',
      'options.export': 'Ekspor pengaturan',
      'options.import': 'Impor pengaturan',
      'options.resetAll': 'Reset semua',
      'options.debugLog': 'Log debug di konsol',
      'options.storage': 'Penyimpanan',
      'options.wipeHistory': 'Hapus daftar stream terbaru',
      'options.setupTitle': 'Persiapan pertama',
      'options.help1': 'Muat <code>dist/chrome</code> atau <code>dist/firefox</code> sebagai ekstensi unpacked atau add-on sementara.',
      'options.help2': 'Tempel kunci <b>Wyzie</b> atau <b>SubDL</b> gratis di <em>Subtitle dan API key</em>.',
      'options.help3': 'Buka video, putar, lalu pakai tombol mengambang atau <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>.',
      'options.help4': 'Klik <b>Nonton Bareng</b> pada stream untuk membuka watchparty.me dengan judulmu sebagai nama room.',
      'options.shortcuts': 'Pintasan',
      'options.shortcutList': '<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> panel, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> scan ulang, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> subtitle, <kbd>Esc</kbd> tutup panel',
      'options.privacy': 'Privasi',
    },
  };

  let lang = 'en';

  function safeParse(s) {
    try {
      return JSON.parse(s) || {};
    } catch (_) {
      return {};
    }
  }

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

    /**
     * Translate all data-i18n* hooks under `rootEl` (defaults to the document).
     * Call AFTER dynamic render finishes so injected nodes are translated too.
     * Supported attributes (no fifth mechanism):
     *   data-i18n        -> textContent
     *   data-i18n-title  -> title attribute
     *   data-i18n-aria   -> aria-label attribute
     *   data-i18n-html   -> innerHTML, ONLY for dictionary strings containing
     *                       <kbd>/<code>; the value always comes from our dict.
     * Vars may be supplied via data-i18n-vars as JSON; otherwise {}.
     * Document title follows the key in data-i18n-title on <title> or the
     * settings.title key.
     */
    apply(rootEl, vars) {
      const scope = rootEl || (typeof document !== 'undefined' ? document : null);
      if (!scope) return;;
      const v = vars || {};
      const set = (el, key, attr) => {
        if (!key) return;
        const val = this.t(key, el.dataset && el.dataset.i18nVars ? safeParse(el.dataset.i18nVars) : v);
        if (attr === 'html') el.innerHTML = val;
        else if (attr) el.setAttribute(attr, val);
        else el.textContent = val;
      };
      scope.querySelectorAll('[data-i18n]').forEach(el => set(el, el.getAttribute('data-i18n')));
      scope.querySelectorAll('[data-i18n-title]').forEach(el => set(el, el.getAttribute('data-i18n-title'), 'title'));
      scope.querySelectorAll('[data-i18n-aria]').forEach(el => set(el, el.getAttribute('data-i18n-aria'), 'aria-label'));
      scope.querySelectorAll('[data-i18n-html]').forEach(el => set(el, el.getAttribute('data-i18n-html'), 'html'));
      if (typeof scope.title === 'string' || scope.querySelector) {
        const titleEl = scope.querySelector ? scope.querySelector('title[data-i18n-title], title[data-i18n]') : null;
        if (titleEl) {
          const k = titleEl.getAttribute('data-i18n-title') || titleEl.getAttribute('data-i18n');
          scope.title = this.t(k, v);
        }
      }
    },
    dict: DICT,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ===== inlined: src/shared/store.js ===== */
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

/* ===== inlined: src/shared/updater.js ===== */
/**
 * Stream Radar â€” live rule packs + signed hot patches
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
    x: 'UZ33kOysXiijfF9rVCLCU6s0JHFtlRKx3xHer-0pDmE',
    y: '3m66hI6NDl_cJb4vE_rLEIATjYMB_T3v2i3jLSPF2kc',
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

  /** DER â†’ raw r||s (WebCrypto wants the raw form; node's crypto.sign gives DER). */
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
          // Declare BOTH parameters: new Function(body)(SR, root) discards the
          // arguments because the function body never names them, so a patch
          // using `root` threw ReferenceError inside this try/catch with no
          // visible effect. The declared-parameter form passes SR and root.
          new Function('SR', 'root', '"use strict";\n' + patch.code)(SR, root);
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

/**
 * Stream Radar — background worker (Manifest V3 service worker)
 * ==================================================================
 * The single owner of state. The in-page panel, the action popup and the options
 * page are all thin views on top of it.
 *
 *   LAYER 1b — webRequest.onHeadersReceived on <all_urls>: sees *every* request
 *               of *every* frame (nested 3rd-party iframes, service workers,
 *               <video> media requests). A userscript cannot do this: it is the
 *               main reason the extension detects more than Tampermonkey can.
 *   LAYER 1a/2/3/4/5 — reported by src/page/inject.js and src/shared/dom-scanner.js.
 *   Enrichment — HLS master / DASH MPD parsing (real quality ladder, AES-128
 *               key, DRM system), size, duration, ranking, segment aggregation.
 *   PART 3  — WatchParty launcher (watchNow?url= hand-off + room automation).
 *   PART 4  — subtitle search (SubDL / OpenSubtitles / YIFY) + SRT→VTT + attach.
 *   Plus: action badge, desktop notifications, context menus, keyboard
 *   shortcuts, per-tab persistence and a browser-wide "recent streams" list.
 *
 * The importScripts block below runs when the extension is loaded straight from
 * /src (Chrome). `npm run build` concatenates the shared modules in front of
 * this file for dist/chrome + dist/firefox, so Firefox does not need to support
 * importScripts inside a MV3 service worker.
 */
/* shared modules are inlined above by tools/build.mjs */

(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;
  const rules = SR.rules;
  const api = util.api();
  const TAB_PREFIX = 'srad:tab:';
  const PARTY_PREFIX = 'srad:party:';
  const HISTORY_KEY = 'srad:history';
  const t = (k, v) => SR.i18n.t(k, v);

  let settings = Object.assign({}, SR.defaults);
  let blockedHosts = [];
  /** @type {Map<number, object>} */
  const tabs = new Map();
  const log = (...a) => {
    if (settings.debug) console.log('[StreamRadar/BG]', ...a);
  };

  /* ================================================================== *
   * tab state
   * ================================================================== */
  function newTabState(tabId) {
    return {
      tabId: tabId,
      store: new SR.MediaStore({ maxItems: settings.maxItems, blockPatterns: settings.blockPatterns, allowPatterns: settings.allowPatterns }),
      title: null,
      url: '',
      frames: [],
      players: [],
      sub: { status: 'idle', items: [], at: 0 },
      pendingSub: null,
      drm: null,
      sw: null,
      health: null,
      mediaError: null,
      activeLevel: null,
      contentReady: false,
      restored: false,
      lastNotify: 0,
    };
  }

  function getTab(tabId) {
    if (tabId == null || tabId < 0) return null;
    let st = tabs.get(tabId);
    if (!st) {
      st = newTabState(tabId);
      tabs.set(tabId, st);
    }
    return st;
  }

  /* ================================================================== *
   * ingest — every detection layer funnels through here
   * ================================================================== */
  function ingest(tabId, raw, origin) {
    const st = getTab(tabId);
    if (!st || !settings.enabled || !raw || !raw.url) return null;
    // A muted site stays muted for every request it triggers, including the
    // third-party CDN the iframe actually streams from.
    if (isBlockedHost(raw.url) || (st.url && isBlockedHost(st.url))) return null;
    const via = raw.via || '';
    if (origin === 'network' && !settings.layerNetwork) return null;
    if (via.indexOf('dom') === 0 && !settings.layerDom) return null;
    if (via === 'cache-api' && !settings.layerSw) return null;
    if (/heuristic|player|hls-js|jwplayer|videojs|global-config|inline-script|document.write|performance|eventsource|websocket/.test(via) && !settings.layerHeuristic) return null;

    const before = st.store.order.length;
    const item = st.store.ingest(raw, origin);
    if (!item) return null;
    const isNew = st.store.order.length > before;
    if (item.needsManifest) fetchManifest(st, item);
    touch(tabId);
    if (isNew && !item.isAd) notifyNewMedia(tabId, item, st);
    if (isNew && st.pendingSub && item.category !== 'blob') item.sub = { status: 'found', name: st.pendingSub.name };
    return item;
  }

  /* ---- manifest fetching (page-reported bodies are parsed by the store) ---- */
  const manifestQueue = new Map();
  function fetchManifest(st, item) {
    if (manifestQueue.has(item.key)) return;
    const run = util.debounce(async () => {
      manifestQueue.delete(item.key);
      try {
        const text = await util.fetchText(item.url, { timeoutMs: 9000, maxBytes: 700000 });
        if (!text) return;
        st.store.parseManifest(item, text);
        item.needsManifest = false;
        touch(st.tabId);
        broadcast(st.tabId, 'manifest');
      } catch (e) {
        item.manifestError = String((e && e.message) || e);
        log('manifest fetch failed', item.url, item.manifestError);
      }
    }, 800);
    manifestQueue.set(item.key, run);
    run();
  }

  /* ================================================================== *
   * LAYER 1b — network observer
   * ================================================================== */
  const REPORTED = new Map();

  function shouldTrack(url, type) {
    if (!url) return false;
    if (/^(chrome|moz)-extension:|^(chrome|moz)-search:|devtools:|view-source:/i.test(url)) return false;
    if (type === 'image' || type === 'stylesheet' || type === 'font' || type === 'ping' || type === 'beacon' || type === 'csp_report' || type === 'main_frame') return false;
    if (rules.NOISE_RE.test(url)) return false;
    return true;
  }

  function headerVal(headers, name) {
    if (!headers) return '';
    const lower = name.toLowerCase();
    for (const h of headers) {
      if (String(h.name || '').toLowerCase() !== lower) continue;
      if (h.value != null) return String(h.value);
      if (h.rawBytes && h.rawBytes.length) {
        try {
          return new TextDecoder().decode(Uint8Array.from(h.rawBytes));
        } catch (_) {}
      }
      if (h.binaryValue) {
        try {
          return atob(h.binaryValue);
        } catch (_) {}
      }
      return '';
    }
    return '';
  }

  function recentlyReported(key) {
    const t0 = REPORTED.get(key);
    const now = Date.now();
    if (t0 && now - t0 < 6000) return true;
    REPORTED.set(key, now);
    if (REPORTED.size > 5000) for (const [k, v] of REPORTED) if (now - v > 90000) REPORTED.delete(k);
    return false;
  }

  function onHeadersReceived(details) {
    try {
      if (!settings.enabled || !settings.layerNetwork) return;
      const tabId = details.tabId;
      if (tabId == null || tabId < 0) return;
      const url = details.url;
      const interesting = details.type === 'media' || details.type === 'xmlhttprequest' || details.type === 'object' || details.type === 'sub_frame';
      if (!interesting && !shouldTrack(url, details.type)) return;

      const headers = details.responseHeaders;
      const mime = headerVal(headers, 'content-type');
      const status = details.statusCode || 0;
      const len = parseInt(headerVal(headers, 'content-length') || '0', 10) || 0;

      // redirect chains: the real stream often appears in Location
      if (status >= 300 && status < 400) {
        const loc = headerVal(headers, 'location');
        const abs = loc ? util.abs(url, loc) : '';
        if (abs && /\.(m3u8|mpd|mp4|webm|mkv|m4v)(\?|#|$)/i.test(abs)) ingest(tabId, { url: abs, via: 'network', mime: mime, size: len, public: { redirectFrom: url } }, 'network');
        return;
      }

      // streams hidden inside a proxy URL's query string / base64 param
      if (/\?|%3a%2f%2f|base64/i.test(url)) {
        for (const n of rules.unwrapUrl(url)) {
          if (n === url || recentlyReported(util.dedupKey(n, ''))) continue;
          ingest(tabId, { url: n, via: 'network', mime: mime, size: len, public: { unwrappedFrom: url } }, 'network');
        }
      }

      const cls = rules.classify(url, { mime: mime, size: len });
      if (!cls) return;
      if (recentlyReported(util.dedupKey(url, cls.category))) return;
      const disposition = headerVal(headers, 'content-disposition');
      ingest(
        tabId,
        {
          url: url,
          via: 'network',
          mime: mime,
          size: len,
          public: {
            status: status,
            ranged: status === 206 || !!headerVal(headers, 'content-range'),
            acceptRanges: /bytes/i.test(headerVal(headers, 'accept-ranges')),
            attachment: /attachment/i.test(disposition),
            fileName: (disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1] || '',
            fromCache: !!details.fromCache,
            initiator: details.initiator || '',
            frameId: details.frameId,
          },
        },
        'network'
      );
    } catch (e) {
      log('webRequest error', String((e && e.stack) || e));
    }
  }

  if (api.webRequest && api.webRequest.onHeadersReceived && api.webRequest.onHeadersReceived.addListener) {
    try {
      api.webRequest.onHeadersReceived.addListener(onHeadersReceived, { urls: ['<all_urls>'] }, ['responseHeaders']);
    } catch (e) {
      console.warn('[StreamRadar] could not install the webRequest listener', e);
    }
  }

  /* ================================================================== *
   * state broadcasting + persistence
   * ================================================================== */
  function publicState(st) {
    if (!st) return null;
    const v = st.store.view({ title: st.title });
    return {
      items: v.items.slice(0, 60),
      ads: v.ads.slice(0, 40),
      counts: v.counts,
      layers: v.layers,
      title: st.title || null,
      settings: settings,
      frames: st.frames.slice(0, 10),
      players: st.players.slice(0, 8),
      drm: st.drm || null,
      sw: st.sw || null,
      health: st.health || null,
      mediaError: st.mediaError || null,
      sub: st.sub,
      subHasFile: !!st.pendingSub,
      pagePaused: isBlockedHost(st.url) || !settings.enabled,
      updatedAt: Date.now(),
    };
  }

  const touch = util.throttle(function (tabId) {
    const st = tabs.get(tabId);
    if (!st) return;
    persist(st);
    broadcast(tabId, 'update');
  }, 320);

  async function broadcast(tabId, what) {
    const st = tabs.get(tabId);
    if (!st) return;
    const payload = publicState(st);
    try {
      await api.tabs.sendMessage(tabId, { type: 'state', payload: payload, what: what });
      st.contentReady = true;
    } catch (_) {
      st.contentReady = false;
    }
    try {
      api.runtime.sendMessage({ type: 'state-global', tabId: tabId, payload: payload }).catch(() => {});
    } catch (_) {}
    updateBadge(tabId, st);
  }

  function updateBadge(tabId, st) {
    let count = 0;
    for (const id of st.store.order) {
      const e = st.store.byId.get(id);
      if (e && !e.isAd) count++;
    }
    try {
      api.action.setBadgeBackgroundColor({ color: count ? '#6d5efc' : '#94a3b8' });
      api.action.setBadgeText({ tabId: tabId, text: count ? (count > 99 ? '99+' : String(count)) : '' });
      api.action.setTitle({ tabId: tabId, title: count ? t('fab.label', { n: count }) : 'Stream Radar: ' + t('panel.empty') });
    } catch (_) {}
  }

  const persist = util.throttle(function (st) {
    try {
      api.storage.local.set({ [TAB_PREFIX + st.tabId]: { entries: st.store.serialize(40), title: st.title, url: st.url, savedAt: Date.now() } });
      pushHistory(st);
    } catch (_) {}
  }, 1500);

  /* ---------------- live rule packs / signed patches (no reinstall) ---------------- */
  const RULES_KEY = 'srad:rules';
  const PATCH_KEY = 'srad:patch';
  let updateState = { status: 'idle', at: 0, version: 0, notes: '' };

  async function loadRemote(packFromStorage) {
    try {
      const stored = packFromStorage || (await api.storage.local.get([RULES_KEY, PATCH_KEY]));
      if (stored[RULES_KEY] && stored[RULES_KEY].pack) SR.updater.applyRemote(stored[RULES_KEY].pack, null);
      return stored;
    } catch (_) {
      return {};
    }
  }

  async function checkForUpdates(reason) {
    const stored = await api.storage.local.get([RULES_KEY, PATCH_KEY]);
    const res = await SR.updater.checkForUpdates({
      settings: settings,
      appVersion: SR.VERSION,
      log: log,
      persist: async (payload) => {
        await api.storage.local.set({ [RULES_KEY]: payload });
        settings = await SR.settings.save({ rulesVersion: payload.version, lastUpdateCheck: Date.now() });
      },
      persistPatch: async (patch) => {
        await api.storage.local.set({ [PATCH_KEY]: patch });
        settings = await SR.settings.save({ patchVersion: patch.version, lastUpdateCheck: Date.now() });
      },
    });
    updateState = Object.assign({ reason: reason || 'manual' }, res);
    if (res.status === 'updated') {
      for (const st of tabs.values()) {
        // a fresh ad-domain list can change how existing rows are classified
        st.store.clear();
        api.tabs.sendMessage(st.tabId, { type: 'rules', payload: { pack: storedPack(), patch: await storedPatch() } }).catch(() => {});
        broadcast(st.tabId, 'rules');
      }
      toastToAll(SR.i18n.t('update.applied', { v: res.version }), 'ok');
    } else if (reason === 'manual') {
      toastToAll(res.status === 'current' ? SR.i18n.t('update.current') : res.status === 'disabled' ? SR.i18n.t('update.off') : SR.i18n.t('update.failed', { msg: res.error || res.status }), res.status === 'current' ? 'ok' : 'warn');
    }
    return updateState;
  }

  function storedPack() {
    return api.storage.local.get(RULES_KEY).then((r) => (r[RULES_KEY] && r[RULES_KEY].pack) || null);
  }
  function storedPatch() {
    return api.storage.local.get(PATCH_KEY).then((r) => r[PATCH_KEY] || null);
  }
  function toastToAll(text, kind) {
    for (const id of tabs.keys()) toastTo(id, text, kind);
  }

  async function restore(tabId) {
    const st = getTab(tabId);
    if (!st) return null;
    if (st.restored) return st;
    st.restored = true;
    try {
      const stored = await api.storage.local.get(TAB_PREFIX + tabId);
      const slim = stored[TAB_PREFIX + tabId];
      if (slim && Date.now() - (slim.savedAt || 0) < 12 * 3600 * 1000) {
        st.store.restore(slim.entries);
        st.title = slim.title || null;
        st.url = slim.url || '';
      }
    } catch (_) {}
    return st;
  }

  /* ---- browser-wide "recent streams" ------------------------------- */
  const historyQueue = [];
  const saveHistory = util.debounce(() => {
    try {
      api.storage.local.set({ [HISTORY_KEY]: historyQueue });
    } catch (_) {}
  }, 1500);
  function pushHistory(st) {
    const host = util.host(st.url || '');
    for (const e of st.store.serialize(6)) {
      if (e.isAd || e.kind === 'segmentgroup' || !e.url) continue;
      if (historyQueue.some((h) => h.url === e.url)) continue;
      historyQueue.unshift({ host: host, title: (st.title && st.title.title) || '', url: e.url, category: e.category, quality: e.quality || '', ts: Date.now() });
    }
    while (historyQueue.length > 150) historyQueue.pop();
    saveHistory();
  }

  /* ================================================================== *
   * notifications
   * ================================================================== */
  function toastTo(tabId, text, kind, action) {
    if (tabId == null) return;
    api.tabs.sendMessage(tabId, { type: 'toast', text: text, kind: kind || 'info', action: action }).catch(() => {});
  }

  async function notifyNewMedia(tabId, item, st) {
    const now = Date.now();
    if (now - (st.lastNotify || 0) < 1200) return;
    st.lastNotify = now;
    const label = rules.CATEGORY_LABEL[item.category] || 'MEDIA';
    const text = t('toast.newmedia', { type: label }) + (item.quality ? ', ' + item.quality : '');
    toastTo(tabId, text, 'ok');
    if (!settings.notify) return;
    let focused = true;
    try {
      focused = !!((await api.tabs.get(tabId)) || {}).active;
    } catch (_) {}
    if (focused || !api.notifications || !api.notifications.create) return;
    try {
      api.notifications.create('srad-' + tabId + '-' + item.id, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Stream Radar, ' + label,
        message: text + (st.title && st.title.title ? ', ' + st.title.title : ''),
        priority: 1,
      });
    } catch (_) {}
  }

  if (api.notifications && api.notifications.onClicked) {
    api.notifications.onClicked.addListener(async (id) => {
      const m = /^srad-(\d+)(-|$)/.exec(id);
      if (m) {
        try {
          const tab = await api.tabs.get(Number(m[1]));
          await api.tabs.update(Number(m[1]), { active: true });
          if (tab && tab.windowId != null && api.windows) api.windows.update(tab.windowId, { focused: true });
        } catch (_) {}
      }
      try {
        api.notifications.clear(id);
      } catch (_) {}
    });
  }

  /* ================================================================== *
   * subtitles (PART 4)
   * ================================================================== */
  const subTimers = new Map();
  function scheduleSubSearch(tabId, force) {
    const st = getTab(tabId);
    if (!st || !st.title) return;
    if (!force && !settings.autoSubtitle) return;
    if (!st.title.title && !st.title.imdbId) return;
    if (!force && st.sub && (st.sub.status === 'searching' || (st.sub.status === 'found' && Date.now() - st.sub.at < 600000))) return;
    const prev = subTimers.get(tabId);
    if (prev) prev.cancel();
    const job = util.debounce(() => runSubSearch(tabId), force ? 250 : 1800);
    subTimers.set(tabId, job);
    job();
  }

  async function runSubSearch(tabId) {
    const st = getTab(tabId);
    if (!st || !st.title) return;
    const want = {
      title: st.title.title,
      show: st.title.showName || st.title.title,
      year: st.title.year || null,
      season: st.title.season || null,
      episode: st.title.episode || null,
      imdbId: st.title.imdbId || null,
      tmdbId: st.title.tmdbId || null,
    };
    st.sub = { status: 'searching', items: st.sub.items || [], query: want.title, at: Date.now() };
    broadcast(tabId, 'sub');
    try {
      const res = await SR.subs.search(want, settings, {});
      st.sub = { status: res.results.length ? 'found' : 'none', items: res.results.slice(0, 12), providers: res.providerInfo, errors: res.errors, query: want.title, at: Date.now() };
      if (res.results.length) {
        const best = res.results[0];
        try {
          const vtt = await SR.subs.resolve(best, settings, {});
          st.pendingSub = { vtt: vtt, name: best.filename || best.name, provider: best.provider };
          st.sub.chosen = { index: 0, name: best.name };
          toastTo(tabId, t('toast.subs', { name: shorten(best.name || best.filename) }), 'ok', { id: 'sub-attach', label: t('panel.subs.attach') });
        } catch (e) {
          st.sub.resolveError = String((e && e.message) || e);
          toastTo(tabId, t('panel.subs.found'), 'ok');
        }
        if (settings.notify && api.notifications && api.notifications.create) {
          try {
            api.notifications.create('srad-sub-' + tabId, { type: 'basic', iconUrl: 'icons/icon128.png', title: 'Stream Radar, subtitle', message: t('toast.subs', { name: shorten(best.name || best.filename) }) });
          } catch (_) {}
        }
      } else {
        toastTo(tabId, t('toast.subsNone', { title: want.title || '?' }), 'warn');
      }
    } catch (e) {
      st.sub = { status: 'error', items: st.sub.items || [], error: String((e && e.message) || e), query: want.title, at: Date.now() };
      toastTo(tabId, t('toast.error', { msg: String((e && e.message) || e) }), 'err');
    }
    for (const e of st.store.byId.values()) if (e.sub && e.sub.status === 'searching') e.sub = { status: st.sub.status, name: (st.sub.items[0] || {}).name };
    broadcast(tabId, 'sub');
  }

  function shorten(s, n) {
    s = String(s || '');
    return s.length > (n || 42) ? s.slice(0, (n || 42) - 1) + '...' : s;
  }

  /* ================================================================== *
   * WatchParty (PART 3)
   * ================================================================== */
  // /create?video= auto-creates the room server-side and redirects into it.
  function watchPartyCreateUrl(mediaUrl) {
    return 'https://www.watchparty.me/create?video=' + encodeURIComponent(mediaUrl);
  }

  async function launchWatchParty(st, itemId) {
    const media = (itemId && st.store.byId.get(itemId)) || st.store.best();
    const url = media && media.url;
    if (!url) return { ok: false, reason: t('panel.empty') };
    if (media.category === 'blob') return { ok: false, reason: t('label.mseHint') };
    const ti = st.title || {};
    const roomName = String(
      ti.title ? ti.title + (ti.year ? ' (' + ti.year + ')' : '') + (ti.episode ? ' S' + (ti.season || '01') + 'E' + ti.episode : '') : ti.raw || util.domain(st.url) || 'Stream Radar room'
    ).slice(0, 90);
    const payload = {
      mediaUrl: url,
      roomName: roomName,
      userName: settings.watchpartyName || '',
      category: media.category,
      quality: media.quality || '',
      title: st.title || null,
      subtitle: st.pendingSub ? { vtt: st.pendingSub.vtt, name: st.pendingSub.name } : null,
      autoJoin: settings.watchpartyAutoJoin !== false,
      createdAt: Date.now(),
    };
    // WatchParty's /create?video=<url> route auto-creates a room and loads the
    // video (it POSTs /createRoom then redirects to /watch<room>), exactly like
    // the "Watch Party" button on rivestream etc. That is strictly better than
    // /watchNow?url= which only pre-fills a form, so we open /create and keep the
    // payload for the on-site adapter (user name + subtitle attach).
    const target = watchPartyCreateUrl(url);
    const tab = await api.tabs.create({ url: target, active: true }).catch(async () => await api.tabs.create({ url: target }));
    if (tab && tab.id > 0) await api.storage.local.set({ [PARTY_PREFIX + tab.id]: payload });
    return { ok: true, tabId: tab && tab.id, payload: payload };
  }

  /* ================================================================== *
   * actions (popup + panel + options all land here)
   * ================================================================== */
  async function handleAction(msg, sender) {
    const tabId = sender.tab && sender.tab.id != null ? sender.tab.id : (msg.tabId != null ? msg.tabId : (msg.payload && msg.payload.tabId != null ? msg.payload.tabId : undefined));
    const st = await restore(tabId);
    if (!st) return { ok: false, reason: 'no tab' };
    switch (msg.name) {
      case 'open': {
        const it = st.store.byId.get(msg.id);
        if (it) await api.tabs.create({ url: it.url, active: false });
        return { ok: true };
      }
      case 'download': {
        const it = st.store.byId.get(msg.id);
        if (!it) return { ok: false, reason: 'not found' };
        if (it.kind === 'segmentgroup') return { ok: false, reason: 'a segment group is not a single file. Open the matching playlist instead.' };
        const filename = downloadName(it, st);
        if (it.category === 'hls' || it.category === 'dash') {
          try {
            const text = await util.fetchText(it.url, { timeoutMs: 12000, maxBytes: 1500000 });
            const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text || (it.category === 'hls' ? '#EXTM3U\n' : '<?xml version="1.0"?><MPD/>'));
            return { ok: true, id: await api.downloads.download({ url: dataUrl, filename: filename, saveAs: false, conflictAction: 'uniquify' }), mode: 'playlist' };
          } catch (e) {
            await api.tabs.create({ url: it.url, active: true });
            return { ok: false, reason: String((e && e.message) || e), fallback: 'opened' };
          }
        }
        try {
          return { ok: true, id: await api.downloads.download({ url: it.url, filename: filename, saveAs: false, conflictAction: 'uniquify' }) };
        } catch (e) {
          await api.tabs.create({ url: it.url, active: true });
          return { ok: false, reason: String((e && e.message) || e), fallback: 'opened' };
        }
      }
      case 'variant': {
        const it = st.store.byId.get(msg.id);
        const v = it && it.variants ? it.variants[msg.index] : null;
        if (!v) return { ok: false, reason: 'no such variant' };
        return { ok: true, id: await api.downloads.download({ url: v.uri, filename: downloadName(it, st), saveAs: false, conflictAction: 'uniquify' }) };
      }
      case 'watchparty':
        return await launchWatchParty(st, msg.id);
      case 'subs-search':
        scheduleSubSearch(tabId, true);
        return { ok: true };
      case 'sub-attach': {
        if (!st.pendingSub) await runSubSearch(tabId);
        if (!st.pendingSub) return { ok: false, reason: 'no subtitle available' };
        await api.tabs.sendMessage(tabId, { type: 'attach-subtitle', vtt: st.pendingSub.vtt, name: st.pendingSub.name }).catch(() => {});
        return { ok: true };
      }
      case 'sub-download': {
        if (!st.pendingSub) return { ok: false, reason: 'no subtitle loaded' };
        return { ok: true, id: await api.downloads.download({ url: 'data:text/vtt;charset=utf-8,' + encodeURIComponent(st.pendingSub.vtt), filename: sanitize((st.title && st.title.title) || 'subtitles') + '.id.vtt', saveAs: false, conflictAction: 'uniquify' }) };
      }
      case 'sub-pick': {
        const it = (st.sub.items || [])[Number(msg.index || 0)];
        if (!it) return { ok: false, reason: 'index out of range' };
        try {
          const vtt = await SR.subs.resolve(it, settings, {});
          st.pendingSub = { vtt: vtt, name: it.filename || it.name, provider: it.provider };
          st.sub.chosen = { index: Number(msg.index || 0), name: it.name };
          toastTo(tabId, t('panel.subs.found') + ': ' + shorten(it.name || it.filename, 30), 'ok', { id: 'sub-attach', label: t('panel.subs.attach') });
          broadcast(tabId, 'sub');
          return { ok: true };
        } catch (e) {
          return { ok: false, reason: String((e && e.message) || e) };
        }
      }
      case 'sub-download-info':
        return { ok: !!st.pendingSub, sub: st.pendingSub || null, title: st.title || null };
      case 'set-setting': {
        settings = await SR.settings.save({ [msg.key]: msg.value });
        applySettings();
        return { ok: true, settings: settings };
      }
      case 'toggle-site': {
        const host = util.host(sender.url || st.url || '');
        const list = Object.assign({}, settings.blockedHosts || {});
        list[host] = !list[host];
        settings = await SR.settings.save({ blockedHosts: list });
        applySettings();
        toastTo(tabId, list[host] ? t('toast.paused') : t('toast.resumed'), list[host] ? 'warn' : 'ok');
        return { ok: true, blocked: !!list[host] };
      }
      case 'clear':
        st.store.clear();
        try {
          await api.storage.local.remove(TAB_PREFIX + tabId);
        } catch (_) {}
        await api.tabs.sendMessage(tabId, { type: 'clear-seen' }).catch(() => {});
        broadcast(tabId, 'clear');
        return { ok: true };
      case 'rescan':
        await api.tabs.sendMessage(tabId, { type: 'clear-seen' }).catch(() => {});
        return { ok: true };
      case 'open-options':
        if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
        else api.tabs.create({ url: api.runtime.getURL('options/options.html') });
        return { ok: true };
      case 'history':
        return { ok: true, history: historyQueue.slice(0, 80) };
      case 'get-state':
        return { ok: true, state: publicState(st), history: historyQueue.slice(0, 80) };
      case 'update-status':
        return { ok: true, update: updateState, dynamic: SR.dynamic ? { version: SR.dynamic.version, embedHosts: SR.dynamic.embedHosts.length, adHosts: SR.dynamic.adHosts.length, signed: SR.dynamic.signatureOk } : null, patch: Number(settings.patchVersion || 0) };
      case 'check-updates':
        return await checkForUpdates('manual');
      case 'search-subtitles-manual':
        return { ok: true, res: await SR.subs.search({ title: msg.title, year: msg.year || null, season: msg.season || null, episode: msg.episode || null }, settings, {}) };
      default:
        return { ok: false, reason: 'unknown action: ' + msg.name };
    }
  }

  function downloadName(it, st) {
    const base = (st.title && st.title.title) || String(it.fileName || it.name || 'stream').replace(/\.[a-z0-9]+$/i, '');
    const ext = it.category === 'hls' ? 'm3u8' : it.category === 'dash' ? 'mpd' : it.ext || 'mp4';
    const tag = it.quality ? '-' + it.quality.replace(/\s+/g, '') : '';
    const ep = st.title && st.title.episode ? '-S' + (st.title.season || '01') + 'E' + st.title.episode : '';
    return sanitize(base + ep + tag) + '.' + ext;
  }

  /** Filesystem-safe but still readable: "Dune: Part Two" → "Dune Part Two". */
  function sanitize(s) {
    return String(s || 'stream')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[ .]+|[ .]+$/g, '')
      .slice(0, 110);
  }

  function isBlockedHost(url) {
    if (!blockedHosts.length || !url) return false;
    const h = util.host(url);
    if (!h) return false;
    return blockedHosts.indexOf(h) >= 0 || blockedHosts.some((b) => h.endsWith('.' + b));
  }

  function applySettings() {
    blockedHosts = Object.keys(settings.blockedHosts || {}).filter((h) => settings.blockedHosts[h]);
    SR.i18n.set(settings.lang && settings.lang !== 'auto' ? settings.lang : 'en');
    for (const st of tabs.values()) {
      st.store.configure({ maxItems: settings.maxItems, blockPatterns: settings.blockPatterns, allowPatterns: settings.allowPatterns });
      broadcast(st.tabId, 'settings');
    }
  }

  /* ================================================================== *
   * message router
   * ================================================================== */
  function handlePageEvent(tabId, kind, p) {
    const st = getTab(tabId);
    if (!st || !p) return { ok: false };
    switch (kind) {
      case 'media':
        return { ok: !!ingest(tabId, p, 'page') };
      case 'mse':
        return { ok: !!ingest(tabId, { url: p.url, via: 'mse-src', size: p.bytes, bytes: p.bytes, mimes: p.mimes, duration: p.duration, recording: p.recording }, 'mse') };
      case 'drm':
        st.drm = p.keySystem;
        st.store.layers.mse = true;
        touch(tabId);
        return { ok: true };
      case 'player':
        if (p.name && st.players.indexOf(p.name) < 0) st.players.push(p.name);
        st.store.layers.heuristic = true;
        return { ok: true };
      case 'active-level':
        st.activeLevel = p;
        return { ok: true };
      case 'media-error':
        st.mediaError = p;
        return { ok: true };
      case 'record-done':
        toastTo(tabId, t('toast.recordSaved', { size: util.formatBytes(p.bytes) }), 'ok');
        return { ok: true };
      case 'record-error':
        toastTo(tabId, t('toast.recordEmpty') + (p.reason ? ': ' + p.reason : ''), 'warn');
        return { ok: true };
      case 'heuristic-hit':
      case 'scan-info':
      case 'perf-info':
        st.store.layers.heuristic = true;
        return { ok: true };
      case 'dom-info':
        st.store.layers.dom = true;
        return { ok: true };
      default:
        return { ok: false, reason: 'unhandled page event: ' + kind };
    }
  }

  if (api.runtime.onMessage && api.runtime.onMessage.addListener) {
    api.runtime.onMessage.addListener((msg, sender, respond) => {
      if (!msg || !msg.type) return;
      (async () => {
        const tabId = sender.tab && sender.tab.id != null ? sender.tab.id : (msg.tabId != null ? msg.tabId : (msg.payload && msg.payload.tabId != null ? msg.payload.tabId : undefined));
        const st = getTab(tabId);
        switch (msg.type) {
          case 'page-event':
            return handlePageEvent(tabId, msg.kind, msg.payload);
          case 'media':
            return { ok: !!ingest(tabId, msg.payload, 'page') };
          case 'media-batch': {
            let n = 0;
            for (const it of msg.items || []) if (ingest(tabId, Object.assign({}, it, { frame: msg.isTop ? 'top' : 'iframe' }), it.via || msg.reason)) n++;
            return { ok: true, ingested: n };
          }
          case 'title':
            if (!st) return { ok: false };
            st.title = msg.payload || null;
            if (msg.payload && msg.payload.url) st.url = msg.payload.url;
            touch(tabId);
            scheduleSubSearch(tabId, false);
            return { ok: true };
          case 'frame': {
            if (!st) return { ok: false };
            const p = msg.payload || {};
            const hooks = p.hooks || [];
            const rec = { url: msg.href || sender.url || '', top: !!p.isTop, version: p.version, hooks: hooks };
            if (!st.frames.some((f) => f.url === rec.url)) st.frames.push(rec);
            if (hooks.indexOf('fetch') >= 0) st.store.layers.network = true;
            if (hooks.indexOf('mse') >= 0) st.store.layers.mse = true;
            st.url = st.url || rec.url;
            touch(tabId);
            return { ok: true };
          }
          case 'frame-title':
            if (st && (!st.title || st.title.isJunk)) {
              st.title = Object.assign({ fromFrame: true }, msg.payload);
              touch(tabId);
            }
            return { ok: true };
          case 'sw':
            if (st) {
              st.sw = msg.payload;
              st.store.layers.sw = true;
            }
            return { ok: true };
          case 'health':
            if (st) st.health = msg.payload || { kind: msg.kind, detail: msg.detail };
            return { ok: true };
          case 'ui-ready': {
            if (!st) return { ok: false };
            st.contentReady = true;
            st.url = st.url || sender.url || '';
            await restore(tabId);
            // give the freshly injected frame the verified rule pack + patch
            const [pk, pt] = await Promise.all([storedPack(), storedPatch()]);
            if (pk || pt) api.tabs.sendMessage(tabId, { type: 'rules', payload: { pack: pk, patch: pt } }).catch(() => {});
            await broadcast(tabId, 'init');
            setTimeout(() => api.tabs.sendMessage(tabId, { type: 'state', payload: publicState(st), what: 'late' }).catch(() => {}), 2600);
            setTimeout(() => api.tabs.sendMessage(tabId, { type: 'get-title' }).catch(() => {}), 6500);
            return { ok: true, settings: settings, blocked: isBlockedHost(sender.url || '') };
          }
          case 'wake':
            return { ok: true };
          case 'action':
            // canonical: {type:'action', payload:{name,…}}; also accept the flat
            // shape so an old content script in a stale tab never breaks silently.
            return await handleAction(Object.assign({}, msg.payload || msg, { tabId: tabId }), sender);
          case 'get-party-payload': {
            const key = PARTY_PREFIX + tabId;
            const stored = await api.storage.local.get(key);
            const payload = stored[key];
            if (payload && Date.now() - (payload.createdAt || 0) < 6 * 60 * 1000) {
              await api.storage.local.remove(key);
              return { ok: true, payload: payload };
            }
            return { ok: false };
          }
          case 'party-status':
            toastTo(msg.tabId != null ? msg.tabId : tabId, msg.text, msg.kind || 'info');
            return { ok: true };
          default:
            return { ok: false, reason: 'unknown message: ' + msg.type };
        }
      })()
        .then((r) => {
          try {
            respond(r);
          } catch (_) {}
        })
        .catch((e) => {
          log('router error', String((e && e.stack) || e));
          try {
            respond({ ok: false, reason: String((e && e.message) || e) });
          } catch (_) {}
        });
      return true; // keep the channel open for the async reply
    });
  }

  /* ================================================================== *
   * browser wiring
   * ================================================================== */
  function togglePanel(tab) {
    if (!tab || tab.id == null) return;
    api.tabs.sendMessage(tab.id, { type: 'ui-command', cmd: 'toggle' }).catch(() => api.tabs.sendMessage(tab.id, { type: 'reload-ui' }).catch(() => {}));
  }

  function buildContextMenus() {
    if (!api.contextMenus || !api.contextMenus.create) return;
    try {
      api.contextMenus.removeAll(() => {
        api.contextMenus.create({ id: 'sr-root', title: 'Stream Radar', contexts: ['page', 'video', 'frame', 'link', 'selection'] });
        api.contextMenus.create({ id: 'sr-watchparty', parentId: 'sr-root', title: t('action.watchparty'), contexts: ['page', 'video', 'frame', 'link'] });
        api.contextMenus.create({ id: 'sr-copy', parentId: 'sr-root', title: t('action.copy'), contexts: ['video', 'link', 'image'] });
        api.contextMenus.create({ id: 'sr-download', parentId: 'sr-root', title: t('action.download'), contexts: ['video', 'link'] });
        api.contextMenus.create({ id: 'sr-subs', parentId: 'sr-root', title: t('action.subs'), contexts: ['page', 'video'] });
        api.contextMenus.create({ id: 'sr-ads', parentId: 'sr-root', title: 'Toggle ad / tracker noise', contexts: ['page'] });
        api.contextMenus.create({ id: 'sr-pause', parentId: 'sr-root', title: 'Pause detection on this site', contexts: ['page'] });
      });
    } catch (_) {}
  }

  async function currentTab() {
    const list = await api.tabs.query({ active: true, currentWindow: true });
    return (list && list[0]) || null;
  }

  async function boot() {
    settings = await SR.settings.load(true);
    applySettings();
    await loadRemote();
    if (Date.now() - Number(settings.lastUpdateCheck || 0) > Math.max(1, Number(settings.updateCheckHours || 12)) * 3600000) checkForUpdates('startup').catch(() => {});
    try {
      const h = await api.storage.local.get(HISTORY_KEY);
      if (Array.isArray(h[HISTORY_KEY])) historyQueue.push(...h[HISTORY_KEY]);
    } catch (_) {}

    if (api.runtime.onInstalled) {
      api.runtime.onInstalled.addListener((d) => {
        buildContextMenus();
        if (d && d.reason === 'install') api.tabs.create({ url: api.runtime.getURL('options/options.html?welcome=1'), active: true });
        checkForUpdates('install').catch(() => {});
      });
    }
    if (api.runtime.onStartup) api.runtime.onStartup.addListener(buildContextMenus);
    if (api.action && api.action.onClicked) api.action.onClicked.addListener(togglePanel);

    if (api.tabs.onRemoved) {
      api.tabs.onRemoved.addListener((id) => {
        tabs.delete(id);
        subTimers.delete(id);
        api.storage.local.remove(TAB_PREFIX + id);
      });
    }
    if (api.tabs.onUpdated) {
      api.tabs.onUpdated.addListener((id, change) => {
        const st = tabs.get(id);
        if (!st) return;
        if (change.status === 'loading' && change.url && util.host(change.url) !== util.host(st.url)) {
          st.store.clear();
          st.title = null;
        }
        if (change.url) st.url = change.url;
        if (change.status === 'complete') {
          setTimeout(() => api.tabs.sendMessage(id, { type: 'get-title' }).catch(() => {}), 1200);
          setTimeout(() => broadcast(id, 'complete'), 4200);
        }
      });
    }
    if (api.tabs.onActivated) {
      api.tabs.onActivated.addListener(({ tabId }) => restore(tabId).then((st) => st && broadcast(tabId, 'activate')));
    }

    if (api.commands && api.commands.onCommand) {
      api.commands.onCommand.addListener(async (cmd) => {
        const tab = await currentTab();
        if (!tab) return;
        if (cmd === 'toggle-panel') togglePanel(tab);
        else if (cmd === 'scan-now') {
          await api.tabs.sendMessage(tab.id, { type: 'clear-seen' }).catch(() => {});
          toastTo(tab.id, t('panel.refresh'), 'info');
        } else if (cmd === 'subtitle-now') {
          await restore(tab.id);
          scheduleSubSearch(tab.id, true);
        }
      });
    }

    if (api.contextMenus && api.contextMenus.onClicked) {
      api.contextMenus.onClicked.addListener(async (info, tab) => {
        if (!tab) return;
        const st = await restore(tab.id);
        if (!st) return;
        const url = info.srcUrl || info.linkUrl || '';
        if (info.menuItemId === 'sr-watchparty') {
          const best = st.store.best() || {};
          if (url) await api.storage.local.set({ [PARTY_PREFIX + (await api.tabs.create({ url: watchPartyCreateUrl(url) })).id]: { mediaUrl: url, roomName: (st.title && st.title.title) || 'Stream Radar room', autoJoin: true, createdAt: Date.now() } });
          else await launchWatchParty(st, best.id);
        } else if (info.menuItemId === 'sr-copy' && url) {
          api.tabs.sendMessage(tab.id, { type: 'copy-clipboard', text: url }).catch(() => {});
        } else if (info.menuItemId === 'sr-download' && url) {
          api.downloads.download({ url: url, filename: sanitize((st.title && st.title.title) || '') + '.' + (rules.extOf(url) || 'mp4'), saveAs: true }).catch(() => {});
        } else if (info.menuItemId === 'sr-subs') {
          scheduleSubSearch(tab.id, true);
        } else if (info.menuItemId === 'sr-ads') {
          settings = await SR.settings.save({ showAds: !settings.showAds });
          applySettings();
        } else if (info.menuItemId === 'sr-pause') {
          const host = util.host(tab.url || st.url || '');
          const list = Object.assign({}, settings.blockedHosts || {});
          list[host] = true;
          settings = await SR.settings.save({ blockedHosts: list });
          applySettings();
        }
      });
    }

    if (api.alarms && api.alarms.create) {
      api.alarms.create('srad:prune', { periodInMinutes: 30 });
      const every = Math.max(1, Number(settings.updateCheckHours || 12));
      api.alarms.create('srad:update', { periodInMinutes: every * 60, delayInMinutes: 2 });
      if (api.alarms.onAlarm) {
        api.alarms.onAlarm.addListener(async (a) => {
          if (a && a.name === 'srad:update') {
            await checkForUpdates('scheduled');
            return;
          }
          if (!a || a.name !== 'srad:prune') return;
          const now = Date.now();
          for (const [k, v] of REPORTED) if (now - v > 120000) REPORTED.delete(k);
          for (const [id, st] of tabs) if (!st.store.order.length && now - (st.lastNotify || 0) > 3600000) tabs.delete(id);
          try {
            const open = new Set((await api.tabs.query({})).map((x) => x.id));
            const all = await api.storage.local.get(null);
            for (const k of Object.keys(all)) {
              if (k.indexOf(TAB_PREFIX) !== 0 && k.indexOf(PARTY_PREFIX) !== 0) continue;
              const id = Number(k.split(':').pop());
              const rec = all[k] || {};
              const age = now - (rec.savedAt || rec.createdAt || 0);
              if (!open.has(id) || age > 3600000) api.storage.local.remove(k);
            }
          } catch (_) {}
          saveHistory();
        });
      }
    }

    if (api.storage.onChanged) {
      api.storage.onChanged.addListener((changes) => {
        const ch = changes['srad:settings'];
        if (!ch) return;
        settings = SR.settings.merge(ch.newValue || {});
        applySettings();
      });
    }
    buildContextMenus();
  }

  boot().catch((e) => console.warn('[StreamRadar] background boot failed', e));
})(typeof globalThis !== 'undefined' ? globalThis : self);
