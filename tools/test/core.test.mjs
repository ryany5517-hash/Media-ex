/**
 * Unit tests for the pure core modules (rules, title cleaner, subtitle engine).
 * Run with:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../../src/shared/util.js';
import '../../src/shared/rules.js';
import '../../src/shared/title-cleaner.js';
import '../../src/shared/subtitles.js';

const SR = globalThis.SR;
const { rules, title, subs, util } = SR;

/* ------------------------------------------------------------------ *
 * rules.classify
 * ------------------------------------------------------------------ */
test('classify: hls / dash / mp4 / segments', () => {
  assert.equal(rules.classify('https://cdn.x.com/a/b/master.m3u8').category, 'hls');
  assert.equal(rules.classify('https://cdn.x.com/a/b/master.m3u8?token=abc').category, 'hls');
  assert.equal(rules.classify('https://cdn.x.com/manifest.mpd').category, 'dash');
  assert.equal(rules.classify('https://cdn.x.com/movie.mp4').category, 'mp4');
  assert.equal(rules.classify('https://cdn.x.com/movie.webm').category, 'webm');
  assert.equal(rules.classify('https://cdn.x.com/seg-0001.ts').category, 'segment');
  assert.equal(rules.classify('https://cdn.x.com/video-1.m4s').category, 'segment');
  assert.equal(rules.classify('blob:https://player.x/8f2e-1').category, 'blob');
});

test('classify: content-type wins over a missing extension', () => {
  const r = rules.classify('https://cdn.x.com/stream/12345', { mime: 'application/vnd.apple.mpegurl' });
  assert.equal(r.category, 'hls');
  const r2 = rules.classify('https://cdn.x.com/stream/12345', { mime: 'video/mp4' });
  assert.equal(r2.category, 'mp4');
});

test('classify: rejects images, css and noise', () => {
  assert.equal(rules.classify('https://x.com/logo.png'), null);
  assert.equal(rules.classify('https://x.com/app.css'), null);
  assert.equal(rules.classify('https://x.com/img/favicon.ico'), null);
  assert.equal(rules.classify('data:video/mp4;base64,AAAA'), null);
});

test('classify: flags ad traffic', () => {
  const r = rules.classify('https://doubleclick.net/ad/p.mp4');
  assert.equal(r.isAd, true);
  assert.equal(rules.classify('https://movies.example.com/movie.mp4').isAd, false);
});

test('classify + parsePlayHeaders: m3u8-proxy with Origin/Referer is HLS', () => {
  const inner = 'https://futureproofmarketing.site/pl/master.m3u8';
  const proxy =
    'https://proxy.valhallastream.dpdns.org/m3u8-proxy?url=' +
    encodeURIComponent(inner) +
    '&headers=' +
    encodeURIComponent(JSON.stringify({ Origin: 'https://nextgencloudfabric.com', Referer: 'https://nextgencloudfabric.com/' }));
  const r = rules.classify(proxy);
  assert.ok(r, 'proxy classified');
  assert.equal(r.category, 'hls');
  assert.equal(util.isHlsProxy(proxy), true);
  const h = util.parsePlayHeaders(proxy);
  assert.match(h.referer, /nextgencloudfabric\.com/);
  assert.equal(h.origin, 'https://nextgencloudfabric.com');
  assert.equal(util.watchPartyPlayable(proxy, 'hls'), true);
  const unwrapped = rules.unwrapUrl(proxy);
  assert.ok(unwrapped.some((u) => u.indexOf('master.m3u8') >= 0), JSON.stringify(unwrapped));
});

test('unwrapUrl: extracts streams hidden in query params / base64', () => {
  const urls = rules.unwrapUrl('https://vidlink.pro/movie/123?api=/&src=https%3A%2F%2Fcdn.host%2Fhls%2Fmaster.m3u8');
  assert.ok(urls.some((u) => /master\.m3u8$/.test(u)), JSON.stringify(urls));

  const urls2 = rules.unwrapUrl('https://player.example/embed?file=' + Buffer.from('https://a.b/c/index.m3u8').toString('base64'));
  assert.ok(urls2.some((u) => /index\.m3u8$/.test(u)), JSON.stringify(urls2));
});

