/**
 * Feature audit: does every advertised feature actually run end-to-end?
 * ------------------------------------------------------------------
 * Everything here executes the real shipped code (background worker + content
 * script + page hooks) through the runtime harness. One test per user-visible
 * promise, so "fiturnya jalan" is a fact, not a claim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootExtension, DEFAULT_PAGE, MASTER_M3U8, SRT_TEXT, makeNetStub, PRELUDE, readSrc } from './harness.mjs';

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
    html: opts.html,
    url: opts.url,
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
    seedStorage: opts.seedStorage || null,
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
  assert.match(shadow.querySelector('[data-el="meta"]').textContent, /tt15239678/);
  h.dom.window.close();
});

test('F4b page without IMDb: lookup from title, then Watch Party already has a subtitle', async () => {
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<title>Nonton Interstellar (2014) Subtitle Indonesia | 67movies.net</title>
<meta property="og:title" content="Interstellar (2014)">
</head><body>
<h1>Interstellar (2014)</h1>
<video id="player" controls></video>
</body></html>`;
  const net = makeNetStub({
    'v2.sg.media-imdb.com': {
      body: JSON.stringify({ d: [{ id: 'tt0816692', l: 'Interstellar', y: 2014, qid: 'movie' }] }),
      type: 'application/json',
    },
  });
  const h = await boot({ html, net });
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  assert.ok(await until(h, () => (stateOf(h).title || {}).imdbId === 'tt0816692'), 'imdb resolved: ' + JSON.stringify(stateOf(h).title));
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found'), 'subtitle status: ' + JSON.stringify(stateOf(h).sub));
  assert.ok(net.calls.some(([u]) => String(u).includes('v2.sg.media-imdb.com')), 'IMDb suggestion queried');
  assert.equal((stateOf(h).sub || {}).imdbId, 'tt0816692');
  const shadow = h.dom.window.document.getElementById('stream-radar-host').shadowRoot;
  assert.match(shadow.querySelector('[data-el="meta"]').textContent, /tt0816692/);

  h.hub.fireWebRequest({ url: MP4_URL, type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'video/mp4', 'content-length': '1000' }) });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === MP4_URL));
  const item = h.hub.lastBroadcast.items.find((i) => i.url === MP4_URL);
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'watchparty', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'watchparty launched: ' + JSON.stringify(res));
  const tab = h.hub.tabs.created[h.hub.tabs.created.length - 1];
  const payload = h.hub.storage['srad:party:' + tab.id];
  assert.ok(payload && payload.subtitle && /^WEBVTT/.test(payload.subtitle.vtt), 'subtitle already on the room');
  h.dom.window.close();
});

test('F4c 67movies URL movie id hydrates The Eye and is enough for subtitles', async () => {
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<title>67movies.net — Watch Movies &amp; TV Shows in HD Online</title>
<meta property="og:title" content="67movies.net — Watch Movies & TV Shows in HD Online">
</head><body><p>Finding the best source</p></body></html>`;
  const net = makeNetStub({
    'themoviedb.org/movie/10389': {
      body: '<html><head><meta property="og:title" content="The Eye (2002)"><title>The Eye (2002) — The Movie Database (TMDB)</title></head></html>',
      type: 'text/html',
    },
    'v2.sg.media-imdb.com': {
      body: JSON.stringify({ d: [{ id: 'tt0314196', l: 'The Eye', y: 2002, qid: 'movie' }] }),
      type: 'application/json',
    },
  });
  const h = await boot({ html, url: 'https://67movies.nl/watch/movie/10389', net });
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  assert.ok(await until(h, () => (stateOf(h).title || {}).urlTmdbId === '10389' || (stateOf(h).title || {}).tmdbId === '10389'), 'catalog id from URL: ' + JSON.stringify(stateOf(h).title));
  assert.ok(await until(h, () => (stateOf(h).title || {}).title === 'The Eye'), 'title hydrated: ' + JSON.stringify(stateOf(h).title));
  assert.ok(await until(h, () => (stateOf(h).title || {}).imdbId === 'tt0314196' || (stateOf(h).sub || {}).imdbId === 'tt0314196'), 'imdb from catalog: ' + JSON.stringify({ title: stateOf(h).title, sub: stateOf(h).sub }));
  h.dom.window.close();
});

test('F4d action "subs" (what the panel/popup row buttons send) is treated as subs-search', async () => {
  const h = await boot({ settings: { autoSubtitle: false } });
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs', tabId: 1 } });
  assert.equal(res.ok, true, 'worker accepted the subs action: ' + JSON.stringify(res));
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found'), 'search ran from raw subs action: ' + JSON.stringify(stateOf(h).sub));
  h.dom.window.close();
});

test('F4e clicking the panel Subs button (retry) triggers a subtitle search', async () => {
  const h = await boot({ settings: { autoSubtitle: false } });
  const win = h.dom.window;
  const shadow = win.document.getElementById('stream-radar-host').shadowRoot;
  const tab = shadow.querySelector('[data-act="tab"][data-tab="subs"]');
  assert.ok(tab, 'subs tab rendered');
  tab.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await h.wait(60);
  const retry = shadow.querySelector('[data-act="subs"][data-primary="1"]');
  assert.ok(retry, 'subs pane retry button rendered');
  retry.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found'), 'clicking the retry button searched: ' + JSON.stringify(stateOf(h).sub));
  h.dom.window.close();
});

test('F4f clicking the Subtitles button on a stream row responds visibly (toast + pane switch + search)', async () => {
  const h = await boot({ settings: { autoSubtitle: false } });
  const win = h.dom.window;
  // a detected stream so a row with a Subtitles button exists
  h.hub.fireWebRequest({ url: MP4_URL, type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'video/mp4', 'content-length': '1000' }) });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === MP4_URL));
  await h.wait(80);
  const shadow = win.document.getElementById('stream-radar-host').shadowRoot;
  const row = shadow.querySelector('.srad-item');
  const btn = row && row.querySelector('[data-act="subs"]');
  assert.ok(btn, 'row Subtitles button exists');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  // immediate visible response: panel switched to the subtitles pane
  await until(h, () => {
    const tab = shadow.querySelector('[data-act="tab"][data-tab="subs"]');
    return tab && tab.getAttribute('aria-selected') === 'true';
  }, 4000);
  assert.ok(shadow.querySelector('.srad-sub-card'), 'subtitles pane is shown after clicking row Subtitles');
  // a toast appeared
  assert.ok(shadow.querySelector('.srad-toast'), 'a toast appeared on click');
  // and the search actually ran
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found'), 'search ran from row Subtitles click: ' + JSON.stringify(stateOf(h).sub));
  h.dom.window.close();
});

test('F4g junk page title: stream URL id recovers title and still finds subtitles', async () => {
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<title>Watch Movies &amp; TV Shows in HD Online</title>
<meta property="og:title" content="Watch Movies &amp; TV Shows in HD Online">
</head><body><p>Finding the best source</p></body></html>`;
  const net = makeNetStub({
    'themoviedb.org/movie/10389': {
      body: '<html><head><meta property="og:title" content="The Eye (2002)"><title>The Eye (2002) - TMDB</title></head></html>',
      type: 'text/html',
    },
  });
  const h = await boot({ html, url: 'https://67movies.nl/watch/some-generic-page', net, settings: { autoSubtitle: false } });
  // the page carries no id, but the detected stream URL does: /hls/10389/master.m3u8
  h.hub.fireWebRequest({ url: 'https://a2.shows.st/hls/10389/master.m3u8?token=9f2', type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '1000' }) });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url.includes('master.m3u8')));
  // clicking Subtitles (action 'subs') must recover the id and search anyway
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs', tabId: 1 } });
  assert.ok(await until(h, () => (stateOf(h).title || {}).tmdbId === '10389' || (stateOf(h).title || {}).urlTmdbId === '10389'), 'id recovered from stream URL: ' + JSON.stringify(stateOf(h).title));
  assert.ok(await until(h, () => (stateOf(h).title || {}).title === 'The Eye'), 'title hydrated from TMDB: ' + JSON.stringify(stateOf(h).title));
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found'), 'subtitle search ran with recovered id: ' + JSON.stringify(stateOf(h).sub));
  h.dom.window.close();
});

test('F4h junk page + stream WITHOUT id: click subs must not say "play the video first", status none with reason', async () => {
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8">
<title>Watch Movies &amp; TV Shows in HD Online</title>
</head><body><p>Finding the best source</p><video id="p"></video></body></html>`;
  const h = await boot({ html, url: 'https://generic.example/watch/some-token', net: makeNetStub(), settings: { autoSubtitle: false } });
  // stream whose URL carries NO recognizable movie id
  h.hub.fireWebRequest({ url: 'https://cdn.example/hls/token-abc-xyz/master.m3u8?token=9f2', type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '1000' }) });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url.includes('master.m3u8')));
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs', tabId: 1 } });
  await until(h, () => (stateOf(h).sub || {}).status === 'none', 8000);
  const sub = stateOf(h).sub || {};
  assert.ok(sub.error, 'a reason is recorded: ' + JSON.stringify(sub));
  assert.ok(!/play the video first|putar dulu/.test(sub.error), 'misleading "play the video first" message is NOT used when a stream exists: ' + sub.error);
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

test('F6c watch party: silent v0.m3u8 is replaced by master with AUDIO', async () => {
  const V0 = 'https://cdn.cineplex.test/mpd/tok/v0.m3u8';
  const MASTER = 'https://cdn.cineplex.test/mpd/tok/index.m3u8';
  const net = makeNetStub({
    '/mpd/tok/v0.m3u8': { body: '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg.ts\n#EXT-X-ENDLIST\n', type: 'application/vnd.apple.mpegurl' },
    '/mpd/tok/index.m3u8': {
      body: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="eng",DEFAULT=YES,URI="a0.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="a"\nv0.m3u8\n',
      type: 'application/vnd.apple.mpegurl',
    },
  });
  const h = await boot({ net, settings: { autoSubtitle: false, lastUpdateCheck: Date.now() } });
  h.hub.fireWebRequest({ url: V0, type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'application/vnd.apple.mpegurl' }) });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === V0));
  const item = h.hub.lastBroadcast.items.find((i) => i.url === V0);
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'watchparty', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'watchparty launched: ' + JSON.stringify(res));
  const tab = h.hub.tabs.created[h.hub.tabs.created.length - 1];
  assert.ok(String(tab.url).includes(encodeURIComponent(MASTER)), 'sends master with audio, not silent v0: ' + tab.url);
  assert.ok(!String(tab.url).includes(encodeURIComponent(V0)), 'does not send v0.m3u8');
  h.dom.window.close();
});

test('F6d watch party: HLS on /api/playlist opens a room, never plays in-page', async () => {
  const HLS = 'https://a2.shows.st/api/playlist/tok123';
  const net = makeNetStub({
    '/api/playlist/tok123': { body: MASTER_M3U8, type: 'application/vnd.apple.mpegurl' },
  });
  const h = await boot({ net, settings: { autoSubtitle: false, lastUpdateCheck: Date.now() } });
  h.hub.fireWebRequest({
    url: HLS,
    type: 'media',
    statusCode: 200,
    responseHeaders: h.hub.header({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '4000' }),
  });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === HLS));
  const item = h.hub.lastBroadcast.items.find((i) => i.url === HLS);
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'watchparty', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'watchparty launched: ' + JSON.stringify(res));
  assert.equal(res.inpage, undefined, 'must not fall back to in-page Play');
  const tab = h.hub.tabs.created[h.hub.tabs.created.length - 1];
  assert.ok(String(tab.url).includes('watchparty.me'), 'opens Watch Party: ' + tab.url);
  assert.ok(!String(tab.url).includes('player/player.html'), 'does not open the local player');
  assert.ok(String(tab.url).includes('srad') || String(tab.url).includes('tok123'), 'sends the playlist url: ' + tab.url);
  h.dom.window.close();
});

test('F6e watch party: token /mpd/ HLS on 67movies opens a room', async () => {
  const HLS = 'https://a2.shows.st/mpd/tokNoExt';
  const body = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg.ts\n#EXT-X-ENDLIST\n';
  const net = makeNetStub({
    '/mpd/tokNoExt': { body, type: 'application/vnd.apple.mpegurl' },
  });
  const h = await boot({ net, settings: { autoSubtitle: false, lastUpdateCheck: Date.now() } });
  h.hub.fireWebRequest({
    url: HLS,
    type: 'media',
    statusCode: 200,
    responseHeaders: h.hub.header({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '4000' }),
  });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === HLS));
  const item = h.hub.lastBroadcast.items.find((i) => i.url === HLS);
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'watchparty', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'watchparty launched: ' + JSON.stringify(res));
  assert.equal(res.inpage, undefined, 'must not fall back to in-page Play');
  const tab = h.hub.tabs.created[h.hub.tabs.created.length - 1];
  assert.ok(String(tab.url).includes('watchparty.me'), 'opens Watch Party: ' + tab.url);
  assert.ok(String(tab.url).includes('srad') || String(tab.url).includes('tokNoExt'), 'sends the token url: ' + tab.url);
  h.dom.window.close();
});

test('F6f watch party: /api?d= that is itself HLS opens a room', async () => {
  const API = 'https://a2.shows.st/api?d=zDi0HsW9playlist';
  const body = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg.ts\n#EXT-X-ENDLIST\n';
  const net = makeNetStub({
    'a2.shows.st/api': { body, type: 'application/vnd.apple.mpegurl' },
  });
  const h = await boot({ net, settings: { autoSubtitle: false, lastUpdateCheck: Date.now() } });
  h.hub.fireWebRequest({
    url: API,
    type: 'media',
    statusCode: 200,
    responseHeaders: h.hub.header({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '4000' }),
  });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === API));
  const item = h.hub.lastBroadcast.items.find((i) => i.url === API);
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'watchparty', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'watchparty launched: ' + JSON.stringify(res));
  assert.equal(res.inpage, undefined, 'must not fall back to in-page Play');
  const tab = h.hub.tabs.created[h.hub.tabs.created.length - 1];
  assert.ok(String(tab.url).includes('watchparty.me'), 'opens Watch Party: ' + tab.url);
  assert.ok(!String(tab.url).includes('player/player.html'), 'does not open the local player');
  const sent = decodeURIComponent(String(tab.url));
  assert.ok(!/[?&]srad=/.test(sent), 'must not send srad query to the CDN: ' + sent);
  assert.match(sent, /#playlist\.m3u8/i, 'Watch Party still sees .m3u8 via fragment: ' + sent);
  h.dom.window.close();
});

test('F13d play: silent v0.m3u8 is replaced by master with AUDIO', async () => {
  const V0 = 'https://cdn.cineplex.test/mpd/tok/v0.m3u8';
  const MASTER = 'https://cdn.cineplex.test/mpd/tok/index.m3u8';
  const net = makeNetStub({
    '/mpd/tok/v0.m3u8': { body: '#EXTM3U\\n#EXT-X-TARGETDURATION:4\\n#EXTINF:4.0,\\nseg.ts\\n#EXT-X-ENDLIST\\n', type: 'application/vnd.apple.mpegurl' },
    '/mpd/tok/index.m3u8': {
      body: '#EXTM3U\\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="eng",DEFAULT=YES,URI="a0.m3u8"\\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="a"\\nv0.m3u8\\n',
      type: 'application/vnd.apple.mpegurl',
    },
  });
  const h = await boot({ net, settings: { autoSubtitle: false, lastUpdateCheck: Date.now() } });
  h.hub.fireWebRequest({ url: V0, type: 'media', statusCode: 200, responseHeaders: h.hub.header({ 'content-type': 'application/vnd.apple.mpegurl' }) });
  await until(h, () => (stateOf(h).items || []).some((i) => i.url === V0));
  const item = h.hub.lastBroadcast.items.find((i) => i.url === V0);
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'play', id: item.id, tabId: 1 } });
  assert.equal(res.ok, true, 'play launched: ' + JSON.stringify(res));
  const stored = h.hub.storage['srad:play:' + res.sid] || (res.session || {});
  const playUrl = stored.url || (res.session && res.session.url);
  assert.equal(playUrl, MASTER, 'play uses master with audio, not silent v0: ' + playUrl);
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

  // per-item actions. 'subs' is clicked LAST: it switches the panel to the
  // subtitles pane (visible response), which detaches the row list.
  const first = shadow.querySelector('.srad-item');
  assert.ok(first.querySelector('[data-act="play"]'), 'Play is the primary action on a stream row');
  for (const act of ['watchparty', 'copy', 'download', 'ffmpeg']) {
    const btn = first.querySelector(`[data-act="${act}"]`);
    assert.ok(btn, `action button present: ${act}`);
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  }
  await until(h, () => h.hub.tabs.created.some((t) => t.url.includes('watchparty.me')));
  assert.ok(h.hub.downloads.calls.some((d) => d.filename === 'Dune Part Two.mp4'), 'download action reached the background');
  const subsBtn = first.querySelector('[data-act="subs"]');
  assert.ok(subsBtn, 'subs action button present');
  subsBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.ok(
    await until(h, () => h.fetchImpl.calls.some(([u]) => u.includes('subdl.com')), 8000),
    'subtitle action searched (net calls: ' + h.fetchImpl.calls.map((c) => c[0].slice(0, 40)).join(' | ') + ')'
  );
  // the click visibly responded: panel is now on the subtitles pane
  assert.equal(
    shadow.querySelector('[data-act="tab"][data-tab="subs"]').getAttribute('aria-selected'),
    'true',
    'subs click switched the panel to the subtitles pane'
  );
  assert.ok(shadow.querySelector('.srad-sub-card'), 'subtitles pane rendered');

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
  try {
    h.dom.window.close();
  } catch (_) {}
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

/* ------------------------------------------------------------------ *
 * F7 · subtitle Use/Pick = ONE click to attach (no local download),
 *      and no button failure is ever silent
 * ------------------------------------------------------------------ */
