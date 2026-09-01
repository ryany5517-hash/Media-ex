/**
 * Popup audit: every popup button must send the right action to the worker
 * (or do its local job) and failures must produce a visible toast. Runs the
 * real popup.js + shared prelude in jsdom against a chrome API mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const PRELUDE = [
  'src/shared/util.js',
  'src/shared/icons.js',
  'src/shared/rules.js',
  'src/shared/title-cleaner.js',
  'src/shared/subtitles.js',
  'src/shared/i18n.js',
  'src/shared/updater.js',
];

const STATE = {
  settings: { enabled: true, theme: 'dark', lang: 'id', subdlApiKey: 'x', providers: { subdl: true, wyzie: true } },
  title: { title: 'The Eye', year: '2002', kind: 'movie', isJunk: false },
  layers: { network: true, dom: true, mse: true, sw: false, heuristic: true },
  items: [
    { id: 'a1', url: 'https://cdn.example/hls/master.m3u8', category: 'hls', ext: 'm3u8', host: 'cdn.example', name: 'master.m3u8', quality: '1080p', size: 0, duration: 7200, via: ['network'], confidence: 5, ts: 1 },
    { id: 'b2', url: 'https://cdn.example/movie.mp4', category: 'mp4', ext: 'mp4', host: 'cdn.example', name: 'movie.mp4', size: 2_000_000_000, quality: '720p', via: ['network'], confidence: 3, ts: 2 },
  ],
  ads: [],
  sub: {
    status: 'found',
    items: [
      { provider: 'wyzie', providerLabel: 'Wyzie Subs', id: 's1', name: 'The Eye (2002)', filename: 'The.Eye.2002.srt', langCode: 'id', format: 'srt', downloads: 1500, verified: true, uploader: 'opensubtitles', fileUrl: 'https://sub.example/e.srt' },
      { provider: 'subdl', providerLabel: 'SubDL', id: 's2', name: 'The Eye AI', filename: 'Eye.ai.srt', langCode: 'en', format: 'srt', downloads: 42, aiTranslated: true },
      { provider: 'yify', providerLabel: 'YIFY', id: 's3', name: 'The Eye HI', filename: 'Eye.HI.srt', langCode: 'id', format: 'srt', downloads: 7, hearingImpaired: true },
    ],
    chosen: null,
  },
  history: [{ url: 'https://cdn.example/past.mp4', title: 'past movie', category: 'mp4', ts: 1 }],
};

async function bootPopup({ state = STATE, fail = {} } = {}) {
  const html = read('src/popup/popup.html').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://stream-radar-test/popup/popup.html', runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window;
  const sent = [];
  const copied = [];
  const msgListeners = [];
  Object.defineProperty(win.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t) => { copied.push(String(t)); } },
  });
  win.chrome = {
    runtime: {
      id: 'stream-radar-test',
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg && msg.type === 'action' && msg.payload) {
          const name = msg.payload.name;
          if (name === 'get-state') return { ok: true, state, history: state.history || [] };
          if (fail[name]) return { ok: false, reason: fail[name] };
          return { ok: true };
        }
        if (msg && msg.type === 'get-live') return { ok: false };
        return { ok: false };
      },
      onMessage: { addListener: (cb) => msgListeners.push(cb) },
      openOptionsPage: () => {},
    },
    tabs: {
      query: async () => [{ id: 1, active: true }],
      sendMessage: async () => ({}),
      create: async () => ({}),
    },
  };
  for (const f of PRELUDE) win.eval(read(f));
  win.eval(read('src/popup/popup.js'));
  await new Promise((r) => setTimeout(r, 60)); // let the boot refresh() resolve
  return { dom, win, sent, copied, msgListeners };
}

const actionsSent = (sent) => sent.filter((m) => m && m.type === 'action' && m.payload).map((m) => m.payload);
const click = (win, sel) => {
  const el = win.document.querySelector(sel);
  assert.ok(el, sel + ' exists');
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
};

test('popup renders subtitle rows with flag/language/badges and every row button routes sub-pick', async () => {
  const { dom, win, sent } = await bootPopup();
  const rows = win.document.querySelectorAll('#subsList .sub-item');
  assert.equal(rows.length, 3, 'three subtitle rows rendered');
  const first = rows[0];
  assert.ok(first.querySelector('.sflag'), 'flag span present');
  assert.match(first.querySelector('.sflag').textContent, /[\u{1F1E6}-\u{1F1FF}][\u{1F1E6}-\u{1F1FF}]/u, 'flag is an emoji pair');
  const meta = first.querySelector('.smain small').textContent;
  assert.match(meta, /Bahasa Indonesia/, 'native language name shown');
  assert.match(meta, /SRT/, 'format shown');
  assert.match(meta, /1\.5k/, 'compact download count shown');
  assert.match(meta, /terverifikasi/, 'verified badge label shown (id locale)');
  assert.match(meta, /oleh/, 'uploader "by" shown (id locale)');
  // Use / Pick both route sub-pick with the right index
  click(win, '[data-act="sub-pick"][data-i="0"]');
  click(win, '#subsList .sub-item:nth-child(3) [data-act="sub-pick"]');
  const picks = actionsSent(sent).filter((p) => p.name === 'sub-pick');
  assert.equal(picks.length, 2, 'two sub-pick actions sent');
  assert.equal(picks[0].index, 0, 'Use carries index 0');
  assert.equal(picks[1].index, 2, 'Pick on third row carries index 2');
  dom.window.close();
});

test('popup every action button sends its action to the worker', async () => {
  const { dom, win, sent, copied } = await bootPopup();
  try {
    click(win, '#subsSearch'); // subs-search (retry)
    click(win, '#subsAttach');
    click(win, '#subsDl');
    click(win, '#refreshBtn'); // rescan
    click(win, '#clearBtn'); // clear
    click(win, '#themeBtn'); // set-setting theme
    click(win, '[data-act="play"]');
    click(win, '[data-act="watchparty"]');
    click(win, '[data-act="download"]');
    click(win, '[data-act="subs"]'); // row subs button = search
    click(win, '[data-act="open"]');
    click(win, '[data-act="copy"]'); // local copy
    click(win, '[data-act="hist-copy"]'); // local copy of history url
    await new Promise((r) => setTimeout(r, 40));
    const acts = actionsSent(sent);
    const names = acts.map((p) => p.name);
    for (const expected of ['subs-search', 'sub-attach', 'sub-download', 'rescan', 'clear', 'set-setting', 'play', 'watchparty', 'download', 'subs', 'open']) {
      assert.ok(names.includes(expected), 'sent ' + expected + ' (got: ' + names.join(',') + ')');
    }
    assert.equal(copied.length, 2, 'copy + hist-copy wrote to the clipboard');
    assert.equal(copied[0], 'https://cdn.example/hls/master.m3u8', 'copy writes the row url');
    assert.equal(copied[1], 'https://cdn.example/past.mp4', 'hist-copy writes the history url');
    // local feedback: a success toast for the copy
    assert.ok(win.document.querySelector('#toasts .toast'), 'a toast appeared for the copy action');
  } finally {
    dom.window.close();
  }
});

test('popup a failed action shows an error toast (nothing is silent)', async () => {
  const { dom, win } = await bootPopup({ fail: { 'sub-pick': 'API key ditolak' } });
  click(win, '#subsList .sub-item [data-act="sub-pick"]');
  await new Promise((r) => setTimeout(r, 60));
  const toasts = [...win.document.querySelectorAll('#toasts .toast')];
  assert.ok(toasts.some((el) => /ditolak/.test(el.textContent)), 'failure reason reached the popup toast: ' + toasts.map((t) => t.textContent).join(' | '));
  dom.window.close();
});

test('popup subtitle rows stay STABLE across refreshes (no vanish on 4s poll)', async () => {
  const { dom, win, msgListeners } = await bootPopup();
  try {
    const first = win.document.querySelector('#subsList .sub-item');
    assert.ok(first, 'subtitle rows rendered');
    // the popup's own 4s refresh() re-fetches get-state with the SAME sub
    const list = win.document.querySelector('#subsList');
    // simulate the periodic refresh re-render path by pushing state-global with identical sub
    msgListeners.forEach((cb) => cb({ type: 'state-global', tabId: 1, payload: { sub: STATE.sub, settings: STATE.settings, items: STATE.items } }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(win.document.querySelector('#subsList .sub-item'), first, 'same DOM node after identical broadcast - no rebuild, no vanish');
    assert.equal(win.document.querySelectorAll('#subsList .sub-item').length, 3, 'all rows still present');
    // a real change (chosen) still updates the row state
    msgListeners.forEach((cb) => cb({ type: 'state-global', tabId: 1, payload: { sub: Object.assign({}, STATE.sub, { chosen: { index: 2 } }), settings: STATE.settings, items: STATE.items } }));
    await new Promise((r) => setTimeout(r, 30));
    const rows = win.document.querySelectorAll('#subsList .sub-item');
    assert.equal(rows.length, 3, 'still three rows');
    assert.equal(rows[0].getAttribute('data-picked'), '1', 'chosen row SHIFTED to the top after chosen change');
    assert.equal(rows[0].querySelector('[data-act="sub-pick"]').getAttribute('data-i'), '2', 'top row is the originally-picked index 2');
    assert.equal(rows[0].querySelector('[data-act="sub-pick"]').disabled, true, 'picked button disabled');
    assert.match(rows[0].querySelector('[data-act="sub-pick"]').textContent, /Terpasang/, 'picked button shows the attached label');
    assert.equal(rows[1].querySelector('[data-act="sub-pick"]').disabled, false, 'row 0 not blocked when row 2 is picked');
  } finally {
    dom.window.close();
  }
});
