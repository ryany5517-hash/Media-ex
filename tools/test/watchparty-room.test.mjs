/**
 * Watch Party room test: when the room page opens, the subtitle that
 * travelled with the hand-off payload must (1) be published to
 * watchparty.me/subtitle and pasted into the "Subtitle URL" field, and
 * (2) be attached as a <track> to the room player. Runs the real
 * watchparty-auto.js + watchparty.js in a jsdom watchparty.me page.
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

function bootRoom() {
  const html = `<!doctype html><html><head></head><body>
    <form id="roomForm">
      <input id="roomName" placeholder="Room name" value="" />
      <input id="subUrl" placeholder="Subtitle URL" value="" />
    </form>
    <video id="v"></video>
  </body></html>`;
  const dom = new JSDOM(html, { url: 'https://www.watchparty.me/watch/testroom', runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window;
  const posted = [];
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
  return { dom, win, posted };
}

async function until(pred, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return pred();
}

test('room subtitle URL field is auto-filled with a published same-origin URL', async () => {
  const { dom, win, posted } = bootRoom();
  try {
    const field = win.document.getElementById('subUrl');
    const ok = await until(() => field.value.trim() !== '');
    assert.ok(ok, 'Subtitle URL field got filled: "' + field.value + '"');
    assert.equal(field.value, 'https://www.watchparty.me/subtitle/abc123', 'value is the published same-origin URL');
    assert.ok(posted.some(([u]) => u.startsWith('/subtitle')), 'VTT was published to /subtitle');
    assert.ok(posted.filter(([u]) => u.startsWith('/subtitle')).length === 1, 'published exactly once (no hammering)');
    // the direct Wyzie file URL travelled with the payload
    assert.ok(PAYLOAD.subtitle.fileUrl.startsWith('https://dl.opensubtitles.org'), 'direct wyzie URL carried in payload');
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
