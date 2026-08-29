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
    if (!category && util.isHlsProxy && util.isHlsProxy(clean)) category = 'hls';
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
