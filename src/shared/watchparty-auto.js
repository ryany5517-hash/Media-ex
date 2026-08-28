/**
 * Stream Radar — WatchParty automation core (context-agnostic)
 * ------------------------------------------------------------------
 * Shared by:
 *   • the extension content script src/watchparty/watchparty.js
 *   • the userscript build (tools/build-userscript.mjs → host.js)
 *
 * WatchParty (github.com/howardchung/watchparty) exposes no REST API for room
 * creation, so this module drives its DOM. Matching is *semantic* (label /
 * placeholder / aria-label / name / id text) instead of selector-based, because
 * the React app is rebuilt often and class names are hashed.
 *
 * What it can do:
 *   • fill the room name and the user name on the landing / join form
 *   • fill the "media URL" field if the room was opened without ?url=
 *   • optionally click Join
 *   • attach a WebVTT subtitle track to the room's <video>, re-applying it after
 *     React re-renders (WatchParty natively plays direct files and .m3u8 HLS)
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;

  const NAME_HINT = /(room|party)\s*name|roomname|nama\s*room|^room$/i;
  const USER_HINT = /(user|display|nick)\s*name|username|nama\s*(pengguna|kamu)/i;
  const URL_HINT = /(media|video|url|link|src)\s*(url|link)?|paste.*(url|link)|url\s*(of|the)?\s*(video|media)/i;

  function labelOf(el) {
    const parts = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('name'), el.id];
    try {
      if (el.labels) for (const l of el.labels) parts.push(l.textContent);
      // Only use a wrapper's text when it wraps exactly this control, otherwise
      // a sibling's label leaks in and we fill the wrong field.
      const wrap = el.closest('label');
      if (wrap) parts.push(wrap.textContent);
      else {
        const box = el.closest('[class*="field"], [class*="row"], [class*="input"]');
        if (box && box.querySelectorAll('input, textarea').length === 1) parts.push(box.textContent);
      }
      const prev = el.previousElementSibling;
      if (prev && prev.children.length === 0) parts.push(prev.textContent);
    } catch (_) {}
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function hasLayout(el) {
    // offsetWidth/offsetHeight are 0 while the node is not laid out (and in
    // headless test DOMs) — that must not make us give up on a real form field.
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    if (w === 0 && h === 0) return null; // unknown → treat as "maybe visible"
    return w > 4 && h > 4;
  }

  function fields(doc) {
    const all = [...doc.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea')].filter(
      (el) => !el.disabled && !el.readOnly
    );
    const laid = all.filter((el) => hasLayout(el) !== false);
    return (laid.length ? laid : all).map((el) => ({ el, label: labelOf(el) }));
  }

  function setValue(el, value) {
    if (!el || value == null || value === '') return false;
    if (el.value && el.value.trim()) return false;
    try {
      const proto = el.tagName === 'TEXTAREA' ? root.HTMLTextAreaElement : root.HTMLInputElement;
      const desc = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, String(value));
      else el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (_) {
      el.value = String(value);
      return false;
    }
  }

  function findButton(doc, re) {
    const list = [...doc.querySelectorAll('button, [role="button"], input[type=submit], a[class*="button"]')];
    return list.find((b) => {
      const txt = (b.textContent || b.value || '').trim().replace(/\s+/g, ' ');
      return txt && txt.length < 44 && re.test(txt) && !b.disabled && b.offsetWidth !== 0 ? true : txt && txt.length < 44 && re.test(txt) && !b.disabled;
    });
  }

  SR.watchparty = {
    /**
     * @param {object} opts
     *   doc       Document
     *   payload   {mediaUrl, roomName, userName, autoJoin, subtitle:{vtt,name}}
     *   onStatus(text, kind)
     *   t(key, vars) optional translator
     * @returns {{cancel:Function}}
     */
    run(opts) {
      const doc = opts.doc || root.document;
      const p = opts.payload || {};
      const status = opts.onStatus || function () {};
      const t = opts.t || ((k) => k);
      const state = { done: false, joined: false, attached: false, blobUrls: [], timer: null, observers: [] };
      let attempts = 0;

      function tryForm() {
        if (state.done) return;
        attempts++;
        let touched = 0;
        const f = fields(doc);
        const room = f.find((x) => NAME_HINT.test(x.label));
        const user = f.find((x) => USER_HINT.test(x.label));
        const urlField = p.mediaUrl ? f.find((x) => URL_HINT.test(x.label) && !/search/i.test(x.label)) : null;
        const joinBtn = findButton(doc, /^(join|create|enter|make|gabung|masuk)\b/i);

        if (room) touched += setValue(room.el, p.roomName) ? 1 : 0;
        if (user) touched += setValue(user.el, p.userName || 'Stream Radar') ? 1 : 0;
        if (urlField) touched += setValue(urlField.el, p.mediaUrl) ? 1 : 0;

        if (touched) status('Stream Radar filled the room form (' + touched + ' field' + (touched > 1 ? 's' : '') + ')', 'ok');
        if (p.autoJoin !== false && joinBtn && !state.joined) {
          state.joined = true;
          setTimeout(() => {
            try {
              joinBtn.click();
              status('Joining room…', 'info');
            } catch (_) {}
          }, 320);
        }
        // landing page already gone → we are inside a room
        if (!room && !user && !urlField && (doc.querySelector('video') || /\/watch\/|watchNow/i.test(root.location.href))) state.done = true;
        if (attempts > 45) state.done = true;
      }

      // Object URLs can be patched/restricted by the host page; a data: URL is a
      // perfectly valid <track src> fallback and needs no revocation.
      function makeVttUrl(vtt) {
        try {
          if (root.URL && typeof root.URL.createObjectURL === 'function' && root.Blob) {
            return root.URL.createObjectURL(new root.Blob([vtt], { type: 'text/vtt' }));
          }
        } catch (_) {}
        try {
          return 'data:text/vtt;charset=utf-8,' + encodeURIComponent(vtt);
        } catch (_) {
          return '';
        }
      }

      function attachTracks(vtt, name, force) {
        if (!vtt) return 0;
        let url = state.blobUrl;
        if (!url || force) {
          url = makeVttUrl(vtt);
          if (!url) return 0;
          state.blobUrl = url;
          if (url.indexOf('blob:') === 0) state.blobUrls.push(url);
        }
        let n = 0;
        for (const video of doc.querySelectorAll('video')) {
          try {
            if (video.querySelector('track[data-srad="1"]')) {
              n++;
              continue;
            }
            const track = doc.createElement('track');
            track.kind = 'subtitles';
            track.srclang = 'id';
            track.label = (name || 'Indonesian') + ' · Stream Radar';
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
        if (n) state.attached = true;
        return n;
      }

      function chip() {
        if (state.chip || !doc.body) return;
        const host = doc.createElement('div');
        host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;font-family:system-ui,sans-serif';
        const shadow = host.attachShadow({ mode: 'closed' });
        shadow.innerHTML =
          '<style>:host{all:initial}.wrap{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:14px;background:rgba(20,23,38,.86);backdrop-filter:blur(10px);color:#e9edf7}button{font:600 12px system-ui;padding:8px 11px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:#fff;cursor:pointer;min-height:36px}button:hover{border-color:#8b7cff}span{font:700 11px system-ui;opacity:.7}</style>' +
          '<div class="wrap"><span>STREAM RADAR</span><button data-a="subs">' + t('panel.subs.attach') + '</button><button data-a="copy">' + t('action.copy') + '</button><button data-a="dl">' + t('panel.subs.download') + '</button></div>';
        doc.body.appendChild(host);
        state.chip = host;
        shadow.addEventListener('click', (e) => {
          const b = e.target.closest && e.target.closest('[data-a]');
          if (!b) return;
          const a = b.getAttribute('data-a');
          if (a === 'subs') {
            const n = attachTracks((p.subtitle || {}).vtt, (p.subtitle || {}).name, true);
            status(n ? t('panel.subs.found') + ' ×' + n : t('panel.subs.none'), n ? 'ok' : 'warn');
          } else if (a === 'copy') {
            try {
              navigator.clipboard.writeText(p.mediaUrl || '');
              status(t('toast.copied'), 'ok');
            } catch (_) {}
          } else if (a === 'dl') {
            const vtt = (p.subtitle || {}).vtt;
            if (!vtt) return status(t('panel.subs.none'), 'warn');
            const a2 = doc.createElement('a');
            a2.href = state.blobUrl || root.URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
            a2.download = String(p.roomName || 'subtitles').replace(/[\\/:*?"<>|]/g, '.') + '.id.vtt';
            doc.body.appendChild(a2);
            a2.click();
            a2.remove();
          }
        });
      }

      function tick() {
        try {
          tryForm();
          chip();
          if (!state.attached && p.subtitle && p.subtitle.vtt && doc.querySelector('video')) attachTracks(p.subtitle.vtt, p.subtitle.name, false);
        } catch (_) {}
      }

      state.timer = setInterval(tick, 900);
      tick();
      try {
        const mo = new MutationObserver(util.throttle(tick, 700));
        mo.observe(doc.documentElement, { childList: true, subtree: true });
        state.observers.push(mo);
      } catch (_) {}

      return {
        state: state,
        attach: (vtt, name) => attachTracks(vtt, name, true),
        stop() {
          clearInterval(state.timer);
          state.observers.forEach((o) => {
            try {
              o.disconnect();
            } catch (_) {}
          });
          state.blobUrls.forEach((u) => {
            try {
              URL.revokeObjectURL(u);
            } catch (_) {}
          });
          if (state.chip) state.chip.remove();
        },
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
