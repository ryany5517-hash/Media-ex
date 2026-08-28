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
