/**
 * Stream Radar cinema player.
 *
 * WatchParty fetches the media URL from watchparty.me, so CDNs that check
 * Referer/Origin (the ones IDM still grabs from this browser) refuse to play.
 * This page is an extension origin with <all_urls> host access: it can fetch
 * the same file IDM sees. Playlists and segments go through the background
 * worker with the original page Referer attached.
 */
(function () {
  'use strict';
  const SR = globalThis.SR || {};
  const api = SR.util && SR.util.api ? SR.util.api() : globalThis.chrome || globalThis.browser;
  const t = (k, v) => (SR.i18n ? SR.i18n.t(k, v) : k);
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const sid = params.get('sid') || '';

  const video = $('video');
  const overlay = $('overlay');
  const statusEl = $('status');
  const titleEl = $('title');
  const subEl = $('sub');
  const hintEl = $('hint');
  const qualitySel = $('quality');
  const qualityWrap = $('qualityWrap');
  const subsBtn = $('subsBtn');
  const fsBtn = $('fsBtn');

  let session = null;
  let hls = null;

  function send(msg) {
    if (!api || !api.runtime || !api.runtime.sendMessage) return Promise.reject(new Error('no extension runtime'));
    return api.runtime.sendMessage(msg);
  }

  function setOverlay(show, text, kind) {
    overlay.setAttribute('data-show', show ? '1' : '0');
    overlay.setAttribute('data-kind', kind || 'info');
    if (text) statusEl.textContent = text;
  }

  function applyTheme(pref) {
    let theme = pref || 'dark';
    if (theme === 'system') {
      try {
        theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } catch (_) {
        theme = 'dark';
      }
    }
    document.body.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  }

  function applyLang(pref) {
    if (!SR.i18n) return;
    const lang = pref === 'en' || pref === 'id' ? pref : SR.i18n.detect(navigator);
    SR.i18n.set(lang);
    document.documentElement.lang = lang;
    document.title = t('player.title');
    $('qualityLab').textContent = t('player.quality');
    fsBtn.textContent = t('player.fullscreen');
    hintEl.textContent = t('player.hint');
  }

  function mediaHeaders() {
    return { Referer: session.referer || session.pageUrl || '', Origin: session.origin || '' };
  }

  /* ---------------- HLS loader: background fetch with page Referer ---------------- */
  function ExtLoader(config) {
    this.config = config || {};
    this.stats = { aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0, loading: { start: 0, first: 0, end: 0 } };
    this._abort = null;
  }
  ExtLoader.prototype.load = function (context, config, callbacks) {
    const self = this;
    self.context = context;
    self.callbacks = callbacks;
    self.stats.loading.start = Date.now();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    self._abort = ctrl;
    const range = context.rangeStart != null && context.rangeEnd != null ? { start: context.rangeStart, end: context.rangeEnd } : null;
    send({
      type: 'player-fetch',
      sid: sid,
      url: context.url,
      responseType: context.responseType || 'arraybuffer',
      range: range,
    })
      .then((res) => {
        if (self.stats.aborted) return;
        if (!res || !res.ok) {
          const err = { code: (res && res.status) || 0, text: (res && res.reason) || 'fetch failed' };
          callbacks.onError(err, context, null);
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
  ExtLoader.prototype.abort = function () {
    this.stats.aborted = true;
    try {
      this._abort && this._abort.abort();
    } catch (_) {}
  };
  ExtLoader.prototype.destroy = function () {
    this.abort();
    this.callbacks = null;
    this.context = null;
  };

  function engineFor(category, url) {
    const cat = String(category || '').toLowerCase();
    if (cat === 'hls' || /\.m3u8(\?|#|$)/i.test(url || '')) return 'hls';
    if (cat === 'dash' || /\.mpd(\?|#|$)/i.test(url || '')) return 'dash';
    return 'native';
  }

  function attachSubtitle(vtt, name) {
    if (!vtt || !video) return;
    try {
      const old = video.querySelectorAll('track[data-srad="1"]');
      old.forEach((el) => el.remove());
      const blob = new Blob([vtt], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = name || 'Indonesian';
      track.srclang = 'id';
      track.default = true;
      track.setAttribute('data-srad', '1');
      track.src = url;
      video.appendChild(track);
      subsBtn.hidden = false;
      subsBtn.setAttribute('data-on', '1');
      subsBtn.textContent = t('player.subsOn');
      setTimeout(() => {
        try {
          const tt = video.textTracks;
          for (let i = 0; i < tt.length; i++) if (tt[i].label === track.label) tt[i].mode = 'showing';
        } catch (_) {}
      }, 80);
    } catch (_) {}
  }

  function fillQuality(levels, current) {
    if (!levels || !levels.length) {
      qualityWrap.hidden = true;
      return;
    }
    qualityWrap.hidden = false;
    qualitySel.innerHTML = '<option value="-1">' + t('player.qualityAuto') + '</option>' +
      levels
        .map((lv, i) => {
          const label = lv.height ? lv.height + 'p' : lv.quality || ('#' + (i + 1));
          return '<option value="' + i + '"' + (i === current ? ' selected' : '') + '>' + label + '</option>';
        })
        .join('');
  }

  function destroyHls() {
    if (!hls) return;
    try {
      hls.destroy();
    } catch (_) {}
    hls = null;
  }

  function playHls(url) {
    const Hls = globalThis.Hls;
    if (!Hls || !Hls.isSupported()) {
      video.src = url;
      return;
    }
    destroyHls();
    hls = new Hls({
      enableWorker: false,
      lowLatencyMode: false,
      xhrSetup: null,
      loader: ExtLoader,
      maxBufferLength: 30,
      capLevelToPlayerSize: true,
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const levels = (hls.levels || []).map((lv) => ({ height: lv.height, quality: lv.height ? lv.height + 'p' : '' }));
      fillQuality(levels, hls.currentLevel);
      setOverlay(false);
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_ev, data) => {
      if (!data) return;
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          try {
            hls.startLoad();
            return;
          } catch (_) {}
        }
        setOverlay(true, t('player.error', { msg: (data.details || data.type || 'hls') + (data.response && data.response.code ? ' HTTP ' + data.response.code : '') }), 'err');
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  }

  function playNative(url) {
    destroyHls();
    video.src = url;
    const onReady = () => {
      setOverlay(false);
      video.play().catch(() => {});
    };
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener(
      'error',
      async () => {
        const err = video.error;
        const code = err ? err.code : 0;
        // Direct <video src> often 403s because the Referer is chrome-extension://.
        // Fetch the file through the worker (host access + page Referer) and play the blob.
        if (code === 2 || code === 4 || code === 1) {
          setOverlay(true, t('player.loading'), 'info');
          try {
            const res = await send({ type: 'player-fetch', sid: sid, url: url, responseType: 'arraybuffer' });
            if (!res || !res.ok || !res.data) throw new Error((res && res.reason) || 'HTTP ' + ((res && res.status) || '?'));
            const mime = res.mime && /^video\//i.test(res.mime) ? res.mime : 'video/mp4';
            const blob = new Blob([res.data], { type: mime });
            video.src = URL.createObjectURL(blob);
            video.play().catch(() => {});
            setOverlay(false);
            return;
          } catch (e) {
            setOverlay(true, t('player.error', { msg: String((e && e.message) || e) }), 'err');
            return;
          }
        }
        setOverlay(true, t('player.error', { msg: 'media error ' + code }), 'err');
      },
      { once: true }
    );
  }

  async function start(sess) {
    session = sess;
    applyLang(sess.lang);
    applyTheme(sess.theme);
    const name = (sess.title && sess.title.title) || sess.name || t('player.title');
    titleEl.textContent = name + (sess.title && sess.title.year ? ' (' + sess.title.year + ')' : '');
    const bits = [sess.category ? String(sess.category).toUpperCase() : '', sess.quality || '', sess.host || ''].filter(Boolean);
    subEl.textContent = bits.join(' - ');
    document.title = name + ' - ' + t('player.title');
    hintEl.textContent = t('player.hint');

    if (sess.drm) {
      setOverlay(true, t('player.drm'), 'err');
      return;
    }
    if (!sess.url) {
      setOverlay(true, t('player.noUrl'), 'err');
      return;
    }
    if (sess.category === 'blob') {
      setOverlay(true, t('player.blob'), 'err');
      return;
    }

    if (sess.subtitle && sess.subtitle.vtt) attachSubtitle(sess.subtitle.vtt, sess.subtitle.name);

    const engine = engineFor(sess.category, sess.url);
    if (engine === 'hls') playHls(sess.url);
    else if (engine === 'dash') {
      setOverlay(true, t('player.dashHint'), 'err');
      playNative(sess.url);
    } else playNative(sess.url);
  }

  qualitySel.addEventListener('change', () => {
    if (!hls) return;
    const n = Number(qualitySel.value);
    hls.currentLevel = n;
  });
  subsBtn.addEventListener('click', () => {
    const on = subsBtn.getAttribute('data-on') !== '1';
    subsBtn.setAttribute('data-on', on ? '1' : '0');
    subsBtn.textContent = on ? t('player.subsOn') : t('player.subsOff');
    try {
      const tt = video.textTracks;
      for (let i = 0; i < tt.length; i++) tt[i].mode = on ? 'showing' : 'hidden';
    } catch (_) {}
  });
  fsBtn.addEventListener('click', () => {
    const el = document.documentElement;
    if (!document.fullscreenElement) el.requestFullscreen && el.requestFullscreen();
    else document.exitFullscreen && document.exitFullscreen();
  });
  video.addEventListener('playing', () => setOverlay(false));
  video.addEventListener('waiting', () => setOverlay(true, t('player.loading'), 'info'));
  video.addEventListener('canplay', () => setOverlay(false));

  async function boot() {
    applyLang('auto');
    applyTheme('dark');
    setOverlay(true, t('player.loading'), 'info');
    if (!sid) {
      setOverlay(true, t('player.noUrl'), 'err');
      return;
    }
    try {
      const got = await send({ type: 'get-play-session', sid: sid });
      if (!got || !got.ok || !got.session) {
        setOverlay(true, t('player.noUrl'), 'err');
        return;
      }
      await send({ type: 'player-bind', sid: sid });
      await start(got.session);
    } catch (e) {
      setOverlay(true, t('player.error', { msg: String((e && e.message) || e) }), 'err');
    }
  }

  // Exported for unit tests (jsdom) without a live chrome runtime.
  globalThis.SRPlayer = {
    engineFor,
    ExtLoader,
    start,
    mediaHeaders,
    sid,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
