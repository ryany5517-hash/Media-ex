/**
 * Stream Radar — WatchParty.me adapter (content script, watchparty.me only)
 * ------------------------------------------------------------------
 * Thin glue around src/shared/watchparty-auto.js:
 *   • asks the background worker for the hand-off payload
 *     (media url + room name + converted subtitle text)
 *   • runs the automation
 *   • reports what happened back so the source tab can show a toast
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;
  const api = util.api();
  const doc = root.document;

  if (root.__streamRadarWatchParty) return;
  root.__streamRadarWatchParty = 1;

  let runner = null;

  async function getPayload() {
    try {
      const res = await api.runtime.sendMessage({ type: 'get-party-payload' });
      if (res && res.ok && res.payload) return res.payload;
    } catch (_) {}
    // Hand-opened tab? /create?video= auto-creates the room. There is no /watchNow.
    try {
      const q = new URLSearchParams(root.location.search);
      const url = q.get('video') || q.get('url');
      if (url) return { mediaUrl: url, roomName: q.get('name') || '', autoJoin: true, subtitle: null };
    } catch (_) {}
    return null;
  }

  function status(text, kind) {
    try {
      api.runtime.sendMessage({ type: 'party-status', text: text, kind: kind || 'info' }).catch(() => {});
    } catch (_) {}
  }

  function PartyLoader(config) {
    this.config = config || {};
    this.stats = { aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0, loading: { start: 0, first: 0, end: 0 } };
    this._abort = null;
  }
  PartyLoader.prototype.load = function (context, config, callbacks) {
    const self = this;
    self.context = context;
    self.callbacks = callbacks;
    self.stats.loading.start = Date.now();
    api.runtime
      .sendMessage({
        type: 'party-fetch',
        url: context.url,
        responseType: context.responseType || 'arraybuffer',
        range: context.rangeStart != null && context.rangeEnd != null ? { start: context.rangeStart, end: context.rangeEnd } : null,
      })
      .then((res) => {
        if (self.stats.aborted) return;
        if (!res || !res.ok) {
          callbacks.onError({ code: (res && res.status) || 0, text: (res && res.reason) || 'fetch failed' }, context, null);
          return;
        }
        let data = res.data;
        if (context.responseType !== 'arraybuffer' && typeof data !== 'string') {
          try {
            data = new TextDecoder().decode(data);
          } catch (_) {
            data = String(data || '');
          }
        }
        if (context.responseType === 'arraybuffer' && !(data instanceof ArrayBuffer) && data && data.buffer) {
          data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
        const len = data && data.byteLength != null ? data.byteLength : String(data || '').length;
        self.stats.loading.first = self.stats.loading.first || Date.now();
        self.stats.loading.end = Date.now();
        self.stats.loaded = len;
        self.stats.total = len;
        callbacks.onSuccess({ url: context.url, data: data }, self.stats, context, null);
      })
      .catch((e) => {
        if (self.stats.aborted) return;
        callbacks.onError({ code: 0, text: String((e && e.message) || e) }, context, null);
      });
  };
  PartyLoader.prototype.abort = function () {
    this.stats.aborted = true;
  };
  PartyLoader.prototype.destroy = function () {
    this.abort();
    this.callbacks = null;
    this.context = null;
  };

  function stopPageHls() {
    try {
      root.postMessage({ srad: 1, to: 'page', cmd: 'wp-hls-stop' }, '*');
    } catch (_) {}
  }

  function attachPartyHls(video, url) {
    const H = root.Hls;
    if (!H || !H.isSupported || !H.isSupported() || !video || !url) return false;
    stopPageHls();
    try {
      if (root.__sradWpHls) root.__sradWpHls.destroy();
    } catch (_) {}
    const hls = new H({ enableWorker: false, loader: PartyLoader, maxBufferLength: 60, capLevelToPlayerSize: true });
    root.__sradWpHls = hls;
    const clean = String(url).replace(/#playlist\.m3u8$/i, '');
    hls.loadSource(clean);
    hls.attachMedia(video);
    const ev = H.Events && H.Events.MANIFEST_PARSED ? H.Events.MANIFEST_PARSED : 'hlsManifestParsed';
    hls.on(ev, function () {
      try {
        const levels = hls.levels || [];
        let best = -1;
        let bestS = -1;
        for (let i = 0; i < levels.length; i++) {
          const lv = levels[i];
          const c = String((lv.attrs && lv.attrs.CODECS) || lv.videoCodec || lv.audioCodec || '').toLowerCase();
          if (/hvc1|hev1|hevc|dvh1|av01/.test(c)) continue;
          const h = Number(lv.height || 0);
          if (h > 1080) continue;
          const s = (/mp4a|aac/.test(c) ? 800 : 0) + Math.min(h || 1, 1080);
          if (s > bestS) {
            bestS = s;
            best = i;
          }
        }
        if (best >= 0) hls.currentLevel = best;
      } catch (_) {}
      try {
        video.muted = false;
        if (!video.volume) video.volume = 1;
        video.play();
      } catch (_) {}
    });
    return true;
  }

  function startPartyHls(payload) {
    const url = payload && payload.mediaUrl;
    if (!url) return;
    const cat = payload.category || '';
    const hlsish = cat === 'hls' || /\.m3u8/i.test(url) || /\/api\?d=/i.test(url) || /\/mpd\//i.test(url);
    if (!hlsish) return;
    let lastT = -1;
    let stuck = 0;
    let ticks = 0;
    let attached = false;
    const iv = setInterval(() => {
      if (attached) {
        clearInterval(iv);
        return;
      }
      ticks++;
      const video = doc.querySelector('video');
      if (!video) return;
      const t = Number(video.currentTime) || 0;
      const waiting = video.paused || video.readyState < 3;
      if (t > 0.15 && Math.abs(t - lastT) < 0.2 && waiting) stuck++;
      else stuck = 0;
      lastT = t;
      // First HLS segment is often ~4s; if it freezes there, take over with extension fetch.
      if (stuck >= 2 || (t >= 3 && t < 9 && waiting && stuck >= 1) || (t < 0.2 && ticks >= 8)) {
        attached = attachPartyHls(video, url);
      }
    }, 1000);
  }

  async function boot() {
    if (!SR.watchparty) return;
    const payload = await getPayload();
    if (!payload) return;
    const settings = (await SR.settings.load()) || {};
    payload.autoJoin = settings.watchpartyAutoJoin !== false;
    const path = String(root.location.pathname || '');
    if (payload.mediaUrl && !/^\/watch\//i.test(path) && !/^\/r\//i.test(path) && !/^\/create/i.test(path)) {
      try {
        const res = await fetch('/createRoom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ video: String(payload.mediaUrl).slice(0, 20000) }),
        });
        const data = await res.json();
        if (data && data.name) {
          root.location.assign('/watch' + data.name);
          return;
        }
      } catch (_) {}
    }
    runner = SR.watchparty.run({
      doc: doc,
      payload: payload,
      onStatus: status,
      t: (k, v) => SR.i18n.t(k, v),
    });
    startPartyHls(payload);
    if (payload.subtitle) status('Subtitle ' + (payload.subtitle.name || 'id') + ' ready. Use Attach subtitle in the room.', 'ok');
  }

  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg, sender, respond) => {
      if (msg && msg.type === 'attach-subtitle' && runner) {
        const n = runner.attach(msg.vtt, msg.name);
        respond({ ok: true, applied: n });
        return true;
      }
    });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
