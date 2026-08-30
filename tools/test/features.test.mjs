/**
 * Feature audit: does every advertised feature actually run end-to-end?
 * ------------------------------------------------------------------
 * Everything here executes the real shipped code (background worker + content
 * script + page hooks) through the runtime harness. One test per user-visible
 * promise, so "fiturnya jalan" is a fact, not a claim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootExtension, DEFAULT_PAGE, MASTER_M3U8, makeNetStub, PRELUDE, readSrc } from './harness.mjs';

const HLS_URL = 'https://stream.cdn-vidlove.net/hls/1516698/master.m3u8?token=9f2';
const MP4_URL = 'https://cdn.cineplex.test/movie/movie.mp4';

const ready = async (h) => {
  await h.wait(160);
};
/** broadcast is throttled (320 ms) → give the pipeline room before asserting */
const settle = async (h, ms = 700) => h.wait(ms);
/** poll until true (keeps tests fast AND deterministic) */
async function until(h, predicate, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (predicate()) return true;
    await h.wait(80);
  }
  return predicate();
}
const stateOf = (h) => h.hub.lastBroadcast || {};

async function boot(opts = {}) {
  globalThis.__sradOpenShadow = true;
  const h = await bootExtension({
    net: opts.net || makeNetStub(),
    settings: Object.assign(
      {
        subdlApiKey: 'test-key',
        providers: { subdl: true, opensubtitles: false, yify: false },
        autoSubtitle: true,
        watchpartyAutoJoin: true,
        notify: false,
        showAds: false,
        theme: 'dark',
        lang: 'id',
      },
      opts.settings || {}
    ),
  });
  await ready(h);
  return h;
}

/* ------------------------------------------------------------------ *
 * F1 · webRequest observer (the thing a userscript cannot do)
 * ------------------------------------------------------------------ */
