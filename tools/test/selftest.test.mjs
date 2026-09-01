import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootExtension, makeNetStub } from './harness.mjs';

/* ------------------------------------------------------------------ *
 * Self-test page (docs/selftest.html): the in-browser end-to-end proof.
 * This harness run drives the SAME code the user triggers with
 * ?srad-selftest=1: real search (stubbed) -> real pick -> real attach
 * (native <track>) -> player re-create -> report written into the DOM.
 * ------------------------------------------------------------------ */
const SELFTEST_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Stream Radar - Uji Otomatis Subtitle</title></head>
<body><h1>Stream Radar - Uji Otomatis Subtitle</h1><video id="player" controls></video><div id="srad-selftest"></div></body></html>`;

const SUBS = JSON.stringify({
  results: [
    { attributes: { id: 4242, name: 'The Eye 2002', filename: 'The.Eye.2002.id.srt', lang: { code: 'id', name: 'Indonesian' }, format: 'srt', year: '2002', downloadCount: 1500, verified: true } },
    { attributes: { id: 4243, name: 'The Eye 2002 EN', filename: 'The.Eye.2002.en.srt', lang: { code: 'en', name: 'English' }, format: 'srt', year: '2002', downloadCount: 42, verified: false } },
  ],
});

test('selftest page: search -> pick -> native attach -> player re-create, all reported OK', async () => {
  const net = makeNetStub({ 'subdl.com/api/v1/subtitles?': { body: SUBS, type: 'application/json' } });
  const h = await bootExtension({
    html: SELFTEST_HTML,
    url: 'http://localhost:8088/docs/selftest.html?srad-selftest=1',
    net,
    settings: {
      subdlApiKey: 'test-key',
      providers: { subdl: true, opensubtitles: false, yify: false },
      autoSubtitle: false,
      watchpartyAutoJoin: true,
      notify: false,
      showAds: false,
      theme: 'dark',
      lang: 'id',
    },
  });
  const doc = h.dom.window.document;
  const until = async (pred, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return true;
      await h.wait(150);
    }
    return pred();
  };

  // The self-test runs itself (boot hook) - wait for the final summary.
  const done = await until(() => !!doc.querySelector('#srad-selftest .srad-st-summary'), 25000);
  assert.ok(done, 'self-test finished and wrote a summary');

  const rows = [...doc.querySelectorAll('#srad-selftest .srad-st-row')];
  const summary = doc.querySelector('#srad-selftest .srad-st-summary');
  assert.ok(summary, 'summary present');
  assert.match(summary.textContent, /SELURUH UJI LULUS/, 'all steps passed: ' + summary.textContent);

  // The critical chain is proven on the page's own <video>.
  const track = doc.querySelector('video track[data-srad="1"]');
  assert.ok(track, 'native <track> attached to the page video');
  assert.match(track.getAttribute('src') || '', /^(blob:|data:text\/vtt)/, 'track uses a blob/data URL');

  // Report must cover the real steps.
  const text = rows.map((r) => r.textContent).join('\n');
  for (const step of ['1-search', '2-pick-attach', '3-attach', '4-recreate']) {
    assert.ok(text.includes('[' + step + ']'), 'report includes step ' + step);
  }

  // The player was re-created during the test: the FINAL video element must
  // still carry the subtitle (armed watcher re-attached it).
  const video = doc.querySelector('video');
  assert.ok(video && video.querySelector('track[data-srad="1"]'), 'track survived the player re-create');

  h.dom.window.close();
});
