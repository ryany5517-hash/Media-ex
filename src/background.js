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
  const partyTabs = new Map();
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
      api.action.setBadgeBackgroundColor({ color: count ? '#3d5248' : '#8a847a' });
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
    // Never fail silently on a manual click: tell the user why nothing ran.
    const blocked = (reason) => {
      if (force) toastTo(tabId, reason, 'warn');
      return false;
    };
    if (!st) return blocked(t('toast.subsNoTitle'));
    if (!force && !settings.autoSubtitle) return false;
    // A detected stream is enough to run: runSubSearch recovers the movie id
    // from the stream URL (/hls/10389/master.m3u8) when the page exposes no
    // title/id. st.title may be null/junk (content script not injected yet,
    // SPA not hydrated) - that must NOT block the search.
    const hasStream = !!st.store.best();
    const t0 = st.title || {};
    const hasTitleId = (t0.title && !t0.isJunk) || t0.imdbId || t0.tmdbId || t0.urlTmdbId;
    if (!hasTitleId && !hasStream) return blocked(t('toast.subsNoStream'));
    if (!force && st.sub && (st.sub.status === 'searching' || (st.sub.status === 'found' && Date.now() - st.sub.at < 600000))) return false;
    const prev = subTimers.get(tabId);
    if (prev) prev.cancel();
    const job = util.debounce(() => runSubSearch(tabId, force), force ? 250 : 1800);
    subTimers.set(tabId, job);
    job();
    return true;
  }

  async function runSubSearch(tabId, force) {
    const st = getTab(tabId);
    if (!st) return;
    let title = st.title || {};
    // Page title junk/empty but a stream was detected: many CDNs bake the
    // TMDB/IMDb id into the path (/hls/10389/master.m3u8, /dash/1396/manifest.mpd).
    // Recover it so the search can still run by id (Wyzie) and the title can be
    // hydrated from TMDB even when the page itself is a generic SEO shell.
    if ((!title.title || title.isJunk) && !title.imdbId && !title.tmdbId && !title.urlTmdbId) {
      const best = st.store.best();
      if (best && best.url && SR.title && SR.title.idsFromUrl) {
        try {
          const ids = SR.title.idsFromUrl(best.url);
          if (ids && (ids.tmdbId || ids.imdbId)) {
            title = Object.assign({}, title, {
              urlTmdbId: ids.tmdbId || null,
              imdbId: ids.imdbId || title.imdbId || null,
              kind: ids.kind || title.kind || 'movie',
            });
            st.title = title;
          }
        } catch (_) {}
      }
    }
    if (!st.title) st.title = title;
    const want = {
      title: st.title.title,
      show: st.title.showName || st.title.title,
      year: st.title.year || null,
      season: st.title.season || null,
      episode: st.title.episode || null,
      imdbId: st.title.imdbId || null,
      tmdbId: st.title.tmdbId || st.title.urlTmdbId || null,
      urlTmdbId: st.title.urlTmdbId || st.title.tmdbId || null,
      kind: st.title.kind || 'unknown',
    };
    if (!want.title && !want.imdbId && !want.tmdbId && !want.urlTmdbId) {
      // Nothing to search with (no title, no id, no id in the stream URL).
      const hasStreamNow = !!st.store.best();
      const msg = hasStreamNow ? t('toast.subsNoTitle') : t('toast.subsNoStream');
      if (force) toastTo(tabId, msg, 'warn');
      st.sub = { status: 'none', items: st.sub.items || [], error: msg, query: '', at: Date.now() };
      broadcast(tabId, 'sub');
      return;
    }
    const needLookup = !want.imdbId || !want.title || (want.urlTmdbId && !st.title.tmdbId);
    // Show "searching" immediately so a click is never silent, even while the
    // IMDb/TMDB id lookup below is still in flight (it is timeout-capped).
    st.sub = { status: 'searching', items: st.sub.items || [], query: want.title, year: want.year, imdbId: want.imdbId || '', tmdbId: want.tmdbId || '', at: Date.now() };
    broadcast(tabId, 'sub');
    if (needLookup && SR.title && SR.title.lookupIds) {
      try {
        const ids = await util.withTimeout(SR.title.lookupIds(want, {}), 9000);
        if (ids && (ids.imdbId || ids.tmdbId || ids.name)) {
          if (ids.imdbId && !want.imdbId) {
            want.imdbId = ids.imdbId;
            st.title.imdbId = ids.imdbId;
          }
          if (ids.tmdbId) {
            want.tmdbId = ids.tmdbId;
            st.title.tmdbId = ids.tmdbId;
          }
          if (ids.year && !st.title.year) {
            want.year = ids.year;
            st.title.year = ids.year;
          }
          if (ids.name && (!st.title.title || st.title.isJunk)) {
            want.title = ids.name;
            want.show = ids.name;
            st.title.title = ids.name;
            st.title.isJunk = false;
          }
          if (ids.kind && (st.title.kind === 'unknown' || !st.title.title)) st.title.kind = ids.kind;
        }
      } catch (_) {}
    }
    try {
      const res = await SR.subs.search(want, settings, {});
      st.sub = { status: res.results.length ? 'found' : 'none', items: res.results.slice(0, 12), providers: res.providerInfo, errors: res.errors, query: want.title, year: want.year, imdbId: want.imdbId || '', tmdbId: want.tmdbId || '', at: Date.now() };
      if (res.results.length) {
        const best = res.results[0];
        try {
          const vtt = await SR.subs.resolve(best, settings, {});
          st.pendingSub = { vtt: vtt, name: best.filename || best.name, provider: best.provider, lang: best.langCode || '' };
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
      st.sub = { status: 'error', items: st.sub.items || [], error: String((e && e.message) || e), query: want.title, imdbId: want.imdbId || '', tmdbId: want.tmdbId || '', at: Date.now() };
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
  // /create?video= auto-creates the room. Token URLs are multi-KB and 414 the
  // query; there is no /watchNow route. Long URLs POST /createRoom then /watch{name}.
  function watchPartyCreateUrl(mediaUrl) {
    const encoded = encodeURIComponent(mediaUrl || '');
    if (encoded.length > 1600) return 'https://www.watchparty.me/';
    return 'https://www.watchparty.me/create?video=' + encoded;
  }

  async function createWatchPartyRoom(mediaUrl) {
    try {
      const res = await util.fetchImpl('https://www.watchparty.me/createRoom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video: String(mediaUrl || '').slice(0, 20000) }),
      });
      const data = await res.json();
      if (data && data.name) return 'https://www.watchparty.me/watch' + data.name;
    } catch (e) {
      log('createRoom', String((e && e.message) || e));
    }
    return '';
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

  function pickIndoItem(items) {
    return (items || []).find((x) => SR.subs && SR.subs.isIndonesian(x)) || null;
  }

  async function ensurePartySubtitle(st) {
    if (!st) return null;
    if (!st.pendingSub && st.title && (st.title.title || st.title.imdbId || st.title.tmdbId || st.title.urlTmdbId)) {
      try {
        await runSubSearch(st.tabId);
      } catch (_) {}
    }
    const items = (st.sub && st.sub.items) || [];
    const indo = pickIndoItem(items);
    if (indo) {
      const already =
        st.pendingSub &&
        (st.pendingSub.lang === 'id' ||
          (SR.subs &&
            SR.subs.isIndonesian({
              langCode: st.pendingSub.lang,
              name: st.pendingSub.name,
              filename: st.pendingSub.name,
            })));
      if (already) return { vtt: st.pendingSub.vtt, name: st.pendingSub.name, lang: 'id' };
      try {
        const vtt = await SR.subs.resolve(indo, settings, {});
        return { vtt: vtt, name: indo.filename || indo.name, lang: 'id' };
      } catch (_) {}
    }
    return st.pendingSub ? { vtt: st.pendingSub.vtt, name: st.pendingSub.name, lang: st.pendingSub.lang || '' } : null;
  }

  async function launchWatchParty(st, itemId) {
    const clicked = itemId ? st.store.byId.get(itemId) : null;
    let picked = pickPlayable(st, itemId);
    let media = picked.item || clicked;
    let url = picked.url || (clicked && util.localPlayable(clicked.url, clicked.category) ? clicked.url : null);
    if (!url && media && media.url && util.localPlayable(media.url, media.category)) url = media.url;
    // Unwrap JSON resolvers BEFORE adding a .m3u8 hint — the hint would skip unwrap.
    if (url && media && !/\.(m3u8|mpd|mp4|webm|mkv|m4v|mov)(\?|#|$)/i.test(url) && !util.isHlsProxy(url) && util.localPlayable(url, media.category)) {
      const resolved = await resolvePlaySource(st, media, url);
      if (resolved && resolved.url) {
        url = resolved.url;
        media = Object.assign({}, media, { url: url, category: resolved.category || media.category });
      }
    }
    if (url) url = await preferWatchPartyUrl(st, media, url);
    // Never fall through to Play / in-page overlay — Watch Party must open a room.
    if (!url || !util.watchPartyPlayable(url, (media && media.category) || '')) {
      return { ok: false, reason: t('watchparty.needDirect'), hint: 'vbrowser' };
    }
    const ti = st.title || {};
    const roomName = String(
      ti.title ? ti.title + (ti.year ? ' (' + ti.year + ')' : '') + (ti.episode ? ' S' + (ti.season || '01') + 'E' + ti.episode : '') : ti.raw || util.domain(st.url) || 'Stream Radar room'
    ).slice(0, 90);
    const referer = pageReferer(st, media);
    const origin = originOf(referer) || util.origin(url);
    const partySub = await ensurePartySubtitle(st);
    const payload = {
      mediaUrl: url,
      roomName: roomName,
      userName: settings.watchpartyName || '',
      category: media.category,
      quality: media.quality || '',
      title: st.title || null,
      subtitle: partySub,
      autoJoin: settings.watchpartyAutoJoin !== false,
      referer: referer,
      origin: origin,
      createdAt: Date.now(),
    };
    const target = (encodeURIComponent(url).length > 1600 ? await createWatchPartyRoom(url) : '') || watchPartyCreateUrl(url);
    // Park on watchparty.me, install Referer+CORS for this tab, THEN navigate to
    // /create?video= — otherwise HLS.js races the first playlist fetch and spins.
    const parking = 'https://www.watchparty.me/';
    const tab = await api.tabs.create({ url: parking, active: true }).catch(async () => await api.tabs.create({ url: parking }));
    if (tab && tab.id > 0) {
      await api.storage.local.set({ [PARTY_PREFIX + tab.id]: payload });
      await installPartyNetRules(tab.id, referer, origin, url);
      if (target && target !== parking) {
        try {
          await api.tabs.update(tab.id, { url: target });
        } catch (_) {
          try {
            await api.tabs.create({ url: target, active: true });
          } catch (e) {
            log('party navigate', String((e && e.message) || e));
          }
        }
      }
    }
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
    const baked = util.parsePlayHeaders((media && media.url) || '');
    push(flags.requestReferer || live.referer || baked.referer, true);
    if (baked.origin) push(baked.origin);
    push(media && media.frameUrl, true);
    push(flags.documentUrl, true);
    push(flags.originUrl);
    push(flags.initiator);
    push(media && media.url);
    (st.frames || []).forEach((f) => push(f.url));
    push(st.url);
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
      subtitle: st.pendingSub ? { vtt: st.pendingSub.vtt, name: st.pendingSub.name, lang: st.pendingSub.lang || '' } : null,
      theme: settings.theme || 'dark',
      lang: settings.lang && settings.lang !== 'auto' ? settings.lang : SR.i18n.get(),
      createdAt: Date.now(),
    };
  }

  async function installRefererRule(tabId, referer, origin, mediaUrl) {
    const dnr = api.declarativeNetRequest;
    if (!dnr || !dnr.updateSessionRules) return false;
    const requestHeaders = [];
    if (referer) requestHeaders.push({ header: 'Referer', operation: 'set', value: referer });
    if (origin) requestHeaders.push({ header: 'Origin', operation: 'set', value: origin });
    if (!requestHeaders.length) return false;
    const types = ['media', 'xmlhttprequest', 'other', 'image'];
    const extId = 8899;
    const tabRuleId = tabId != null && tabId > 0 ? 9100 + (Number(tabId) % 800) : 0;
    const removeRuleIds = [extId];
    if (tabRuleId) removeRuleIds.push(tabRuleId);

    const extCondition = { resourceTypes: types };
    if (api.runtime && api.runtime.id) extCondition.initiatorDomains = [String(api.runtime.id)];

    const addRules = [
      {
        id: extId,
        priority: 2,
        action: { type: 'modifyHeaders', requestHeaders: requestHeaders },
        condition: extCondition,
      },
    ];
    if (tabRuleId) {
      addRules.push({
        id: tabRuleId,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: requestHeaders },
        condition: { tabIds: [tabId], resourceTypes: types },
      });
    }
    try {
      await dnr.updateSessionRules({ removeRuleIds: removeRuleIds, addRules: addRules });
      return true;
    } catch (e) {
      log('dnr rule failed', String((e && e.message) || e));
      const host = util.host(mediaUrl || referer || '');
      try {
        const fallback = [
          {
            id: extId,
            priority: 2,
            action: { type: 'modifyHeaders', requestHeaders: requestHeaders },
            condition: host ? { urlFilter: '||' + host, resourceTypes: types } : { resourceTypes: types },
          },
        ];
        if (tabRuleId) {
          fallback.push({
            id: tabRuleId,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: requestHeaders },
            condition: { tabIds: [tabId], resourceTypes: types },
          });
        }
        await dnr.updateSessionRules({ removeRuleIds: removeRuleIds, addRules: fallback });
        return true;
      } catch (e2) {
        log('dnr fallback failed', String((e2 && e2.message) || e2));
        return false;
      }
    }
  }

  async function dropRefererRule(tabId) {
    const dnr = api.declarativeNetRequest;
    if (!dnr || !dnr.updateSessionRules) return;
    const ids = [8899];
    if (tabId != null && tabId > 0) {
      const n = Number(tabId) % 800;
      ids.push(9100 + n, 9200 + n, 9300 + n, 9400 + n, 9500 + n);
    }
    try {
      await dnr.updateSessionRules({ removeRuleIds: ids });
    } catch (_) {}
  }

  /** WatchParty.me fetches the CDN as watchparty.me — attach page Referer (IDM) and unlock CORS. */
  function partyCdnDomains(mediaUrl) {
    const host = util.host(mediaUrl || '');
    const domain = util.domain(mediaUrl || '');
    const out = [];
    const push = (h) => {
      if (!h || out.indexOf(h) >= 0) return;
      if (!/^[a-z0-9.-]+$/i.test(h)) return;
      out.push(h);
    };
    push(host);
    push(domain);
    return out;
  }

  async function installPartyNetRules(tabId, referer, origin, mediaUrl) {
    const dnr = api.declarativeNetRequest;
    if (!dnr || !dnr.updateSessionRules || tabId == null || tabId <= 0) return false;
    const types = ['media', 'xmlhttprequest', 'other', 'image', 'object'];
    const n = Number(tabId) % 800;
    const reqId = 9200 + n;
    const corsId = 9300 + n;
    const removeRuleIds = [reqId, corsId, 9400 + n, 9500 + n];
    const requestHeaders = [];
    if (referer) requestHeaders.push({ header: 'Referer', operation: 'set', value: referer });
    if (origin) requestHeaders.push({ header: 'Origin', operation: 'set', value: origin });
    const responseHeaders = [
      { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
      { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
      { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
      { header: 'Cross-Origin-Resource-Policy', operation: 'set', value: 'cross-origin' },
    ];
    const domains = partyCdnDomains(mediaUrl);
    const hostCond = { tabIds: [tabId], resourceTypes: types };
    if (domains.length) hostCond.requestDomains = domains;
    const addRules = [{ id: corsId, priority: 4, action: { type: 'modifyHeaders', responseHeaders: responseHeaders }, condition: hostCond }];
    if (requestHeaders.length) {
      addRules.push({ id: reqId, priority: 4, action: { type: 'modifyHeaders', requestHeaders: requestHeaders }, condition: hostCond });
    }
    const rec = { referer: referer, origin: origin, mediaUrl: mediaUrl };
    try {
      await dnr.updateSessionRules({ removeRuleIds: removeRuleIds, addRules: addRules });
      partyTabs.set(tabId, rec);
      try {
        await api.storage.local.set({ ['srad:partynet:' + tabId]: rec });
      } catch (_) {}
      return true;
    } catch (e) {
      log('party dnr failed', String((e && e.message) || e));
      try {
        // CORS only — never rewrite Origin/Referer on watchparty.me's own XHR.
        const loose = { tabIds: [tabId], resourceTypes: types };
        if (domains.length) loose.requestDomains = domains;
        await dnr.updateSessionRules({
          removeRuleIds: removeRuleIds,
          addRules: [{ id: corsId, priority: 4, action: { type: 'modifyHeaders', responseHeaders: responseHeaders }, condition: loose }],
        });
        partyTabs.set(tabId, rec);
        try {
          await api.storage.local.set({ ['srad:partynet:' + tabId]: rec });
        } catch (_) {}
        return true;
      } catch (e2) {
        log('party dnr fallback failed', String((e2 && e2.message) || e2));
        return false;
      }
    }
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
      await installRefererRule(null, referer, origin, url);
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

  /**
   * Runs in the PAGE world. IDM plays because it reuses the tab request
   * (cookies + Referer of the iframe that loaded the stream). We do the same:
   * mount HLS.js in that frame. Do not fetch-probe (CORS/CSP hang). Serialized
   * into scripting.executeScript — do not close over background state.
   */
  function inPagePlayFunc(session) {
    try {
      var url = session && session.url;
      if (!url) return { played: false, reason: 'nourl' };
      var here = '';
      try {
        here = String(location.hostname || '').toLowerCase();
      } catch (_) {}
      var want = String((session && session.host) || '').toLowerCase();
      try {
        if (!want) want = new URL(url).hostname.toLowerCase();
      } catch (_) {}
      var sameOrigin = false;
      try {
        sameOrigin = new URL(url, location.href).origin === location.origin;
      } catch (_) {}
      function tail(h) {
        var p = String(h || '').split('.');
        return p.length <= 2 ? h : p.slice(-2).join('.');
      }
      var related =
        sameOrigin ||
        (here &&
          want &&
          (here === want || here.endsWith('.' + want) || want.endsWith('.' + here) || tail(here) === tail(want)));
      if (!session.force && !related) return { played: false, reason: 'host', host: here };
      if (window.__sradPlaying) return { played: true, host: here, dup: 1 };

      function codecsOf(level) {
        return String((level && (level.videoCodec || level.codec || (level.attrs && level.attrs.CODECS))) || '').toLowerCase();
      }
      function isHevc(c) {
        return /hvc1|hev1|hevc|dvh1|dvhe|av01/.test(c || '');
      }
      function pickAvcLevel(hls) {
        var levels = (hls && hls.levels) || [];
        var best = -1;
        var bestScore = -1;
        for (var i = 0; i < levels.length; i++) {
          var c = codecsOf(levels[i]);
          if (isHevc(c)) continue;
          var h = Number(levels[i].height || 0);
          if (h > 1080) continue;
          var score = (h || 1) + (/avc/.test(c) ? 200 : 0);
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        }
        if (best >= 0) return best;
        for (var j = 0; j < levels.length; j++) {
          if (isHevc(codecsOf(levels[j]))) continue;
          var h2 = Number(levels[j].height || 0);
          if (h2 >= bestScore) {
            bestScore = h2;
            best = j;
          }
        }
        return best;
      }
      function mount(playUrl) {
        var doc = document;
        var old = doc.getElementById('srad-inpage');
        if (old) old.remove();
        var wrap = doc.createElement('div');
        wrap.id = 'srad-inpage';
        wrap.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;background:#000;display:flex;flex-direction:column;');
        var bar = doc.createElement('div');
        bar.setAttribute('style', 'display:flex;justify-content:flex-end;padding:8px 12px;background:#111;flex:0 0 auto;');
        var close = doc.createElement('button');
        close.textContent = 'Close';
        close.setAttribute('style', 'color:#fff;background:#333;border:0;padding:6px 12px;cursor:pointer;border-radius:4px');
        close.onclick = function () {
          try {
            if (window.__sradInpageHls) window.__sradInpageHls.destroy();
          } catch (_) {}
          wrap.remove();
          window.__sradPlaying = 0;
        };
        bar.appendChild(close);
        wrap.appendChild(bar);
        (doc.body || doc.documentElement).appendChild(wrap);

        var live = null;
        try {
          var vids = doc.querySelectorAll('video');
          for (var vi = 0; vi < vids.length; vi++) {
            var cand = vids[vi];
            if (cand && cand.id !== 'srad-inpage-video' && cand.videoWidth > 16 && cand.readyState >= 2) {
              live = cand;
              break;
            }
          }
        } catch (_) {}
        if (live) {
          live.setAttribute('controls', '');
          live.setAttribute('playsinline', '');
          live.setAttribute('style', 'flex:1;width:100%;height:100%;min-height:0;object-fit:contain;background:#000');
          wrap.appendChild(live);
          try {
            live.muted = false;
            live.play();
          } catch (_) {}
          return;
        }

        var video = doc.createElement('video');
        video.id = 'srad-inpage-video';
        video.setAttribute('controls', '');
        video.setAttribute('autoplay', '');
        video.setAttribute('playsinline', '');
        video.setAttribute('style', 'flex:1;width:100%;height:100%;min-height:0;object-fit:contain;background:#000');
        wrap.appendChild(video);
        var queue = [playUrl].concat(session.alts || []).filter(function (u, i, a) {
          return u && a.indexOf(u) === i;
        });
        function attach(u, rest) {
          var H = window.Hls;
          if (H && H.isSupported && H.isSupported()) {
            try {
              if (window.__sradInpageHls) window.__sradInpageHls.destroy();
            } catch (_) {}
            var hls = new H({ enableWorker: false, capLevelToPlayerSize: true, startLevel: -1 });
            window.__sradInpageHls = hls;
            try { video.muted = false; } catch (_) {}
            hls.loadSource(u);
            hls.attachMedia(video);
            var ev = H.Events && H.Events.MANIFEST_PARSED ? H.Events.MANIFEST_PARSED : 'hlsManifestParsed';
            hls.on(ev, function () {
              var idx = pickAvcLevel(hls);
              if (idx >= 0) {
                try {
                  hls.currentLevel = idx;
                  hls.loadLevel = idx;
                  hls.nextLevel = idx;
                } catch (_) {}
              }
              try {
                video.play();
              } catch (_) {}
            });
            var errEv = H.Events && H.Events.ERROR ? H.Events.ERROR : 'hlsError';
            hls.on(errEv, function (_e, data) {
              if (data && data.fatal && rest && rest.length) attach(rest[0], rest.slice(1));
            });
            setTimeout(function () {
              if (video.videoWidth < 16 && video.currentTime > 0.2 && rest && rest.length) attach(rest[0], rest.slice(1));
            }, 2500);
            return;
          }
          video.src = u;
          video.play().catch(function () {
            if (rest && rest.length) attach(rest[0], rest.slice(1));
          });
        }
        attach(queue[0], queue.slice(1));
      }
      function extract(text) {
        if (!text) return '';
        if (/#EXTM3U/.test(String(text).slice(0, 64))) return url;
        if (/<MPD[\s>]/i.test(String(text).slice(0, 400))) return url;
        try {
          var j = JSON.parse(text);
          return j.file || j.src || j.url || (j.source && (j.source.file || j.source.src)) || '';
        } catch (_) {}
        var m = String(text).match(/https?:\/\/[^\s"'<>\\)]{8,800}?\.(?:m3u8|mpd|mp4)(?:\?[^\s"'<>\\)]{0,400})?/i);
        return m ? m[0] : '';
      }
      function needsUnwrap(u) {
        try {
          var path = new URL(u).pathname;
          return /\/api\/?$/i.test(path) && !/\.m3u8/i.test(u);
        } catch (_) {
          return false;
        }
      }
      if (related && needsUnwrap(url) && typeof fetch === 'function') {
        window.__sradPlaying = 1;
        return fetch(url, { credentials: 'include' })
          .then(function (r) {
            return r.text();
          })
          .then(function (text) {
            mount(extract(text) || url);
            return { played: true, host: here, via: 'api' };
          })
          .catch(function () {
            mount(url);
            return { played: true, host: here, via: 'api-fail' };
          });
      }
      window.__sradPlaying = 1;
      mount(url);
      return { played: true, host: here, via: session.force ? 'force' : 'related' };
    } catch (e) {
      return { played: false, reason: String((e && e.message) || e) };
    }
  }

  function playlistHasAudio(text) {
    const s = String(text || '');
    if (!/#EXTM3U/.test(s)) return false;
    if (/TYPE=AUDIO|#EXT-X-MEDIA:/i.test(s)) return true;
    if (/mp4a|ac-3|ec-3|opus|fLaC|\baac\b/i.test(s)) return true;
    return false;
  }

  function hlsMasterAlts(st, url) {
    const out = [];
    const push = (u) => {
      if (u && out.indexOf(u) < 0) out.push(u);
    };
    try {
      const u = new URL(url);
      const dir = u.origin + u.pathname.replace(/\/v\d+\.m3u8$/i, '').replace(/\/$/, '');
      const q = u.search || '';
      if (st && st.store) {
        for (const it of st.store.byId.values()) {
          if (!it || !it.url || it.isAd) continue;
          if (it.url.indexOf(dir) !== 0) continue;
          if (/(master|index|playlist)\.m3u8/i.test(it.url)) push(it.url);
        }
      }
      if (/\/v\d+\.m3u8$/i.test(u.pathname) || (/\/mpd\//i.test(u.pathname) && !/\.(m3u8|mpd)$/i.test(u.pathname))) {
        push(dir + '/index.m3u8' + q);
        push(dir + '/master.m3u8' + q);
        push(dir + '/playlist.m3u8' + q);
      }
    } catch (_) {}
    return out;
  }

  async function fetchPlaylistText(url, referer, origin) {
    try {
      const headers = {};
      if (referer) headers.Referer = referer;
      if (origin) headers.Origin = origin;
      return await util.fetchText(url, { timeoutMs: 5000, maxBytes: 200000, headers: headers, credentials: 'include' });
    } catch (_) {
      return '';
    }
  }

  // WatchParty's isHls() is `src.includes('.m3u8')`. Token HLS (/mpd/, /api/playlist)
  // without that substring is treated as a raw <video src> and never loads.
  // Use a fragment — browsers do not send `#…` to the CDN. A query hint
  // (`srad=playlist.m3u8`) was forwarded to a2.shows.st/api?d= and the playlist
  // never played (spinner + red X) while Play (no hint) worked.
  function ensureWpHlsUrl(url, category) {
    if (!url) return url;
    let clean = url;
    try {
      const u = new URL(url);
      if (u.searchParams.has('srad')) {
        u.searchParams.delete('srad');
        clean = u.href;
      }
    } catch (_) {}
    if (/\.m3u8/i.test(clean)) return clean;
    let path = '';
    try {
      path = new URL(clean).pathname || '';
    } catch (_) {
      return clean;
    }
    if (/\.(mp4|webm|mpd|mkv|m4v|mov)(\?|#|$)/i.test(clean)) return clean;
    const hlsish = category === 'hls' || /\/mpd\//i.test(path) || /\/playlist\//i.test(path) || /mpegurl/i.test(category);
    if (!hlsish) return clean;
    if (clean.indexOf('#') >= 0) return clean;
    return clean + '#playlist.m3u8';
  }

  function pickAudioVariant(parsed) {
    const vs = (parsed && parsed.variants) || [];
    let best = '';
    let score = -1;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (!v || !v.uri) continue;
      const c = String(v.codecs || (parsed && parsed.codecs) || '');
      if (/hvc1|hev1|hevc|dvh1|dvhe|av01/i.test(c)) continue;
      const h = Number(v.height || 0);
      if (h > 1080) continue;
      const audio = /mp4a|ac-3|ec-3|opus|fLaC|\baac\b/i.test(c);
      const sc = (audio ? 800 : 0) + Math.min(h || 1, 1080);
      if (sc > score) {
        score = sc;
        best = v.uri;
      }
    }
    return best;
  }

  // v0.m3u8 on token CDNs is often video-only. Prefer a master that has AUDIO.
  async function preferAudioMaster(st, media, url) {
    if (!url) return url;
    const referer = pageReferer(st, media);
    const origin = originOf(referer) || util.origin(url);
    const body = await fetchPlaylistText(url, referer, origin);
    if (body && SR.manifest && SR.manifest.parseM3u8) {
      const parsed = SR.manifest.parseM3u8(body, url);
      if (parsed && parsed.kind === 'master') {
        if (playlistHasAudio(body) || pickAudioVariant(parsed)) return url;
      }
    }
    if (playlistHasAudio(body) || /mp4a/i.test(body || '')) return url;
    const alts = hlsMasterAlts(st, url);
    for (let i = 0; i < alts.length; i++) {
      const text = await fetchPlaylistText(alts[i], referer, origin);
      if (!text) continue;
      if (SR.manifest && SR.manifest.parseM3u8) {
        const parsed = SR.manifest.parseM3u8(text, alts[i]);
        if (parsed && parsed.kind === 'master' && (playlistHasAudio(text) || pickAudioVariant(parsed))) return alts[i];
      }
      if (playlistHasAudio(text) || /#EXT-X-STREAM-INF/i.test(text)) return alts[i];
    }
    return url;
  }

  async function preferWatchPartyUrl(st, media, url) {
    return ensureWpHlsUrl(await preferAudioMaster(st, media, url), (media && media.category) || '');
  }

  function preferPlayUrl(st, media, url) {
    if (!url) return url;
    try {
      const u = new URL(url);
      const hot = /v3\.m3u8|2160|4k/i.test(url + ' ' + ((media && media.quality) || ''));
      if (/\.(m3u8|mpd)(\?|#|$)/i.test(u.pathname) && !hot) return url;
      if (!/\/mpd\//i.test(u.pathname) || !st || !st.store) return url;
      const prefix = (u.origin + u.pathname.replace(/\/v\d+\.m3u8$/i, '').replace(/\/$/, ''));
      let v0 = '';
      let mild = '';
      for (const it of st.store.byId.values()) {
        if (!it || !it.url || it.isAd) continue;
        if (it.url.indexOf(prefix) !== 0) continue;
        if (!/\.m3u8(\?|#|$)/i.test(it.url)) continue;
        if (/v0\.m3u8/i.test(it.url)) v0 = it.url;
        else if (!/v3\.m3u8/i.test(it.url) && !/4k|2160/i.test(String(it.quality || ''))) mild = it.url;
      }
      if (v0) return v0;
      if (mild) return mild;
    } catch (_) {}
    return url;
  }

  function playAlts(url) {
    const out = [];
    try {
      const u = new URL(url);
      if (/\/mpd\//i.test(u.pathname) && !/\.(m3u8|mpd)(\?|#|$)/i.test(u.pathname)) {
        out.push(u.origin + u.pathname.replace(/\/$/, '') + '/v0.m3u8');
        out.push(u.origin + u.pathname.replace(/\/$/, '') + '/v3.m3u8');
      }
    } catch (_) {}
    return out;
  }

  async function tryInPagePlay(tabId, media, session) {
    if (tabId == null) return false;
    const payload = {
      url: session && session.url,
      host: (session && session.host) || util.host((media && media.url) || '') || util.host((session && session.url) || ''),
      hlsLib: (session && session.hlsLib) || '',
      alts: (session && session.alts) || playAlts((session && session.url) || ''),
      force: false,
    };
    if (api.scripting && typeof api.scripting.executeScript === 'function') {
      const injectHls = async (target) => {
        try {
          const probe = await api.scripting.executeScript({
            target: target,
            world: 'MAIN',
            func: function () {
              return !!(window.Hls && window.Hls.isSupported && window.Hls.isSupported());
            },
          });
          if ((probe || []).some((r) => r && r.result)) return;
          await api.scripting.executeScript({ target: target, world: 'MAIN', files: ['vendor/hls.light.min.js'] });
        } catch (e) {
          log('hls inject', String((e && e.message) || e));
        }
      };
      const run = async (target, force) => {
        await injectHls(target);
        const args = Object.assign({}, payload, { force: !!force });
        const results = await api.scripting.executeScript({
          target: target,
          world: 'MAIN',
          func: inPagePlayFunc,
          args: [args],
        });
        return (results || []).some((r) => r && r.result && r.result.played);
      };
      const frameIds = [];
      const pushFid = (id) => {
        if (id == null || frameIds.indexOf(id) >= 0) return;
        frameIds.push(id);
      };
      pushFid(media && media.flags && media.flags.frameId);
      const docUrl = (media && media.flags && (media.flags.documentUrl || media.flags.originUrl || media.flags.initiator)) || (media && media.frameUrl) || '';
      const docHost = util.host(docUrl);
      (stFrames(tabId) || []).forEach((f) => {
        if (!f || f.frameId == null) return;
        if (docUrl && f.url && String(f.url).split('#')[0] === String(docUrl).split('#')[0]) pushFid(f.frameId);
        else if (docHost && util.host(f.url) === docHost) pushFid(f.frameId);
      });
      for (let i = 0; i < frameIds.length; i++) {
        try {
          if (await run({ tabId: tabId, frameIds: [frameIds[i]] }, true)) return true;
        } catch (e) {
          log('inpage frame', String((e && e.message) || e));
        }
      }
      try {
        if (await run({ tabId: tabId, allFrames: true }, false)) return true;
      } catch (e) {
        log('inpage executeScript', String((e && e.message) || e));
      }
    }
    const want = payload.host;
    const ids = [];
    const pushId = (id, front) => {
      if (id == null || ids.indexOf(id) >= 0) return;
      if (front) ids.unshift(id);
      else ids.push(id);
    };
    if (media && media.flags && media.flags.frameId != null) pushId(media.flags.frameId, true);
    (stFrames(tabId) || []).forEach((f) => {
      if (!f || f.frameId == null) return;
      const host = util.host(f.url || '');
      const related = want && host && (host === want || host.endsWith('.' + want) || want.endsWith('.' + host));
      pushId(f.frameId, related);
    });
    async function ping(frameId) {
      try {
        const msg = { type: 'play-in-page', session: session };
        const res = frameId != null ? await api.tabs.sendMessage(tabId, msg, { frameId: frameId }) : await api.tabs.sendMessage(tabId, msg);
        return !!(res && res.played);
      } catch (_) {
        return false;
      }
    }
    for (let i = 0; i < ids.length; i++) {
      if (await ping(ids[i])) return true;
    }
    return false;
  }

  function stFrames(tabId) {
    const st = tabs.get(tabId);
    return (st && st.frames) || [];
  }

  async function launchPlayer(st, itemId, urlOverride) {
    const clicked = itemId ? st.store.byId.get(itemId) : null;
    const picked = pickPlayable(st, itemId);
    const media = clicked || picked.item;
    let url = urlOverride || (clicked && util.localPlayable(clicked.url, clicked.category) ? clicked.url : null) || picked.url;
    if (!url) return { ok: false, reason: t('player.needDirect') };
    if (media && media.drm) return { ok: false, reason: t('player.drm') };

    const origUrl = await preferAudioMaster(st, media, url);
    url = origUrl;
    const sid = util.uuid();
    const inSession = buildPlaySession(st, media, origUrl);
    inSession.host = (media && media.host) || util.host((media && media.url) || origUrl) || inSession.host;
    inSession.alts = playAlts(origUrl);
    try {
      inSession.hlsLib = api.runtime.getURL('vendor/hls.light.min.js');
    } catch (_) {}
    const inPage = await tryInPagePlay(st.tabId, media, inSession);
    if (inPage) {
      toastTo(st.tabId, t('toast.player'), 'ok');
      return { ok: true, inpage: true, session: inSession };
    }

    const previewRef = pageReferer(st, media);
    await installRefererRule(null, previewRef, originOf(previewRef) || util.origin(url), url);
    const resolved = await resolvePlaySource(st, media, url);
    url = await preferAudioMaster(st, media, resolved.url || url);
    if (!st.pendingSub) {
      try {
        await ensurePartySubtitle(st);
      } catch (_) {}
    }
    const mediaForSession = Object.assign({}, media || {}, { url: url, category: resolved.category || (media && media.category) || '' });
    const session = buildPlaySession(st, mediaForSession, url);
    if (resolved.referer) session.referer = resolved.referer;
    if (resolved.origin) session.origin = resolved.origin;
    if (resolved.referers && resolved.referers.length) session.referers = resolved.referers;
    session.host = (media && media.host) || util.host((media && media.url) || '') || session.host;
    try {
      session.hlsLib = api.runtime.getURL('vendor/hls.light.min.js');
    } catch (_) {}

    await api.storage.local.set({ [PLAY_PREFIX + sid]: session });
    const target = api.runtime.getURL('player/player.html?sid=' + encodeURIComponent(sid));
    const tab = await api.tabs.create({ url: target, active: true });
    if (tab && tab.id > 0) {
      playTabs.set(tab.id, sid);
      await installRefererRule(tab.id, session.referer, session.origin, session.url);
    }
    return { ok: true, tabId: tab && tab.id, sid: sid, session: session };
  }

  async function refererFetch(url, referer, origin, responseType, range) {
    if (!url || !/^https?:/i.test(url)) return { ok: false, reason: 'bad url', status: 0 };
    url = String(url).split('#')[0];
    const headers = {};
    if (referer) headers.Referer = referer;
    if (origin) headers.Origin = origin;
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

  async function playerFetch(sid, url, responseType, range) {
    if (!sid) return { ok: false, reason: 'session expired', status: 0 };
    const stored = await api.storage.local.get(PLAY_PREFIX + sid);
    const session = stored[PLAY_PREFIX + sid];
    if (!session) return { ok: false, reason: 'session expired', status: 0 };
    return refererFetch(url, session.referer, session.origin, responseType, range);
  }

  async function partyFetch(tabId, url, responseType, range) {
    let rec = tabId != null ? partyTabs.get(tabId) : null;
    if (!rec && tabId != null) {
      try {
        const stored = await api.storage.local.get('srad:partynet:' + tabId);
        rec = stored['srad:partynet:' + tabId] || null;
        if (rec) partyTabs.set(tabId, rec);
      } catch (_) {}
    }
    if (!rec) return { ok: false, reason: 'no party session', status: 0 };
    return refererFetch(url, rec.referer, rec.origin, responseType, range);
  }

  /* ================================================================== *
   * actions (popup + panel + options all land here)
   * ================================================================== */
  /** Re-inject the content script (and MAIN-world page hooks) into a tab that
   *  was opened before the extension reloaded - without it the title is never
   *  read and clicks can feel dead. Best-effort, never throws. */
  async function ensureContentAlive(tabId) {
    try {
      await api.tabs.sendMessage(tabId, { type: 'ping' });
      return true;
    } catch (_) {}
    const iso = ['shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'shared/i18n.js', 'shared/icons.js', 'shared/updater.js', 'shared/dom-scanner.js', 'vendor/motion.min.js', 'shared/subtitles.js', 'content/ui-styles.js', 'content/ui.js', 'content/content.js'];
    const main = ['shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'page/inject.js'];
    try {
      await api.scripting.executeScript({ target: { tabId }, files: iso });
    } catch (_) {}
    try {
      await api.scripting.executeScript({ target: { tabId }, files: main, world: 'MAIN' });
    } catch (_) {}
    return true;
  }

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
      case 'subs':
      case 'subs-search':
        // The panel/popup rows send 'subs'; the dedicated retry buttons send
        // 'subs-search'. Both mean "search subtitles for the current title".
        {
          // A tab that was open before the extension was reloaded has no content
          // script anymore (title detection dead). Re-inject it so the title can
          // be read; the search itself also recovers ids from stream URLs.
          await ensureContentAlive(tabId);
          const ok = scheduleSubSearch(tabId, true);
          return ok ? { ok: true } : { ok: false, reason: t('toast.subsNoStream') };
        }
      case 'sub-attach': {
        if (!st.pendingSub) await runSubSearch(tabId);
        if (!st.pendingSub) return { ok: false, reason: 'no subtitle available' };
        await ensureContentAlive(tabId);
        const att = await api.tabs
          .sendMessage(tabId, { type: 'attach-subtitle', vtt: st.pendingSub.vtt, name: st.pendingSub.name, langCode: st.pendingSub.langCode || 'id' })
          .catch(() => null);
        if (!att) return { ok: false, reason: t('panel.subs.noContent') };
        if (att.applied === 0) return { ok: false, reason: t('panel.subs.noPlayer') };
        return { ok: true, attached: att.applied };
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
          st.pendingSub = { vtt: vtt, name: it.filename || it.name, provider: it.provider, langCode: it.langCode || 'id' };
          st.sub.chosen = { index: Number(msg.index || 0), name: it.name };
          // One click = done: attach straight to the page player (blob URL, no
          // local download). The toast keeps a Download action for people who
          // still want the file.
          let att = await api.tabs
            .sendMessage(tabId, { type: 'attach-subtitle', vtt: vtt, name: st.pendingSub.name, langCode: st.pendingSub.langCode })
            .catch(() => null);
          if (!att) {
            // Content script dead (tab opened before the extension reloaded):
            // re-inject it, then retry once before giving up honestly.
            await ensureContentAlive(tabId);
            att = await api.tabs
              .sendMessage(tabId, { type: 'attach-subtitle', vtt: vtt, name: st.pendingSub.name, langCode: st.pendingSub.langCode })
              .catch(() => null);
          }
          const applied = att && att.applied;
          if (!att) {
            // Content script unreachable: be honest, offer the manual attach path.
            toastTo(tabId, t('panel.subs.found') + ': ' + shorten(it.name || it.filename, 30), 'ok', { id: 'sub-attach', label: t('panel.subs.attach') });
          } else {
            const done = applied === 'queued' ? t('panel.subs.attachedQueued') : t('panel.subs.attached', { name: shorten(it.name || it.filename, 30) });
            toastTo(tabId, done, 'ok', { id: 'sub-download', label: t('panel.subs.download') });
          }
          broadcast(tabId, 'sub');
          return { ok: true, attached: !!applied };
        } catch (e) {
          const reason = String((e && e.message) || e);
          toastTo(tabId, t('panel.subs.attachFail', { reason: shorten(reason, 90) }), 'err');
          return { ok: false, reason: reason };
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
      case 'options':
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
      case 'update-check':
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
            const rec = { url: msg.href || sender.url || '', top: !!p.isTop, version: p.version, hooks: hooks, frameId: sender.frameId };
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
              await installPartyNetRules(tabId, payload.referer, payload.origin, payload.mediaUrl);
              const href = (sender && (sender.url || (sender.tab && sender.tab.url))) || '';
              if (/watchparty\.me\/watch\//i.test(href)) await api.storage.local.remove(key);
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
          case 'party-fetch': {
            return await partyFetch(tabId, msg.url, msg.responseType, msg.range);
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
        }
        if (sid || partyTabs.has(id)) dropRefererRule(id);
        partyTabs.delete(id);
        try {
          api.storage.local.remove('srad:partynet:' + id);
        } catch (_) {}
      });
    }
    if (api.tabs.onUpdated) {
      api.tabs.onUpdated.addListener((id, change) => {
        if (partyTabs.has(id) && (change.status === 'complete' || change.url)) {
          const p = partyTabs.get(id);
          installPartyNetRules(id, p.referer, p.origin, p.mediaUrl);
        }
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
        if (info.menuItemId === 'sr-play') {
          const best = st.store.best() || {};
          await launchPlayer(st, best.id, url || undefined);
        } else if (info.menuItemId === 'sr-watchparty') {
          const best = st.store.best() || {};
          await launchWatchParty(st, best.id);
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