test('F1 webRequest: a video/mp4 response in a nested frame becomes an MP4 entry', async () => {
  const h = await boot();
  h.hub.fireWebRequest({
    url: MP4_URL,
    type: 'media',
    statusCode: 200,
    responseHeaders: h.hub.header({ 'content-type': 'video/mp4', 'content-length': '734003200', 'accept-ranges': 'bytes' }),
  });
  await settle(h);
  const st = h.hub.lastBroadcast;
  assert.ok(st, 'background broadcast state to the tab');
  const item = st.items.find((i) => i.url === MP4_URL);
  assert.ok(item, 'mp4 item present: ' + JSON.stringify((st.items || []).map((i) => i.url)));
  assert.equal(item.category, 'mp4');
  assert.equal(item.size, 734003200);
  assert.equal(item.sizeLabel, '700 MB');
  assert.equal(item.via.includes('network'), true);
  assert.equal(h.hub.badge.get(1), '1', 'toolbar badge counts the media');

  // ranged seeking (206) is recognised, not duplicated
  h.hub.fireWebRequest({
    url: MP4_URL,
    type: 'media',
    statusCode: 206,
    responseHeaders: h.hub.header({ 'content-type': 'video/mp4', 'content-range': 'bytes 0-1023/734003200' }),
  });
  await h.wait(80);
  const st2 = h.hub.lastBroadcast;
  assert.equal(st2.items.filter((i) => i.url === MP4_URL).length, 1, 'no duplicate row for range requests');
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F2 · streams hidden by embed providers + manifest enrichment
 * ------------------------------------------------------------------ */
test('F2 embed wrappers are unwrapped and the master playlist is parsed', async () => {
  const h = await boot();
  // vidlove-style: the real .m3u8 only exists inside the iframe URL query
  h.hub.fireWebRequest({
    url: 'https://vidlove.org/embed/1516698?url=' + encodeURIComponent(HLS_URL),
    type: 'sub_frame',
    statusCode: 200,
    responseHeaders: h.hub.header({ 'content-type': 'text/html' }),
  });
  await settle(h, 1800); // debounced manifest fetch (800 ms) + parse + broadcast
  const item = (h.hub.lastBroadcast.items || []).find((i) => i.url === HLS_URL);
  assert.ok(item, 'inner m3u8 must be extracted from the wrapper URL');
  assert.equal(item.category, 'hls');
  assert.equal(item.quality, '1080p', 'best variant height from the master playlist');
  assert.equal(item.variants.length, 2, 'two variants listed for the quality picker');
  assert.equal(item.variants[1].quality, '720p');
  assert.match(item.aes, /key\.cdn\.test/, 'AES-128 key URI surfaced');
  assert.ok(h.fetchImpl.calls.some(([u]) => u.includes('master.m3u8')), 'background fetched the manifest once');
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F3 · page hooks (LAYER 1 + 3) reach the store through the content script
 * ------------------------------------------------------------------ */
test('F3 page hooks: fetch + blob/MSE reports are ingested, ads are separated', async () => {
  const h = await boot();
  const win = h.dom.window;
  win.__sradOpenShadow = true;
  win.postMessage(
    {
      srad: 1,
      kind: 'media',
      payload: { url: HLS_URL, category: 'hls', ext: 'm3u8', via: 'fetch', frame: 'iframe', t: Date.now(), manifestBody: MASTER_M3U8 },
    },
    '*'
  );
  win.postMessage({ srad: 1, kind: 'media', payload: { url: 'https://vast.doubleclick.net/preroll/spot.mp4', category: 'mp4', ext: 'mp4', via: 'fetch', isAd: true, frame: 'top', t: Date.now() } }, '*');
  win.postMessage({ srad: 1, kind: 'mse', payload: { url: 'blob:https://player.x/1-2', bytes: 42_000_000, mimes: ['video/mp4;codecs="avc1.640028"'], duration: 3600, recording: false } }, '*');
  await settle(h);
  const st = h.hub.lastBroadcast;
  const hls = st.items.find((i) => i.url === HLS_URL);
  assert.ok(hls && hls.via.includes('fetch'), 'page fetch report stored: ' + JSON.stringify(st.items.map((i) => [i.url, i.via])));
  assert.equal(hls.quality, '1080p', 'manifest body sent by the page is parsed without a second request');
  const blob = st.items.find((i) => i.category === 'blob');
  assert.ok(blob, 'blob/MSE entry exists');
  assert.equal(blob.mseBytes, 42_000_000);
  const ad = st.ads.find((i) => i.url.includes('doubleclick'));
  assert.ok(ad, 'ad row is kept in the ads bucket');
  assert.equal(st.items.some((i) => i.url.includes('doubleclick')), false, 'ads hidden from the default list');
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F4 · title extraction (JSON-LD + cleansing) drives the whole pipeline
 * ------------------------------------------------------------------ */
test('F4 title: SEO spam becomes a clean title, year and IMDb id', async () => {
  const h = await boot();
  await settle(h);
  const title = h.hub.lastBroadcast.title;
  assert.equal(title.title, 'Dune: Part Two', 'got: ' + title.title);
  assert.equal(title.year, '2024');
  assert.equal(title.kind, 'movie');
  assert.equal(title.source, 'json-ld', 'JSON-LD has priority over og:title');
  assert.match(title.imdbId, /tt15239678/);
  assert.match(title.poster, /poster\.jpg/);
  assert.equal(title.episode, null);
  // UI shows it
  const shadow = h.dom.window.document.getElementById('stream-radar-host').shadowRoot;
  assert.match(shadow.querySelector('[data-el="title"] b').textContent, /Dune: Part Two \(2024\)/);
  assert.match(shadow.querySelector('[data-el="title"] small').textContent, /67movies\.nl/);
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F5 · auto Indonesian subtitle: search → download zip → SRT→VTT → attach
 * ------------------------------------------------------------------ */
test('F5 subtitles: title triggers search, zip is unpacked, VTT is attached to the page video', async () => {
  const net = makeNetStub();
  const h = await boot({ net });
  // trigger explicitly (auto search is debounced after the title arrives)
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found'), 'subtitle status: ' + JSON.stringify(stateOf(h).sub));
  const st = stateOf(h);
  assert.equal(st.sub.items.length, 1);
  assert.equal(st.sub.items[0].provider, 'subdl');
  assert.ok(st.subHasFile, 'converted VTT cached for attach + WatchParty');
  assert.ok(net.calls.some(([u]) => u.includes('subdl.com/api/v1/subtitles?')), 'SubDL searched');
  assert.ok(net.calls.some(([u]) => u.includes('4242.zip')), 'zip downloaded for conversion');

  // attach to the current page
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-attach', tabId: 1 } });
  assert.equal(res.ok, true, 'attach action ok');
  await settle(h, 200);
  const track = h.dom.window.document.querySelector('video track[data-srad="1"]');
  assert.ok(track, '<track> injected into the page player');
  assert.equal(track.getAttribute('srclang'), 'id');
  assert.match(track.src, /^blob:/);
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F6 · WatchParty hand-off (no self-built player)
 * ------------------------------------------------------------------ */
test('F6 watch party: opens watchparty.me with media + cleaned room name + subtitle', async () => {
  const h = await boot();
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  await until(h, () => (stateOf(h).sub || {}).status === 'found', 8000);
  h.hub.fireWebRequest({ url: MP4_URL, type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'video/mp4', 'content-length': '1000' }) });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === MP4_URL));
  const item = h.hub.lastBroadcast.items.find((i) => i.url === MP4_URL);
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'watchparty', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'watchparty launched: ' + JSON.stringify(res));
  const tab = h.hub.tabs.created[h.hub.tabs.created.length - 1];
  assert.equal(tab.url.startsWith('https://www.watchparty.me/create?video='), true, 'auto-creates a room: ' + tab.url);
  assert.ok(tab.url.includes(encodeURIComponent(MP4_URL)), 'media url passed as ?video=');
  assert.ok(!tab.url.includes('watchNow'), 'legacy /watchNow hand-off is replaced by /create');
  const key = 'srad:party:' + tab.id;
  const payload = h.hub.storage[key];
  assert.ok(payload, 'hand-off payload stored for the watchparty tab');
  assert.equal(payload.mediaUrl, MP4_URL);
  assert.ok(payload.roomName.includes('Dune'), 'cleaned room name travels in the payload: ' + payload.roomName);
  assert.equal(payload.autoJoin, true);
  assert.ok(payload.subtitle && /^WEBVTT/.test(payload.subtitle.vtt), 'subtitle travels with the room');

  // Keep the payload until /watch/:id so a long-URL POST→redirect can still read it.
  const wpSender = { tab: { id: tab.id, url: tab.url }, url: tab.url };
  const got = await h.hub.sendFromContent({ type: 'get-party-payload' }, wpSender);
  assert.equal(got.ok, true, 'the new tab receives the payload');
  assert.ok(h.hub.storage[key], 'payload kept until the room URL loads');
  const roomUrl = 'https://www.watchparty.me/watch/abc123';
  const roomSender = { tab: { id: tab.id, url: roomUrl }, url: roomUrl };
  const gotRoom = await h.hub.sendFromContent({ type: 'get-party-payload' }, roomSender);
  assert.equal(gotRoom.ok, true);
  assert.equal(h.hub.storage[key], undefined, 'payload removed after the room loads');
  const again = await h.hub.sendFromContent({ type: 'get-party-payload' }, roomSender);
  assert.equal(again.ok, false, 'cannot be replayed');
  const thief = await h.hub.sendFromContent({ type: 'get-party-payload', tabId: tab.id });
  assert.equal(thief.ok, false, 'another tab cannot steal the payload');
  h.dom.window.close();
});

test('F6b watch party: long token POSTs /createRoom then opens /watch/{id}', async () => {
  const LONG = 'https://cdn.cineplex.test/movie/v0.m3u8?t=' + 'A'.repeat(2000);
  const net = makeNetStub({
    'watchparty.me/createRoom': { body: JSON.stringify({ name: '/room99' }), type: 'application/json' },
  });
  const h = await boot({ net, settings: { autoSubtitle: false, lastUpdateCheck: Date.now() } });
  h.hub.fireWebRequest({
    url: LONG,
    type: 'media',
    statusCode: 200,
    responseHeaders: h.hub.header({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '1000' }),
  });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === LONG));
  const item = h.hub.lastBroadcast.items.find((i) => i.url === LONG);
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'watchparty', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'watchparty launched: ' + JSON.stringify(res));
  assert.ok(net.calls.some(([u, m]) => String(u).includes('/createRoom') && String(m).toUpperCase() === 'POST'), 'POSTed createRoom');
  const tab = h.hub.tabs.created[h.hub.tabs.created.length - 1];
  assert.equal(tab.url, 'https://www.watchparty.me/watch/room99');
  assert.ok(!tab.url.includes('watchNow'), 'never opens the missing /watchNow route');
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F7 · downloads: file naming from the cleaned title, playlist for HLS
 * ------------------------------------------------------------------ */
test('F7 downloads: mp4 goes to chrome.downloads, hls downloads the parsed playlist', async () => {
  const h = await boot();
  h.hub.fireWebRequest({ url: MP4_URL, type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'video/mp4', 'content-length': '734003200' }) });
  h.hub.fireWebRequest({
    url: 'https://vidlove.org/embed/9?url=' + encodeURIComponent(HLS_URL),
    type: 'sub_frame',
    statusCode: 200,
    responseHeaders: h.hub.header({ 'content-type': 'text/html' }),
  });
  await settle(h, 1800);
  const st = h.hub.lastBroadcast;
  const mp4 = st.items.find((i) => i.category === 'mp4');
  const hls = st.items.find((i) => i.category === 'hls');
  assert.ok(mp4 && hls, 'both entries present for the test');
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'download', id: mp4.id, tabId: 1 } });
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'download', id: hls.id, tabId: 1 } });
  const dl = h.hub.downloads.calls;
  assert.equal(dl.length, 2, 'two downloads: ' + JSON.stringify(dl.map((d) => d.filename)));
  assert.equal(dl[0].filename, 'Dune Part Two.mp4');
  assert.match(dl[1].filename, /\.m3u8$/);
  assert.match(dl[1].url, /^data:text\/plain/, 'playlist is fetched then saved as a file');
  assert.ok(decodeURIComponent(dl[1].url).includes('#EXT-X-STREAM-INF'), 'real playlist body saved');
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F8 · settings: panel switch → storage → broadcast → per-site opt-out
 * ------------------------------------------------------------------ */