test('findUrlsInText: scans scripts for stream urls', () => {
  const script = `var cfg = { file: "https://cdn.film.net/hls/1080/720p.m3u8?token=x", backup: '/data/movie.mp4' };`;
  const found = rules.findUrlsInText(script);
  assert.ok(found.some((f) => f.includes('720p.m3u8')), JSON.stringify(found));
});

test('qualityFromUrl / codecHint', () => {
  assert.equal(rules.qualityFromUrl('https://x/movie.1080p.x264.mp4'), '1080p');
  assert.equal(rules.qualityFromUrl('https://x/movie_2160.mp4'), '4K');
  assert.equal(rules.codecHint('https://x/hevc.mp4', ''), 'HEVC');
});

test('dedupKey ignores volatile query strings', () => {
  const a = util.dedupKey('https://c.net/x.m3u8?token=1', 'hls');
  const b = util.dedupKey('https://c.net/x.m3u8?token=2', 'hls');
  assert.equal(a, b);
});

/* ------------------------------------------------------------------ *
 * manifest parsing
 * ------------------------------------------------------------------ */
test('manifest.parseM3u8: master playlist variants + AES key', () => {
  const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.64001f,mp4a.40.2"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-KEY:METHOD=AES-128,URI="https://key.host/k?id=1"
`;
  const m = SR.manifest.parseM3u8(text, 'https://cdn.film.net/hls/master.m3u8');
  assert.equal(m.kind, 'master');
  assert.equal(m.variants.length, 2);
  assert.equal(m.variants[0].height, 1080);
  assert.equal(m.variants[0].uri, 'https://cdn.film.net/hls/1080/index.m3u8');
  assert.equal(m.aesKeyUrl, 'https://key.host/k?id=1');
  assert.match(m.codecs, /avc1/);
});

test('manifest.parseM3u8: media playlist reports duration + segments', () => {
  const text = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.0,
seg-1.ts
#EXTINF:9.0,
seg-2.ts
#EXT-X-ENDLIST`;
  const m = SR.manifest.parseM3u8(text, 'https://cdn/x/index.m3u8');
  assert.equal(m.kind, 'media');
  assert.equal(m.segmentCount, 2);
  assert.equal(m.durationSec, 18);
});

