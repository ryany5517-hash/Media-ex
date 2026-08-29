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
/* ---8<--- prelude:start */
try {
  importScripts('shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'shared/subtitles.js', 'shared/i18n.js', 'shared/store.js', 'shared/updater.js');
} catch (_) {
  /* prelude already inlined by tools/build.mjs */
}
/* ---8<--- prelude:end */

(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;
  const rules = SR.rules;
  const api = util.api();
  const TAB_PREFIX = 'srad:tab:';
  const PARTY_PREFIX = 'srad:party:';
  const PLAY_PREFIX = 'srad:play:';
  const HISTORY_KEY = 'srad:history';
  const playTabs = new Map();
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
        const flags = item.flags || {};
        const headers = {};
        if (flags.requestReferer) headers.Referer = flags.requestReferer;
        else if (flags.initiator) headers.Referer = asReferer(flags.initiator) || flags.initiator;
        if (flags.requestOrigin) headers.Origin = flags.requestOrigin;
        const text = await util.fetchText(item.url, { timeoutMs: 9000, maxBytes: 700000, headers: headers, credentials: 'include' });
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
  /** Last Referer/Origin the page actually sent for a URL (what IDM copies). */
  const REQUEST_HDRS = new Map();

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
        const wrapHdr = util.parsePlayHeaders(url);
        for (const n of rules.unwrapUrl(url)) {
          if (n === url || recentlyReported(util.dedupKey(n, ''))) continue;
          ingest(
            tabId,
            {
              url: n,
              via: 'network',
              mime: mime,
              size: len,
              public: {
                unwrappedFrom: url,
                requestReferer: wrapHdr.referer || '',
                requestOrigin: wrapHdr.origin || '',
              },
            },
            'network'
          );
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
            initiator: details.initiator || details.originUrl || '',
            documentUrl: details.documentUrl || details.originUrl || '',
            originUrl: details.originUrl || details.initiator || '',
            requestReferer: (REQUEST_HDRS.get(url) || {}).referer || (util.parsePlayHeaders(url) || {}).referer || '',
            requestOrigin: (REQUEST_HDRS.get(url) || {}).origin || (util.parsePlayHeaders(url) || {}).origin || '',
            frameId: details.frameId,
          },
        },
        'network'
      );
    } catch (e) {
      log('webRequest error', String((e && e.stack) || e));
    }
  }

  function rememberRequestHeaders(details) {
    try {
      if (!settings.enabled || !settings.layerNetwork) return;
      const tabId = details.tabId;
      if (tabId == null || tabId < 0) return;
      const url = details.url;
      if (!url) return;
      const referer = headerVal(details.requestHeaders, 'referer');
      const origin = headerVal(details.requestHeaders, 'origin');
      if (!referer && !origin) return;
      REQUEST_HDRS.set(url, { referer: referer, origin: origin, at: Date.now() });
      if (REQUEST_HDRS.size > 2000) {
        const now = Date.now();
        for (const [k, v] of REQUEST_HDRS) if (now - (v.at || 0) > 180000) REQUEST_HDRS.delete(k);
      }
    } catch (_) {}
  }

  if (api.webRequest && api.webRequest.onHeadersReceived && api.webRequest.onHeadersReceived.addListener) {
    try {
      api.webRequest.onHeadersReceived.addListener(onHeadersReceived, { urls: ['<all_urls>'] }, ['responseHeaders']);
    } catch (e) {
      console.warn('[StreamRadar] could not install the webRequest listener', e);
    }
  }
  if (api.webRequest && api.webRequest.onBeforeSendHeaders && api.webRequest.onBeforeSendHeaders.addListener) {
    const wrFilter = { urls: ['<all_urls>'] };
    try {
      api.webRequest.onBeforeSendHeaders.addListener(rememberRequestHeaders, wrFilter, ['requestHeaders', 'extraHeaders']);
    } catch (_) {
      try {
        api.webRequest.onBeforeSendHeaders.addListener(rememberRequestHeaders, wrFilter, ['requestHeaders']);
      } catch (e) {
        log('onBeforeSendHeaders failed', String((e && e.message) || e));
      }
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
      if (stored[RULES_KEY] && stored[RULES_KEY].pack) {
        // the patch is signature-verified at fetch time; applyRemote re-checks the
        // autoPatch opt-in and size cap before running it in this worker too.
        SR.updater.applyRemote(stored[RULES_KEY].pack, stored[PATCH_KEY] || null, settings);
      }
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

  // WatchParty's direct-URL mode only plays a file it can fetch as media
  // (.m3u8/.mpd/.mp4/.webm/...). A resolver/API link such as
  // "d.shows.st/api?d=...." returns JSON/an HTML page, so WatchParty shows
  // "it doesn't look like this is a media file". Pick a truly playable item:
  // prefer a media-extension direct manifest/file and never send an API link.
  function playableUrlFrom(item) {
    if (!item || !item.url || item.isAd) return null;
    return util.watchPartyPlayable(item.url, item.category) ? item.url : null;
  }
  function pickPlayable(st, itemId) {
    const first = itemId && st.store.byId.get(itemId);
    const direct = playableUrlFrom(first);
    if (direct) return { url: direct, item: first };
    // fall back to the best detected stream that is genuinely playable
    const items = st.store.view ? st.store.view().items : [...st.store.byId.values()];
    const weights = (SR.rules && SR.rules.CATEGORY_WEIGHT) || { mp4: 100, hls: 95, dash: 90, webm: 85, other: 70 };
    const scored = items
      .map((it) => ({ it, u: playableUrlFrom(it) }))
      .filter((x) => x.u)
      .sort((a, b) => (weights[b.it.category] || 0) - (weights[a.it.category] || 0) || (b.it.size || 0) - (a.it.size || 0));
    return scored.length ? { url: scored[0].u, item: scored[0].it } : { url: null, item: first || null };
  }

  async function launchWatchParty(st, itemId) {
    const picked = pickPlayable(st, itemId);
    const media = picked.item;
    const url = picked.url;
    if (!url) {
      // No direct-playable stream found. A resolver/API link (or blob/segments)
      // cannot be used by WatchParty direct mode; VBrowser can open the page.
      return { ok: false, reason: t('watchparty.needDirect'), hint: 'vbrowser' };
    }
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
   * Local cinema player
   *
   * WatchParty fetches from watchparty.me, so CDNs that require the original
   * page Referer (the ones IDM still downloads) refuse to play. The extension
   * player is an extension page: host_permissions bypass CORS, and we attach
   * the page Referer on every playlist/segment fetch.
   * ================================================================== */
  function asReferer(raw) {
    try {
      const u = new URL(raw);
      if (/^https?:$/i.test(u.protocol)) return u.origin + '/';
    } catch (_) {}
    return '';
  }

  function originOf(raw) {
    try {
      return new URL(raw).origin;
    } catch (_) {
      return '';
    }
  }

  function refererCandidates(st, media) {
    const flags = (media && media.flags) || {};
    const live = (media && media.url && REQUEST_HDRS.get(media.url)) || {};
    const out = [];
    const push = (raw, keepPath) => {
      if (!raw || typeof raw !== 'string') return;
      if (!/^https?:/i.test(raw)) return;
      const v = keepPath ? raw : asReferer(raw) || raw;
      if (v && out.indexOf(v) < 0) out.push(v);
    };
    // Exact Referer the embed sent (IDM copies this). Prefer it over the tab URL.
    push(flags.requestReferer || live.referer, true);
    push(media && media.frameUrl, true);
    push(flags.documentUrl, true);
    push(flags.originUrl);
    push(flags.initiator);
    (st.frames || []).forEach((f) => push(f.url));
    push(st.url);
    push(media && media.url);
    return out;
  }

  function pageReferer(st, media) {
    return refererCandidates(st, media)[0] || '';
  }

  function buildPlaySession(st, media, urlOverride) {
    const url = urlOverride || (media && media.url) || '';
    const referer = pageReferer(st, media);
    let origin = '';
    try {
      origin = referer ? new URL(referer).origin : util.origin(st.url || '');
    } catch (_) {
      origin = util.origin(st.url || '');
    }
    return {
      url: url,
      category: (media && media.category) || '',
      quality: (media && media.quality) || '',
      host: (media && media.host) || util.host(url),
      name: (media && media.name) || '',
      mime: (media && media.mime) || '',
      drm: (media && media.drm) || st.drm || null,
      aes: (media && media.aes) || '',
      variants: (media && media.variants) || null,
      title: st.title || null,
      pageUrl: st.url || '',
      referer: referer,
      origin: origin,
      subtitle: st.pendingSub ? { vtt: st.pendingSub.vtt, name: st.pendingSub.name } : null,
      theme: settings.theme || 'dark',
      lang: settings.lang && settings.lang !== 'auto' ? settings.lang : SR.i18n.get(),
      createdAt: Date.now(),
    };
  }

  async function installRefererRule(tabId, referer, origin) {
    const dnr = api.declarativeNetRequest;
    if (!dnr || !dnr.updateSessionRules) return false;
    const id = 9100 + (Number(tabId) % 800);
    const requestHeaders = [];
    if (referer) requestHeaders.push({ header: 'Referer', operation: 'set', value: referer });
    if (origin) requestHeaders.push({ header: 'Origin', operation: 'set', value: origin });
    if (!requestHeaders.length) return false;
    try {
      await dnr.updateSessionRules({
        removeRuleIds: [id],
        addRules: [
          {
            id: id,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: requestHeaders },
            condition: {
              tabIds: [tabId],
              resourceTypes: ['media', 'xmlhttprequest', 'other', 'image'],
            },
          },
        ],
      });
      return true;
    } catch (e) {
      log('dnr rule failed', String((e && e.message) || e));
      return false;
    }
  }

  async function dropRefererRule(tabId) {
    const dnr = api.declarativeNetRequest;
    if (!dnr || !dnr.updateSessionRules) return;
    const id = 9100 + (Number(tabId) % 800);
    try {
      await dnr.updateSessionRules({ removeRuleIds: [id] });
    } catch (_) {}
  }

  function categoryFromUrl(url, fallback) {
    if (/\.m3u8(\?|#|$)/i.test(url) || /\.m3u(\?|#|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
    if (/\.webm(\?|#|$)/i.test(url)) return 'webm';
    if (/\.(mp4|m4v|mkv|mov)(\?|#|$)/i.test(url)) return 'mp4';
    return fallback || '';
  }

  function sniffCategory(mime, text, url, fallback) {
    if (/mpegurl|x-mpegurl|vnd\.apple\.mpegurl/i.test(mime || '')) return 'hls';
    if (/dash\+xml/i.test(mime || '')) return 'dash';
    if (/video\/webm/i.test(mime || '')) return 'webm';
    if (/video\/(mp4|quicktime|x-m4v)/i.test(mime || '')) return 'mp4';
    if (text && /#EXTM3U/.test(String(text).slice(0, 64))) return 'hls';
    if (text && /<MPD[\s>]/i.test(String(text).slice(0, 400))) return 'dash';
    return categoryFromUrl(url, fallback);
  }

  function looksLikeHtml(text) {
    const s = String(text || '').slice(0, 240);
    return /<!DOCTYPE|<html[\s>]|<head[\s>]/i.test(s);
  }

  async function resolvePlaySource(st, media, url, hop) {
    const refs = refererCandidates(st, media);
    const live = (media && media.url && REQUEST_HDRS.get(media.url)) || {};
    const flags = (media && media.flags) || {};
    const fallback = {
      url: url,
      category: (media && media.category) || categoryFromUrl(url, ''),
      referer: refs[0] || '',
      origin: flags.requestOrigin || live.origin || originOf(refs[0]) || util.origin(url || ''),
      referers: refs,
    };
    if (!url || (hop || 0) > 2) return fallback;
    if (util.isHlsProxy(url)) {
      const baked = util.parsePlayHeaders(url);
      return {
        url: url,
        category: 'hls',
        referer: baked.referer || refs[0] || '',
        origin: baked.origin || originOf(baked.referer) || fallback.origin,
        referers: refs,
      };
    }
    if (/\.(m3u8|mpd|mp4|webm|mkv|m4v|mov|m3u)(\?|#|$)/i.test(url)) {
      return Object.assign({}, fallback, { url: url, category: sniffCategory('', '', url, fallback.category) });
    }
    const tryRefs = refs.length ? refs : [''];
    for (let i = 0; i < tryRefs.length; i++) {
      const referer = tryRefs[i];
      const origin = originOf(referer) || util.origin(url);
      const headers = {};
      if (referer) headers.Referer = referer;
      if (origin) headers.Origin = origin;
      try {
        const text = await util.fetchText(url, { timeoutMs: 10000, maxBytes: 800000, headers: headers, credentials: 'include' });
        if (looksLikeHtml(text)) continue;
        const extracted = util.extractMediaUrl(util.safeJSON(text, null) || text);
        if (extracted && extracted !== url) {
          const inner = await resolvePlaySource(st, media, extracted, (hop || 0) + 1);
          return {
            url: inner.url,
            category: inner.category,
            referer: referer || inner.referer,
            origin: origin || inner.origin,
            referers: refs,
          };
        }
        if (text && /#EXTM3U/.test(String(text).slice(0, 64))) return { url: url, category: 'hls', referer: referer, origin: origin, referers: refs };
        if (text && /<MPD[\s>]/i.test(String(text).slice(0, 400))) return { url: url, category: 'dash', referer: referer, origin: origin, referers: refs };
        if (i < tryRefs.length - 1) continue;
        return { url: url, category: sniffCategory('', text, url, fallback.category || 'hls'), referer: referer, origin: origin, referers: refs };
      } catch (_) {}
    }
    return fallback;
  }

  async function launchPlayer(st, itemId, urlOverride) {
    const clicked = itemId ? st.store.byId.get(itemId) : null;
    const picked = pickPlayable(st, itemId);
    const media = clicked || picked.item;
    let url = urlOverride || (clicked && util.localPlayable(clicked.url, clicked.category) ? clicked.url : null) || picked.url;
    if (!url) return { ok: false, reason: t('player.needDirect') };
    if (media && media.drm) return { ok: false, reason: t('player.drm') };
    const resolved = await resolvePlaySource(st, media, url);
    url = resolved.url || url;
    const mediaForSession = Object.assign({}, media || {}, { url: url, category: resolved.category || (media && media.category) || '' });
    const sid = util.uuid();
    const session = buildPlaySession(st, mediaForSession, url);
    if (resolved.referer) session.referer = resolved.referer;
    if (resolved.origin) session.origin = resolved.origin;
    if (resolved.referers && resolved.referers.length) session.referers = resolved.referers;
    await api.storage.local.set({ [PLAY_PREFIX + sid]: session });
    const target = api.runtime.getURL('player/player.html?sid=' + encodeURIComponent(sid));
    const tab = await api.tabs.create({ url: target, active: true });
    if (tab && tab.id > 0) {
      playTabs.set(tab.id, sid);
      await installRefererRule(tab.id, session.referer, session.origin);
    }
    return { ok: true, tabId: tab && tab.id, sid: sid, session: session };
  }

  async function playerFetch(sid, url, responseType, range) {
    if (!sid || !url || !/^https?:/i.test(url)) return { ok: false, reason: 'bad url', status: 0 };
    const stored = await api.storage.local.get(PLAY_PREFIX + sid);
    const session = stored[PLAY_PREFIX + sid];
    if (!session) return { ok: false, reason: 'session expired', status: 0 };
    const headers = {};
    if (session.referer) headers.Referer = session.referer;
    if (session.origin) headers.Origin = session.origin;
    if (range && range.start != null && range.end != null) headers.Range = 'bytes=' + range.start + '-' + range.end;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), responseType === 'arraybuffer' ? 25000 : 15000);
    try {
      const res = await util.fetchImpl(url, { headers: headers, credentials: 'include', redirect: 'follow', signal: ctrl.signal });
      const status = res.status || 0;
      if (!res.ok && status >= 400) return { ok: false, reason: 'HTTP ' + status, status: status };
      const mime = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      if (responseType === 'arraybuffer') {
        const data = await res.arrayBuffer();
        return { ok: true, status: status || 200, mime: mime, data: data };
      }
      let text = await res.text();
      if (text.length > 2_000_000) text = text.slice(0, 2_000_000);
      return { ok: true, status: status || 200, mime: mime, data: text };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e), status: 0 };
    } finally {
      clearTimeout(timer);
    }
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
      case 'play': {
        const res = await launchPlayer(st, msg.id);
        if (!res.ok) toastTo(tabId, res.reason || t('player.needDirect'), 'warn');
        return res;
      }
      case 'watchparty': {
        const res = await launchWatchParty(st, msg.id);
        if (!res.ok) toastTo(tabId, res.reason || t('panel.empty'), 'warn');
        return res;
      }
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
          case 'get-live': {
            // Hand the already-verified pack (and, only when the user opted into
            // signed code patches, the patch) to extension pages (popup/options)
            // so live fixes can reach the whole UI, not just content scripts.
            const [pack, patch] = await Promise.all([storedPack(), storedPatch()]);
            return { ok: true, pack: pack || null, patch: settings.autoPatch ? patch || null : null, settings: settings };
          }
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
          case 'get-play-session': {
            const sid = msg.sid || (msg.payload && msg.payload.sid);
            if (!sid) return { ok: false };
            const stored = await api.storage.local.get(PLAY_PREFIX + sid);
            const session = stored[PLAY_PREFIX + sid];
            if (session && Date.now() - (session.createdAt || 0) < 6 * 60 * 60 * 1000) {
              return { ok: true, session: session };
            }
            return { ok: false };
          }
          case 'player-bind': {
            const sid = msg.sid;
            if (tabId != null && sid) {
              playTabs.set(tabId, sid);
              const stored = await api.storage.local.get(PLAY_PREFIX + sid);
              const session = stored[PLAY_PREFIX + sid];
              if (session) await installRefererRule(tabId, session.referer, session.origin);
            }
            return { ok: true };
          }
          case 'player-fetch': {
            return await playerFetch(msg.sid, msg.url, msg.responseType, msg.range);
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
        api.contextMenus.create({ id: 'sr-play', parentId: 'sr-root', title: t('action.play'), contexts: ['page', 'video', 'frame', 'link'] });
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
        const sid = playTabs.get(id);
        if (sid) {
          playTabs.delete(id);
          api.storage.local.remove(PLAY_PREFIX + sid);
          dropRefererRule(id);
        }
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
              if (k.indexOf(TAB_PREFIX) !== 0 && k.indexOf(PARTY_PREFIX) !== 0 && k.indexOf(PLAY_PREFIX) !== 0) continue;
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