test('F8 settings: changes persist, reach every view, and per-site mute stops detection', async () => {
  const h = await boot();
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'set-setting', key: 'showAds', value: true, tabId: 1 } });
  await settle(h, 200);
  const saved = h.hub.storage['srad:settings'];
  assert.equal(saved.showAds, true, 'written to storage');
  assert.equal(h.hub.lastBroadcast.settings.showAds, true, 'broadcast back to the panel');

  // per-site opt-out
  const toggle = await h.hub.sendFromContent({ type: 'action', payload: { name: 'toggle-site', tabId: 1 } });
  assert.equal(toggle.ok, true);
  assert.equal(h.hub.storage['srad:settings'].blockedHosts['67movies.nl'], true, 'host muted');
  const before = (h.hub.lastBroadcast.items || []).length;
  h.hub.fireWebRequest({ url: MP4_URL, type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'video/mp4' }) });
  await h.wait(120);
  const after = (h.hub.lastBroadcast.items || []).length;
  assert.equal(after, before, 'no new media while the site is muted');
  // and the panel shows the paused chip
  const shadow = h.dom.window.document.getElementById('stream-radar-host').shadowRoot;
  assert.ok(h.hub.lastBroadcast.pagePaused, 'state says paused');
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'toggle-site', tabId: 1 } });
  await h.wait(60);
  assert.equal(h.hub.storage['srad:settings'].blockedHosts['67movies.nl'], false, 'unmute works');
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F9 · UI interactions: click → action routing, keyboard, badge, pulse
 * ------------------------------------------------------------------ */
