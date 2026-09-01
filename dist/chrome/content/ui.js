/**
 * Stream Radar — the UI (FAB, panel, tabs, toasts, settings sheet)
 * ------------------------------------------------------------------
 * View only. It never fetches and never decides what counts as media; it renders
 * `state` from the background worker and reports intent through `onAction`.
 *
 * Polish details, all deliberate:
 *   • Motion (vendored, src/vendor/motion.min.js) drives entrance, exit, FLIP
 *     list reordering and press springs; when it is unavailable (older browser,
 *     userscript) every effect degrades to CSS and nothing breaks.
 *   • pointerdown ripple on every button + optional haptic tick on touch devices,
 *     so each click has a visible, immediate answer.
 *   • Icons are Lucide SVG (src/shared/icons.js). No emoji, no decorative glyphs.
 *   • Closed shadow root: the host page cannot restyle us and we cannot restyle it.
 *   • Keyboard: Tab/Shift+Tab, Enter/Space on the FAB, ↑↓ between rows, E to
 *     expand, Esc to close. Focus is trapped while the panel is open.
 *   • All durations honour prefers-reduced-motion (see ui-styles.js).
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;
  const ico = (n, cls) => (SR.icons ? SR.icons(n, cls) : '');

  /* ---------------- motion bridge (safe when Motion is missing) ---------------- */
  const reduced = () => {
    try {
      return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {
      return false;
    }
  };
  function animate(el, frames, opts) {
    if (!el || reduced()) return null;
    const M = root.Motion;
    try {
      if (M && M.animate) return M.animate(el, frames, Object.assign({ duration: 0.24, easing: [0.22, 0.72, 0.24, 1] }, opts || {}));
      if (el.animate) return el.animate(frames, { duration: ((opts && opts.duration) || 0.24) * 1000, easing: 'cubic-bezier(.22,.72,.24,1)', fill: 'both' });
    } catch (_) {}
    return null;
  }
  const spring = { duration: 0.34, easing: [0.2, 0.9, 0.28, 1.24] };
  function vibrate(ms) {
    try {
      if (root.navigator && root.navigator.vibrate && matchMedia('(pointer: coarse)').matches) root.navigator.vibrate(ms);
    } catch (_) {}
  }

  /* ---------------- ripples ---------------- */
  function attachRipples(shadow) {
    shadow.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest && e.target.closest('.srad-btn, .srad-iconbtn, .srad-tab, .srad-switch');
      if (!btn || reduced()) return;
      const r = btn.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 1.9;
      const span = root.document.createElement('span');
      span.className = 'srad-ripple';
      span.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
      btn.appendChild(span);
      const anim = animate(span, { transform: ['scale(0)', 'scale(1)'], opacity: [0.24, 0] }, { duration: 0.5 });
      const kill = () => span.remove();
      if (anim && anim.finished) anim.finished.then(kill, kill);
      else setTimeout(kill, 480);
    });
  }

  SR.ui = {
    create(opts) {
      const o = opts || {};
      const t = (k, v) => SR.i18n.t(k, v);
      const api = {
        open: false,
        tab: 'media',
        lastCount: -1,
        items: [],
        ads: [],
        showAds: false,
        settings: {},
        state: null,
        popOpen: false,
      };
      let host, shadow, rootEl, fab, badge, panel, bodyEl, toastsEl, footEl, metaEl, tabsEl;
      let drag = null,
        moved = false,
        lastFocused = null,
        mounted = false,
        rowRects = new Map();

      /* ================= mount ================= */
      function mount() {
        if (mounted || !root.document || !root.document.documentElement) return false;
        mounted = true;
        host = root.document.createElement('div');
        host.id = 'stream-radar-host';
        host.setAttribute('data-srad', '1');
        // closed by default: the page must not be able to read or poke our UI.
        // Tests opt into an open root to assert generated markup (see content.js).
        shadow = host.attachShadow({ mode: o.shadowMode === 'open' ? 'open' : 'closed' });
        const style = root.document.createElement('style');
        style.textContent = SR.uiCss;
        shadow.appendChild(style);

        rootEl = root.document.createElement('div');
        rootEl.className = 'srad-root';
        rootEl.setAttribute('dir', 'ltr');
        rootEl.innerHTML =
          '<div class="srad-toasts" role="region" aria-live="polite" aria-label="' + esc(t('toast.title', {})) + '"></div>' +
          '<section class="srad-panel" role="dialog" aria-modal="false" aria-label="' + esc(t('panel.title')) + '" data-open="0">' +
          header() +
          '<div class="srad-tabs" role="tablist"></div>' +
          '<div class="srad-meta" data-el="meta"></div>' +
          '<div class="srad-body" role="region" tabindex="-1" data-el="body"></div>' +
          footer() +
          '<div class="srad-pop" data-el="pop" role="region" aria-label="' + esc(t('panel.settings')) + '"></div>' +
          '</section>' +
          '<div class="srad-fab" role="button" tabindex="0" aria-haspopup="dialog" aria-expanded="false"></div>' +
          '<div class="srad-sr" role="status" aria-live="polite" data-el="live"></div>';
        shadow.appendChild(rootEl);

        panel = rootEl.querySelector('.srad-panel');
        bodyEl = panel.querySelector('[data-el="body"]');
        metaEl = panel.querySelector('[data-el="meta"]');
        tabsEl = panel.querySelector('.srad-tabs');
        footEl = panel.querySelector('.srad-foot');
        toastsEl = rootEl.querySelector('.srad-toasts');
        fab = rootEl.querySelector('.srad-fab');
        badge = root.document.createElement('div');
        badge.className = 'srad-badge';
        badge.setAttribute('data-empty', '1');
        badge.setAttribute('data-show', '0');
        badge.setAttribute('aria-hidden', 'true');
        fab.appendChild(badge);
        fab.insertAdjacentHTML('afterbegin', ico('radar'));
        fab.setAttribute('aria-label', t('fab.label', { n: 0 }));

        renderTabs();
        renderBody();
        renderFooter();
        wire();
        applyFabPos((o.getSettings && o.getSettings().fabPos) || null);
        applyTheme();
        const attach = () => {
          const target = root.document.body || root.document.documentElement;
          if (target && host.parentNode !== target) target.appendChild(host);
          animate(fab, { transform: ['scale(.6) translateY(14px)', 'scale(1) translateY(0)'], opacity: [0, 1] }, spring);
        };
        attach();
        if (!root.document.body) root.document.addEventListener('DOMContentLoaded', attach, { once: true });
        return true;
      }

      function header() {
        return (
          '<header class="srad-head">' +
          '<div class="srad-brand" data-el="grip">' +
          '<span class="srad-mark">' + ico('clapperboard') + '</span>' +
          '<span class="srad-headtxt"><span data-el="title"><b>' + esc(t('panel.title')) + '</b><small>' + esc(t('app.tagline')) + '</small></span></span>' +
          '</div>' +
          '<span class="srad-spacer"></span>' +
          iconBtn('theme', t('common.theme')) +
          iconBtn('refresh', t('panel.refresh')) +
          iconBtn('settings', t('panel.settings')) +
          iconBtn('x', t('common.close')) +
          '</header>'
        );
      }
      function iconBtn(act, label) {
        return '<button class="srad-iconbtn" data-act="' + act + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + ico(act === 'x' ? 'x' : act === 'theme' ? 'moon' : act) + '</button>';
      }
      function footer() {
        return (
          '<div class="srad-foot">' +
          '<span class="srad-count" data-el="count"></span>' +
          '<span class="srad-spacer"></span>' +
          '<button class="srad-btn" data-act="copy-all" title="' + esc(t('action.copyAll')) + '" aria-label="' + esc(t('action.copyAll')) + '">' + ico('copy') + esc(t('action.copyAllShort')) + '</button>' +
          '<button class="srad-btn" data-act="ads" data-el="ads" aria-label="' + esc(t('panel.toggleAds')) + '" title="' + esc(t('panel.toggleAds')) + '"><span data-el="adslabel"></span></button>' +
          '<button class="srad-btn" data-act="clear">' + ico('trash-2') + esc(t('panel.clear')) + '</button>' +
          '<button class="srad-btn" data-act="options" title="' + esc(t('panel.openPanel')) + '">' + ico('settings-2') + '</button>' +
          '</div>'
        );
      }

      function renderTabs() {
        if (!tabsEl) return;
        const sub = (api.state && api.state.sub) || {};
        const badge = sub.status === 'found' ? (sub.items || []).length : 0;
        tabsEl.innerHTML = [
          ['media', t('panel.tabMedia'), 'video', ((api.state && api.state.items) || []).length],
          ['subs', t('panel.tabSubs'), 'captions', badge],
          ['info', t('panel.tabInfo'), 'info', 0],
        ]
          .map(
            ([id, label, icon, count]) =>
              '<button class="srad-tab" role="tab" id="srad-tab-' + id + '" aria-controls="srad-pane-' + id + '" aria-selected="' +
              (api.tab === id ? 'true' : 'false') +
              '" data-act="tab" data-tab="' + id + '">' + ico(icon) + esc(label) + (count ? '<i>' + count + '</i>' : '') + '</button>'
          )
          .join('');
      }

      /* ================= render ================= */
      function render(state) {
        if (!mounted && !mount()) return;
        if (state) api.state = state;
        const s = (api.state && api.state.settings) || api.settings || {};
        api.settings = s;
        applyTheme();
        renderTabs();
        renderMeta();
        renderBody();
        renderFooter();
        updateBadge();
      }

      function updateBadge() {
        const items = visible();
        const n = items.length;
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.setAttribute('data-show', n ? '1' : '0');
        badge.setAttribute('data-empty', n ? '0' : '1');
        fab.setAttribute('aria-label', t('fab.label', { n: n }));
        fab.setAttribute('data-live', api.settings.enabled === false ? '0' : '1');
        if (api.lastCount >= 0 && n > api.lastCount) pulse();
        api.lastCount = n;
      }

      function pulse() {
        fab.setAttribute('data-pulse', '1');
        animate(fab, { transform: ['scale(1)', 'scale(1.12)', 'scale(1)'] }, spring);
        setTimeout(() => fab.removeAttribute('data-pulse'), 3100);
      }

      function visible() {
        const items = ((api.state && api.state.items) || []).slice();
        if (api.showAds || (api.settings && api.settings.showAds)) items.push(...((api.state && api.state.ads) || []));
        return items.sort(rankItems);
      }
      function rankItems(a, b) {
        const w = (x) => (SR.rules && SR.rules.CATEGORY_WEIGHT[x.category]) || 0;
        return (b.confidence || 0) - (a.confidence || 0) || w(b) - w(a) || (b.ts || 0) - (a.ts || 0);
      }

      function renderMeta() {
        const st = api.state || {};
        const info = st.title;
        const titleEl = panel.querySelector('[data-el="title"]');
        if (titleEl) {
          titleEl.innerHTML =
            '<b>' + esc(info && info.title ? info.title + (info.year ? ' (' + info.year + ')' : '') : t('panel.title')) + '</b>' +
            '<small>' + esc(util.host((info && info.url) || root.location.href)) + '</small>';
        }
        const chips = [];
        if (info && info.isJunk) chips.push(chip('warn', 'search', t('panel.noTitle')));
        if (info && info.year) chips.push(chip('year', 'calendar', info.year));
        if (info && info.imdbId) chips.push(chip('id', 'clapperboard', info.imdbId));
        if (info && (info.tmdbId || info.urlTmdbId)) chips.push(chip('id', 'clapperboard', 'tmdb ' + (info.tmdbId || info.urlTmdbId)));
        const ep = info && SR.title && SR.title.episodeLabel ? SR.title.episodeLabel(info) : null;
        if (ep) chips.push(chip('ep', 'captions', ep));
        if (info && info.kind === 'episode') chips.push(chip('ep', 'monitor-smartphone', t('panel.series')));
        if (st.drm) chips.push(chip('err', 'shield-check', t('label.drm') + ' ' + st.drm));
        const layers = st.layers || {};
        const on = Object.keys(layers).filter((k) => layers[k]).length;
        if (on) chips.push(chip('', 'list-filter', t('panel.layers', { n: on })));
        if (st.pagePaused) chips.push(chip('warn', 'eye', t('panel.paused')));
        const dyn = st.rulesVersion ? chip('', 'sparkles', t('update.pack') + ' ' + st.rulesVersion) : '';
        if (dyn) chips.push(dyn);
        metaEl.innerHTML = chips.join('');
      }
      function chip(kind, icon, text) {
        return '<span class="srad-chip"' + (kind ? ' data-kind="' + kind + '"' : '') + '>' + (icon ? ico(icon) : '') + esc(text) + '</span>';
      }

      let bodySig = null;
      function renderBody() {
        if (!bodyEl) return;
        if (api.tab === 'subs') return renderSubs();
        if (api.tab === 'info') return renderInfo();
        const items = visible();
        // Keep the row DOM alive while nothing about the list changed (title /
        // subtitle re-scans broadcast new state constantly). Rebuilding the list
        // mid-click detaches the button the user is pressing. The signature
        // covers the tab, the set of rows and their live chips.
        const sig =
          api.tab +
          '|' +
          items.map((it) => [it.id, it.category, it.confidence, it.quality, (it.sub && it.sub.status) || ''].join(':')).join('~');
        if (bodySig === sig && bodyEl.querySelector('[data-el="list"]')) return;
        bodySig = sig;
        const before = captureRects();
        if (!items.length) {
          bodyEl.innerHTML =
            '<div class="srad-empty">' + ico('loader') + '<b>' + esc(t('panel.empty')) + '</b><p>' + esc(t('panel.emptyHint')) + '</p></div>';
          rowRects = new Map();
          return;
        }
        bodyEl.innerHTML = '<div role="list" data-el="list">' + items.map(itemHtml).join('') + '</div>';
        flipRows(before);
        const rows = [...bodyEl.querySelectorAll('.srad-item')];
        rows.forEach((el, i) => {
          if (i > 7) return;
          animate(el, { opacity: [0, 1], transform: ['translateY(8px) scale(.99)', 'none'] }, { duration: 0.26, delay: i * 0.022 });
        });
      }

      function captureRects() {
        const map = new Map();
        for (const el of bodyEl.querySelectorAll('.srad-item')) map.set(el.getAttribute('data-id'), el.getBoundingClientRect().top);
        return map;
      }
      /** FLIP: when the ranking changes, rows glide instead of jumping. */
      function flipRows(before) {
        if (reduced() || !before.size) return;
        for (const el of bodyEl.querySelectorAll('.srad-item')) {
          const prev = before.get(el.getAttribute('data-id'));
          if (prev == null) continue;
          const dy = prev - el.getBoundingClientRect().top;
          if (Math.abs(dy) > 1) animate(el, { transform: ['translateY(' + dy + 'px)', 'translateY(0)'] }, { duration: 0.3 });
        }
      }

      function itemHtml(it) {
        const cat = it.category || 'other';
        const label = (SR.rules && SR.rules.CATEGORY_LABEL && SR.rules.CATEGORY_LABEL[cat]) || cat.toUpperCase();
        const name = it.name || urlName(it.url);
        const tags = [];
        if (it.quality) tags.push('<span class="srad-tag" data-tone="q">' + esc(it.quality) + '</span>');
        if (it.sizeLabel) tags.push('<span class="srad-tag">' + esc(it.sizeLabel) + '</span>');
        if (it.durationLabel) tags.push('<span class="srad-tag">' + esc(it.durationLabel) + '</span>');
        if (it.isLive) tags.push('<span class="srad-tag" data-tone="warn">' + esc(t('label.live')) + '</span>');
        if (it.aes) tags.push('<span class="srad-tag" data-tone="warn">' + ico('shield-check') + esc(t('label.aes')) + '</span>');
        if (it.drm) tags.push('<span class="srad-tag" data-tone="err">' + ico('shield-check') + esc(t('label.drm')) + '</span>');
        if (it.segmentCount) tags.push('<span class="srad-tag">' + esc(t('label.segments', { n: it.segmentCount, size: it.segmentBytesLabel || '' })) + '</span>');
        if (it.mseBytes) tags.push('<span class="srad-tag">' + esc(util.formatBytes(it.mseBytes)) + ' ' + esc(t('label.buffered')) + '</span>');
        if (it.isAd) tags.push('<span class="srad-tag" data-tone="err">' + esc(t('label.ad')) + '</span>');
        if (it.via && it.via.length) tags.push('<span class="srad-tag" title="' + esc(t('label.via') + ': ' + it.via.join(', ')) + '">' + it.via.length + ' ' + esc(t('label.sources')) + '</span>');
        const subs = it.sub || {};
        if (subs.status && subs.status !== 'idle') tags.push('<span class="srad-tag" data-tone="' + subTone(subs.status) + '"' + (subs.status === 'searching' ? ' data-busy="1"' : '') + '>' + (subs.status === 'searching' ? ico('loader') : ico('captions')) + esc(subLabel(subs)) + '</span>');

        const via = [].concat(it.via || []);
        const conf = Math.min(3, via.length + (it.size ? 1 : 0) + (it.quality ? 1 : 0));
        const dots = [0, 1, 2].map((i) => '<i data-on="' + (i < conf ? 1 : 0) + '"></i>').join('');
        const thumb = it.thumb ? '<img src="' + esc(it.thumb) + '" alt="" loading="lazy">' : ico(cat === 'segment' ? 'list-filter' : cat === 'blob' ? 'video' : cat === 'hls' ? 'play' : 'video');
        const variants = (it.variants || [])
          .slice(0, 14)
          .map(
            (v, i) =>
              '<div class="srad-variant"><span class="srad-vq">' + esc(v.quality || (v.height ? util.qualityLabel(v.height) : '?')) + '</span><b>' + esc(v.codecs || label) + '</b>' +
              '<span>' + esc(v.bandwidthLabel || '') + '</span><button class="srad-btn" data-act="variant" data-id="' + esc(it.id) + '" data-variant-id="' + i + '">' + ico('copy') + esc(t('action.copy')) + '</button></div>'
          )
          .join('');
        const canRecord = cat === 'blob';
        return (
          '<article class="srad-item" role="listitem" tabindex="0" data-id="' + esc(it.id) + '" data-ad="' + (it.isAd ? 1 : 0) + '" aria-label="' + esc(label + ' ' + name) + '">' +
          '<div class="srad-thumb" data-cat="' + esc(cat) + '">' + thumb + '</div>' +
          '<div class="srad-main">' +
          '<div class="srad-row1"><span class="srad-name">' + esc(name) + '</span><span class="srad-conf" aria-hidden="true">' + dots + '</span></div>' +
          '<div class="srad-url" title="' + esc(it.url) + '">' + esc(shortenUrl(it.url)) + '</div>' +
          '<div class="srad-tags">' + tags.join('') + '</div>' +
          '<div class="srad-actions">' +
          (cat === 'blob'
            ? '<span class="srad-no-party" title="' + esc(t('watchparty.noBlob')) + '">' + ico('info') + esc(t('watchparty.noBlob')) + '</span>'
            : '<button class="srad-btn" data-act="play" data-primary="1">' + ico('play') + esc(t('action.play')) + '</button>' +
              '<button class="srad-btn" data-act="watchparty">' + ico('users') + esc(t('action.watchparty')) + '</button>') +
          '<button class="srad-btn" data-act="copy">' + ico('copy') + esc(t('action.copy')) + '</button>' +
          '<button class="srad-btn" data-act="download">' + ico('download') + esc(it.category === 'hls' || it.category === 'dash' ? t('action.downloadPlaylist') : t('action.download')) + '</button>' +
          '<button class="srad-btn" data-act="subs">' + ico('captions') + esc(t('action.subs')) + '</button>' +
          '<button class="srad-btn" data-act="ffmpeg" title="' + esc(t('action.ffmpeg')) + '" aria-label="' + esc(t('action.ffmpeg')) + '">' + ico('link-2') + '</button>' +
          (variants ? '<button class="srad-btn" data-act="toggle-expand" aria-expanded="false">' + ico('chevron-down') + esc(t('action.variants', { n: (it.variants || []).length })) + '</button>' : '') +
          (canRecord ? '<button class="srad-btn" data-act="record">' + ico('circle') + esc(t('action.record')) + '</button>' : '') +
          '</div>' +
          (variants ? '<div class="srad-variants">' + variants + '</div>' : '') +
          (cat === 'blob' ? '<div class="srad-note">' + ico('info') + '<span>' + esc(t('label.mseHint')) + '</span></div>' : '') +
          '</div></article>'
        );
      }

      function subTone(s) {
        return s === 'found' ? 'ok' : s === 'searching' ? 'q' : s === 'error' ? 'err' : 'warn';
      }
      function subLabel(subs) {
        if (subs.status === 'found') return subs.name || t('panel.subs.found');
        if (subs.status === 'searching') return t('panel.subs.searching');
        if (subs.status === 'none') return t('panel.subs.none');
        if (subs.status === 'error') return t('panel.subs.error');
        if (subs.status === 'skipped') return t('panel.subs.skipped');
        return '';
      }
      function shortenUrl(u) {
        u = String(u || '');
        return u.length > 118 ? u.slice(0, 56) + '...' + u.slice(-46) : u;
      }
      function urlName(u) {
        try {
          const p = new URL(u).pathname.split('/').filter(Boolean).pop() || util.host(u);
          return decodeURIComponent(p).slice(0, 70);
        } catch (_) {
          return String(u).slice(0, 60);
        }
      }

      /* ================= subtitles pane ================= */
      function renderSubs() {
        const sub = (api.state && api.state.sub) || { status: 'idle', items: [] };
        const st = {
          idle: t('action.subs'),
          searching: t('panel.subs.searching'),
          found: t('panel.subs.found'),
          none: t('panel.subs.none'),
          error: t('panel.subs.error'),
          skipped: t('panel.subs.skipped'),
        };
        const providers = sub.providers || {};
        const rows = (sub.items || []).slice(0, 6).map((it, i) => subRowHtml(it, i, sub)).join('');
        bodyEl.innerHTML =
          '<div class="srad-sub-card">' +
          '<div class="srad-sub-head">' + ico('captions') + '<span>' + esc(t('panel.subs.title')) + '</span>' +
          '<span class="srad-state" data-s="' + esc(sub.status) + '">' + (sub.status === 'searching' ? ico('loader') : '') + esc(st[sub.status] || sub.status) + '</span></div>' +
          (sub.query || sub.imdbId || sub.tmdbId ? '<div class="srad-url" style="margin-top:6px">' + esc(sub.query || '') + (sub.year ? ' (' + esc(String(sub.year)) + ')' : '') + (sub.imdbId ? ' <b>' + esc(sub.imdbId) + '</b>' : '') + (sub.tmdbId ? ' <b>tmdb ' + esc(String(sub.tmdbId)) + '</b>' : '') + '</div>' : '') +
          '<div class="srad-providers">' +
          Object.keys(providers)
            .map((k) => '<span class="srad-pv" data-s="' + esc(providers[k].status || '') + '" title="' + esc(providers[k].reason || '') + '">' + esc(providers[k].label || k) + ' ' + (providers[k].count != null ? providers[k].count : '') + '</span>')
            .join('') +
          '</div>' +
          (rows
            ? '<div class="srad-sub-list">' + rows + '</div>'
            : '<div class="srad-note">' + ico('info') + '<span>' + esc(sub.error || t('panel.subs.hint')) + '</span></div>') +
          '<div class="srad-sub-actions">' +
          '<button class="srad-btn" data-act="subs" data-primary="1">' + ico('search') + esc(t('panel.subs.retry')) + '</button>' +
          '<button class="srad-btn" data-act="sub-attach">' + ico('captions') + esc(t('panel.subs.attach')) + '</button>' +
          '<button class="srad-btn" data-act="sub-download">' + ico('file-down') + esc(t('panel.subs.download')) + '</button>' +
          '</div></div>';
        const subRows = [...bodyEl.querySelectorAll('.srad-sub-row')];
        subRows.forEach((el, i) => {
          animate(el, { opacity: [0, 1], transform: ['translateY(7px) scale(.97)', 'none'] }, { duration: 0.24, delay: i * 0.04 });
        });
      }

      /** One informative subtitle result row: flag, language, format, badges, editor. */
      function subRowHtml(it, i, sub) {
        const name = it.name || it.filename || t('panel.subs.found');
        const flag = (SR.subs && SR.subs.flagOf) ? SR.subs.flagOf(it.langCode || it.lang) : '';
        const bits = [];
        const lang = (SR.subs && SR.subs.langName) ? SR.subs.langName(it.langCode || it.lang) : (it.langCode || it.lang || '').toUpperCase();
        if (lang) bits.push('<span class="srad-slang">' + esc(lang) + '</span>');
        const fmt = String(it.format || 'srt').toUpperCase();
        if (fmt) bits.push('<span>' + esc(fmt) + '</span>');
        const dl = (SR.subs && SR.subs.countLabel) ? SR.subs.countLabel(it.downloads) : '';
        if (dl) bits.push('<span title="' + esc(t('panel.subs.downloads')) + '">' + ico('download') + ' ' + esc(dl) + '</span>');
        if (it.verified) bits.push('<span class="srad-sbadge" data-tone="ok">' + ico('check') + esc(t('panel.subs.verified')) + '</span>');
        if (it.aiTranslated) bits.push('<span class="srad-sbadge" data-tone="warn">AI</span>');
        if (it.hearingImpaired) bits.push('<span class="srad-sbadge" data-tone="q">HI</span>');
        const by = it.uploader ? (SR.i18n ? t('panel.subs.by') : 'by') + ' ' + it.uploader : '';
        if (by) bits.push('<span class="srad-sup" title="' + esc(by) + '">' + esc(by) + '</span>');
        const picked = (sub.chosen && sub.chosen.index === i) || (i === 0 && sub.chosen) ? 1 : 0;
        return (
          '<div class="srad-sub-row" data-picked="' + picked + '">' +
          (flag ? '<span class="srad-sflag" aria-hidden="true">' + flag + '</span>' : '') +
          '<span class="srad-smain">' +
          '<b class="srad-sname" title="' + esc(name) + '">' + esc(name) + '</b>' +
          '<small class="srad-smeta">' + bits.join('<i class="srad-sdot" aria-hidden="true">|</i>') + '</small>' +
          '</span>' +
          '<button class="srad-btn" data-act="sub-pick" data-index="' + i + '">' + esc(i === 0 ? t('action.use') : t('action.pick')) + '</button>' +
          '</div>'
        );
      }

      /* ================= info pane ================= */
      function renderInfo() {
        const st = api.state || {};
        const rows = [
          [t('panel.layers'), Object.keys(st.layers || {}).filter((k) => st.layers[k]).join(', ') || t('panel.none')],
          [t('label.frames'), (st.frames || []).map((f) => util.host(f.url)).filter(Boolean).slice(0, 6).join(', ') || '-'],
          [t('label.players'), (st.players || []).join(', ') || '-'],
          ['Service worker', st.sw && st.sw.caches ? st.sw.caches + ' cache' + (st.sw.caches > 1 ? 'es' : '') + (st.sw.checked ? ', ' + st.sw.checked + ' checked' : '') : '-'],
          ['Diagnostics', st.health && st.health.kind ? st.health.kind : '-'],
          [t('update.state'), st.update && st.update.status ? st.update.status + (st.update.version ? ' v' + st.update.version : '') : 'idle'],
        ];
        bodyEl.innerHTML =
          '<div class="srad-sub-card">' +
          rows.map(([k, v]) => '<div class="srad-field"><span class="lab">' + esc(k) + '</span><span style="color:var(--c-fg-2);font-size:12px;text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(v) + '</span></div>').join('') +
          '</div>' +
          '<div class="srad-note" style="padding:0 2px">' + ico('shield-check') + '<span>' + esc(t('privacy.note')) + '</span></div>';
      }

      function renderFooter() {
        if (!footEl) return;
        const st = api.state || {};
        const n = ((st.items || []).length) || 0;
        footEl.querySelector('[data-el="count"]').textContent = t('panel.items', { n: n });
        const ads = (st.ads || []).length;
        const adsBtn = footEl.querySelector('[data-act="ads"]');
        const label = adsBtn.querySelector('[data-el="adslabel"]');
        if (ads) {
          adsBtn.hidden = false;
          label.textContent = api.showAds ? t('panel.hideAds') : t('panel.ads', { n: ads });
        } else {
          adsBtn.hidden = true;
        }
      }

      /* ================= settings sheet ================= */
      function openPop(on) {
        const pop = panel.querySelector('[data-el="pop"]');
        if (!pop) return;
        api.popOpen = !!on;
        if (on) {
          pop.innerHTML =
            '<header class="srad-head"><div class="srad-brand"><span class="srad-mark">' + ico('settings') + '</span>' +
            '<span class="srad-headtxt"><b>' + esc(t('settings.title')) + '</b><small>' + esc(t('settings.subtitle')) + '</small></span></div>' +
            '<span class="srad-spacer"></span>' + iconBtn('x', t('common.close')) + '</header>' +
            '<div class="srad-popbody">' +
            swField('enabled', t('settings.autoDetect'), t('settings.autoDetectHint')) +
            swField('layerNetwork', 'L1 ' + t('settings.network')) +
            swField('layerDom', 'L2 ' + t('settings.dom')) +
            swField('layerMse', 'L3 ' + t('settings.mse')) +
            swField('layerSw', 'L4 ' + t('settings.sw')) +
            swField('layerHeuristic', 'L5 ' + t('settings.heuristic')) +
            swField('autoSubtitle', t('settings.autosub'), t('settings.autosubHint')) +
            swField('notify', t('settings.notify')) +
            swField('recordMse', t('settings.record'), t('settings.recordHint')) +
            '<div class="srad-field"><span class="lab">' + esc(t('common.theme')) + '</span><span class="srad-seg">' +
            ['system', 'dark', 'light'].map((v) => '<button data-act="theme-' + v + '" data-on="' + ((api.settings.theme || 'system') === v ? 1 : 0) + '">' + esc(t('theme.' + v)) + '</button>').join('') +
            '</span></div>' +
            '<div class="srad-field"><span class="lab">' + esc(t('common.language')) + '</span><span class="srad-seg">' +
            ['auto', 'en', 'id'].map((v) => '<button data-act="lang-' + v + '" data-on="' + ((api.settings.lang || 'auto') === v ? 1 : 0) + '">' + v.toUpperCase() + '</button>').join('') +
            '</span></div>' +
            '<div class="srad-field"><span class="lab">' + esc(t('settings.fab')) + '<span class="hint">' + esc(t('settings.fabHint')) + '</span></span>' +
            '<button class="srad-btn" data-act="reset-fab">' + esc(t('settings.reset')) + '</button></div>' +
            '<div class="srad-sub-actions" style="margin-top:12px"><button class="srad-btn" data-act="update-check">' + ico('refresh-cw') + esc(t('update.check')) + '</button>' +
            '<button class="srad-btn" data-act="options">' + ico('keyboard') + esc(t('settings.openOptions')) + '</button></div>' +
            (api.state && api.state.update ? '<div class="srad-note" style="margin-top:10px">' + ico('info') + '<span>' + esc(t('update.state') + ': ' + api.state.update.status + (api.state.update.notes ? ', ' + api.state.update.notes : '')) + '</span></div>' : '') +
            '</div>';
          panel.querySelectorAll('[data-act^="theme-"]').forEach((b) => b.addEventListener('click', () => fire('set-setting', { key: 'theme', value: b.getAttribute('data-act').slice(6) })));
          panel.querySelectorAll('[data-act^="lang-"]').forEach((b) => b.addEventListener('click', () => fire('set-setting', { key: 'lang', value: b.getAttribute('data-act').slice(5) })));
        }
        pop.setAttribute('data-open', on ? '1' : '0');
        if (on) setTimeout(() => pop.querySelector('.srad-iconbtn') && pop.querySelector('.srad-iconbtn').focus(), 80);
      }
      function swField(key, label, hint) {
        const on = api.settings[key] !== false;
        return (
          '<div class="srad-field"><span class="lab">' + esc(label) + (hint ? '<span class="hint">' + esc(hint) + '</span>' : '') + '</span>' +
          '<button class="srad-switch" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" data-act="set:' + key + '" aria-label="' + esc(label) + '"></button></div>'
        );
      }

      /* ================= events ================= */
      function wire() {
        attachRipples(shadow);
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
        root.addEventListener('resize', util.throttle(() => applyFabPos(currentFabPos()), 260));

        panel.addEventListener('click', onPanelClick);
        panel.addEventListener('keydown', onPanelKey);
        root.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && api.open) {
            e.preventDefault();
            setOpen(false);
            try {
              fab.focus();
            } catch (_) {}
          }
          if (api.open && e.key === 'Tab') trapFocus(e);
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
      }

      function trapFocus(e) {
        const f = [...shadow.querySelectorAll('.srad-panel button:not([disabled]), .srad-panel [role="switch"], .srad-panel [tabindex="0"]')].filter((el) => el.offsetParent !== null || el.getClientRects().length);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        const active = shadow.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }

      function onPanelClick(e) {
        const btn = e.target.closest ? e.target.closest('[data-act]') : null;
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        const holder = btn.closest('[data-id]');
        const id = btn.getAttribute('data-id') || (holder ? holder.getAttribute('data-id') : null);
        const vbtn = e.target.closest ? e.target.closest('[data-variant-id]') : null;
        if (vbtn) return fire('variant', { id: holder ? holder.getAttribute('data-id') : id, index: Number(vbtn.getAttribute('data-variant-id')) });

        if (act === 'close' || act === 'x') {
          // X closes the settings pop first, then the panel (both headers render data-act="x").
          if (api.popOpen) return openPop(false);
          return setOpen(false);
        }
        if (act === 'theme') return cycleTheme(btn);
        if (act === 'settings') return openPop(true);
        if (act === 'tab') return setTab(btn.getAttribute('data-tab'));
        if (act === 'toggle-auto') return fire('set-setting', { key: 'enabled', value: !(api.settings.enabled !== false) });
        if (act.indexOf('set:') === 0) {
          const key = act.slice(4);
          return fire('set-setting', { key: key, value: api.settings[key] === false });
        }
        if (act === 'refresh') {
          btn.setAttribute('data-done', '1');
          fire('scan-now');
          setTimeout(() => btn.removeAttribute('data-done'), 900);
          return;
        }
        if (act === 'reset-fab') {
          // Local job: snap the FAB back to its default corner and persist it.
          applyFabPos(null);
          fire('set-setting', { key: 'fabPos', value: null });
          toast(t('settings.resetDone'), 'ok');
          return;
        }
        if (act === 'update-check') {
          fire('update-check');
          return;
        }
        if (act === 'clear' || act === 'options') {
          fire(act);
          return;
        }
        if (act === 'ads') {
          api.showAds = !api.showAds;
          fire('set-setting', { key: 'showAds', value: api.showAds });
          render();
          return;
        }
        if (act === 'subs') {
          // Subtitles button on a stream row (or the subs-pane retry): fire the
          // search AND switch to the subtitles pane so the user always sees an
          // immediate response (spinner / provider status), never silence.
          fire('subs', { id: id || null, button: btn });
          setTab('subs');
          return;
        }
        if (act === 'toggle-expand') {
          const item = btn.closest('.srad-item');
          const open = item.getAttribute('data-expanded') === '1' ? '0' : '1';
          item.setAttribute('data-expanded', open);
          btn.setAttribute('aria-expanded', open === '1' ? 'true' : 'false');
          const panelEl = item.querySelector('.srad-variants');
          if (panelEl) animate(panelEl, { opacity: [0, 1], transform: ['translateY(-4px)', 'none'] }, { duration: 0.2 });
          return;
        }
        // Item-scoped actions need a row id. 'subs' is exempt: the subtitles
        // pane's retry button has no row and must still trigger a page-level
        // search (row-level subs buttons carry their own id).
        if (!id && ['copy', 'download', 'watchparty', 'play', 'ffmpeg', 'record', 'open'].indexOf(act) >= 0) return;
        if (act === 'copy') {
          btn.setAttribute('data-done', '1');
          const original = btn.innerHTML;
          btn.innerHTML = ico('check') + esc(t('action.copied'));
          setTimeout(() => {
            btn.innerHTML = original;
            btn.removeAttribute('data-done');
          }, 1400);
        }
        if (act === 'record') vibrate(12);
        fire(act, { id: id, index: Number(btn.getAttribute('data-index') || 0), button: btn });
      }

      function onPanelKey(e) {
        const row = e.target.closest && e.target.closest('.srad-item');
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const rows = [...bodyEl.querySelectorAll('.srad-item')];
          if (!rows.length) return;
          e.preventDefault();
          const i = rows.indexOf(row);
          const next = util.clamp((i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1);
          rows[next].focus();
          rows[next].scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
          rows.forEach((el, k) => el.setAttribute('data-active', k === next ? '1' : '0'));
          return;
        }
        if (!row) return;
        if (e.key === 'e' || e.key === 'Enter') {
          const toggle = row.querySelector('[data-act="toggle-expand"]');
          if (toggle) {
            e.preventDefault();
            toggle.click();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const play = row.querySelector('[data-act="play"]');
            const wp = row.querySelector('[data-act="watchparty"]');
            if (play) play.click();
            else if (wp) wp.click();
          }
        }
        if (e.key === 'c') {
          e.preventDefault();
          row.querySelector('[data-act="copy"]').click();
        }
        if (e.key === 's') {
          e.preventDefault();
          row.querySelector('[data-act="subs"]').click();
        }
      }

      function fire(action, payload) {
        try {
          if (o.onAction) o.onAction(action, payload || {});
        } catch (_) {}
      }
      function setTab(id) {
        if (api.tab === id) return;
        api.tab = id;
        animate(bodyEl, { opacity: [0.35, 1], transform: ['translateY(4px)', 'none'] }, { duration: 0.2 });
        renderTabs();
        renderBody();
      }

      /* ---------------- FAB drag + anchor ---------------- */
      function rect(which) {
        const r = fab.getBoundingClientRect();
        return which === 'left' ? r.left : r.top;
      }
      function onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        const r = fab.getBoundingClientRect();
        drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height, id: e.pointerId };
        moved = false;
        try {
          fab.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      function onPointerMove(e) {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 7) return;
        if (!moved) {
          moved = true;
          fab.setAttribute('data-dragging', '1');
          vibrate(6);
        }
        const left = util.clamp(drag.left + dx, 6, Math.max(8, root.innerWidth - drag.w - 6));
        const top = util.clamp(drag.top + dy, 6, Math.max(8, root.innerHeight - drag.h - 6));
        fab.style.left = left + 'px';
        fab.style.top = top + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        positionPanel(left, top, drag.w, drag.h);
      }
      function onPointerUp() {
        if (!drag) return;
        fab.removeAttribute('data-dragging');
        const wasMoved = moved;
        drag = null;
        if (wasMoved) {
          moved = false;
          fire('set-setting', { key: 'fabPos', value: currentFabPos() });
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
          fab.style.right = fab.style.bottom = '';
          positionPanel();
          return;
        }
        const w = fab.offsetWidth || 56;
        const h = fab.offsetHeight || 56;
        const left = util.clamp(pos.x, 6, Math.max(8, root.innerWidth - w - 6));
        const top = util.clamp(pos.y, 6, Math.max(8, root.innerHeight - h - 6));
        fab.style.left = left + 'px';
        fab.style.top = top + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        positionPanel(left, top, w, h);
      }
      function positionPanel(left, top, w, h) {
        if (!panel) return;
        if (left == null) {
          const r = fab.getBoundingClientRect();
          left = r.left;
          top = r.top;
          w = w || r.width;
          h = h || r.height;
        }
        const nearTop = top < root.innerHeight * 0.34;
        const anchor = (nearTop ? 't' : 'b') + (left + (w || 56) / 2 < root.innerWidth / 2 ? 'l' : 'r');
        panel.setAttribute('data-anchor', anchor);
      }

      /* ---------------- theme ---------------- */
      let mq = null;
      function applyTheme() {
        if (!rootEl) return;
        let theme = api.settings.theme || 'system';
        if (theme === 'system') {
          try {
            mq = mq || root.matchMedia('(prefers-color-scheme: dark)');
            theme = mq.matches ? 'dark' : 'light';
          } catch (_) {
            theme = 'light';
          }
        }
        rootEl.setAttribute('data-theme', theme);
        const btn = panel && panel.querySelector('[data-act="theme"]');
        if (btn) btn.innerHTML = theme === 'dark' ? ico('sun') : ico('moon');
        try {
          root.document.documentElement.setAttribute('data-srad-theme', theme);
        } catch (_) {}
      }
      function cycleTheme(btn) {
        const order = ['system', 'dark', 'light'];
        const cur = api.settings.theme || 'system';
        const next = order[(order.indexOf(cur) + 1) % order.length];
        if (btn) animate(btn, { transform: ['rotate(0deg) scale(1)', 'rotate(-28deg) scale(1.14)', 'rotate(0deg) scale(1)'] }, { duration: 0.36 });
        fire('set-setting', { key: 'theme', value: next });
      }
      try {
        if (root.matchMedia) root.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (api.settings.theme || 'system') === 'system' && applyTheme());
      } catch (_) {}

      /* ---------------- toasts ---------------- */
      const live = [];
      function toast(msg, kind, action, ms) {
        if (!mounted && !mount()) return null;
        const life = ms || 4000;
        const el = root.document.createElement('div');
        el.className = 'srad-toast';
        el.setAttribute('data-kind', kind || 'info');
        el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
        el.innerHTML =
          '<span class="srad-tico">' + ico(kind === 'ok' ? 'check' : kind === 'err' ? 'info' : kind === 'warn' ? 'info' : 'sparkles') + '</span>' +
          '<span>' + esc(msg) + '</span>' +
          (action ? '<button data-toast-act="' + esc(action.id) + '">' + esc(action.label) + '</button>' : '') +
          '<span class="srad-tbar"></span>';
        toastsEl.appendChild(el);
        live.push(el);
        // dismiss() only removes the DOM asynchronously, so shift() the array
        // synchronously here or this loop spins forever once a 5th toast lands.
        while (live.length > 4) {
          const old = live.shift();
          if (old && old.getAttribute('data-leaving') !== '1') dismiss(old);
        }
        animate(el, { opacity: [0, 1], transform: ['translateX(16px) scale(.97)', 'none'] }, spring);
        const bar = el.querySelector('.srad-tbar');
        animate(bar, { transform: ['scaleX(1)', 'scaleX(0)'] }, { duration: life / 1000, easing: 'linear' });
        const timer = setTimeout(() => dismiss(el), life);
        el.addEventListener('pointerenter', () => clearTimeout(timer), { once: true });
        el.addEventListener('pointerleave', () => setTimeout(() => dismiss(el), 1200), { once: true });
        const b = el.querySelector('[data-toast-act]');
        if (b) b.addEventListener('click', () => {
          fire(action.id, action.payload || {});
          dismiss(el);
        });
        const sr = rootEl.querySelector('[data-el="live"]');
        if (sr) sr.textContent = String(msg);
        return el;
      }
      function dismiss(el) {
        if (!el || el.getAttribute('data-leaving') === '1') return;
        el.setAttribute('data-leaving', '1');
        const anim = animate(el, { opacity: [1, 0], transform: ['none', 'translateX(18px) scale(.97)'] }, { duration: 0.2 });
        const rm = () => {
          el.remove();
          const i = live.indexOf(el);
          if (i >= 0) live.splice(i, 1);
        };
        if (anim && anim.finished) anim.finished.then(rm, rm);
        else setTimeout(rm, 220);
      }

      /* ---------------- open / close ---------------- */
      function setOpen(on) {
        api.open = !!on;
        panel.setAttribute('data-open', on ? '1' : '0');
        fab.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (on) {
          lastFocused = root.document.activeElement;
          positionPanel();
          render();
          setTimeout(() => {
            const first = panel.querySelector('.srad-item') || bodyEl;
            try {
              first.focus({ preventScroll: true });
            } catch (_) {}
          }, 70);
        } else {
          openPop(false);
          if (lastFocused && lastFocused.focus) {
            try {
              lastFocused.focus({ preventScroll: true });
            } catch (_) {}
          }
        }
      }
      function toggle() {
        if (!api.open && o.beforeOpen) o.beforeOpen();
        vibrate(8);
        setOpen(!api.open);
      }

      function esc(v) {
        return util.esc ? util.esc(v) : String(v == null ? '' : v);
      }

      return Object.assign(api, {
        mount,
        render,
        toast,
        dismissAll() {
          live.slice().forEach(dismiss);
        },
        toggle,
        setOpen,
        setTab,
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