test('F7 sub-pick attaches the subtitle to the page player in one click', async () => {
  const h = await boot({ settings: { autoSubtitle: false } });
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found', 8000), 'search found subtitles');
  const items = (stateOf(h).sub || {}).items || [];
  assert.ok(items.length >= 1, 'at least one result row');
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-pick', index: 0, tabId: 1 } });
  assert.equal(res.ok, true, 'sub-pick ok: ' + JSON.stringify(res));
  assert.equal(res.attached, true, 'attached flag set');
  await settle(h, 200);
  const track = h.dom.window.document.querySelector('video track[data-srad="1"]');
  assert.ok(track, '<track> injected into the page player immediately after the pick');
  assert.match(track.src, /^blob:/, 'subtitle rides a blob URL - no local download');
  assert.equal((stateOf(h).sub.chosen || {}).index, 0, 'chosen persisted for re-attach / download');
  // the resolved copy is kept, so the Download button works right after the pick
  const dl = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-download-info', tabId: 1 } });
  assert.equal(dl.ok, true, 'pending subtitle is ready for download');
  h.dom.window.close();
});

test('F7b sub-pick failure is never silent: an error toast explains it', async () => {
  // serve a broken "zip" so resolving the file fails inside the real code path
  const net = makeNetStub({ '4242.zip': { body: 'not a real zip', type: 'application/octet-stream' } });
  const h = await boot({ net, settings: { autoSubtitle: false } });
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found', 8000), 'search still finds rows');
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-pick', index: 0, tabId: 1 } });
  assert.equal(res.ok, false, 'sub-pick failed: ' + JSON.stringify(res));
  assert.ok(res.reason, 'failure carries a reason: ' + res.reason);
  await settle(h, 150);
  const shadow = h.dom.window.document.getElementById('stream-radar-host').shadowRoot;
  const errToasts = shadow ? [...shadow.querySelectorAll('.srad-toast')].filter((el) => el.getAttribute('data-kind') === 'err') : [];
  assert.ok(errToasts.length >= 1, 'an error toast reached the page: ' + (errToasts.map((el) => el.textContent).join(' | ')));
  h.dom.window.close();
});

