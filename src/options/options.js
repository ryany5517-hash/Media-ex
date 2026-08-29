/**
 * Stream Radar — options / settings page.
 * Writes straight into the shared settings object (storage.local), which the
 * background worker and every content script observe through
 * `storage.onChanged` — so changes apply to open tabs instantly.
 */
(function () {
  'use strict';
  const SR = globalThis.SR;
  const util = SR.util;
  const api = util.api();
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  let settings = Object.assign({}, SR.defaults);

  /* ---------------- helpers ---------------- */
  const getPath = (obj, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  const setPath = (obj, key, value) => {
    const parts = key.split('.');
    let o = obj;
    while (parts.length > 1) {
      const k = parts.shift();
      o[k] = Object.assign({}, o[k]);
      o = o[k];
    }
    o[parts[0]] = value;
  };

  function applyTheme() {
    const pref = settings.theme || 'system';
    const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  function fill() {
    $$('[data-key]').forEach((el) => {
      const key = el.getAttribute('data-key');
      const val = getPath(settings, key);
      if (el.classList.contains('seg')) {
        $$('button', el).forEach((b) => b.setAttribute('data-on', b.getAttribute('data-v') === val ? '1' : '0'));
        return;
      }
      if (el.type === 'checkbox') el.checked = !!val;
      else if (el.type === 'number') el.value = val == null ? '' : String(val);
      else el.value = val == null ? '' : String(val);
    });
    const hosts = Object.keys(settings.blockedHosts || {}).filter((h) => settings.blockedHosts[h]);
    $('#blockedHosts').value = hosts.join('\n');
    $('#fabPosLabel').textContent = settings.fabPos ? settings.fabPos.x + ', ' + settings.fabPos.y : 'default';
    SR.i18n.set(settings.lang && settings.lang !== 'auto' ? settings.lang : SR.i18n.detect(navigator));
    // translate every data-i18n* hook (nav, headings, fields, buttons, title)
    SR.i18n.apply(document);
  }

  async function save(patch, silent) {
    settings = Object.assign({}, settings, patch || {});
    settings = await SR.settings.save(settings);
    fill();
    flashSaved(silent);
    return settings;
  }

  function flashSaved(silent) {
    const el = $('#saveState');
    if (silent || !el) return;
    el.textContent = SR.i18n.t('common.saved');
    setTimeout(() => {
      el.textContent = '';
    }, 1800);
  }

  /* ---------------- events ---------------- */
  function wire() {
    $$('#tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
        $$('[data-panel]').forEach((p) => (p.hidden = p.getAttribute('data-panel') !== b.getAttribute('data-tab')));
      })
    );

    document.addEventListener('click', (e) => {
      const segBtn = e.target.closest('.seg button');
      if (segBtn) {
        const key = segBtn.closest('[data-key]').getAttribute('data-key');
        return save({ [key]: segBtn.getAttribute('data-v') });
      }
      if (e.target.id === 'saveBtn') {
        return save(collect());
      }
      if (e.target.id === 'resetFab') return save({ fabPos: null });
      if (e.target.id === 'wipeHistory') {
        return api.storage.local.remove('srad:history').then(() => {
          toast('recent list cleared');
          storageInfo();
        });
      }
      if (e.target.id === 'exportBtn') return exportJson();
      if (e.target.id === 'importBtn') return $('#importFile').click();
      if (e.target.id === 'testBtn') return testSearch();
      if (e.target.id === 'checkUpdates') return checkUpdates();
      if (e.target.id === 'resetBtn') {
        if (!confirm('Reset all Stream Radar settings? API keys will be removed.')) return;
        return SR.settings.save(Object.assign({}, SR.defaults)).then(() => {
          settings = Object.assign({}, SR.defaults);
          fill();
          toast('settings reset');
        });
      }
    });

    // inputs: save on change (debounced) so typing an API key does not spam writes
    const commit = util.debounce(() => save(collect()), 700);
    $$('[data-key]').forEach((el) => {
      if (el.classList.contains('seg')) return;
      el.addEventListener('change', () => {
        save(collect());
      });
      el.addEventListener('input', () => {
        const key = el.getAttribute('data-key');
        setPath(settings, key, value(el));
        commit();
      });
    });
    $('#blockedHosts').addEventListener('change', () => {
      const list = {};
      for (const line of $('#blockedHosts').value.split(/\r?\n/)) {
        const h = line.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (h) list[h] = true;
      }
      save({ blockedHosts: list });
    });
    $('#importFile').addEventListener('change', (e) => importJson(e.target.files[0]));
    if (api.storage.onChanged) {
      api.storage.onChanged.addListener((ch) => {
        if (ch['srad:settings']) {
          settings = SR.settings.merge(ch['srad:settings'].newValue || {});
          fill();
          applyTheme();
        }
        if (ch['srad:history']) storageInfo();
      });
    }
  }

  function value(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') return Number(el.value) || 0;
    return el.value;
  }

  function collect() {
    const out = {};
    $$('[data-key]').forEach((el) => {
      if (el.classList.contains('seg')) return;
      setPath(out, el.getAttribute('data-key'), value(el));
    });
    return Object.assign({}, settings, out);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'stream-radar-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function importJson(file) {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = async () => {
      const data = util.safeJSON(fr.result, null);
      if (!data || typeof data !== 'object') return toast('not a valid settings file', 'err');
      await save(SR.settings.merge(data));
      toast('settings imported');
    };
    fr.readAsText(file);
  }

  async function testSearch() {
    const out = $('#testOut');
    out.textContent = '...';
    const want = {
      title: $('#testTitle').value.trim() || 'Dune Part Two',
      year: $('#testYear').value.trim() || null,
      season: $('#testSeason').value.trim() || null,
      episode: $('#testEpisode').value.trim() || null,
    };
    try {
      const res = await SR.subs.search(want, settings, {});
      out.textContent =
        'query: ' + JSON.stringify(want) + '\nproviders: ' + JSON.stringify(res.providerInfo, null, 1) + '\nerrors: ' + (res.errors.join('; ') || 'none') +
        '\n\n' + (res.results.length ? res.results.map((r) => `#${r.rank} [${r.providerLabel}] ${r.name} [${r.langCode}] ${r.format} score ${r.score}`).join('\n') : 'no results');
      if (res.results[0]) out.textContent += '\n\nTip: use Pick in the popup to download and convert that one to WebVTT.';
    } catch (e) {
      out.textContent = 'failed: ' + ((e && e.stack) || e);
    }
  }

  function renderUpdateCard(status, st) {
    const card = $('#updateCard');
    if (!card) return;
    const t = SR.i18n.t;
    const stateMap = {
      current: 'current', updated: 'updated', error: 'error',
      incompatible: 'error', disabled: 'idle', checking: 'checking',
    };
    const state = stateMap[status] || (status ? 'idle' : 'idle');
    card.setAttribute('data-state', state);
    const titleKey = {
      current: 'update.stateCurrent', updated: 'update.stateUpdated', error: 'update.stateError',
      incompatible: 'update.stateIncompat', checking: 'update.stateChecking', idle: 'update.stateIdle',
    }[state] || 'update.stateIdle';
    $('#updateStatusTitle').textContent = t(titleKey);
    $('#updateStatusSub').textContent = t('update.hint');

    const d = (st && st.dynamic) || {};
    const chip = (id, text, on) => { const el = $(id); if (!el) return; el.textContent = text; el.setAttribute('data-on', on ? '1' : '0'); };
    chip('#chipPack', t('update.packVersion', { v: d.version || 0 }), d.version > 0);
    chip('#chipHosts', t('update.hostsAdded', { n: d.embedHosts || 0 }), (d.embedHosts || 0) > 0);
    chip('#chipAds', t('update.adsAdded', { n: d.adHosts || 0 }), (d.adHosts || 0) > 0);
    chip('#chipSig', d.signed ? t('update.sigOk') : t('update.sigNone'), !!d.signed);
    chip('#chipPatch', t('update.patchVersion', { v: (st && st.patch) || 0 }), (st && st.patch) > 0);
  }

  async function checkUpdates() {
    const out = $('#updateOut');
    renderUpdateCard('checking', null);
    out.hidden = true;
    try {
      const res = await api.runtime.sendMessage({ type: 'action', payload: { name: 'check-updates' } });
      const st = await api.runtime.sendMessage({ type: 'action', payload: { name: 'update-status' } });
      const status = (res && res.status) || 'error';
      renderUpdateCard(status, st);
      out.hidden = false;
      out.textContent = JSON.stringify({ check: res, status: st }, null, 1);
    } catch (e) {
      renderUpdateCard('error', null);
      out.hidden = false;
      out.textContent = String((e && e.message) || e);
    }
  }

  async function updateInfo() {
    try {
      const st = await api.runtime.sendMessage({ type: 'action', payload: { name: 'update-status' } });
      const d = (st && st.dynamic) || {};
      // before the user ever presses "Check now" show the last known pack state
      const status = d.version > 0 ? (st && st.lastStatus) || 'current' : 'idle';
      renderUpdateCard(status, st);
    } catch (_) {
      renderUpdateCard('error', null);
    }
  }

  async function storageInfo() {
    try {
      const bytes = await (api.storage.local.getBytesInUse ? api.storage.local.getBytesInUse() : Promise.resolve(-1));
      const h = (await api.storage.local.get('srad:history'))['srad:history'] || [];
      $('#storageInfo').textContent =
        (bytes > 0 ? util.formatBytes(bytes) + ' used, ' : '') + h.length + ' saved stream links, settings key: srad:settings';
    } catch (_) {
      $('#storageInfo').textContent = 'storage: ' + Object.keys(settings).length + ' keys';
    }
  }

  let toastTimer;
  function toast(text, kind) {
    const el = document.createElement('div');
    el.textContent = text;
    el.className = 'opt-toast' + (kind ? ' data-' + kind : '');
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3000);
  }

  async function boot() {
    const url = new URL(location.href);
    if (url.searchParams.get('welcome') === '1') toast('Welcome! Add a SubDL API key to auto-fetch Indonesian subtitles.', 'ok');
    settings = await SR.settings.load(true);
    SR.i18n.set(settings.lang && settings.lang !== 'auto' ? settings.lang : SR.i18n.detect(navigator));
    applyTheme();
    fill();
    wire();
    storageInfo();
    updateInfo();
    applyLive();
  }
  // Live fixes reach the options page: run the verified pack (and the code
  // patch only when opted in) so even settings UI can be improved remotely.
  function applyLive() {
    SR.util.api().runtime.sendMessage({ type: 'get-live' }).then((res) => {
      if (res && res.ok && SR.updater) {
        const allowed = res.settings && res.settings.autoPatch === true;
        SR.updater.applyRemote(res.pack, allowed ? res.patch : null, res.settings);
        updateInfo();
      }
    }).catch(() => {});
  }
  SR.util.api().runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'rules') applyLive();
  });
  boot();
})();