test('manifest.parseMpd: resolutions + Widevine detection', () => {
  const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT1H59M12.5S">
<Period><AdaptationSet mimeType="video/mp4">
<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" value="Widevine"/>
<Representation id="v1" bandwidth="4800000" width="1920" height="1080" codecs="avc1.640028"/>
<Representation id="v2" bandwidth="1200000" width="1280" height="720" codecs="avc1.64001f"/>
</AdaptationSet></Period></MPD>`;
  const m = SR.manifest.parseMpd(mpd, 'https://cdn/x/manifest.mpd');
  assert.equal(m.variants.length, 2);
  assert.equal(m.bestHeight, 1080);
  assert.equal(m.drm, 'Widevine');
  assert.equal(m.durationSec, 7153); // PT1H59M12.5S
});

/* ------------------------------------------------------------------ *
 * title cleansing
 * ------------------------------------------------------------------ */
const cases = [
  ['Nonton The Last Sunrise (2024) Subtitle Indonesia | Layarkaca21', 'The Last Sunrise', '2024'],
  ['Dune: Part Two (2024) 1080p WEBRip x265 - LookMovie', 'Dune: Part Two', '2024'],
  ['Watch The Dark Knight (2008) Full Movie HD 720p | moviezworld.com', 'The Dark Knight', '2008'],
  ['67movies.net — Watch Movies & TV Shows in HD Online', '', null],
  ['Nonton Avatar The Way of Water (2022) Sub Indo Kualitas 1080p - Indoxxi', 'Avatar The Way of Water', '2022'],
  ['Venom: The Last Dance S01E02 Subtitle Indonesia nonton', 'Venom: The Last Dance', null],
  ['Oppenheimer 2023 BluRay 1080p x264 AC3 - LK21', 'Oppenheimer', '2023'],
  ['Spider-Man Across the Spider-Verse (2023) [GDT] Dual Audio Sub Indo', 'Spider-Man Across the Spider-Verse', '2023'],
  ['The Flash (2023) Episode 5 Sub Indo - streaming21.net', 'The Flash', '2023'],
  ['Inception.2010.720p.BluRay.x264 - YTS', 'Inception', '2010'],
];

for (const [raw, want, wantYear] of cases) {
  test('title.clean: ' + raw.slice(0, 46), () => {
    const r = title.clean(raw);
    assert.equal(r.title, want, 'got: ' + JSON.stringify(r.title) + ' from ' + raw);
    assert.equal(r.year, wantYear);
  });
}

test('title.clean: episode / season parsing', () => {
  const a = title.clean('Breaking Bad S02E05 Subtitle Indonesia');
  assert.equal(a.season, '02');
  assert.equal(a.episode, '05');
  assert.equal(title.episodeLabel(a), 'S02E05');
  const b = title.clean('The Boys 3x04 Watch Online HD');
  assert.equal(b.season, '03');
  assert.equal(b.episode, '04');
  const c = title.clean('Loki Episode 6 Sub Indo');
  assert.equal(c.episode, '06');
});

test('title.clean: junk / cookie-wall pages flagged', () => {
  assert.equal(title.clean('Just a moment...').isJunk, true);
  assert.equal(title.clean('Loading player').isJunk, true);
});

test('title.clean: keeps punctuation inside real titles', () => {
  const r = title.clean('Alien: Romulus (2024) Sub Indo - nonton21');
  assert.match(r.title, /Alien: Romulus/);
});

test('title.lookupIds: IMDb suggestion picks tt id', async () => {
  let requested = '';
  const fake = async (url) => {
    requested = String(url);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          d: [
            { id: 'tt0816692', l: 'Interstellar', y: 2014, qid: 'movie' },
            { id: 'nm0000129', l: 'Someone Else' },
          ],
        });
      },
    };
  };
  const r = await title.lookupIds({ title: 'Interstellar', year: '2014' }, { fetchImpl: fake });
  assert.match(requested, /v2\.sg\.media-imdb\.com\/suggestion\/i\/interstellar\.json/);
  assert.equal(r.imdbId, 'tt0816692');
  assert.equal(r.year, '2014');
});

test('title.lookupIds: Cinemeta fallback when IMDb is empty', async () => {
  const fake = async (url) => {
    if (String(url).includes('media-imdb')) return { ok: false, status: 500, async text() { return ''; } };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ metas: [{ imdb_id: 'tt0816692', name: 'Interstellar', year: '2014', type: 'movie' }] });
      },
    };
  };
  const r = await title.lookupIds({ title: 'Interstellar', year: '2014' }, { fetchImpl: fake });
  assert.equal(r.imdbId, 'tt0816692');
});

test('title.lookupIds: fail-soft on network errors', async () => {
  const r = await title.lookupIds({ title: 'Anything' }, { fetchImpl: async () => { throw new Error('nope'); } });
  assert.deepEqual(r, {});
});

test('title.idsFromUrl: catalog ids on any watch-site path / query / embed', () => {
  const a = title.idsFromUrl('https://67movies.nl/watch/movie/10389');
  assert.equal(a.tmdbId, '10389');
  assert.equal(a.kind, 'movie');
  const b = title.idsFromUrl('https://random.site/watch/tv/1396');
  assert.equal(b.tmdbId, '1396');
  assert.equal(b.kind, 'episode');
  const c = title.idsFromUrl('https://www.imdb.com/title/tt0314196/');
  assert.equal(c.imdbId, 'tt0314196');
  assert.equal(title.idsFromUrl('https://vidsrc.to/embed/movie/10389').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://vidlink.pro/movie/10389').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/play?tmdb=10389').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/watch?imdb=tt0314196').imdbId, 'tt0314196');
  assert.equal(title.idsFromUrl('https://lk21.example/movie/the-eye-10389').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/nonton/10389').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/film/the-eye-tt0314196').imdbId, 'tt0314196');
  assert.equal(title.idsFromUrl('https://cdn.x/hls/1080/index.m3u8').tmdbId || '', '');
  assert.equal(title.idsFromUrl('https://x.example/movie/inception-2010').tmdbId || '', '');
  // id-first slugs, .html suffixes, extra query keys, short media prefixes
  assert.equal(title.idsFromUrl('https://x.example/movie/10389-the-eye').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/films/1396-arcane').tmdbId, '1396');
  assert.equal(title.idsFromUrl('https://x.example/watch/movie/10389.html').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/film/10389').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/detail/10389.html').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/view/10389').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/watch?movie_id=10389').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/embed?film_id=10389').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/watch?episode_id=1396').tmdbId, '1396');
  assert.equal(title.idsFromUrl('https://x.example/tv/1396/season/1/episode/3').tmdbId, '1396');
  assert.equal(title.idsFromUrl('https://x.example/tv/1396/season/1/episode/3').kind, 'episode');
  assert.equal(title.idsFromUrl('https://x.example/news/2024/05/10389').tmdbId || '', '');
  // numeric ids baked into the stream URL itself (CDN path carries the TMDB id)
  assert.equal(title.idsFromUrl('https://a2.shows.st/hls/10389/master.m3u8?token=9f2').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://cdn.x/dash/1396/manifest.mpd').tmdbId, '1396');
  assert.equal(title.idsFromUrl('https://x.cdn/player/10389/index.m3u8').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://cdn.example/hls/tok123/master.m3u8?id=10389&token=9f2').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/movie/watch?mid=13962').tmdbId, '13962');
  assert.equal(title.idsFromUrl('https://x.example/title/10389').tmdbId, '10389');
  assert.equal(title.idsFromUrl('https://x.example/watch?id=abc123').tmdbId || '', '');
  assert.equal(title.idsFromUrl('https://cdn.x/hls/1080/index.m3u8').tmdbId || '', '');
  assert.equal(title.idsFromUrl('https://cdn.x/dash/2160/manifest.mpd').tmdbId || '', '');
  assert.equal(title.namesMatch('The Eye', 'The Eye (2002)'), true);
  assert.equal(title.namesMatch('The Eye', 'Interstellar'), false);
});

test('title.idsFromDoc: iframe embed and data-tmdb on a slug page', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    `<!doctype html><html><head><link rel="canonical" href="https://site.example/nonton/the-eye"></head>
<body><h1>Nonton</h1><iframe src="https://vidsrc.to/embed/movie/10389"></iframe></body></html>`,
    { url: 'https://site.example/nonton/the-eye' }
  );
  const got = title.idsFromDoc(dom.window.document);
  assert.equal(got.tmdbId, '10389');
  const dom2 = new JSDOM(
    `<!doctype html><html><body><div data-imdb="tt0314196" data-tmdb="10389"></div></body></html>`,
    { url: 'https://other.example/watch/foo' }
  );
  const got2 = title.idsFromDoc(dom2.window.document);
  assert.equal(got2.imdbId, 'tt0314196');
  assert.equal(got2.tmdbId, '10389');
  dom.window.close();
  dom2.window.close();
});

test('title.lookupIds: TMDB catalog id hydrates title when the page is junk', async () => {
  const fake = async (url) => {
    const u = String(url);
    if (u.includes('themoviedb.org/movie/10389')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return '<html><head><meta property="og:title" content="The Eye (2002)"><title>The Eye (2002) — The Movie Database (TMDB)</title></head></html>';
        },
      };
    }
    if (u.includes('media-imdb')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ d: [{ id: 'tt0314196', l: 'The Eye', y: 2002, qid: 'movie' }] });
        },
      };
    }
    return { ok: false, status: 404, async text() { return ''; } };
  };
  const r = await title.lookupIds({ urlTmdbId: '10389', kind: 'movie' }, { fetchImpl: fake });
  assert.equal(r.tmdbId, '10389');
  assert.equal(r.name, 'The Eye');
  assert.equal(r.year, '2002');
  assert.equal(r.imdbId, 'tt0314196');
});

test('title.lookupIds: URL TMDB id is dropped when it does not match the page title', async () => {
  const fake = async (url) => {
    if (String(url).includes('themoviedb.org/movie/10389')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return '<html><head><meta property="og:title" content="The Eye (2002)"></head></html>';
        },
      };
    }
    if (String(url).includes('media-imdb')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ d: [{ id: 'tt0816692', l: 'Interstellar', y: 2014, qid: 'movie' }] });
        },
      };
    }
    return { ok: false, status: 404, async text() { return ''; } };
  };
  const r = await title.lookupIds({ title: 'Interstellar', year: '2014', urlTmdbId: '10389' }, { fetchImpl: fake });
  assert.equal(r.tmdbId || '', '');
  assert.equal(r.imdbId, 'tt0816692');
});

/* ------------------------------------------------------------------ *
 * subtitles
 * ------------------------------------------------------------------ */
test('subs.srtToVtt: converts timings and drops numeric cue ids', () => {
  const srt = `1
00:00:01,000 --> 00:00:04,500
Halo, apa kabar?

2
00:00:05,250 --> 00:00:08,000
<font color="#00ff00">Teks hijau</font>
`;
  const vtt = subs.srtToVtt(srt);
  assert.match(vtt, /^WEBVTT/);
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:04.500'), vtt);
  assert.ok(vtt.includes('<c>Teks hijau</c>'), vtt);
  assert.equal(subs.countCues(vtt), 2);
});

test('subs.srtToVtt: idempotent for VTT input', () => {
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n';
  const out = subs.srtToVtt(vtt);
  assert.match(out, /^WEBVTT/);
  assert.ok(out.includes('-->'));
});

test('subs.srtToVtt: garbage input is rejected', () => {
  const out = subs.srtToVtt('this is not a subtitle');
  assert.equal(subs.countCues(out), 0);
});

test('subs.isIndonesian + score ranking', () => {
  const want = { title: 'Dune Part Two', year: '2024', season: null, episode: null };
  const good = { name: 'Dune Part Two', year: '2024', langCode: 'id', format: 'srt', downloads: 900 };
  const other = { name: 'Dune Part Two', year: '2024', langCode: 'spa', format: 'srt' };
  assert.ok(subs.score(good, want) > subs.score(other, want));
  assert.ok(subs.isIndonesian(good));
  assert.ok(!subs.isIndonesian(other));
});

test('subs.score: wrong episode is punished', () => {
  const want = { title: 'The Boys', year: '2024', season: '03', episode: '05' };
  const right = { name: 'The Boys', season: '3', episode: '5', langCode: 'id' };
  const wrong = { name: 'The Boys', season: '3', episode: '2', langCode: 'id' };
  assert.ok(subs.score(right, want) > subs.score(wrong, want) + 40);
});

test('subs.search: provider orchestration with fake fetch', async () => {
  const fakeFetch = async (url) => {
    if (String(url).startsWith('https://api.subdl.com')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            results: [
              { attributes: { id: 777, name: 'Dune Part Two', filename: 'dune.2024.id.srt', lang: { code: 'id', name: 'Indonesian' }, format: 'srt', year: '2024', downloadCount: 1200, verified: true } },
              { attributes: { id: 778, name: 'Dune Part Two', filename: 'dune.2024.spa.srt', lang: { code: 'es', name: 'Spanish' }, format: 'srt', year: '2024' } },
            ],
          };
        },
      };
    }
    throw new Error('network blocked in test');
  };
  const settings = Object.assign({}, SR.defaults, {
    subdlApiKey: 'test-key',
    providers: { subdl: true, opensubtitles: false, yify: false },
  });
  const res = await subs.search({ title: 'Dune Part Two', year: '2024' }, settings, { fetchImpl: fakeFetch });
  assert.equal(res.results.length, 1, 'only the Indonesian result survives');
  assert.equal(res.results[0].id, '777');
  assert.equal(res.providerInfo.opensubtitles.status, 'disabled', 'disabled provider not queried');
  assert.equal(res.providerInfo.subdl.status, 'ok');
});

test('subs.search: missing API key marks provider as skipped, never throws', async () => {
  const settings = Object.assign({}, SR.defaults, { subdlApiKey: '', osApiKey: '', wyzieApiKey: '', providers: { subdl: true, opensubtitles: true, yify: false, wyzie: true } });
  const res = await subs.search({ title: 'X' }, settings, { fetchImpl: async () => { throw new Error('nope'); } });
  assert.equal(res.results.length, 0);
  assert.equal(res.providerInfo.subdl.status, 'skipped');
  assert.equal(res.providerInfo.opensubtitles.status, 'skipped');
  assert.equal(res.providerInfo.wyzie.status, 'skipped', 'wyzie with no key is skipped, never throws');
});

test('wyzie: searches by IMDb id, maps Indonesian srt result, requires key and id', async () => {
  const wyzieRows = [
    { id: 'a1', url: 'https://sub.wyzie.io/c/abc/id/a1?format=srt&encoding=UTF-8', language: 'id', display: 'Indonesian', format: 'srt', media: 'The Martian', fileName: 'martian.id.srt', source: 'opensubtitles', ai: false, downloadCount: 50 },
    { id: 'a2', url: 'https://sub.wyzie.io/c/abc/en/a2?format=srt', language: 'en', display: 'English', format: 'srt', media: 'The Martian', fileName: 'martian.en.srt', ai: false },
  ];
  let requestedUrl = '';
  const fakeFetch = async (url) => {
    requestedUrl = String(url);
    if (requestedUrl.startsWith('https://sub.wyzie.io/search')) {
      return { ok: true, status: 200, async text() { return JSON.stringify(wyzieRows); }, async json() { return wyzieRows; } };
    }
    if (requestedUrl.includes('/c/abc/id/a1')) {
      return { ok: true, status: 200, async text() { return '1\n00:00:01,000 --> 00:00:03,000\nHalo dunia'; } };
    }
    throw new Error('network blocked: ' + url);
  };

  // 1. no key -> skipped
  let settings = Object.assign({}, SR.defaults, { wyzieApiKey: '', providers: { wyzie: true, subdl: false, opensubtitles: false, yify: false } });
  let res = await subs.search({ title: 'The Martian', imdbId: 'tt3659388' }, settings, { fetchImpl: fakeFetch });
  assert.equal(res.providerInfo.wyzie.status, 'skipped');

  // 2. key but no id -> skipped (wyzie cannot search by title text)
  settings = Object.assign({}, SR.defaults, { wyzieApiKey: 'k', providers: { wyzie: true, subdl: false, opensubtitles: false, yify: false } });
  res = await subs.search({ title: 'No Id Movie' }, settings, { fetchImpl: fakeFetch });
  assert.equal(res.providerInfo.wyzie.status, 'skipped');

  // 3. key + id -> Indonesian result mapped
  settings = Object.assign({}, SR.defaults, { wyzieApiKey: 'k', subtitleLang: 'id', providers: { wyzie: true, subdl: false, opensubtitles: false, yify: false } });
  res = await subs.search({ title: 'The Martian', year: '2015', imdbId: 'tt3659388' }, settings, { fetchImpl: fakeFetch });
  assert.equal(res.providerInfo.wyzie.status, 'ok');
  assert.match(requestedUrl, /id=tt3659388/);
  assert.match(requestedUrl, /language=id/);
  assert.match(requestedUrl, /format=srt/);
  assert.match(requestedUrl, /key=k/);
  assert.equal(res.results.length, 1, 'Indonesian result kept, English filtered for subtitleLang=id');
  assert.equal(res.results[0].provider, 'wyzie');
  assert.equal(res.results[0].langCode, 'id');
  assert.equal(res.results[0].fileUrl.includes('a1'), true);

  // 4. fetchFile resolves the SRT text through the load/convert path
  const text = await subs.resolve(Object.assign({}, res.results[0]), settings, {
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/x-subrip' },
      async text() { return '1\n00:00:01,000 --> 00:00:03,000\nHalo dunia'; },
      async arrayBuffer() { return new TextEncoder().encode('1\n00:00:01,000 --> 00:00:03,000\nHalo dunia').buffer; },
    }),
  });
  assert.match(String(text), /WEBVTT|Halo dunia/);

  // 5. TV episode passes season & episode
  res = await subs.search({ title: 'South Park', imdbId: 'tt0121955', season: 1, episode: 1 }, settings, { fetchImpl: fakeFetch });
  assert.match(requestedUrl, /season=1/);
  assert.match(requestedUrl, /episode=1/);

  // 6. 401/403 surfaces an error, not a silent skip
  const badKey = Object.assign({}, settings);
  const failFetch = async () => ({ ok: false, status: 401, async text() { return '{}'; } });
  res = await subs.search({ title: 'X', imdbId: 'tt1' }, badKey, { fetchImpl: failFetch });
  assert.equal(res.providerInfo.wyzie.status, 'error');
  assert.match(res.providerInfo.wyzie.reason, /key|401/);

  // 7. English filter still asks Wyzie for id,en and keeps both (Watch Party can pick ID)
  settings = Object.assign({}, SR.defaults, { wyzieApiKey: 'k', subtitleLang: 'en', providers: { wyzie: true, subdl: false, opensubtitles: false, yify: false } });
  res = await subs.search({ title: 'The Martian', year: '2015', imdbId: 'tt3659388' }, settings, { fetchImpl: fakeFetch });
  assert.match(requestedUrl, /language=id%2Cen|language=id,en/);
  assert.equal(res.results.length, 2, 'English + Indonesian kept when subtitleLang=en');
  assert.equal(res.results[0].langCode, 'en', 'selected language ranks first');
});

/* ------------------------------------------------------------------ *
 * settings layer
 * ------------------------------------------------------------------ */
test('settings.merge: unknown keys dropped, nested providers merged', () => {
  const merged = SR.settings.merge({ theme: 'dark', nope: 1, providers: { yify: true } });
  assert.equal(merged.theme, 'dark');
  assert.equal(merged.nope, undefined);
  assert.equal(merged.providers.subdl, true);
  assert.equal(merged.providers.yify, true);
});

test('util.extractMediaUrl + localPlayable: resolver JSON is playable locally', () => {
  const api = 'https://d.shows.st/api?d=fC1Oq-resolver-token-very-long';
  assert.equal(util.localPlayable(api, 'other'), true);
  assert.equal(util.localPlayable(api, 'blob'), false);
  assert.equal(util.extractMediaUrl({ file: 'https://cdn.x/a/master.m3u8?t=1' }), 'https://cdn.x/a/master.m3u8?t=1');
  assert.equal(util.extractMediaUrl({ source: { src: 'https://cdn.x/v.mp4' } }), 'https://cdn.x/v.mp4');
  assert.match(util.extractMediaUrl(JSON.parse('{"url":"https://a.b/c/index.m3u8"}')), /index\.m3u8/);
});

test('util.watchPartyPlayable: direct media yes, resolver/API links no', () => {
  const yes = [
    ['https://cdn.x/a/master.m3u8', 'hls'],
    ['https://cdn.x/a/play.mp4?t=1', 'mp4'],
    ['https://cdn.x/manifest.mpd', 'dash'],
    ['https://cdn.x/v.webm', 'webm'],
    ['https://cdn.x/noext-but-hls', 'hls'],
    // real HLS CDNs frequently serve the manifest through an /api path;
    // a real .m3u8 on the path must still play despite "api" in the URL
    ['https://a2.shows.st/api/playlist/aBc.m3u8?token=x', 'hls'],
    ['https://cdn.x/api/manifest/master.m3u8', 'hls'],
    ['https://a2.shows.st/api/playlist/tok123', 'hls'],
    ['https://cdn.x/v0.m3u8?srad=playlist.m3u8', 'hls'],
    ['https://a2.shows.st/api?d=tok#playlist.m3u8', 'hls'],
    // 67movies: token HLS without .m3u8 — already classified, so send it
    ['https://a2.shows.st/api?d=zDi0HsW9-WyCwCalBZIXmeiNh6I', 'hls'],
    ['https://nova-edge.example.workers.dev/mpd/token-no-ext', 'hls'],
  ];
  for (const [u, c] of yes) assert.equal(util.watchPartyPlayable(u, c), true, 'should play ' + u);
  const no = [
    ['https://d.shows.st/api?d=fC1Oq-resolver-token-very-long', 'other'],
    ['https://x.com/redirect?to=https%3A%2F%2Fcdn%2Fa.m3u8', 'other'],
    // a gateway with no media path AND no direct-media category is a resolver
    ['https://x.com/gateway/v1/stream?id=9', 'other'],
    ['blob:https://x/1-2-3', 'blob'],
    ['https://cdn.x/seg0.ts', 'segment'],
    ['https://x.com/page/123', 'other'],
  ];
  for (const [u, c] of no) assert.equal(util.watchPartyPlayable(u, c), false, 'must reject ' + u);
});

test('util: pattern compiler + matching', () => {
  const pats = util.compilePatterns('*.example.com\n/m3u8$/i\n# comment');
  assert.equal(pats.length, 2);
  assert.ok(util.matchesAny(pats, 'https://a.example.com/x'));
  assert.ok(util.matchesAny(pats, 'https://z.net/playlist.m3u8'));
});

test('util: formatters', () => {
  assert.equal(util.formatBytes(1536), '1.5 KB');
  assert.equal(util.formatBytes(3_200_000_000), '3.0 GB');
  assert.equal(util.qualityLabel(1920), '1080p');
  assert.equal(util.qualityLabel(2160), '4K');
  assert.equal(util.formatDuration(7384), '2:03:04');
});
