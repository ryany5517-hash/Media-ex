/* --- live-reload (injected only by `npm run watch` / build --dev; never in production) --- */
(function streamRadarLiveReload() {
  'use strict';
  var PORT = 18765;
  var STAMP = 'http://127.0.0.1:' + PORT + '/stamp';
  var api = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome : (typeof browser !== 'undefined' ? browser : null);
  if (!api || !api.runtime || !api.runtime.reload) return;
  var last = null;
  var armed = false;

  function storageGet(keys) {
    try {
      return api.storage.local.get(keys);
    } catch (_) {
      return Promise.resolve({});
    }
  }
  function storageSet(obj) {
    try {
      return api.storage.local.set(obj);
    } catch (_) {
      return Promise.resolve();
    }
  }

  async function maybeReloadOpenTabs() {
    var rec = await storageGet(['srad:devreload-tabs']);
    if (!rec['srad:devreload-tabs']) return;
    await api.storage.local.remove('srad:devreload-tabs');
    if (!api.tabs || !api.tabs.query) return;
    var tabs = await api.tabs.query({});
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var u = t && t.url ? String(t.url) : '';
      if (!u || /^(chrome|moz|edge|about|devtools|view-source):/i.test(u)) continue;
      if (t.id == null) continue;
      try {
        api.tabs.reload(t.id);
      } catch (_) {}
    }
  }

  async function tick() {
    try {
      var r = await fetch(STAMP, { cache: 'no-store', mode: 'cors' });
      if (!r.ok) return;
      var j = await r.json();
      if (!j || !j.id) return;
      if (last == null) {
        last = j.id;
        await storageSet({ 'srad:devstamp': j.id });
        return;
      }
      if (String(j.id) === String(last)) return;
      last = j.id;
      await storageSet({ 'srad:devstamp': j.id, 'srad:devreload-tabs': 1 });
      try {
        api.runtime.reload();
      } catch (_) {}
    } catch (_) {
      /* watch server not running — stay silent */
    }
  }

  storageGet(['srad:devstamp']).then(function (s) {
    last = s['srad:devstamp'] || null;
    maybeReloadOpenTabs().catch(function () {});
    tick();
  });
  setInterval(tick, 1000);
  if (api.alarms && api.alarms.create) {
    try {
      api.alarms.create('srad:devwatch', { periodInMinutes: 1, delayInMinutes: 1 });
    } catch (_) {}
  }
  armed = true;
  try {
    console.log('[StreamRadar] live-reload armed →', STAMP);
  } catch (_) {}
  return armed;
})();
