/**
 * Stream Radar — the whole UI (FAB + panel + toasts + settings popover).
 * ------------------------------------------------------------------
 * Rendered inside a *closed shadow root* on every frame's document, so the
 * page cannot restyle it and it cannot restyle the page.
 * Pure view: it never fetches anything itself, it calls `onAction()` and the
 * content script relays that to the background worker, then re-renders us.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;

  const ICONS = {
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M7 4v16M17 4v16M2.5 9.3h4.5M2.5 14.7h4.5M17 9.3h4.5M17 14.7h4.5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15H4.5a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.06-.06A2 2 0 1 1 8.57 5.2l.06.06A1.7 1.7 0 0 0 10.5 4.6V4.5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.1a1.7 1.7 0 0 0 1.57 1.04h.14a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1.2z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.8 4.2v5h-5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M5 15.5A2.5 2.5 0 0 1 3.6 13V5.6A2.6 2.6 0 0 1 6.2 3h7.4A2.6 2.6 0 0 1 16 5.6"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 3.6v11M7.4 10.2 12 14.8l4.6-4.6M4.5 19.4h15"/></svg>',
    party: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20.5 8 9l8.5 3.5z"/><path d="M14.5 4.2a3 3 0 0 1 5.6 2M17.6 2.5l.9 1.7M21.4 5.4l-1.9.7"/></svg>',
    subs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2.6" y="4.6" width="18.8" height="14.8" rx="3"/><path d="M6.4 13.2h5M13.6 13.2h4M6.4 9.4h3.2M11.6 9.4h6"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14.5V18a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V8.5A2.5 2.5 0 0 1 6 6h3.6"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M20 14.4A8.4 8.4 0 0 1 9.6 4 8.6 8.6 0 1 0 20 14.4z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4.5 12.5 9.5 17.5 20 6.5"/></svg>',
    rec: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 10.5 12 14.5 16 10.5"/></svg>',
  };

  const t = (k, v) => SR.i18n.t(k, v);

  SR.ui = {
    /**
     * @param {{onAction:Function, getSettings:Function, isTopFrame?:boolean}} opts
     */
    create(opts) {
      const o = opts || {};
      const api = { open: false, lastCount: 0, items: [], ads: [], settings: {}, state: null, theme: 'system' };
      let host, shadow, rootEl, fab, badge, panel, listEl, toastsEl, popEl, liveEl;
      let drag = null;
      let mounted = false;

      /* ---------- mount ---------- */
      function mount() {
        if (mounted || !root.document || !root.document.documentElement) return false;
        mounted = true;
        host = root.document.createElement('div');
        host.id = 'stream-radar-host';
        host.setAttribute('data-srad', '1');
        // `closed` by default so the host page can never reach our UI.
        // (tests pass shadowMode:'open' to assert the generated markup)
        shadow = host.attachShadow({ mode: o.shadowMode === 'open' ? 'open' : 'closed', delegatesFocus: false });

        const style = root.document.createElement('style');
        style.textContent = SR.uiCss;
        shadow.appendChild(style);

        rootEl = root.document.createElement('div');
        rootEl.className = 'srad-root';
        rootEl.setAttribute('dir', 'ltr');
        rootEl.innerHTML =
          '<div class="srad-toasts" part="toasts" aria-live="polite" aria-atomic="false"></div>' +
          '<div class="srad-panel" role="dialog" aria-modal="false" aria-label="' + util.esc(t('panel.title')) + '" data-open="0"></div>' +
          '<div class="srad-fab" role="button" tabindex="0" aria-haspopup="dialog" aria-expanded="false"></div>' +
          '<div class="srad-sr" aria-live="polite"></div>';
        shadow.appendChild(rootEl);

        fab = rootEl.querySelector('.srad-fab');
        badge = root.document.createElement('div');
        badge.className = 'srad-badge';
        badge.setAttribute('aria-hidden', 'true');
        fab.appendChild(badge);
        fab.insertAdjacentHTML('afterbegin', ICONS.film);
        panel = rootEl.querySelector('.srad-panel');
        toastsEl = rootEl.querySelector('.srad-toasts');
        liveEl = rootEl.querySelector('.srad-sr');
        renderPanelShell();
        wireEvents();
        applyFabPos((o.getSettings && o.getSettings().fabPos) || null);
        applyTheme();
        const attach = () => {
          const target = root.document.body || root.document.documentElement;
          if (target && host.parentNode !== target) target.appendChild(host);
        };
        attach();
        if (!root.document.body) {
          root.document.addEventListener('DOMContentLoaded', attach, { once: true });
        }
        return true;
      }

      /* ---------- panel skeleton ---------- */
      function renderPanelShell() {
        panel.innerHTML =
          '<div class="srad-head">' +
          '<span class="srad-title"><span class="srad-dot"></span><span>' +
          '<span data-el="title">' + util.esc(t('panel.title')) + '</span>' +
          '<small data-el="subtitle">' + util.esc(t('app.tagline')) + '</small></span></span>' +
          '<span class="srad-spacer"></span>' +
          '<button class="srad-iconbtn" data-act="theme" title="theme" aria-label="' + util.esc(t('common.theme')) + '">' + ICONS.sun + '</button>' +
          '<button class="srad-iconbtn" data-act="refresh" aria-label="' + util.esc(t('panel.refresh')) + '" title="' + util.esc(t('panel.refresh')) + '">' + ICONS.refresh + '</button>' +
          '<button class="srad-iconbtn" data-act="settings" aria-label="' + util.esc(t('panel.settings')) + '" title="' + util.esc(t('panel.settings')) + '">' + ICONS.gear + '</button>' +
          '<button class="srad-iconbtn" data-act="close" aria-label="' + util.esc(t('common.close')) + '" title="' + util.esc(t('common.close')) + '">' + ICONS.close + '</button>' +
          '</div>' +
          '<div class="srad-meta" data-el="meta"></div>' +
          '<div class="srad-list" role="list" tabindex="-1" data-el="list"></div>' +
          '<div class="srad-foot">' +
          '<label class="srad-switch" title="' + util.esc(t('panel.detecting')) + '"><input type="checkbox" data-act="toggle-auto" checked><span class="srad-slider"></span><span>' + util.esc(t('panel.detecting')) + '</span></label>' +
          '<span class="srad-spacer"></span>' +
          '<button class="srad-btn" data-act="ads"><span data-el="adslabel"></span></button>' +
          '<button class="srad-btn" data-act="options" title="' + util.esc(t('panel.openPanel')) + '">' + ICONS.open + '<span>' + util.esc(t('panel.settings')) + '</span></button>' +
          '<button class="srad-btn" data-act="clear">' + util.esc(t('panel.clear')) + '</button>' +
          '</div>' +
          '<div class="srad-pop" data-el="pop" role="region" aria-label="' + util.esc(t('panel.settings')) + '">' +
          '<div class="srad-head"><span class="srad-title">' + util.esc(t('settings.title')) + '</span><span class="srad-spacer"></span>' +
          '<button class="srad-iconbtn" data-act="popclose" aria-label="' + util.esc(t('common.close')) + '">' + ICONS.close + '</button></div>' +
          '<div class="srad-popbody" data-el="popbody"></div></div>';
        listEl = panel.querySelector('[data-el="list"]');
      }

      /* ---------- events ---------- */
      function wireEvents() {
        fab.addEventListener('click', () => toggle());
        fab.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        });
        fab.addEventListener('pointerdown', onPointerDown);
        root.addEventListener('pointermove', onPointerMove, { passive: true });
        root.addEventListener('pointerup', onPointerUp);
        root.addEventListener('pointercancel', onPointerUp);

        panel.addEventListener('click', onPanelClick);
        panel.addEventListener('keydown', onPanelKey);
        panel.addEventListener('change', (e) => {
          const act = e.target.getAttribute('data-act');
          if (act === 'toggle-auto') fire('set-setting', { key: 'enabled', value: e.target.checked });
          else if (act && act.startsWith('set:')) fire('set-setting', { key: act.slice(4), value: e.target.checked });
        });
        root.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && api.open) {
            e.preventDefault();
            setOpen(false);
            fab.focus();
          }
        }, true);
        root.addEventListener(
          'pointerdown',
          (e) => {
            if (!api.open || !root.document) return;
            const path = e.composedPath ? e.composedPath() : [e.target];
            if (path.indexOf(host) >= 0) return;
            if (e.target === root.document.documentElement || e.target === root.document.body) setOpen(false);
          },
          true
        );
        // re-clamp on resize
        root.addEventListener('resize', util.throttle(() => applyFabPos(currentFabPos()), 250));
      }

      function onPanelClick(e) {
        const btn = e.target.closest ? e.target.closest('[data-act],[data-variant-id]') : null;
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        const id = btn.getAttribute('data-id') || (btn.closest('[data-id]') ? btn.closest('[data-id]').getAttribute('data-id') : null);
        if (act === 'close') return setOpen(false);
        if (act === 'theme') return cycleTheme();
        if (act === 'settings') return openPop(true);
        if (act === 'popclose') return openPop(false);
        if (act === 'options') return fire('open-options');
        if (act === 'refresh') {
          btn.setAttribute('data-done', '1');
          fire('scan-now');
          setTimeout(() => btn.removeAttribute('data-done'), 900);
          return;
        }
        if (act === 'clear') return fire('clear');
        if (act === 'ads') {
          api.showAds = !api.showAds;
          fire('set-setting', { key: 'showAds', value: api.showAds });
          render(api.state);
          return;
        }
        if (act === 'toggle-expand') {
          const item = btn.closest('.srad-item');
          if (item) item.setAttribute('data-expanded', item.getAttribute('data-expanded') === '1' ? '0' : '1');
          return;
        }
        if (!act || !id) {
          const vbtn = e.target.closest ? e.target.closest('[data-variant-id]') : null;
          if (vbtn) {
            fire('variant', { id: id, index: Number(vbtn.getAttribute('data-variant-id')) });
          }
          return;
        }
        fire(act, { id: id, button: btn });
      }

      function onPanelKey(e) {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const items = [...panel.querySelectorAll('.srad-item')];
        if (!items.length) return;
        const cur = items.indexOf(e.target.closest('.srad-item'));
        const next = util.clamp((cur < 0 ? 0 : cur) + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1);
        e.preventDefault();
        const focusable = items[next].querySelector('.srad-btn, .srad-iconbtn');
        (focusable || items[next]).focus && items[next].scrollIntoView({ block: 'nearest' });
        if (focusable) focusable.focus();
        items.forEach((el, i) => el.setAttribute('data-active', i === next ? '1' : '0'));
      }

      function fire(action, payload) {
        try {
          if (o.onAction) o.onAction(action, payload || {});
        } catch (_) {}
      }

      /* ---------- FAB drag + position ---------- */
      let moved = false;
      function onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        drag = { x: e.clientX, y: e.clientY, ox: fab.offsetLeft, oy: fab.offsetTop, startLeft: rectLeft(), startTop: rectTop(), id: e.pointerId };
        moved = false;
        try {
          fab.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      function rectLeft() {
        const r = fab.getBoundingClientRect();
        return r.left;
      }
      function rectTop() {
        const r = fab.getBoundingClientRect();
        return r.top;
      }
      function onPointerMove(e) {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 7) return;
        moved = true;
        fab.setAttribute('data-dragging', '1');
        const w = fab.offsetWidth;
        const h = fab.offsetHeight;
        const left = util.clamp(drag.startLeft + dx, 6, Math.max(8, root.innerWidth - w - 6));
        const top = util.clamp(drag.startTop + dy, 6, Math.max(8, root.innerHeight - h - 6));
        fab.style.left = left + 'px';
        fab.style.top = top + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        positionPanel(left, top, w, h);
      }
      function onPointerUp() {
        if (!drag) return;
        fab.removeAttribute('data-dragging');
        const wasMoved = moved;
        drag = null;
        if (wasMoved) {
          const r = fab.getBoundingClientRect();
          fire('set-setting', { key: 'fabPos', value: { x: Math.round(r.left), y: Math.round(r.top) } });
          moved = false;
        }
      }
      function currentFabPos() {
        const r = fab.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top) };
      }
      function applyFabPos(pos) {
        if (!fab) return;
        if (!pos || typeof pos.x !== 'number') {
          fab.style.left = fab.style.top = 'auto';
          fab.style.right = '20px';
          fab.style.bottom = '20px';
          if (root.innerWidth < 720) {
            fab.style.right = '12px';
            fab.style.bottom = '12px';
          }
          positionPanel();
          return;
        }
        const w = fab.offsetWidth || 58;
        const h = fab.offsetHeight || 58;
        const left = util.clamp(pos.x, 6, Math.max(8, root.innerWidth - w - 6));
        const top = util.clamp(pos.y, 6, Math.max(8, root.innerHeight - h - 6));
        fab.style.left = left + 'px';
        fab.style.top = top + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        positionPanel(left, top, w, h);
      }
      /** Keep the panel on the same side as the FAB (and below/below it). */
      function positionPanel(left, top, w, h) {
        if (!panel) return;
        if (left == null) {
          const r = fab.getBoundingClientRect();
          left = r.left;
          top = r.top;
          w = w || r.width;
          h = h || r.height;
        }
        const midX = left + (w || 58) / 2;
        const nearTop = top < root.innerHeight * 0.34;
        const anchor = (nearTop ? 't' : 'b') + (midX < root.innerWidth / 2 ? 'l' : 'r');
        panel.setAttribute('data-anchor', panel.getAttribute('data-anchor') === anchor ? anchor : anchor);
      }

      /* ---------- theme ---------- */
      let mq = null;
      function applyTheme() {
        if (!rootEl) return;
        const s = api.settings || {};
        let theme = s.theme || 'system';
        if (theme === 'system') {
          try {
            mq = mq || root.matchMedia('(prefers-color-scheme: dark)');
            theme = mq.matches ? 'dark' : 'light';
          } catch (_) {
            theme = 'light';
          }
        }
        rootEl.setAttribute('data-theme', theme);
        const btn = panel.querySelector('[data-act="theme"]');
        if (btn) btn.innerHTML = theme === 'dark' ? ICONS.moon : ICONS.sun;
        try {
          root.document.documentElement.setAttribute('data-srad-theme', theme);
        } catch (_) {}
      }
      function cycleTheme() {
        const order = ['system', 'dark', 'light'];
        const cur = (api.settings && api.settings.theme) || 'system';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        fire('set-setting', { key: 'theme', value: next });
      }
      if (root.matchMedia) {
        try {
          root.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (!api.settings || api.settings.theme === 'system') applyTheme();
          });
        } catch (_) {}
      }

      /* ---------- settings popover ---------- */
      function openPop(on) {
        const pop = panel.querySelector('[data-el="pop"]');
        if (!pop) return;
        if (on) renderPop();
        pop.setAttribute('data-open', on ? '1' : '0');
      }
      function renderPop() {
        const s = api.settings || {};
        const rows = [
          switchRow('enabled', 'Auto-detect (master)', 'Nyalakan/matikan deteksi di situs ini'),
          switchRow('layerNetwork', 'Layer 1 · Network intercept', 'fetch / XHR / WebSocket + webRequest'),
          switchRow('layerDom', 'Layer 2 · DOM deep scan', 'video, source, iframe, embed, object + MutationObserver'),
          switchRow('layerMse', 'Layer 3 · MSE / blob', 'MediaSource, SourceBuffer, createObjectURL'),
          switchRow('layerSw', 'Layer 4 · Service Worker & Cache API', 'scan caches for video responses'),
          switchRow('layerHeuristic', 'Layer 5 · Heuristics', 'inline scripts, resource timing, player configs'),
          switchRow('autoSubtitle', 'Auto subtitle search', 'Cari subtitle Indonesia otomatis'),
          switchRow('notify', 'Notifications', 'Toast + browser notification'),
          switchRow('recordMse', 'Allow MSE buffer recording', 'Beta: rekam stream blob menjadi file'),
          '<div class="srad-field"><label>' +
            util.esc(t('common.theme')) +
            '</label><span class="srad-seg">' +
            ['system', 'dark', 'light']
              .map((v) => '<button data-act="theme-' + v + '" data-on="' + (s.theme === v ? 1 : 0) + '">' + util.esc(t('theme.' + v)) + '</button>')
              .join('') +
            '</span></div>',
          '<div class="srad-field"><label>' + util.esc(t('common.language')) + '</label><span class="srad-seg">' +
            ['auto', 'en', 'id']
              .map((v) => '<button data-act="lang-' + v + '" data-on="' + (s.lang === v ? 1 : 0) + '">' + v.toUpperCase() + '</button>')
              .join('') +
            '</span></div>',
          '<div class="srad-field"><label>Simpan posisi FAB<div class="hint">Reset ke pojok kanan bawah</div></label>' +
            '<button class="srad-btn" data-act="reset-fab">Reset</button></div>',
        ].join('');
        const body = panel.querySelector('[data-el="popbody"]');
        if (body) body.innerHTML = rows;
        panel.querySelectorAll('[data-act^="theme-"]').forEach((b) => {
          b.addEventListener('click', () => fire('set-setting', { key: 'theme', value: b.getAttribute('data-act').slice(6) }));
        });
        panel.querySelectorAll('[data-act^="lang-"]').forEach((b) => {
          b.addEventListener('click', () => fire('set-setting', { key: 'lang', value: b.getAttribute('data-act').slice(5) }));
        });
        const rf = panel.querySelector('[data-act="reset-fab"]');
        if (rf) rf.addEventListener('click', () => fire('set-setting', { key: 'fabPos', value: null }));
      }
      function switchRow(key, label, hint) {
        const v = api.settings ? api.settings[key] : false;
        return (
          '<div class="srad-field"><label>' + util.esc(label) + (hint ? '<span class="hint">' + util.esc(hint) + '</span>' : '') + '</label>' +
          '<label class="srad-switch"><input type="checkbox" data-act="set:' + key + '"' + (v ? ' checked' : '') + ' aria-label="' + util.esc(label) + '"><span class="srad-slider"></span></label></div>'
        );
      }

      /* ---------- render ---------- */
      function render(state) {
        if (!mounted) return;
        api.state = state;
        api.settings = (state && state.settings) || api.settings || {};
        if (SR.i18n.get() === 'auto') SR.i18n.set(SR.i18n.detect(root.navigator));
        applyTheme();
        const items = (state && state.items) || [];
        const s = api.settings;
        const ads = (state && state.ads) || [];
        if (s.showAds) items.push(...ads);
        else api.showAds = false;

        // badge + pulse
        const count = items.filter((i) => !i.hidden).length;
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.setAttribute('data-show', count ? '1' : '0');
        fab.setAttribute('aria-label', t('fab.label', { n: count }));
        fab.setAttribute('data-live', state && state.settings && state.settings.enabled ? '1' : '0');
        if (count > api.lastCount && api.lastCount >= 0) pulse();
        api.lastCount = count;

        // header subtitle = cleaned title
        const info = (state && state.title) || null;
        const titleEl = panel.querySelector('[data-el="title"]');
        const subEl = panel.querySelector('[data-el="subtitle"]');
        if (info && info.title) {
          titleEl.textContent = info.title + (info.year ? ' (' + info.year + ')' : '');
          subEl.textContent = util.host(root.location.href) + ' · ' + t('panel.items', { n: count });
        } else {
          titleEl.textContent = t('panel.title');
          subEl.textContent = util.host(root.location.href);
        }
        renderMeta(state, count, ads.length);
        renderList(items, state);
        const auto = panel.querySelector('[data-act="toggle-auto"]');
        if (auto) auto.checked = !!(state && state.settings && state.settings.enabled);
        const adsLabel = panel.querySelector('[data-el="adslabel"]');
        if (adsLabel)
          adsLabel.textContent = ads.length ? (api.showAds ? t('panel.hideAds') : t('panel.ads', { n: ads.length })) : '';
        const adsBtn = panel.querySelector('[data-act="ads"]');
        if (adsBtn) adsBtn.style.display = ads.length ? '' : 'none';
      }

      function renderMeta(state, count, adCount) {
        const meta = panel.querySelector('[data-el="meta"]');
        if (!meta) return;
        const chips = [];
        const info = state && state.title;
        if (info && info.isJunk) chips.push('<span class="srad-chip" data-kind="junk">' + util.esc(t('popup.empty')) + '</span>');
        if (info && info.year) chips.push('<span class="srad-chip" data-kind="year">' + util.esc(info.year) + '</span>');
        const ep = info && SR.title.episodeLabel(info);
        if (ep) chips.push('<span class="srad-chip" data-kind="ep">' + util.esc(ep) + '</span>');
        if (info && info.kind === 'episode') chips.push('<span class="srad-chip" data-kind="ep">Series</span>');
        if (state && state.drm) chips.push('<span class="srad-chip" data-kind="ep">' + util.esc(t('label.drm')) + ' · ' + util.esc(state.drm) + '</span>');
        const layers = (state && state.layers) || {};
        const active = Object.keys(layers).filter((k) => layers[k]);
        if (active.length) chips.push('<span class="srad-chip" title="' + util.esc(active.join(', ')) + '">' + active.length + '/5 layers</span>');
        if (state && state.pagePaused) chips.push('<span class="srad-chip" data-kind="junk">' + util.esc(t('panel.paused')) + '</span>');
        meta.innerHTML = chips.join('');
        meta.style.display = chips.length ? '' : 'none';
      }

      function renderList(items, state) {
        if (!items.length) {
          listEl.innerHTML =
            '<div class="srad-empty"><div class="srad-spin"></div><strong>' + util.esc(t('panel.empty')) + '</strong>' + util.esc(t('panel.emptyHint')) + '</div>';
          return;
        }
        const sorted = items
          .slice()
          .sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || (SR.rules.CATEGORY_WEIGHT[b.category] || 0) - (SR.rules.CATEGORY_WEIGHT[a.category] || 0) || (b.ts || 0) - (a.ts || 0));
        listEl.innerHTML = sorted.map((it) => itemHtml(it, state)).join('');
      }

      function itemHtml(it, state) {
        const cat = it.category || 'other';
        const label = SR.rules.CATEGORY_LABEL[cat] || cat.toUpperCase();
        const name = it.name || it.file || urlName(it.url);
        const thumb = it.thumb ? '<img src="' + util.esc(it.thumb) + '" alt="" loading="lazy">' : util.esc(label.replace('SEGMENTS', 'SEG').slice(0, 5));
        const tags = [];
        if (it.quality) tags.push('<span class="srad-tag" data-tone="q">' + util.esc(it.quality) + '</span>');
        if (it.sizeLabel) tags.push('<span class="srad-tag">' + util.esc(it.sizeLabel) + '</span>');
        if (it.durationLabel) tags.push('<span class="srad-tag">' + util.esc(it.durationLabel) + '</span>');
        if (it.isLive) tags.push('<span class="srad-tag" data-tone="warn">' + util.esc(t('label.live')) + '</span>');
        if (it.aes) tags.push('<span class="srad-tag" data-tone="warn">' + util.esc(t('label.aes')) + '</span>');
        if (it.drm) tags.push('<span class="srad-tag" data-tone="err">' + util.esc(t('label.drm')) + '</span>');
        if (it.segmentCount) tags.push('<span class="srad-tag">' + util.esc(t('label.segments', { n: it.segmentCount, size: it.segmentBytesLabel || '' })) + '</span>');
        if (it.mseBytes) tags.push('<span class="srad-tag">' + util.esc(util.formatBytes(it.mseBytes)) + ' buffered</span>');
        if (it.isAd) tags.push('<span class="srad-tag" data-tone="err">AD</span>');
        const via = [].concat(it.via || []).filter(Boolean);
        if (via.length) tags.push('<span class="srad-tag" title="' + util.esc(t('label.via')) + ': ' + util.esc(via.join(', ')) + '">' + via.length + ' src</span>');

        const subs = it.sub || {};
        const subTone = subs.status === 'found' ? 'ok' : subs.status === 'none' ? 'warn' : subs.status === 'error' ? 'err' : '';
        if (subs.status) tags.push('<span class="srad-tag" data-tone="' + subTone + '">' + util.esc(subLabel(subs)) + '</span>');

        const conf = Math.min(3, via.length + (it.size ? 1 : 0) + (it.quality ? 1 : 0));
        const dots = [0, 1, 2].map((i) => '<i data-on="' + (i < conf ? 1 : 0) + '"></i>').join('');

        const variants = (it.variants || [])
          .slice(0, 12)
          .map(
            (v, i) =>
              '<div class="srad-variant"><span class="srad-vq">' + util.esc(v.quality || (v.height ? util.qualityLabel(v.height) : '?')) + '</span>' +
              '<b>' + util.esc(v.codecs || cat.toUpperCase()) + '</b><span>' + util.esc(v.bandwidthLabel || '') + '</span>' +
              '<button class="srad-btn" data-variant-id="' + i + '">' + util.esc(t('action.copy')) + '</button></div>'
          )
          .join('');

        return (
          '<div class="srad-item" role="listitem" data-id="' + util.esc(it.id) + '" data-ad="' + (it.isAd ? '1' : '0') + '" tabindex="0" aria-label="' + util.esc(label + ' ' + name) + '">' +
          '<div class="srad-thumb" data-cat="' + util.esc(cat) + '">' + thumb + '</div>' +
          '<div class="srad-main">' +
          '<div class="srad-row1"><span class="srad-name">' + util.esc(name) + '</span><span class="srad-conf" aria-hidden="true">' + dots + '</span></div>' +
          '<div class="srad-url" title="' + util.esc(it.url) + '">' + util.esc(it.url.length > 130 ? it.url.slice(0, 60) + '…' + it.url.slice(-52) : it.url) + '</div>' +
          '<div class="srad-tags">' + tags.join('') + '</div>' +
          '<div class="srad-actions">' +
          '<button class="srad-btn" data-act="watchparty" data-primary="1">' + ICONS.party + util.esc(t('action.watchparty')) + '</button>' +
          '<button class="srad-btn" data-act="copy">' + ICONS.copy + util.esc(t('action.copy')) + '</button>' +
          (cat === 'hls' || cat === 'dash' ? '<button class="srad-btn" data-act="download">' + ICONS.download + 'M3U8</button>' : '<button class="srad-btn" data-act="download">' + ICONS.download + util.esc(t('action.download')) + '</button>') +
          '<button class="srad-btn" data-act="subs">' + ICONS.subs + util.esc(t('action.subs')) + '</button>' +
          (cat === 'hls' || cat === 'dash' || cat === 'blob' ? '<button class="srad-btn" data-act="open">' + ICONS.open + util.esc(t('action.open')) + '</button>' : '') +
          '<button class="srad-btn" data-act="ffmpeg" title="' + util.esc(t('action.ffmpeg')) + '">' + ICONS.play + '</button>' +
          (variants ? '<button class="srad-btn" data-act="toggle-expand">' + ICONS.chevron + t('action.variants', { n: (it.variants || []).length }) + '</button>' : '') +
          (cat === 'blob' ? '<button class="srad-btn" data-act="record">' + ICONS.rec + util.esc(t('action.record')) + '</button>' : '') +
          '</div>' +
          (variants ? '<div class="srad-variants">' + variants + '</div>' : '') +
          (cat === 'blob' && it.mseBytes ? '<div class="srad-variants" style="display:block;border:0;padding-top:4px"><span class="srad-tag">' + util.esc(t('label.mseHint')) + '</span></div>' : '') +
          '</div></div>'
        );
      }

      function subLabel(subs) {
        if (subs.status === 'found') return '♪ ' + (subs.name || t('panel.subs.found'));
        if (subs.status === 'searching') return t('panel.subs.searching');
        if (subs.status === 'none') return t('panel.subs.none');
        if (subs.status === 'error') return t('panel.subs.error');
        if (subs.status === 'skipped') return t('panel.subs.skipped');
        return '';
      }

      function urlName(u) {
        try {
          const p = new URL(u).pathname.split('/').filter(Boolean).pop() || util.host(u);
          return decodeURIComponent(p).slice(0, 70);
        } catch (_) {
          return String(u).slice(0, 60);
        }
      }

      function pulse() {
        fab.setAttribute('data-pulse', '1');
        setTimeout(() => fab.removeAttribute('data-pulse'), 2600);
      }

      /* ---------- toasts ---------- */
      const liveToasts = [];
      function toast(msg, kind, action) {
        if (!mounted) mount();
        const el = root.document.createElement('div');
        el.className = 'srad-toast';
        el.setAttribute('data-kind', kind || 'info');
        el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
        el.innerHTML =
          '<span class="srad-tico">' + (kind === 'ok' ? ICONS.check : kind === 'err' ? ICONS.close : ICONS.film) + '</span>' +
          '<span style="flex:1 1 auto;min-width:0">' + util.esc(msg) + '</span>' +
          (action ? '<button data-toast-act="' + util.esc(action.id) + '">' + util.esc(action.label) + '</button>' : '') +
          '<span class="srad-tbar"></span>';
        toastsEl.appendChild(el);
        liveToasts.push(el);
        while (liveToasts.length > 4) dismiss(liveToasts.shift());
        if (action) {
          const b = el.querySelector('[data-toast-act]');
          if (b) b.addEventListener('click', () => { fire(action.id, action.payload || {}); dismiss(el); });
        }
        const timer = setTimeout(() => dismiss(el), 4000);
        el.addEventListener('pointerenter', () => clearTimeout(timer), { once: true });
        el.addEventListener('click', (e) => {
          if (!e.target.closest('button')) dismiss(el);
        });
        if (liveEl) liveEl.textContent = msg;
        return el;
      }
      function dismiss(el) {
        if (!el || el.getAttribute('data-leaving') === '1') return;
        el.setAttribute('data-leaving', '1');
        setTimeout(() => {
          el.remove();
          const i = liveToasts.indexOf(el);
          if (i >= 0) liveToasts.splice(i, 1);
        }, 240);
      }

      /* ---------- open/close ---------- */
      function setOpen(on) {
        api.open = on;
        panel.setAttribute('data-open', on ? '1' : '0');
        fab.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (on) {
          positionPanel();
          setTimeout(() => {
            const first = panel.querySelector('.srad-item .srad-btn');
            if (first && !root.document.activeElement?.closest?.('[data-act="close"]')) first.focus({ preventScroll: true });
            else if (!first) listEl.focus({ preventScroll: true });
          }, 60);
        }
      }
      function toggle() {
        if (!api.open && o.beforeOpen) o.beforeOpen();
        setOpen(!api.open);
      }

      /* ---------- public ---------- */
      return Object.assign(api, {
        mount,
        render,
        toast,
        dismissAll() {
          [...liveToasts].forEach(dismiss);
        },
        toggle,
        setOpen,
        destroy() {
          try {
            host.remove();
          } catch (_) {}
          mounted = false;
        },
        setFabPos: applyFabPos,
        applyTheme,
        isMounted() {
          return mounted && host && host.isConnected;
        },
      });
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
