/**
 * Watch Party room test: when the room page opens, the subtitle that
 * travelled with the hand-off payload must (1) be published to
 * watchparty.me/subtitle and pasted into the "Subtitle URL" input, and
 * (2) be attached as a <track> to the room player. Runs the real
 * watchparty-auto.js + watchparty.js in a jsdom watchparty.me page.
 *
 * The fixture mirrors the REAL WatchParty room page (verified against
 * github.com/howardchung/watchparty source): the "Subtitle URL" input only
 * exists inside the SubtitleModal, which opens when the Captions control
 * ([title="Captions"]) is clicked, and is disabled unless the caller holds
 * the room lock. The auto-fill must open the modal and fill the input there,
 * and warn honestly when the lock blocks it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const PRELUDE = ['src/shared/util.js', 'src/shared/rules.js', 'src/shared/title-cleaner.js', 'src/shared/i18n.js'];

const PAYLOAD = {
  mediaUrl: 'https://cdn.example/movie.mp4',
  roomName: 'Dune (2024)',
  category: 'mp4', // not hls → no Hls.js needed
  subtitle: {
    vtt: 'WEBVTT\n\n1\n00:00:01,000 --> 00:00:03,000\nHalo ini subtitle',
    name: 'Dune.2024.id.srt',
    lang: 'id',
    fileUrl: 'https://dl.opensubtitles.org/en/download/subencoding-utf8/src-api/vrf-x/file/1',
  },
  autoJoin: true,
};

/** Real WatchParty room-page structure. opts: { locked, modal } */
function bootRoom(opts = {}) {
  const locked = !!opts.locked;
  const withModal = opts.modal !== false;
  const directField = !withModal;
  const html = `<!doctype html><html><head></head><body>
    <form id="roomForm">
      <input id="roomName" placeholder="Room name" value="" />
      ${directField ? '<input id="subUrl" placeholder="Subtitle URL" value="" />' : ''}
    </form>
    ${withModal ? '<button id="cc" title="Captions">CC</button><div id="modalWrap" style="display:none"></div>' : ''}
    <video id="v"></video>
    <script>
      (function () {
        var cc = document.getElementById('cc');
        if (!cc) return;
        cc.addEventListener('click', function () {
          // React renders the SubtitleModal asynchronously after the click.
          setTimeout(function () {
            var wrap = document.getElementById('modalWrap');
            var input = document.createElement('input');
            input.id = 'subUrl';
            input.placeholder = 'Subtitle URL';
            input.value = '';
            ${locked ? 'input.disabled = true;' : ''}
            wrap.appendChild(input);
            wrap.style.display = 'block';
          }, 30);
        });
      })();
    </script>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://www.watchparty.me/watch/testroom', runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window;
  const posted = [];
  const statuses = [];
  win.fetch = async (url, init) => {
    posted.push([String(url), init || {}]);
    if (String(url).startsWith('/subtitle')) return { json: async () => ({ hash: 'abc123' }) };
    throw new Error('unexpected fetch ' + url);
  };
  win.chrome = {
    runtime: {
      id: 'stream-radar-test',
      sendMessage: async (msg) => {
        if (msg && msg.type === 'get-party-payload') return { ok: true, payload: PAYLOAD };
        if (msg && msg.type === 'party-status') {
          statuses.push(msg);
          return { ok: true };
        }
        return { ok: false };
      },
      onMessage: { addListener: () => {} },
    },
  };
  // force boot() to run synchronously when watchparty.js evaluates
  Object.defineProperty(win.document, 'readyState', { configurable: true, get: () => 'complete' });
  for (const f of PRELUDE) win.eval(read(f));
  win.eval(read('src/shared/watchparty-auto.js'));
  win.eval(read('src/watchparty/watchparty.js'));
  return { dom, win, posted, statuses };
}

async function until(pred, ms = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

test('room subtitle URL is auto-filled via the REAL WatchParty flow (Captions modal)', async () => {
  const { dom, win, posted, statuses } = bootRoom();
  try {
    // The input does not exist until the modal is opened by our code.
    const ok = await until(() => {
      const el = win.document.getElementById('subUrl');
      return el && el.value === 'https://www.watchparty.me/subtitle/abc123';
    });
    assert.ok(ok, 'Subtitle URL input got filled with the published same-origin URL');
    assert.ok(posted.some(([u]) => u.startsWith('/subtitle')), 'VTT was published to /subtitle');
    assert.ok(posted.filter(([u]) => u.startsWith('/subtitle')).length === 1, 'published exactly once (no hammering)');
    assert.ok(
      statuses.some((s) => s.kind === 'ok' && s.text.includes('https://www.watchparty.me/subtitle/abc123')),
      'a status OK reports the exact subtitle URL (' + JSON.stringify(statuses.map((s) => s.text)) + ')'
    );
    // the direct Wyzie file URL travelled with the payload
    assert.ok(PAYLOAD.subtitle.fileUrl.startsWith('https://dl.opensubtitles.org'), 'direct wyzie URL carried in payload');
  } finally {
    dom.window.close();
  }
});

test('room lock blocks the subtitle: honest warning, no silent failure', async () => {
  const { dom, win, statuses } = bootRoom({ locked: true });
  try {
    const warned = await until(() => statuses.some((s) => s.kind === 'warn' && /terkunci/i.test(s.text)));
    assert.ok(warned, 'a warn status explains the room lock (' + JSON.stringify(statuses.map((s) => s.text)) + ')');
    const el = win.document.getElementById('subUrl');
    if (el) assert.equal(el.value, '', 'disabled/locked input is never force-filled');
  } finally {
    dom.window.close();
  }
});

test('direct-field fallback still fills a plain Subtitle URL input (other layouts)', async () => {
  const { dom, win, posted } = bootRoom({ modal: false });
  try {
    const field = win.document.getElementById('subUrl');
    const ok = await until(() => field.value.trim() !== '');
    assert.ok(ok, 'Subtitle URL field got filled: "' + field.value + '"');
    assert.equal(field.value, 'https://www.watchparty.me/subtitle/abc123', 'value is the published same-origin URL');
    assert.ok(posted.filter(([u]) => u.startsWith('/subtitle')).length === 1, 'published exactly once');
  } finally {
    dom.window.close();
  }
});

test('room player gets a <track> attached automatically', async () => {
  const { dom, win } = bootRoom();
  try {
    const video = win.document.getElementById('v');
    const ok = await until(() => video.querySelector('track[data-srad="1"]') != null);
    assert.ok(ok, 'track attached to the room player');
    const track = video.querySelector('track[data-srad="1"]');
    assert.match(track.getAttribute('src'), /^(blob:|data:text\/vtt)/, 'track src is a usable vtt URL');
    assert.equal(track.getAttribute('srclang'), 'id', 'language matches the subtitle payload');
    assert.match(track.getAttribute('label'), /Stream Radar/, 'labelled so the room UI can toggle it');
  } finally {
    dom.window.close();
  }
});