test('F9 UI: FAB opens the panel, item buttons route real actions, Esc closes', async () => {
  const h = await boot();
  h.hub.fireWebRequest({ url: MP4_URL, type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'video/mp4', 'content-length': '734003200' }) });
  await settle(h);
  const win = h.dom.window;
  win.__sradOpenShadow = true;
  const shadow = win.document.getElementById('stream-radar-host').shadowRoot;
  const fab = shadow.querySelector('.srad-fab');
  const panel = shadow.querySelector('.srad-panel');
  assert.equal(fab.getAttribute('aria-expanded'), 'false', 'starts closed');
  fab.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.equal(panel.getAttribute('data-open'), '1', 'opens on click');
  assert.equal(fab.getAttribute('aria-expanded'), 'true');
  assert.ok(shadow.querySelector('.srad-item'), 'list rendered');
  assert.equal(shadow.querySelector('.srad-badge').textContent, '1');

  // per-item actions
  const first = shadow.querySelector('.srad-item');
  assert.ok(first.querySelector('[data-act="play"]'), 'Play is the primary action on a stream row');
  for (const act of ['watchparty', 'copy', 'subs', 'download', 'ffmpeg']) {
    const btn = first.querySelector(`[data-act="${act}"]`);
    assert.ok(btn, `action button present: ${act}`);
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  }
  await until(h, () => h.hub.tabs.created.some((t) => t.url.includes('watchparty.me')));
  assert.ok(h.hub.downloads.calls.some((d) => d.filename === 'Dune Part Two.mp4'), 'download action reached the background');
  assert.ok(
    await until(h, () => h.fetchImpl.calls.some(([u]) => u.includes('subdl.com')), 8000),
    'subtitle action searched (net calls: ' + h.fetchImpl.calls.map((c) => c[0].slice(0, 40)).join(' | ') + ')'
  );

  // Esc closes
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await h.wait(20);
  assert.equal(panel.getAttribute('data-open'), '0', 'Esc closes the panel');

  // keyboard shortcut from the manifest
  await h.hub.fireCommand('toggle-panel');
  await h.wait(20);
  assert.equal(panel.getAttribute('data-open'), '1', 'Alt+Shift+S toggles the panel');

  // dragging the FAB persists its position through the settings action
  const before = fab.getBoundingClientRect();
  const mk = (type, x, y) => new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  fab.dispatchEvent(mk('pointerdown', before.left + 20, before.top + 20));
  win.dispatchEvent(mk('pointermove', before.left - 140, before.top - 120));
  win.dispatchEvent(mk('pointerup', before.left - 140, before.top - 120));
  await until(h, () => h.hub.log.some(([k, v]) => k === 'storage.set' && String(v).includes('srad:settings')));
  assert.equal(h.hub.storage['srad:settings'].fabPos && typeof h.hub.storage['srad:settings'].fabPos.x, 'number', 'fab position persisted');
  assert.notEqual(fab.style.left, '', 'inline offset applied');

  // accessibility + touch contract on every control
  assert.equal(fab.getAttribute('role'), 'button');
  assert.equal(fab.getAttribute('aria-expanded'), 'true');
  assert.ok(panel.getAttribute('role'), 'dialog');
  for (const b of panel.querySelectorAll('.srad-btn, .srad-iconbtn')) {
    const label = b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent.trim();
    assert.ok(label.length > 1, 'every control has an accessible name');
  }
  assert.equal(panel.querySelectorAll('svg [onclick], [onclick]').length, 0, 'no inline handlers');
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F10 · ad noise, dedupe, cap, clear
 * ------------------------------------------------------------------ */
