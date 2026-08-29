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
            (GM_notification || GM.notification)({ title: 'Stream Radar, ' + label, text: (state.title && state.title.title ? state.title.title + ': ' : '') + (item.url || '').slice(0, 90) });
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
   * Local player overlay — same-page <video> so the browser sends this
   * page as Referer (the same trick IDM uses). HLS uses the site's own
   * Hls.js when present; otherwise native src (Safari / some Android).
   * ------------------------------------------------------------------ */
  function playLocal(item) {
    const url = item && item.url;
    if (!url) return toast(t('player.noUrl'), 'warn');
    if (item.category === 'blob') return toast(t('player.blob'), 'warn');
    if (item.drm) return toast(t('player.drm'), 'warn');
    const prev = doc.getElementById('srad-player-overlay');
    if (prev) prev.remove();
    const wrap = doc.createElement('div');
    wrap.id = 'srad-player-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', t('player.title'));
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#07080d;color:#e9edf7;font:14px/1.4 system-ui,sans-serif';
    const title = (state.title && state.title.title) || item.name || t('player.title');
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#10131c">' +
      '<b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      esc(title) +
      '</b><button type="button" data-srad-close="1" style="min-height:40px;padding:0 14px;border:0;border-radius:10px;background:#6d5efc;color:#fff;font-weight:700;cursor:pointer">' +
      esc(t('common.close')) +
      '</button></div>';
    const video = doc.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.style.cssText = 'flex:1 1 auto;width:100%;height:auto;min-height:0;background:#000;object-fit:contain';
    wrap.appendChild(video);
    if (pendingSub && pendingSub.vtt) {
      try {
        const track = doc.createElement('track');
        track.kind = 'subtitles';
        track.srclang = 'id';
        track.label = 'Indonesian';
        track.default = true;
        track.src = URL.createObjectURL(new Blob([pendingSub.vtt], { type: 'text/vtt' }));
        video.appendChild(track);
      } catch (_) {}
    }
    function close() {
      try {
        video.pause();
      } catch (_) {}
      wrap.remove();
    }
    wrap.addEventListener('click', (e) => {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-srad-close')) close();
    });
    doc.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') {
        close();
        doc.removeEventListener('keydown', onEsc);
      }
    });
    (doc.body || doc.documentElement).appendChild(wrap);
    const Hls = W.Hls || root.Hls;
    const wantHls = item.category === 'hls' || /\.m3u8(\?|#|$)/i.test(url);
    if (wantHls && Hls && Hls.isSupported && Hls.isSupported()) {
      try {
        const hls = new Hls({ enableWorker: false });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_ev, data) => {
          if (data && data.fatal) toast(t('player.error', { msg: String(data.details || 'hls') }), 'err');
        });
      } catch (e) {
        toast(t('player.error', { msg: String((e && e.message) || e) }), 'err');
      }
    } else {
      video.src = url;
      video.play().catch(() => {});
      video.addEventListener('error', () => {
        toast(t('player.error', { msg: wantHls ? 'HLS' : 'media' }), 'err');
      });
    }
    toast(t('toast.player'), 'ok');
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
      <p style="opacity:.7;margin-top:22px">Toggles available from the panel: auto-detect (master), layers, subtitles, notifications. Use the gear icon on the floating panel.</p>
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
