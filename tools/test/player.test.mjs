/**
 * Cinema player: engine selection and HLS loader message shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function bootPlayer() {
  const html = read('src/player/player.html').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://stream-radar-test/player/player.html?sid=abc', runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window;
  win.chrome = {
    runtime: {
      sendMessage: async () => ({ ok: false }),
    },
  };
  win.eval(read('src/shared/util.js'));
  win.eval(read('src/shared/i18n.js'));
  win.eval(read('src/player/player.js'));
  return win;
}

test('player engine: HLS vs native vs dash from category/url', () => {
  const win = bootPlayer();
  const { engineFor } = win.SRPlayer;
  assert.equal(engineFor('hls', 'https://cdn/x'), 'hls');
  assert.equal(engineFor('mp4', 'https://cdn/movie.mp4'), 'native');
  assert.equal(engineFor('webm', 'https://cdn/v.webm'), 'native');
  assert.equal(engineFor('other', 'https://cdn/a/master.m3u8?t=1'), 'hls');
  assert.equal(engineFor('dash', 'https://cdn/manifest.mpd'), 'dash');
  win.close();
});

test('player HTML is a self-contained cinema page with video + overlay', () => {
  const html = read('src/player/player.html');
  assert.match(html, /id="video"/);
  assert.match(html, /hls\.light\.min\.js/);
  assert.match(html, /player\.js/);
  assert.match(html, /id="overlay"/);
});