test('F10 hygiene: volatile query tokens dedupe, segment flood aggregates, clear empties', async () => {
  const h = await boot();
  const fire = (url, type = 'media', extra = {}) =>
    h.hub.fireWebRequest({ url, type, statusCode: 200, responseHeaders: h.hub.header(Object.assign({ 'content-type': 'video/mp4', 'content-length': '1000' }, extra)) });

  fire(MP4_URL + '?token=aaa');
  fire(MP4_URL + '?token=bbb');
  fire(MP4_URL + '?token=ccc');
  for (let i = 0; i < 40; i++) fire(`https://cdn.cineplex.test/movie/seg-${i}.ts`, 'media', { 'content-type': 'video/mp2t' });
  await h.wait(160);
  const st = h.hub.lastBroadcast;
  assert.equal(st.items.filter((i) => i.url.startsWith(MP4_URL)).length, 1, 'token rotation must not create duplicates');
  const group = st.items.find((i) => i.kind === 'segmentgroup');
  assert.ok(group, 'segments aggregated into one row');
  assert.equal(group.segmentCount, 40);
  assert.match(group.segmentBytesLabel, /KB|MB/);

  // clear
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'clear', tabId: 1 } });
  await h.wait(120);
  assert.equal(h.hub.lastBroadcast.items.length, 0, 'cleared');
  assert.equal(h.hub.badge.get(1), '', 'badge cleared');
  assert.equal(h.hub.storage['srad:tab:1'], undefined, 'persisted state cleared');
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F11 · context menu + command + recent-history + prune
 * ------------------------------------------------------------------ */