test('F7c with nothing loaded the Download/Attach buttons are disabled, not dead', async () => {
  const h = await boot({ settings: { autoSubtitle: false } });
  const win = h.dom.window;
  await until(h, () => !!(stateOf(h).title || {}).title, 8000);
  const shadow = win.document.getElementById('stream-radar-host').shadowRoot;
  assert.ok(shadow, 'panel mounted');
  const tab = shadow.querySelector('[data-act="tab"][data-tab="subs"]');
  if (tab) tab.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const dlBtn = shadow.querySelector('[data-act="sub-download"]');
  const attBtn = shadow.querySelector('[data-act="sub-attach"]');
  assert.ok(dlBtn && attBtn, 'subs pane buttons exist');
  assert.equal(dlBtn.disabled, true, 'Download disabled when no subtitle file is ready');
  assert.equal(attBtn.disabled, true, 'Attach disabled when no subtitle file is ready');
  h.dom.window.close();
});

test('F7d re-picking a subtitle SWAPS the track (old language never stays)', async () => {
  const net = makeNetStub({
    'subdl.com/api/v1/subtitles?': {
      body: JSON.stringify({
        results: [
          { attributes: { id: 4242, name: 'Dune Part Two', filename: 'Dune.2024.id.srt', lang: { code: 'id', name: 'Indonesian' }, format: 'srt', year: '2024', downloadCount: 1500, verified: true } },
          { attributes: { id: 4243, name: 'Dune Part Two EN', filename: 'Dune.2024.en.srt', lang: { code: 'en', name: 'English' }, format: 'srt', year: '2024', downloadCount: 42, verified: false } },
        ],
      }),
      type: 'application/json',
    },
  });
  const h = await boot({ net, settings: { autoSubtitle: false, subtitleLang: 'all' } });
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  assert.ok(await until(h, () => ((stateOf(h).sub || {}).items || []).length >= 2, 8000), 'two subtitle rows found');
  const items = (stateOf(h).sub || {}).items || [];
  assert.equal(items[0].langCode, 'id', 'first result is Indonesian');
  assert.equal(items[1].langCode, 'en', 'second result is English');

  const video = h.dom.window.document.querySelector('video');
  const res0 = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-pick', index: 0, tabId: 1 } });
  assert.equal(res0.ok, true, 'pick #0 ok: ' + JSON.stringify(res0));
  await settle(h, 120);
  let tracks = video.querySelectorAll('track[data-srad="1"]');
  assert.equal(tracks.length, 1, 'exactly one srad track after first pick');
  assert.equal(tracks[0].getAttribute('srclang'), 'id', 'first pick is Indonesian');
  const firstSrc = tracks[0].getAttribute('src');

  const res1 = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-pick', index: 1, tabId: 1 } });
  assert.equal(res1.ok, true, 'pick #1 ok: ' + JSON.stringify(res1));
  await settle(h, 120);
  tracks = video.querySelectorAll('track[data-srad="1"]');
  assert.equal(tracks.length, 1, 'still exactly ONE track after re-pick - old one was swapped out');
  assert.equal(tracks[0].getAttribute('srclang'), 'en', 'track now carries the picked English language');
  assert.notEqual(tracks[0].getAttribute('src'), firstSrc, 'blob URL refreshed (old subtitle content gone)');
  assert.equal((stateOf(h).sub.chosen || {}).index, 1, 'chosen moved to the second row');
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F8 · Wyzie end-to-end with the REAL response shape (verified live
 *      against sub.wyzie.io with a user key): search -> pick -> attach
 *      to the page video -> download as a file. No local file is ever
 *      required for playback; the blob-URL track is the "without
 *      download" path and chrome.downloads is the "with download" path.
 * ------------------------------------------------------------------ */
const WYZIE_LIVE_SHAPE = [
  { id: '81111', url: 'https://dl.opensubtitles.org/en/download/subencoding-utf8/src-api/vrf-ddf90b45/file/81111', flagUrl: 'https://flagsapi.com/SA/flat/24.png', format: 'srt', encoding: 'UTF-8', display: 'Arabic', language: 'ar', media: 'Catch Me If You Can', isHearingImpaired: false, source: 'charlie', release: 'Catch Me If You Can (2002)', fileName: '1.SRT', downloadCount: 62018, ai: false },
  { id: '70511', url: 'https://dl.opensubtitles.org/en/download/subencoding-utf8/src-api/vrf-ddfc0b47/file/70511', flagUrl: 'https://flagsapi.com/US/flat/24.png', format: 'srt', encoding: 'UTF-8', display: 'English', language: 'en', media: 'Catch Me If You Can', isHearingImpaired: false, source: 'charlie', release: 'Catch Me If You Can (2002)', fileName: 'anglais sourd.srt', downloadCount: 37842, ai: false },
  { id: '75973', url: 'https://dl.opensubtitles.org/en/download/subencoding-utf8/src-api/vrf-de2a0b58/file/75973', flagUrl: 'https://flagsapi.com/BR/flat/24.png', format: 'srt', encoding: 'UTF-8', display: 'Portuguese (BR)', language: 'pb', media: 'Catch Me If You Can', isHearingImpaired: false, source: 'charlie', release: 'Catch Me If You Can (2002)', fileName: 'Catch_Me_If_You_Can_(2002).CD1.ViTE.ShareReactor.srt', downloadCount: 4708, ai: false },
];

test('F8 wyzie real shape: search -> Use attaches to the page video WITHOUT any local download', async () => {
  const net = makeNetStub({
    'sub.wyzie.io/search': { body: JSON.stringify(WYZIE_LIVE_SHAPE), type: 'application/json' },
    'dl.opensubtitles.org': { body: SRT_TEXT, type: 'application/x-subrip' },
  });
  const h = await boot({
    net,
    settings: { autoSubtitle: false, subtitleLang: 'all', wyzieApiKey: 'test-wyzie-key', providers: { wyzie: true, subdl: false, opensubtitles: false, yify: false } },
  });
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found', 8000), 'wyzie search found: ' + JSON.stringify(stateOf(h).sub));
  const items = (stateOf(h).sub || {}).items || [];
  assert.ok(items.length >= 3, 'rows from the real wyzie shape: ' + items.length);
  assert.equal(items[0].provider, 'wyzie');
  assert.equal(items[0].langCode, 'ar', 'language mapped from the response');
  assert.equal(items[0].downloads, 62018, 'downloadCount mapped');
  assert.equal(items[0].uploader, 'charlie', 'uploader mapped');

  // Use = pick index 0 -> resolve the file -> attach as a blob <track>.
  const beforeDl = h.hub.downloads.calls.length;
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-pick', index: 0, tabId: 1 } });
  assert.equal(res.ok, true, 'wyzie pick ok: ' + JSON.stringify(res));
  assert.equal(res.attached, true, 'attached flag set');
  await settle(h, 150);
  const track = h.dom.window.document.querySelector('video track[data-srad="1"]');
  assert.ok(track, '<track> attached to the page player');
  assert.match(track.src, /^blob:/, 'subtitle rides a blob URL - applied WITHOUT any local download');
  assert.equal(h.hub.downloads.calls.length, beforeDl, 'no chrome.downloads happened for the Use path');
  assert.equal((stateOf(h).sub.chosen || {}).index, 0, 'chosen persisted');
  h.dom.window.close();
});

test('F8b wyzie real shape: sub-download saves the SAME resolved subtitle as a .vtt file', async () => {
  const net = makeNetStub({
    'sub.wyzie.io/search': { body: JSON.stringify(WYZIE_LIVE_SHAPE), type: 'application/json' },
    'dl.opensubtitles.org': { body: SRT_TEXT, type: 'application/x-subrip' },
  });
  const h = await boot({
    net,
    settings: { autoSubtitle: false, subtitleLang: 'all', wyzieApiKey: 'test-wyzie-key', providers: { wyzie: true, subdl: false, opensubtitles: false, yify: false } },
  });
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found', 8000), 'search found');
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-pick', index: 1, tabId: 1 } });
  assert.equal(res.ok, true, 'pick ok');
  await settle(h, 150);
  const dl = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-download', tabId: 1 } });
  assert.equal(dl.ok, true, 'sub-download ok: ' + JSON.stringify(dl));
  const call = h.hub.downloads.calls[h.hub.downloads.calls.length - 1];
  assert.ok(call, 'chrome.downloads called');
  assert.ok(String(call.url).startsWith('data:text/vtt'), 'saved as a vtt data URL');
  assert.match(call.filename, /\.vtt$/, 'filename ends .vtt');
  assert.ok(decodeURIComponent(call.url).includes('WEBVTT'), 'the vtt content is the resolved subtitle');
  h.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F9 · results survive a worker restart (the "vanish forever" bug):
 *      sub + pendingSub are persisted and restored with the tab state.
 * ------------------------------------------------------------------ */
test('F9 subtitle results + pick survive a service-worker restart', async () => {
  const net = makeNetStub({
    'subdl.com/api/v1/subtitles?': {
      body: JSON.stringify({
        results: [
          { attributes: { id: 4242, name: 'Dune Part Two', filename: 'Dune.2024.id.srt', lang: { code: 'id', name: 'Indonesian' }, format: 'srt', year: '2024', downloadCount: 1500, verified: true } },
          { attributes: { id: 4243, name: 'Dune Part Two EN', filename: 'Dune.2024.en.srt', lang: { code: 'en', name: 'English' }, format: 'srt', year: '2024', downloadCount: 42, verified: false } },
        ],
      }),
      type: 'application/json',
    },
  });
  const h = await boot({ net, settings: { autoSubtitle: false, subtitleLang: 'all' } });
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found', 8000), 'search found');
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-pick', index: 1, tabId: 1 } });
  assert.equal(res.ok, true, 'picked row 1');
  await settle(h, 150);
  // let the 1.5s persist throttle write the tab state
  await h.wait(2000);
  const slim = h.hub.storage['srad:tab:1'];
  assert.ok(slim, 'tab state persisted');
  assert.equal(slim.sub.chosen.index, 1, 'chosen persisted');
  assert.ok(Array.isArray(slim.sub.items) && slim.sub.items.length >= 1, 'subtitle items persisted');
  assert.ok(slim.pendingSub && /^WEBVTT/.test(slim.pendingSub.vtt), 'resolved subtitle vtt persisted');

  // simulate the MV3 worker being killed & waking up fresh: new boot, same storage
  const h2 = await boot({ settings: { autoSubtitle: false }, seedStorage: { 'srad:tab:1': slim } });
  const st = await h2.hub.sendFromContent({ type: 'action', payload: { name: 'get-state', tabId: 1 } });
  assert.equal(st.ok, true, 'fresh worker answers get-state');
  assert.equal(st.state.sub.chosen.index, 1, 'chosen restored after restart');
  assert.ok((st.state.sub.items || []).length >= 1, 'results restored after restart');
  assert.equal(st.state.subHasFile, true, 'pending subtitle restored after restart');
  h.dom.window.close();
  h2.dom.window.close();
});

/* ------------------------------------------------------------------ *
 * F10 · native-track injection: picked subtitle is injected straight into
 *       the player (no overlay -> in sync), auto re-attaches when the
 *       player is re-created, and comes back after a full page reload.
 * ------------------------------------------------------------------ */
test('F10 picked subtitle auto re-attaches when the player is re-created (native track, no overlay)', async () => {
  const h = await boot({ settings: { autoSubtitle: false } });
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found', 8000), 'search found');
  const res = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-pick', index: 0, tabId: 1 } });
  assert.equal(res.ok, true, 'pick ok');
  await settle(h, 120);
  const doc = h.dom.window.document;
  let video = doc.querySelector('video');
  assert.ok(video && video.querySelector('track[data-srad="1"]'), 'track attached to the player');
  assert.match(video.querySelector('track[data-srad="1"]').getAttribute('src'), /^(blob:|data:text\/vtt)/, 'native <track> with a blob URL - player renders it in sync');

  // Simulate a player re-init (ad overlay removed / quality switch / SPA swap):
  // the old <video> is destroyed and a brand-new one takes its place.
  const parent = video.parentNode;
  const fresh = doc.createElement('video');
  fresh.id = 'player2';
  parent.appendChild(fresh);
  video.remove();
  assert.equal(fresh.querySelector('track[data-srad="1"]'), null, 'fresh player starts without a track');

  // The armed watcher must attach the SAME subtitle to the new player.
  const got = await until(h, () => fresh.querySelector('track[data-srad="1"]') != null, 8000);
  assert.ok(got, 'subtitle auto re-attached to the re-created player');
  assert.match(fresh.querySelector('track[data-srad="1"]').getAttribute('src'), /^(blob:|data:text\/vtt)/, 're-attached via native track');
  h.dom.window.close();
});

test('F10b picked subtitle comes back automatically after a full page reload', async () => {
  const net = makeNetStub({
    'subdl.com/api/v1/subtitles?': {
      body: JSON.stringify({
        results: [
          { attributes: { id: 4242, name: 'Dune Part Two', filename: 'Dune.2024.id.srt', lang: { code: 'id', name: 'Indonesian' }, format: 'srt', year: '2024', downloadCount: 1500, verified: true } },
          { attributes: { id: 4243, name: 'Dune Part Two EN', filename: 'Dune.2024.en.srt', lang: { code: 'en', name: 'English' }, format: 'srt', year: '2024', downloadCount: 42, verified: false } },
        ],
      }),
      type: 'application/json',
    },
  });
  const baseSettings = { autoSubtitle: false, subtitleLang: 'all' };
  const h = await boot({ net, settings: baseSettings });
  await h.hub.sendFromContent({ type: 'action', payload: { name: 'subs-search', tabId: 1 } });
  assert.ok(await until(h, () => (stateOf(h).sub || {}).status === 'found', 8000), 'search found');
  const pick = await h.hub.sendFromContent({ type: 'action', payload: { name: 'sub-pick', index: 1, tabId: 1 } });
  assert.equal(pick.ok, true, 'picked');
  await h.wait(2200); // let persist throttle write sub + pendingSub
  const slim = h.hub.storage['srad:tab:1'];
  assert.ok(slim && slim.pendingSub, 'pendingSub persisted');

  // "Reload": a fresh page + fresh content script against the same storage.
  const h2 = await boot({ net, settings: baseSettings, seedStorage: { 'srad:tab:1': slim } });
  const doc = h2.dom.window.document;
  const track = await until(h2, () => doc.querySelector('video track[data-srad="1"]') != null, 9000);
  assert.ok(track, 'subtitle auto-attached after reload without any click');
  const t = doc.querySelector('video track[data-srad="1"]');
  assert.match(t.getAttribute('src'), /^(blob:|data:text\/vtt)/, 'native track again');
  assert.equal(t.getAttribute('srclang'), 'en', 're-attached with the picked language');
  h.dom.window.close();
  h2.dom.window.close();
});
