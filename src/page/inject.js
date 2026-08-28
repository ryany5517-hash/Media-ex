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