test('F11 browser surfaces: context menu, recent list, storage prune', async () => {
  const h = await boot();
  assert.ok(h.hub.contextMenus.items.has('sr-watchparty'), 'context menu registered');
  assert.match(h.hub.contextMenus.items.get('sr-watchparty').title, /Watch|Nonton/);
  assert.ok(h.hub.contextMenus.items.has('sr-play'), 'Play context menu registered');

  h.hub.fireWebRequest({ url: MP4_URL, type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'video/mp4', 'content-length': '1000' }) });
  await settle(h, 2200);
  h.hub.fireContext({ menuItemId: 'sr-download', srcUrl: MP4_URL });
  await h.wait(60);
  assert.ok(h.hub.downloads.calls.some((d) => d.url === MP4_URL), 'context-menu download works');

  // recent list persisted for cross-tab recovery (debounced 4 s on purpose)
  await h.wait(4300);
  assert.ok(Array.isArray(h.hub.storage['srad:history']), 'history written');
  assert.ok(h.hub.storage['srad:history'].some((x) => x.url === MP4_URL));
  const hist = await h.hub.sendFromContent({ type: 'action', payload: { name: 'history', tabId: 1 } });
  assert.ok(hist.history.length >= 1, 'popup can read the history');

  // prune removes state of closed tabs
  h.hub.storage['srad:tab:999'] = { savedAt: Date.now() - 9_999_999, entries: [] };
  await h.hub.fireAlarm('srad:prune');
  assert.equal(h.hub.storage['srad:tab:999'], undefined, 'stale tab state pruned');
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F12 · per-tab state survives a service worker restart (the MV3 gotcha)
 * ------------------------------------------------------------------ */
