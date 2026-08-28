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
