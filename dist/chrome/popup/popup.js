/**
 * Stream Radar — toolbar popup.
 * Thin view over the background state for the *active tab* (plus a browser-wide
 * recent list). Every control mirrors what the in-page panel offers, so users
 * can act even when the page UI is hidden/disabled.
 */
(function () {
  'use strict';
  const SR = globalThis.SR || {};
  const util = SR.util;
  const api = util.api();
  const t = (k, v) => SR.i18n.t(k, v);
  const $ = (s) => document.querySelector(s);
  const esc = util.esc;
  const ico = (n) => (SR.icons ? SR.icons(n) : '');

  let tabId = null;
  let state = { items: [], ads: [], title: null, settings: {}, sub: { status: 'idle', items: [] }, layers: {} };
  let showAds = false;

  /* ---------------- data ---------------- */
  async function refresh() {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    tabId = tab.id;
    const res = await api.runtime.sendMessage({ type: 'action', payload: { name: 'get-state', tabId: tabId } }).catch(() => null);
    if (res && res.ok) {
      state = res.state || state;
      state.history = res.history || [];
    } else if (tab.id != null) {
      // content script state is authoritative for pages where the worker has no data
      const fromContent = await api.tabs.sendMessage(tabId, { type: 'ping' }).catch(() => null);
      state.page = fromContent;
    }
    render();
  }

  function render() {
    const s = state.settings || {};
    showAds = !!s.showAds;
    // language follows settings (auto = browser locale), then static labels
    SR.i18n.set(resolvedLang(s.lang));
    document.body.setAttribute('data-theme', resolvedTheme(s.theme));
    $('#brandIco').innerHTML = ico('radar');
    updateThemeBtn(s.theme);
    $('#refreshBtn').innerHTML = ico('refresh-cw');
    $('#optionsBtn').innerHTML = ico('settings');
    $('#brandSub').textContent = (state.title && state.title.title) || util.host((state.title && state.title.url) || '') || t('app.tagline');
    renderLayers();
    renderMeta();
    renderSubs();
    renderList();
    renderHistory();
    const enable = $('#enableSite');
    enable.checked = !s.blockedHosts || !s.blockedHosts[util.host((state.title && state.title.url) || location.host)] ? true : false;
    $('#enableLabel').textContent = s.enabled === false ? t('popup.disabled') : t('popup.tabMedia');
    // static labels last, so every dynamic node above is translated too
    SR.i18n.apply(document);
  }

  function resolvedLang(pref) {
    if (pref === 'en' || pref === 'id') return pref;
    return SR.i18n.detect(navigator);
  }

  function resolvedTheme(pref) {
    if (pref === 'dark' || pref === 'light') return pref;
    try {
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
      return 'dark';
    }
  }

  // Smart theme cycle: the first click always changes something visible. From
  // "system" jump to the opposite of what is currently shown; explicit light
  // and dark just swap, so the cycle is system > opposite-in-effect > ... .
  function nextTheme(pref) {
    const effective = resolvedTheme(pref);
    if (pref === 'system' || !pref) return effective === 'dark' ? 'light' : 'dark';
    if (pref === 'dark') return 'light';
    return 'system';
  }
  function prefIcon(pref) {
    if (pref === 'dark') return 'moon';
    if (pref === 'light') return 'sun';
    return 'monitor-smartphone';
  }
  function updateThemeBtn(pref) {
    const btn = $('#themeBtn');
    if (!btn) return;
    const p = pref || 'system';
    const effective = resolvedTheme(p);
    const nxt = nextTheme(p);
    btn.innerHTML = ico(prefIcon(p));
    btn.setAttribute('data-pref', p);
    const effKey = effective === 'dark' ? 'theme.nowDark' : 'theme.nowLight';
    const nextKey = nxt === 'dark' ? 'theme.nextDark' : nxt === 'light' ? 'theme.nextLight' : 'theme.nextSystem';
    const label = t('theme.btnLabel', { pref: t('theme.' + p) || p, effective: t(effKey), next: t(nextKey) });
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
  }

  function renderLayers() {
    const L = state.layers || {};
    const defs = [
      ['network', 'L1', t('panel.detecting')],
      ['dom', 'L2', 'DOM'],
      ['mse', 'L3', 'MSE'],
      ['sw', 'L4', 'SW/Cache'],
      ['heuristic', 'L5', 'Heuristics'],
    ];
    $('#layers').innerHTML = defs
      .map(([k, n, label]) => `<div class="layer" data-on="${L[k] ? 1 : 0}" title="${esc(label)}"><b>${n}</b>${esc(label)}</div>`)
      .join('');
  }

  function renderMeta() {
    const info = state.title || {};
    $('#metaTitle').textContent = info.title || t('panel.empty');
    const chips = [];
    if (info.year) chips.push(`<span class="chip" data-tone="ep">${esc(info.year)}</span>`);
    const ep = SR.title.episodeLabel(info);
    if (ep) chips.push(`<span class="chip" data-tone="ep">${esc(ep)}</span>`);
    if (info.imdbId) chips.push(`<span class="chip">${esc(info.imdbId)}</span>`);
    if (info.isJunk || !info.title) chips.push(`<span class="chip" data-tone="warn">title not resolved</span>`);
    if (state.drm) chips.push(`<span class="chip" data-tone="err">${esc(t('label.drm'))} ${esc(state.drm)}</span>`);
    if (state.frames && state.frames.length) chips.push(`<span class="chip">${state.frames.length} frame${state.frames.length > 1 ? 's' : ''}</span>`);
    if (state.players && state.players.length) chips.push(`<span class="chip">${esc('players: ' + state.players.join(', '))}</span>`);
    const total = (state.items || []).length;
    chips.push(`<span class="chip" data-tone="q">${esc(t('panel.items', { n: total }))}</span>`);
    if ((state.ads || []).length) chips.push(`<span class="chip" data-tone="warn">${esc(t('panel.ads', { n: state.ads.length }))}</span>`);
    $('#metaChips').innerHTML = chips.join('');
  }

  function renderSubs() {
    const sub = state.sub || { status: 'idle', items: [] };
    const labels = {
      idle: t('action.subs'),
      searching: t('panel.subs.searching'),
      found: t('panel.subs.found'),
      none: t('panel.subs.none'),
      error: t('panel.subs.error'),
      skipped: t('panel.subs.skipped'),
    };
    $('#subsStatus').textContent = labels[sub.status] || sub.status;
    $('#subsStatus').setAttribute('data-s', sub.status);
    const pv = sub.providers || {};
    $('#subsProviders').innerHTML = Object.keys(pv)
      .map((k) => `<span class="pv" data-s="${esc(pv[k].status)}" title="${esc(pv[k].reason || '')}">${esc(pv[k].label || k)}: ${esc(pv[k].count != null ? pv[k].count : pv[k].status)}</span>`)
      .join('');
    $('#subsList').innerHTML = (sub.items || [])
      .slice(0, 5)
      .map(
        (it, i) =>
          `<div class="sub-item"><button class="btn tiny" data-act="sub-pick" data-i="${i}">${i === 0 ? 'Use' : 'Pick'}</button><span title="${esc(it.name)}">${esc(it.name || it.filename)}</span><b>${esc(it.providerLabel || it.provider)} ${esc(it.format || 'srt')}</b></div>`
      )
      .join('');
    $('#subsSearch').textContent = t('panel.subs.retry');
    $('#subsAttach').textContent = t('panel.subs.attach');
    $('#subsDl').textContent = t('panel.subs.download');
  }

  function renderList() {
    const items = (state.items || []).concat(showAds ? state.ads || [] : []);
    const list = $('#list');
    if (!items.length) {
      list.innerHTML = `<div class="empty"><strong>${esc(t('panel.empty'))}</strong>${esc(t('panel.emptyHint'))}</div>`;
      return;
    }
    list.innerHTML = items.map(itemHtml).join('');
  }

  function itemHtml(it) {
    const label = SR.rules.CATEGORY_LABEL[it.category] || (it.category || '').toUpperCase();
    const tags = [];
    if (it.quality) tags.push(`<span class="chip" data-tone="q">${esc(it.quality)}</span>`);
    if (it.sizeLabel) tags.push(`<span class="chip">${esc(it.sizeLabel)}</span>`);
    if (it.durationLabel) tags.push(`<span class="chip">${esc(it.durationLabel)}</span>`);
    if (it.segmentCount) tags.push(`<span class="chip">${esc(t('label.segments', { n: it.segmentCount, size: it.segmentBytesLabel || '' }))}</span>`);
    if (it.aes) tags.push(`<span class="chip" data-tone="warn">${esc(t('label.aes'))}</span>`);
    if (it.drm) tags.push(`<span class="chip" data-tone="err">${esc(it.drm)}</span>`);
    if (it.isAd) tags.push(`<span class="chip" data-tone="err">AD</span>`);
    if (it.via && it.via.length) tags.push(`<span class="chip" title="${esc(it.via.join(', '))}">${it.via.length} src</span>`);
    const canDl = it.kind !== 'segmentgroup';
    const name = it.name || it.url.split('/').pop().slice(0, 48);
    return `<div class="row" data-id="${esc(it.id)}">
      <div class="cat" data-c="${esc(it.category)}">${esc(label.slice(0, 5))}</div>
      <div>
        <div class="rname" title="${esc(it.url)}">${esc(name)}</div>
        <div class="rurl">${esc(it.host || util.host(it.url))}</div>
        <div class="rtags">${tags.join('')}</div>
        <div class="acts">
          <button class="btn" data-primary="1" data-act="watchparty">${ico('users')}${esc(t('action.watchparty'))}</button>
          <button class="btn" data-act="copy">${ico('copy')}${esc(t('action.copy'))}</button>
          ${canDl ? `<button class="btn" data-act="download">${esc(it.category === 'hls' || it.category === 'dash' ? '.m3u8/.mpd' : t('action.download'))}</button>` : ''}
          <button class="btn" data-act="subs">${ico('captions')}${esc(t('action.subs'))}</button>
          <button class="btn" data-act="open" title="${esc(t('action.open'))}">${ico('external-link')}</button>
        </div>
      </div>
    </div>`;
  }

  function renderHistory() {
    const list = (state.history || []).slice(0, 12);
    $('#histList').innerHTML = list.length
      ? list
          .map(
            (h, i) =>
              `<div class="hist"><span title="${esc(h.url)}">${esc(h.title || h.host || '')} ${esc((h.category || '').toUpperCase())}</span><button data-act="hist-copy" data-i="${i}">${esc(t('action.copy'))}</button></div>`
          )
          .join('')
      : '<div class="hist"><span>-</span></div>';
  }

  /* ---------------- actions ---------------- */
  async function act(name, extra, btn) {
    if (btn) {
      btn.disabled = true;
      setTimeout(() => {
        btn.disabled = false;
      }, 900);
    }
    const payload = Object.assign({ name: name, tabId: tabId }, extra || {});
    if (name === 'copy') {
      const it = findItem(extra.id);
      try {
        await navigator.clipboard.writeText(it.url);
        toast(t('toast.copied'), 'ok');
      } catch (_) {
        toast(t('toast.error', { msg: 'clipboard' }), 'err');
      }
      return;
    }
    if (name === 'hist-copy') {
      const h = (state.history || [])[extra.index];
      if (h) await navigator.clipboard.writeText(h.url).catch(() => {});
      toast(t('toast.copied'), 'ok');
      return;
    }
    if (name === 'toggle-site') {
      await api.runtime.sendMessage({ type: 'action', payload }).catch(() => {});
      return refresh();
    }
    if (name === 'set-setting') {
      await api.runtime.sendMessage({ type: 'action', payload: { name: 'set-setting', key: extra.key, value: extra.value, tabId: tabId } }).catch(() => {});
      return refresh();
    }
    const res = await api.runtime.sendMessage({ type: 'action', payload }).catch((e) => ({ ok: false, reason: String(e && e.message) }));
    if (res && res.ok === false && res.reason) toast(t('toast.error', { msg: res.reason }), 'err');
    if (res && res.ok === false && res.fallback) toast('opened in a new tab instead', 'warn');
    setTimeout(refresh, 700);
  }

  function findItem(id) {
    return (state.items || []).concat(state.ads || []).find((x) => x.id === id) || { url: '' };
  }

  let toastN = 0;
  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('data-k', kind || 'info');
    el.textContent = text;
    $('#toasts').appendChild(el);
    const my = ++toastN;
    setTimeout(() => {
      if (!el.parentNode) return;
      el.remove();
      if (my === toastN) $('#toasts').innerHTML = '';
    }, 3600);
  }

  /* ---------------- events ---------------- */
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = btn.closest('[data-id]');
    const id = row ? row.getAttribute('data-id') : null;
    const actName = btn.getAttribute('data-act');
    if (actName === 'hist-copy') return act('hist-copy', { index: Number(btn.getAttribute('data-i')) }, btn);
    if (actName === 'sub-pick') return act('sub-pick', { index: Number(btn.getAttribute('data-i')) }, btn);
    if (['watchparty', 'copy', 'download', 'subs', 'open', 'clear', 'sub-attach', 'sub-download'].indexOf(actName) < 0) return;
    await act(actName, id ? { id: id } : {}, btn);
  });

  $('#subsSearch').addEventListener('click', () => act('subs-search', {}, $('#subsSearch')));
  $('#subsAttach').addEventListener('click', () => act('sub-attach', {}, $('#subsAttach')));
  $('#subsDl').addEventListener('click', () => act('sub-download', {}, $('#subsDl')));
  $('#refreshBtn').addEventListener('click', () => {
    api.tabs.sendMessage(tabId, { type: 'clear-seen' }).catch(() => {});
    act('rescan', {}, $('#refreshBtn'));
  });
  $('#clearBtn').addEventListener('click', () => act('clear', {}, $('#clearBtn')));
  $('#optionsBtn').addEventListener('click', () => api.runtime.sendMessage({ type: 'action', payload: { name: 'open-options', tabId: tabId } }).catch(() => {}));
  $('#themeBtn').addEventListener('click', () => {
    const cur = (state.settings || {}).theme || 'system';
    act('set-setting', { key: 'theme', value: nextTheme(cur) });
  });
  // re-render when the OS colour scheme flips while the popup is open
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => refresh().catch(() => {}));
  } catch (_) {}
  $('#enableSite').addEventListener('change', (e) => act('toggle-site', { value: !e.target.checked }));
  $('#histToggle').addEventListener('click', (e) => {
    const box = $('#histList');
    box.hidden = !box.hidden;
    e.target.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
  });

  api.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'state-global' && msg.tabId === tabId) {
      state = Object.assign({}, state, msg.payload || {});
      render();
    }
  });

  if (SR.i18n) SR.i18n.set((state.settings && state.settings.lang) === 'id' ? 'id' : SR.i18n.detect(navigator));
  refresh();
  const timer = setInterval(refresh, 4000);
  window.addEventListener('unload', () => clearInterval(timer));
})();
