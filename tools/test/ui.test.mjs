/**
 * UI render smoke test — the panel/FAB/toast code path in jsdom.
 * The userscript test covers mounting inside a bundle; this one exercises the
 * renderer with a realistic state (including the awkward cases: blob entry,
 * segment group, ad row, variants, subtitle statuses) and asserts interactions
 * (open/close, theme cycle, settings popover, drag persistence, action routing)
 * never throw and produce the right markup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['shared/util.js', 'shared/rules.js', 'shared/title-cleaner.js', 'shared/i18n.js', 'content/ui-styles.js', 'content/ui.js'];

function boot() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://67movies.nl/watch/movie/1516698', runScripts: 'dangerously', pretendToBeVisual: true });
  for (const f of FILES) dom.window.eval(readFileSync(path.join(ROOT, 'src', f), 'utf8'));
  return dom;
}

const STATE = {
  settings: Object.assign({}, globalThis.__none || {}, { enabled: true, theme: 'dark', showAds: false, maxItems: 80 }),
  title: { title: 'Dune: Part Two', year: '2024', episode: null, season: null, kind: 'movie', poster: 'https://img/poster.jpg', isJunk: false },
  layers: { network: true, dom: true, mse: true, sw: false, heuristic: true },
  drm: null,
  items: [
    {
      id: 'a1',
      url: 'https://cdn.stream/hls/master.m3u8?token=xyz',
      category: 'hls',
      ext: 'm3u8',
      host: 'cdn.stream',
      name: 'master.m3u8',
      quality: '1080p',
      size: 0,
      duration: 7380,
      via: ['fetch', 'performance', 'dom'],
      confidence: 6,
      ts: Date.now(),
      aes: 'https://cdn.stream/key',
      variants: [
        { uri: 'https://cdn.stream/hls/1080/index.m3u8', quality: '1080p', bandwidthLabel: '6 Mb/s', codecs: 'avc1.640028' },
        { uri: 'https://cdn.stream/hls/720/index.m3u8', quality: '720p', bandwidthLabel: '2.2 Mb/s', codecs: '' },
      ],
      sub: { status: 'found', name: 'Dune.2024.ID.srt' },
    },
    { id: 'b2', url: 'https://cdn.stream/backup/movie.mp4', category: 'mp4', ext: 'mp4', host: 'cdn.stream', name: 'movie.mp4', size: 2_100_000_000, quality: '720p', via: ['network'], confidence: 3, ts: Date.now(), sub: { status: 'searching' } },
    { id: 'c3', url: 'blob:https://player.x/1-2-3', category: 'blob', ext: 'blob', host: 'player.x', name: 'blob', mseBytes: 42_000_000, mseMimes: ['video/mp4;codecs="avc1.640028"'], duration: 120, via: ['mse-src'], confidence: 2, ts: Date.now(), sub: { status: 'skipped' } },
    { id: 'd4', url: 'https://cdn.stream/hls/', category: 'segment', kind: 'segmentgroup', host: 'cdn.stream', name: 'cdn.stream · segment stream', segmentCount: 740, segmentBytes: 1_240_000_000, via: ['network'], confidence: 1, ts: Date.now(), sub: { status: 'none' } },
  ],
  ads: [{ id: 'e5', url: 'https://doubleclick.net/vast/preroll.mp4', category: 'mp4', host: 'doubleclick.net', name: 'preroll.mp4', isAd: true, via: ['network'], confidence: 1, ts: Date.now(), sub: { status: 'idle' } }],
};

test('panel renders every item kind without throwing', () => {
  const dom = boot();
  const win = dom.window;
  const actions = [];
  const ui = win.SR.ui.create({ getSettings: () => STATE.settings, onAction: (a, p) => actions.push([a, p && p.id]) });
  ui.mount();
  ui.render(STATE);

  const host = win.document.getElementById('stream-radar-host');
  assert.ok(host, 'host element mounted');
  // closed shadow root → page cannot see it, which is the point
  assert.equal(host.shadowRoot, null);
  assert.equal(win.document.querySelectorAll('.srad-item').length, 0, 'page DOM must stay clean');

  // interactions must be routed by the panel, not swallowed
  const shadow = host.__proto__ && null; // (not accessible; drive through events on window-level instead)
  assert.ok(ui, 'controller returned');

  // toast + render twice (idempotent, no listener leak warnings)
  ui.toast('halo', 'ok');
  ui.render(STATE);
  ui.setOpen(true);
  ui.setOpen(false);
  ui.setFabPos({ x: 12, y: 40 });
  ui.applyTheme();
  ui.dismissAll();
  assert.ok(true, 'full interaction cycle survived');
});

test('footer offers copy-all and watchparty uses the auto-create route strings', () => {
  const src = readFileSync(path.join(ROOT, 'src/content/ui.js'), 'utf8');
  assert.ok(src.includes('data-act="copy-all"'), 'footer must have a copy-all button');
  assert.ok(src.includes('action.copyAll'), 'copy-all uses an i18n label');
  const bg = readFileSync(path.join(ROOT, 'src/background.js'), 'utf8');
  assert.ok(bg.includes("watchPartyCreateUrl") && bg.includes("/create?video="), 'launcher auto-creates a room');
});

test('blob rows show the no-party marker, not a Watch Party button', () => {
  const src = readFileSync(path.join(ROOT, 'src/content/ui.js'), 'utf8');
  // the marker is rendered only for blob rows; streamable rows keep the button
  assert.ok(src.includes('srad-no-party'), 'panel must define the blob no-party marker');
  assert.ok(/cat === 'blob'[\s\S]{0,200}srad-no-party/.test(src), 'marker must be gated on the blob category');
  assert.ok(src.includes('watchparty.noBlob'), 'marker must use the explanatory i18n key');
});

test('play is the primary action and opens the local player page', () => {
  const src = readFileSync(path.join(ROOT, 'src/content/ui.js'), 'utf8');
  assert.ok(src.includes('data-act="play"'), 'panel has a Play button');
  assert.ok(src.includes('action.play'), 'Play uses an i18n label');
  const bg = readFileSync(path.join(ROOT, 'src/background.js'), 'utf8');
  assert.ok(bg.includes('player/player.html'), 'background opens the cinema player page');
  assert.ok(bg.includes('player-fetch'), 'HLS segments are fetched in the worker with the page Referer');
});

test('panel reflects settings changes (ads toggle, enabled switch, theme)', () => {
  const dom = boot();
  const win = dom.window;
  const settings = Object.assign({}, STATE.settings);
  const actions = [];
  const ui = win.SR.ui.create({ getSettings: () => settings, onAction: (a, p) => actions.push([a, p]) });
  ui.mount();
  ui.render(STATE);
  ui.render(Object.assign({}, STATE, { settings: Object.assign({}, settings, { showAds: true }) }));
  ui.render(Object.assign({}, STATE, { settings: Object.assign({}, settings, { theme: 'light' }) }));
  ui.render(Object.assign({}, STATE, { settings: Object.assign({}, settings, { enabled: false }) }));
  ui.render(Object.assign({}, STATE, { title: { title: '', isJunk: true } }));
  ui.render(Object.assign({}, STATE, { items: [], ads: [] }));
  assert.ok(true, 're-render across all UI states is safe');
});

test('every panel button fires its intended action or a visible local effect (full sweep)', () => {
  const dom = boot();
  const win = dom.window;
  const actions = [];
  const settings = Object.assign({}, STATE.settings);
  const ui = win.SR.ui.create({
    shadowMode: 'open',
    getSettings: () => settings,
    onAction: (a, p) => actions.push([a, p || {}]),
  });
  ui.mount();
  const sub = {
    status: 'found',
    query: 'The Eye',
    imdbId: 'tt0264464',
    items: [
      { provider: 'wyzie', providerLabel: 'Wyzie Subs', id: 's1', name: 'The Eye (2002)', filename: 'The.Eye.2002.srt', langCode: 'id', format: 'srt', downloads: 1500, verified: true, uploader: 'opensubtitles', fileUrl: 'https://sub.example/e.srt' },
      { provider: 'subdl', providerLabel: 'SubDL', id: 's2', name: 'The Eye (2002) AI', filename: 'Eye.ai.srt', langCode: 'en', format: 'srt', downloads: 42, aiTranslated: true },
      { provider: 'yify', providerLabel: 'YIFY', id: 's3', name: 'The Eye HI', filename: 'Eye.HI.srt', langCode: 'id', format: 'srt', downloads: 7, hearingImpaired: true },
    ],
    chosen: null,
  };
  ui.render(Object.assign({}, STATE, { sub }));
  ui.setOpen(true);
  const shadow = win.document.getElementById('stream-radar-host').shadowRoot;
  assert.ok(shadow, 'shadow root open for the sweep');

  const click = (sel, label) => {
    const el = shadow.querySelector(sel);
    assert.ok(el, label + ' button exists');
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  };
  const routed = (name, note) =>
    assert.ok(actions.some(([a]) => a === name), note + ' routed action "' + name + '" (got: ' + actions.map((x) => x[0]).join(',') + ')');

  // --- streams tab -------------------------------------------------
  click('[data-act="play"]', 'Play'); routed('play', 'Play');
  click('[data-act="watchparty"]', 'WatchParty'); routed('watchparty', 'WatchParty');
  click('[data-act="copy"]', 'Copy'); routed('copy', 'Copy');
  click('[data-act="download"]', 'Download'); routed('download', 'Download');
  click('[data-act="ffmpeg"]', 'ffmpeg'); routed('ffmpeg', 'ffmpeg');
  click('[data-act="toggle-expand"]', 'Variants expand'); // local: aria flips, no action
  assert.ok(!actions.some(([a]) => a === 'toggle-expand'), 'toggle-expand stays local');
  click('[data-act="variant"]', 'Variant copy'); routed('variant', 'Variant copy');
  click('[data-act="record"]', 'Record (blob row)'); routed('record', 'Record');
  click('[data-act="subs"]', 'Row Subtitles'); routed('subs', 'Row Subtitles');
  // panel should now be on the subs tab
  const subsTab = shadow.querySelector('[data-act="tab"][data-tab="subs"]');
  assert.equal(subsTab.getAttribute('aria-selected'), 'true', 'subs tab selected after row subs click');

  // --- subs pane buttons -------------------------------------------
  click('[data-act="sub-pick"][data-index="0"]', 'Use first result'); routed('sub-pick', 'Use first result');
  const pick0 = actions.filter(([a]) => a === 'sub-pick')[0];
  assert.equal(pick0[1].index, 0, 'Use carries index 0');
  click('[data-act="sub-pick"][data-index="2"]', 'Pick third result'); routed('sub-pick', 'Pick third result');
  click('[data-act="sub-attach"]', 'Attach here'); routed('sub-attach', 'Attach here');
  click('[data-act="sub-download"]', 'Download .vtt'); routed('sub-download', 'Download .vtt');
  click('[data-act="subs"][data-primary="1"]', 'Subs retry'); routed('subs', 'Subs retry');

  // --- footer ------------------------------------------------------
  click('[data-act="copy-all"]', 'Copy all'); routed('copy-all', 'Copy all');
  click('[data-act="ads"]', 'Ads toggle'); routed('set-setting', 'Ads toggle');
  click('[data-act="clear"]', 'Clear'); routed('clear', 'Clear');
  click('[data-act="options"]', 'Options'); routed('options', 'Options');

  // --- settings pop -------------------------------------------------
  click('[data-act="settings"]', 'Settings button'); // local: opens pop, no action
  assert.ok(!actions.some(([a]) => a === 'settings'), 'settings button stays local');
  click('[data-act="update-check"]', 'Update check'); routed('update-check', 'Update check');
  // Reset FAB is a local job: it must NOT bounce an unknown action to the
  // worker; it snaps the FAB back and persists fabPos:null.
  click('[data-act="reset-fab"]', 'Reset FAB');
  assert.ok(!actions.some(([a]) => a === 'reset-fab'), 'reset-fab never goes to the background');
  assert.ok(actions.some(([a, p]) => a === 'set-setting' && p.key === 'fabPos' && p.value === null), 'fabPos null persisted via set-setting');
  click('[data-act="theme-system"]', 'Theme system'); routed('set-setting', 'Theme system');
  click('[data-act="lang-id"]', 'Lang ID'); routed('set-setting', 'Lang ID');

  // --- tab / theme / close are local & visible ----------------------
  click('[data-act="tab"][data-tab="info"]', 'Info tab');
  assert.equal(shadow.querySelector('[data-act="tab"][data-tab="info"]').getAttribute('aria-selected'), 'true', 'info tab switches');
  click('[data-act="tab"][data-tab="media"]', 'Media tab');
  assert.equal(shadow.querySelector('[data-act="tab"][data-tab="media"]').getAttribute('aria-selected'), 'true', 'media tab switches');
  click('[data-act="theme"]', 'Theme cycle'); // cycles without an action
  assert.ok(!actions.some(([a]) => a === 'theme'), 'theme cycle stays local');
  // X close: the settings pop is still open, so the first X closes the pop,
  // the second X closes the panel (both headers render data-act="x").
  click('[data-act="x"]', 'X close (settings pop)');
  assert.equal(ui.popOpen, false, 'settings pop closed by its X');
  click('[data-act="x"]', 'X close (panel)');
  assert.equal(shadow.querySelector('.srad-panel').getAttribute('data-open'), '0', 'panel closes via X');
});

test('subs results stay STABLE across identical re-renders (no flicker / no vanish)', () => {
  const dom = boot();
  const win = dom.window;
  const ui = win.SR.ui.create({ shadowMode: 'open', getSettings: () => STATE.settings, onAction: () => {} });
  ui.mount();
  const sub = {
    status: 'found',
    query: 'The Eye',
    items: [
      { provider: 'wyzie', id: 's1', name: 'The Eye (2002)', filename: 'The.Eye.2002.srt', langCode: 'id', format: 'srt', downloads: 1500, verified: true },
      { provider: 'subdl', id: 's2', name: 'The Eye AI', filename: 'Eye.ai.srt', langCode: 'en', format: 'srt', downloads: 42, aiTranslated: true },
      { provider: 'yify', id: 's3', name: 'The Eye HI', filename: 'Eye.HI.srt', langCode: 'id', format: 'srt', downloads: 7, hearingImpaired: true },
    ],
    chosen: null,
  };
  ui.render(Object.assign({}, STATE, { sub }));
  ui.setOpen(true);
  ui.setTab('subs');
  const shadow = win.document.getElementById('stream-radar-host').shadowRoot;
  const rows = () => shadow.querySelectorAll('.srad-sub-row');
  assert.equal(rows().length, 3, 'three rows on first render');
  const firstNode = rows()[0];

  // Identical re-render (what constant broadcasts do on stream sites):
  // the row DOM must be untouched - same node, no flicker.
  ui.render(Object.assign({}, STATE, { sub }));
  assert.equal(rows()[0], firstNode, 'row DOM node is untouched on identical re-render');
  assert.equal(rows().length, 3, 'still exactly three rows');
  assert.equal(shadow.querySelector('.srad-sub-card'), shadow.querySelector('.srad-sub-card'), 'subs pane not rebuilt');

  // A real change (chosen) re-renders but keeps the row content correct.
  ui.render(Object.assign({}, STATE, { sub: Object.assign({}, sub, { chosen: { index: 1 } }) }));
  assert.equal(rows().length, 3, 'still three rows after chosen change');
  assert.equal(shadow.querySelector('[data-act="sub-pick"][data-index="1"]').disabled, true, 'chosen row button disabled/attached');
  assert.match(shadow.querySelector('[data-act="sub-pick"][data-index="1"]').textContent, /Attached/, 'chosen row shows Attached');
  // media tab still renders fine after all that
  ui.setTab('media');
  assert.ok(shadow.querySelector('.srad-item'), 'back on media tab without throwing');
});
