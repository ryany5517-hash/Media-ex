/**
 * Stream Radar — content script (ISOLATED world)
 * ==================================================================
 * The bridge between three worlds and the glue for the UI:
 *
 *   page (MAIN world, src/page/inject.js)
 *        │  window.postMessage({srad:1,…})           LAYER 1 / 3 / 5
 *        ▼
 *   content script (this file)                        LAYER 2 / 4 + title
 *        │  chrome.runtime.sendMessage               ── watchparty, subs, UI
 *        ▼
 *   background worker (owns all state)
 *        │
 *        └─► {type:'state'} → this file → SR.ui.render()
 *
 * It also guarantees the MAIN-world hooks are alive: it waits for their
 * `hello`, and if the browser ignored `world:"MAIN"` it re-injects the page
 * script through a <script> tag (web_accessible_resources) as a fallback.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;
  const api = util.api();
  const doc = root.document;
  const t = (k, v) => SR.i18n.t(k, v);

  if (root.__streamRadarContent) return;
  root.__streamRadarContent = { version: SR.VERSION };

  const isTop = safeIsTop();
  let settings = Object.assign({}, SR.defaults);
  let ui = null;
  let scanner = null;
  let pageAlive = false;
  let state = { items: [], ads: [], title: null, settings: settings, layers: {}, sub: { status: 'idle' } };
  let pendingAttach = null;

  /* ------------------------------------------------------------------ *
   * transport: content ⇄ background
   * ------------------------------------------------------------------ */
  function send(type, payload) {
    try {
      if (!api || !api.runtime || !api.runtime.sendMessage) return Promise.resolve(null);
      return api.runtime
        .sendMessage(Object.assign({ type: type, href: root.location.href, isTop: isTop, url: root.location.href }, payload || {}))
        .catch(() => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function safeIsTop() {
    try {
      return root.top === root;
    } catch (_) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * MAIN world hooks: handshake + fallback injection
   * ------------------------------------------------------------------ */
  function publicConfig() {
    return {
      recordMse: !!settings.recordMse,
      recordCapMB: settings.recordCapMB || 256,
      scanScripts: settings.scanScripts !== false,
      playerProbe: settings.playerProbe !== false,
      maxReports: settings.maxItems || 80,
    };
  }

  function postCmd(cmd, payload) {
    try {
      root.postMessage(Object.assign({ srad: 1, to: 'page', cmd: cmd, payload: payload }), '*');
    } catch (_) {}
  }

  function ensurePageHooks() {
    root.addEventListener('message', onPageMessage);
    postCmd('ping');
    setTimeout(() => {
      if (pageAlive) return;
      injectViaTag();
      postCmd('ping');
    }, 350);
    setTimeout(() => postCmd('config', publicConfig()), 1200);
  }

  function injectViaTag() {
    try {
      if (!doc || !doc.documentElement || !api || !api.runtime || !api.runtime.getURL) return;
      if (doc.getElementById('srad-page-hooks') || root.__streamRadarPage) return;
      const files = ['shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'page/inject.js'];
      const frag = doc.createDocumentFragment();
      files.forEach((f, i) => {
        const s = doc.createElement('script');
        s.src = api.runtime.getURL(f);
        s.async = false;
        s.charset = 'utf-8';
        if (i === files.length - 1) s.id = 'srad-page-hooks';
        s.addEventListener('error', () => send('health', { kind: 'page-script-blocked', detail: f }));
        frag.appendChild(s);
      });
      (doc.head || doc.documentElement).appendChild(frag);
      send('health', { kind: 'tag-injection-attempted' });
    } catch (_) {}
  }

  function onPageMessage(ev) {
    const d = ev.data;
    if (!d || d.srad !== 1 || ev.source !== root) return;
    if (d.kind === 'hello') {
      pageAlive = true;
      postCmd('config', publicConfig());
      send('frame', { payload: { href: root.location.href, isTop: d.isTop, version: d.version, hooks: d.payload && d.payload.hooks } });
      return;
    }
    if (d.kind === 'media' && d.payload && d.payload.manifestBody) {
      // manifests are forwarded verbatim: the worker parses them once, offline
      send('page-event', { kind: 'media', payload: d.payload });
      return;
    }
    switch (d.kind) {
      case 'media':
      case 'mse':
      case 'drm':
      case 'player':
      case 'active-level':
      case 'heuristic-hit':
      case 'dom-info':
      case 'perf-info':
      case 'scan-info':
      case 'media-error':
      case 'record-done':
      case 'record-error':
      case 'record-state':
        send('page-event', { kind: d.kind, payload: d.payload });
        if (d.kind === 'record-done') toast(t('toast.recordSaved', { size: util.formatBytes((d.payload || {}).bytes) }), 'ok');
        if (d.kind === 'record-error') toast(t('toast.recordEmpty'), 'warn');
        return;
    }
  }

  /* ------------------------------------------------------------------ *
   * LAYER 2 + 4 + title, through the shared scanner
   * ------------------------------------------------------------------ */
  function startScanner() {
    scanner = SR.domScan.create({
      win: root,
      doc: doc,
      isTop: isTop,
      enabled: () => settings.layerDom !== false,
      swEnabled: () => settings.layerSw !== false,
      emit: (entries, reason) => send('media-batch', { items: entries, reason: reason }),
      onSw: (info) => send('sw', { payload: info }),
      onTitle: (info) => {
        state.title = info;
        send('title', { payload: info });
        render();
      },
    });
    scanner.start();
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  function ensureUi() {
    if (ui || !isTop || !SR.ui) return ui;
    try {
      ui = SR.ui.create({
        getSettings: () => settings,
        beforeOpen: () => send('ui-open', {}),
        onAction: onAction,
        isTopFrame: isTop,
      });
      ui.mount();
      ui.render(state);
      if (pendingAttach) {
        attachSubtitle(pendingAttach.vtt, pendingAttach.name);
        pendingAttach = null;
      }
    } catch (e) {
      console.debug('[StreamRadar] UI failed to mount', e);
    }
    return ui;
  }

  function render() {
    if (ui) ui.render(state);
  }

  function toast(text, kind, action) {
    ensureUi();
    if (ui) ui.toast(text, kind || 'info', action);
    else notifyBrowser(text);
  }

  function notifyBrowser(text) {
    try {
      if (api.notifications && api.notifications.create) api.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'Stream Radar', message: text });
    } catch (_) {}
  }

  function findItem(id) {
    const all = (state.items || []).concat(state.ads || []);
    return all.find((x) => x.id === id) || {};
  }

  function onAction(action, payload) {
    payload = payload || {};
    switch (action) {
      case 'copy':
        return copyText(findItem(payload.id).url || '').then((ok) => {
          if (payload.button) {
            payload.button.setAttribute('data-done', '1');
            setTimeout(() => payload.button.removeAttribute('data-done'), 1100);
          }
          toast(ok ? t('toast.copied') : t('toast.error', { msg: 'clipboard blocked' }), ok ? 'ok' : 'err');
        });
      case 'ffmpeg': {
        const it = findItem(payload.id);
        const cmd = buildFfmpeg(it);
        return copyText(cmd).then(() => toast(cmd ? 'ffmpeg · ' + (it.name || 'stream') + ' → clipboard' : t('toast.error', { msg: 'no stream' }), 'ok'));
      }
      case 'variant': {
        const it = findItem(payload.id);
        const v = (it.variants || [])[payload.index];
        return v && v.uri ? copyText(v.uri).then(() => toast(t('toast.copied'), 'ok')) : undefined;
      }
      case 'record': {
        const on = payload.recording !== true;
        postCmd(on ? 'record-start' : 'record-stop');
        toast(on ? t('toast.recording') : t('toast.recordSaved', { size: '' }), 'info');
        return;
      }
      case 'scan-now':
        postCmd('scan');
        scanner && scanner.scan('manual');
        scanner && scanner.readTitle(true);
        return void send('action', { name: 'rescan' });
      case 'set-setting': {
        settings = Object.assign({}, settings, { [payload.key]: payload.value });
        if (payload.key === 'fabPos') ui && ui.setFabPos(payload.value);
        if (payload.key === 'theme' || payload.key === 'lang') {
          applyLang();
          ui && ui.applyTheme();
        }
        postCmd('config', publicConfig());
        render();
        return void send('action', { name: 'set-setting', key: payload.key, value: payload.value });
      }
      default:
        return void send('action', { name: action, id: payload.id, index: payload.index });
    }
  }

  function buildFfmpeg(it) {
    if (!it || !it.url) return '';
    const out = ((state.title && state.title.title) || it.name || 'stream').replace(/[\\/:*?"<>|]/g, '.') + (it.category === 'hls' || it.category === 'dash' ? '.mp4' : '.' + (it.ext || 'mp4'));
    const hdr = '-user_agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0" -headers "Referer: ' + root.location.origin + '/"';
    const tail = it.category === 'hls' || it.category === 'dash' ? '-c copy -bsf:a aac_adtstoasc -movflags +faststart' : '-c copy';
    return ['ffmpeg -hide_banner', hdr, '-i "' + it.url + '"', tail, '"' + out + '"'].join(' ');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        (doc.body || doc.documentElement).appendChild(ta);
        ta.select();
        const ok = doc.execCommand('copy');
        ta.remove();
        return ok;
      } catch (_2) {
        return false;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * subtitle application on the current page
   * ------------------------------------------------------------------ */
  function attachSubtitle(vttText, name) {
    if (!doc || !vttText) return 0;
    let url = '';
    try {
      url = root.URL.createObjectURL(new Blob([vttText], { type: 'text/vtt' }));
    } catch (_) {
      return 0;
    }
    const apply = () => {
      let n = 0;
      for (const video of doc.querySelectorAll('video')) {
        try {
          if (video.querySelector('track[data-srad="1"]')) continue;
          const track = doc.createElement('track');
          track.kind = 'subtitles';
          track.label = (name || 'Indonesian') + ' · Stream Radar';
          track.srclang = 'id';
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
      return n;
    };
    let n = apply();
    if (n) return n;
    let tries = 0;
    const iv = setInterval(() => {
      if (apply() || ++tries > 16) clearInterval(iv);
    }, 1000);
    return 'queued';
  }

  /* ------------------------------------------------------------------ *
   * background → content
   * ------------------------------------------------------------------ */
  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg, sender, respond) => {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'state':
          state = Object.assign({}, state, msg.payload || {});
          settings = state.settings || settings;
          applyLang();
          if (isTop) {
            ensureUi();
            render();
          }
          return void respond({ ok: true });
        case 'settings':
          settings = Object.assign({}, settings, msg.payload || {});
          state.settings = settings;
          applyLang();
          render();
          postCmd('config', publicConfig());
          return;
        case 'toast':
          toast(msg.text, msg.kind, msg.action);
          return;
        case 'attach-subtitle': {
          const r = attachSubtitle(msg.vtt, msg.name);
          respond({ ok: true, applied: !!r });
          return true;
        }
        case 'get-title':
          scanner && scanner.readTitle(true);
          respond({ info: state.title || null, href: root.location.href });
          return true;
        case 'ui-command':
          if (msg.cmd === 'toggle') {
            ensureUi();
            ui && ui.toggle();
          }
          return;
        case 'reload-ui':
          if (ui) ui.destroy();
          ui = null;
          ensureUi();
          send('ui-ready', { isTop: isTop, relink: true });
          return;
        case 'copy-clipboard':
          copyText(String(msg.text || '')).then((ok) => toast(ok ? t('toast.copied') : t('toast.error', { msg: 'clipboard' }), ok ? 'ok' : 'err'));
          return;
        case 'clear-seen':
          scanner && scanner.reset();
          scanner && scanner.scan('clear');
          return;
        case 'ping':
          respond({ ok: true, pageAlive: pageAlive, isTop: isTop, version: SR.VERSION, hooks: pageAlive ? 'MAIN' : 'fallback' });
          return true;
      }
    });
  }

  function applyLang() {
    SR.i18n.set(settings.lang && settings.lang !== 'auto' ? settings.lang : SR.i18n.detect(root.navigator));
  }

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */
  async function boot() {
    try {
      settings = await SR.settings.load();
      state.settings = settings;
    } catch (_) {}
    applyLang();
    ensurePageHooks();
    startScanner();
    if (isTop) ensureUi();
    send('ui-ready', { isTop: isTop, title: doc && doc.title, watchparty: /watchparty\.me$/i.test(root.location.hostname) });
    // late SPA hydration re-checks
    setTimeout(() => scanner && scanner.readTitle(true), 4000);
  }

  boot().catch(() => {});
})(typeof window !== 'undefined' ? window : globalThis);