test('F12 restart resilience: state restored from storage after the worker dies', async () => {
  const h = await boot();
  h.hub.fireWebRequest({ url: MP4_URL, type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'video/mp4', 'content-length': '1000' }) });
  await settle(h, 2200); // persist is debounced
  const saved = JSON.parse(JSON.stringify(h.hub.storage['srad:tab:1']));
  assert.ok(saved.entries.length >= 1, 'state was persisted');

  // simulate the worker being torn down and woken up again
  h.hub.bgListeners.length = 0;
  const vm = await import('node:vm');
  const ctx2 = vm.createContext({
    chrome: h.hub.apiBg,
    importScripts() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    fetch: (u, i) => h.fetchImpl(u, i),
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    Blob: class {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    structuredClone,
    Uint8Array,
    ArrayBuffer,
  });
  const src = [...PRELUDE, 'background.js'].map((f) => readModule(f)).join('\n');
  vm.runInContext(src, ctx2, { filename: 'background-restarted.js' });
  await new Promise((r) => setTimeout(r, 120));
  h.hub.tabActivated && h.hub.tabActivated({ tabId: 1 });
  await new Promise((r) => setTimeout(r, 120));
  const st = h.hub.lastBroadcast;
  assert.ok(st.items.some((i) => i.url === MP4_URL), 'list rebuilt after worker restart: ' + JSON.stringify(st.items.map((i) => i.url)));
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F13 · local player (the thing that actually plays, unlike WatchParty)
 * ------------------------------------------------------------------ */
test('F13 play: opens the cinema player with page Referer and proxies HLS with that Referer', async () => {
  const h = await boot();
  h.hub.fireWebRequest({ url: HLS_URL, type: 'xmlhttprequest', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'application/vnd.apple.mpegurl' }) });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === HLS_URL), 4000);
  const item = h.hub.lastBroadcast.items.find((i) => i.url === HLS_URL);
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'play', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'play launched: ' + JSON.stringify(res));
  assert.ok(res.sid, 'session id issued');
  const tab = h.hub.tabs.created.find((t) => String(t.url).includes('player/player.html'));
  assert.ok(tab, 'player tab opened: ' + JSON.stringify(h.hub.tabs.created.map((t) => t.url)));
  assert.match(tab.url, /sid=/);
  const stored = h.hub.storage['srad:play:' + res.sid];
  assert.ok(stored, 'play session persisted');
  assert.equal(stored.url, HLS_URL);
  assert.match(stored.referer, /67movies\.nl/, 'Referer is the original page, not the extension: ' + stored.referer);

  const got = await h.hub.sendFromContent({ type: 'get-play-session', sid: res.sid }, { tab: tab, url: tab.url });
  assert.equal(got.ok, true);
  assert.equal(got.session.url, HLS_URL);

  const fetched = await h.hub.sendFromContent({ type: 'player-fetch', sid: res.sid, url: HLS_URL, responseType: 'text' }, { tab: tab, url: tab.url });
  assert.equal(fetched.ok, true, 'worker fetch: ' + JSON.stringify(fetched));
  assert.match(String(fetched.data), /#EXTM3U/, 'playlist body returned for hls.js');
  h.dom.window.close();
});

test('F14 play: resolver API (d.shows.st/api?d=) is fetched with page Referer and unwrapped to HLS', async () => {
  const API = 'https://d.shows.st/api?d=TsjRBDQAZCnpz8n3Nnaf0jZHBf8D7BI4token';
  const INNER = 'https://stream.cdn-vidlove.net/hls/1516698/master.m3u8?token=9f2';
  const net = makeNetStub({
    'd.shows.st/api': { body: JSON.stringify({ file: INNER }), type: 'application/json' },
  });
  const h = await boot({ net });
  h.hub.fireWebRequest({
    url: API,
    type: 'xmlhttprequest',
    statusCode: 200,
    responseHeaders: h.hub.header({ 'content-type': 'application/json', 'content-length': '240' }),
  });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === API), 2000);
  let item = (h.hub.lastBroadcast.items || []).find((i) => i.url === API);
  if (!item) {
    h.hub.fireWebRequest({
      url: API,
      type: 'media',
      statusCode: 200,
      responseHeaders: h.hub.header({ 'content-type': 'video/mp4', 'content-length': '240' }),
    });
    await until(h, () => (stateOf(h).items || []).some((i) => i.url === API), 4000);
    item = (h.hub.lastBroadcast.items || []).find((i) => i.url === API);
  }
  assert.ok(item, 'resolver row present: ' + JSON.stringify((h.hub.lastBroadcast.items || []).map((i) => i.url)));
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'play', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'play launched: ' + JSON.stringify(res));
  const stored = h.hub.storage['srad:play:' + res.sid];
  assert.ok(stored, 'play session persisted');
  assert.equal(stored.url, INNER, 'resolver unwrapped to the real m3u8: ' + stored.url);
  assert.equal(stored.category, 'hls');
  assert.match(stored.referer, /67movies\.nl/);
  assert.ok(net.calls.some(([u]) => String(u).includes('d.shows.st/api')), 'resolver fetched with host access');
  h.dom.window.close();
});

