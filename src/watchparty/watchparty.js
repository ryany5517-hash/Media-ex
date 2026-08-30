/**
 * Stream Radar — WatchParty.me adapter (content script, watchparty.me only)
 * ------------------------------------------------------------------
 * Thin glue around src/shared/watchparty-auto.js:
 *   • asks the background worker for the hand-off payload
 *     (media url + room name + converted subtitle text)
 *   • runs the automation
 *   • reports what happened back so the source tab can show a toast
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;
  const api = util.api();
  const doc = root.document;

  if (root.__streamRadarWatchParty) return;
  root.__streamRadarWatchParty = 1;

  let runner = null;

  async function getPayload() {
    try {
      const res = await api.runtime.sendMessage({ type: 'get-party-payload' });
      if (res && res.ok && res.payload) return res.payload;
    } catch (_) {}
    // Hand-opened tab? /create?video= auto-creates the room. There is no /watchNow.
    try {
      const q = new URLSearchParams(root.location.search);
      const url = q.get('video') || q.get('url');
      if (url) return { mediaUrl: url, roomName: q.get('name') || '', autoJoin: true, subtitle: null };
    } catch (_) {}
    return null;
  }

  function status(text, kind) {
    try {
      api.runtime.sendMessage({ type: 'party-status', text: text, kind: kind || 'info' }).catch(() => {});
    } catch (_) {}
  }

  async function boot() {
    if (!SR.watchparty) return;
    const payload = await getPayload();
    if (!payload) return;
    const settings = (await SR.settings.load()) || {};
    payload.autoJoin = settings.watchpartyAutoJoin !== false;
    const path = String(root.location.pathname || '');
    if (payload.mediaUrl && !/^\/watch\//i.test(path) && !/^\/r\//i.test(path) && !/^\/create/i.test(path)) {
      try {
        const res = await fetch('/createRoom', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ video: String(payload.mediaUrl).slice(0, 20000) }),
        });
        const data = await res.json();
        if (data && data.name) {
          root.location.assign('/watch' + data.name);
          return;
        }
      } catch (_) {}
    }
    runner = SR.watchparty.run({
      doc: doc,
      payload: payload,
      onStatus: status,
      t: (k, v) => SR.i18n.t(k, v),
    });
    if (payload.subtitle) status('Subtitle ' + (payload.subtitle.name || 'id') + ' ready. Use Attach subtitle in the room.', 'ok');
  }

  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg, sender, respond) => {
      if (msg && msg.type === 'attach-subtitle' && runner) {
        const n = runner.attach(msg.vtt, msg.name);
        respond({ ok: true, applied: n });
        return true;
      }
    });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