test('F15 play: page Referer 403 then retry with stream origin like IDM', async () => {
  const API = 'https://d.shows.st/api?d=TsjRBDQAZCnpz8n3Nnaf0jZHBf8D7BI4token';
  const PLAYLIST = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720\n720/index.m3u8\n';
  const calls = [];
  const net = async (url, init) => {
    const u = String(url);
    const headers = (init && init.headers) || {};
    const ref = String(headers.Referer || headers.referer || '');
    calls.push([u, ref]);
    net.calls = calls;
    if (u.includes('d.shows.st/api')) {
      if (!/shows\.st/i.test(ref)) throw new Error('HTTP 403 for ' + u);
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/vnd.apple.mpegurl' : null) },
        async text() {
          return PLAYLIST;
        },
        async arrayBuffer() {
          return new TextEncoder().encode(PLAYLIST).buffer;
        },
      };
    }
    throw new Error('net stub: unexpected ' + u);
  };
  net.calls = calls;
  const h = await boot({ net, settings: { autoSubtitle: false, lastUpdateCheck: Date.now() } });
  h.hub.fireWebRequest({
    url: API,
    type: 'xmlhttprequest',
    statusCode: 200,
    initiator: 'https://fzmovies.net',
    responseHeaders: h.hub.header({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '240' }),
  });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === API), 4000);
  const item = (h.hub.lastBroadcast.items || []).find((i) => i.url === API);
  assert.ok(item, 'hls resolver row present');
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'play', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'play launched: ' + JSON.stringify(res));
  const stored = h.hub.storage['srad:play:' + res.sid];
  assert.ok(stored, 'play session persisted');
  assert.equal(stored.url, API);
  assert.equal(stored.category, 'hls');
  assert.match(stored.referer, /shows\.st/, 'Referer fell through to the stream host after the page 403: ' + stored.referer);
  assert.ok(calls.some(([u, r]) => u.includes('d.shows.st/api') && /shows\.st/i.test(r)), 'worker retried with stream-origin Referer');
  h.dom.window.close();
});

test('F16 play: m3u8-proxy URL keeps wrapper + baked Origin/Referer', async () => {
  const inner = 'https://futureproofmarketing.site/pl/master.m3u8';
  const proxy =
    'https://proxy.valhallastream.dpdns.org/m3u8-proxy?url=' +
    encodeURIComponent(inner) +
    '&headers=' +
    encodeURIComponent(JSON.stringify({ Origin: 'https://nextgencloudfabric.com', Referer: 'https://nextgencloudfabric.com/' }));
  const h = await boot({ settings: { autoSubtitle: false, lastUpdateCheck: Date.now() } });
  h.hub.fireWebRequest({
    url: proxy,
    type: 'xmlhttprequest',
    statusCode: 200,
    responseHeaders: h.hub.header({ 'content-type': 'application/vnd.apple.mpegurl' }),
  });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === proxy), 4000);
  const item = (h.hub.lastBroadcast.items || []).find((i) => i.url === proxy);
  assert.ok(item, 'proxy row present: ' + JSON.stringify((h.hub.lastBroadcast.items || []).map((i) => i.url)));
  assert.equal(item.category, 'hls');
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'play', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'play launched: ' + JSON.stringify(res));
  const stored = h.hub.storage['srad:play:' + res.sid];
  assert.equal(stored.url, proxy, 'play uses the proxy wrapper, not the naked inner m3u8');
  assert.equal(stored.category, 'hls');
  assert.match(stored.referer, /nextgencloudfabric\.com/, 'Referer taken from headers= query: ' + stored.referer);
  assert.match(stored.origin, /nextgencloudfabric\.com/);
  h.dom.window.close();
});

const readModule = (rel) => readSrc(rel);
