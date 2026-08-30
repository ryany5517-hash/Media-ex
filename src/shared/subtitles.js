/**
 * Stream Radar — subtitle engine (pure logic, no DOM)
 * ------------------------------------------------------------------
 * Providers (all optional, all fail-soft):
 *   1. SubDL          api.subdl.com          (needs a free API key)
 *   2. OpenSubtitles  api.opensubtitles.com  (needs a free API key)
 *   3. YIFY Subtitles best-effort (public endpoint, frequently offline)
 *
 * `opts.fetchImpl` lets unit tests inject a fake fetch. SRT→VTT conversion,
 * .gz and .zip unpacking are implemented in this file, so the extension ships
 * zero runtime dependencies for subtitles.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util || (SR.util = {});

  const ID_LANGS = new Set(['id', 'ind', 'indonesia', 'indonesian', 'bahasa indonesia', 'bahasa-indonesia']);
  const ID_RE = /(?:^|[\s._\-[(])(id|ind|indonesia|indonesian|bahasa[-_ ]?indonesia|sub[-_ ]?indo|subid)(?:$|[\s._\-)\]])/i;

  // Self-registering: never assume another module ran, and never clobber a
  // namespace a previous load (or another provider script) already built.
  const subs = (SR.subs = SR.subs || {});
  subs.providers = Array.isArray(subs.providers) ? subs.providers : [];

  /* ---------------------------------------------------------------- *
   * Decoding / unpacking
   * ---------------------------------------------------------------- */

  /** UTF-8 with latin-1 fallback (subtitle files are often cp1252). */
  subs.decodeSmart = function (buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
    let start = 0;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
    } catch (_) {
      for (const enc of ['windows-1252', 'windows-1250', 'latin1']) {
        try {
          const text = new TextDecoder(enc).decode(bytes.subarray(start));
          if (!/[ÃÂð][-¿]/.test(text)) return text;
        } catch (_) {}
      }
      return new TextDecoder('utf-8').decode(bytes.subarray(start));
    }
  };

  /** gunzip / raw-deflate using the platform DecompressionStream. */
  async function inflate(bytes, format) {
    if (!root.DecompressionStream) return bytes; // graceful: return raw
    try {
      const ds = new DecompressionStream(format);
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) {
      return null;
    }
  }
  subs.inflate = inflate;

  /** Minimal ZIP reader: returns every .srt/.vtt/.txt entry as text. */
  subs.readZip = async function (bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const out = [];
    if (u.length < 22) return out;

    // Locate End Of Central Directory (signature 0x06054b50) scanning backwards.
    let eocd = -1;
    const scanFrom = Math.max(0, u.length - 66000);
    for (let i = u.length - 22; i >= scanFrom; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return out;

    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);

    for (let n = 0; n < count && off + 46 <= u.length; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const uncompSize = dv.getUint32(off + 24, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = new TextDecoder().decode(u.subarray(off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;

      if (!/\.(srt|vtt|txt|sub)$/i.test(name)) continue;
      // Local file header: skip its own name/extra fields.
      if (localOff + 30 > u.length) continue;
      if (dv.getUint32(localOff, true) !== 0x04034b50) continue;
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      // Sizes in the central directory can be 0 for streamed zips → trust local header.
      const size = compSize || dv.getUint32(localOff + 18, true);
      const raw = u.subarray(dataStart, dataStart + size);
      let text = '';
      if (method === 0) text = subs.decodeSmart(raw);
      else if (method === 8) {
        const inflated = await inflate(raw, 'deflate-raw');
        if (inflated) text = subs.decodeSmart(inflated);
      }
      if (text && text.length > 20) out.push({ name, text });
      if (out.length >= 4) break;
    }
    return out;
  };

  /** Fetch an arbitrary subtitle URL (zip / gz / srt / vtt) → text. */
  subs.loadSubtitleFile = async function (url, opts) {
    const o = opts || {};
    const fetchImpl = o.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
    const headers = Object.assign({}, o.headers);
    const res = await fetchImpl(url, { headers, redirect: 'follow', credentials: o.credentials || 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' on subtitle file');
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const ctype = (res.headers && res.headers.get('content-type')) || '';
    const name = (res.headers && res.headers.get('content-disposition')) || url;

    if (/zip/i.test(ctype) || /\.zip(\?|$)/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      const entries = await subs.readZip(bytes);
      if (!entries.length) throw new Error('empty zip');
      entries.sort((a, b) => prefer(a.name, o.want) - prefer(b.name, o.want));
      return entries[0].text;
    }
    if (/gzip/i.test(ctype) || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      const inflated = await inflate(bytes, 'gzip');
      return subs.decodeSmart(inflated || bytes);
    }
    return subs.decodeSmart(bytes);

    function prefer(n, want) {
      const w = String(want || '').toLowerCase();
      let score = 0;
      if (w && n.toLowerCase().includes(w)) score -= 10;
      if (/id|ind|indonesia/i.test(n)) score -= 6;
      if (/\.srt$/i.test(n)) score -= 3;
      return score;
    }
  };

  /* ---------------------------------------------------------------- *
   * SRT → VTT
   * ---------------------------------------------------------------- */
  subs.srtToVtt = function (srt) {
    let src = String(srt || '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').trim();
    if (!src) return 'WEBVTT\n\n';
    if (/^WEBVTT/i.test(src)) return ensureCueIds(src);

    const lines = src.split('\n');
    const out = ['WEBVTT', '', ''];
    let inCue = false;
    let sawAnyTime = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const t = line.replace(/\s+$/, '');
      const time = t.match(/^\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*(?:-->|--?>>)\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}.*$/);
      if (time) {
        sawAnyTime = true;
        inCue = true;
        out.push(normaliseTiming(t));
        continue;
      }
      if (inCue && /^\s*$/.test(t)) {
        inCue = false;
        out.push('');
        continue;
      }
      if (!inCue && /^\d+$/.test(t.trim())) continue; // SRT numeric cue index
      if (inCue && /<\/?(?:i|b|u|font|c|ruby|rt)>/i.test(t)) {
        out.push(t.replace(/<font[^>]*>/gi, '<c>').replace(/<\/font>/gi, '</c>'));
        continue;
      }
      out.push(t.replace(/\\N/gi, '\n').replace(/\\h/gi, ' '));
    }
    if (!sawAnyTime) return 'WEBVTT\n\n<!-- not a parseable subtitle file -->\n';
    return ensureCueIds(out.join('\n').replace(/\n{3,}/g, '\n\n'));
  };

  function normaliseTiming(line) {
    return line
      .replace(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/g, (m, h, mi, s, ms) => pad(h, 2) + ':' + mi + ':' + s + '.' + pad(ms, 3))
      .replace(/(\d{2}):(\d{2})[.,](\d{1,3})\s*(-->|--?>>)\s*/g, '00:$1:$2.$3 --> ')
      .replace(/--?>>/g, '-->')
      .replace(/\s*-->\s*/, ' --> ')
      .replace(/[^\x20-\x7e\n]/g, (c) => c);
  }

  function pad(n, len) {
    return String(n).padStart(len, '0');
  }

  function ensureCueIds(text) {
    const body = text.replace(/^WEBVTT[^\n]*\n/, 'WEBVTT - Stream Radar\n');
    return body.replace(/\n{3,}/g, '\n\n');
  }

  /** Very small heuristic validation: how many cues does this file have? */
  subs.countCues = function (text) {
    return String(text || '').split('\n').filter((l) => /\d{1,2}:\d{2}:\d{2}([.,]\d{1,3})?\s*-->/.test(l)).length;
  };

  subs.looksLikeSubtitle = function (text) {
    const t = String(text || '');
    return /^WEBVTT/i.test(t.trim()) || /^\s*\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/.test(t) || /-->/.test(t);
  };

  /* ---------------------------------------------------------------- *
   * Matching helpers
   * ---------------------------------------------------------------- */
  subs.norm = function (s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  subs.isIndonesian = function (item) {
    const lang = String(item.langCode || item.lang || item.language || '').toLowerCase();
    if (lang && ID_LANGS.has(lang)) return true;
    const name = String(item.langName || item.languageName || '').toLowerCase();
    if (name && /indonesia/.test(name)) return true;
    if (!lang && !name) return ID_RE.test(String(item.filename || '') + ' ' + String(item.name || ''));
    return false;
  };

  subs.score = function (item, want) {
    const w = want || {};
    let s = 0;
    const name = subs.norm(item.name || item.filename || '');
    const title = subs.norm(w.title);
    if (title) {
      if (name === title) s += 60;
      else if (name.includes(title)) s += 40;
      else {
        const tokens = title.split(' ').filter((t) => t.length > 2);
        const hit = tokens.filter((t) => name.includes(t)).length;
        s += tokens.length ? Math.round((hit / tokens.length) * 30) : 0;
      }
    }
    if (w.year && String(item.year || '').includes(w.year)) s += 18;
    else if (w.year && item.year && String(item.year) !== String(w.year)) s -= 12;

    const ep = w.episode ? String(w.episode).replace(/^0+(?=\d)/, '') : '';
    const season = w.season ? String(w.season).replace(/^0+(?=\d)/, '') : '';
    const itemEp = item.episode ? String(item.episode).replace(/^0+(?=\d)/, '') : '';
    const itemSeason = item.season ? String(item.season).replace(/^0+(?=\d)/, '') : '';
    if (ep) {
      if (itemEp === ep && (!season || itemSeason === season)) s += 55;
      else if (itemEp === ep) s += 25;
      else if (itemEp) s -= 35; // clearly another episode
    } else if (itemEp) s -= 8; // series subs when we wanted a movie

    if (/srt/i.test(String(item.format || ''))) s += 8;
    if (item.verified) s += 6;
    if (item.downloads) s += Math.min(15, Math.log10(item.downloads + 1) * 6);
    if (item.aiTranslated) s -= 12;
    if (subs.isIndonesian(item)) s += 25;
    return s;
  };

  subs.filterIndonesian = function (list, strict) {
    const kept = list.filter((x) => subs.isIndonesian(x));
    return kept.length || strict ? kept : list;
  };

  /* ---------------------------------------------------------------- *
   * Providers
   * ---------------------------------------------------------------- */

  /** sub.wyzie.io - free/libre subtitle API, searches by IMDb/TMDB id.
   * Needs a per-user key (store.wyzie.io/redeem). The key is read from the
   * user's settings only; it is never committed because Wyzie forbids keys in
   * browser extensions/public repos. Returns an array of subtitle objects
   * whose `url` is a direct SRT/ASS download. */
  subs.wyzie = {
    id: 'wyzie',
    label: 'Wyzie Subs',
    needsKey: true,
    base: 'https://sub.wyzie.io',
    async search(want, settings, ctx) {
      const key = settings.wyzieApiKey;
      if (!key) return { ok: false, skipped: true, reason: 'API key belum diisi' };
      const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      let id = want.imdbId || want.tmdbId || '';
      let resolvedTitle = want.title || '';
      let resolvedYear = want.year || '';
      if (!id && want.title) {
        const hit = await this.resolveTmdbByTitle(want, key, fetchImpl);
        if (!hit) return { ok: false, skipped: true, reason: 'butuh id IMDb/TMDB, pencarian judul ke TMDB tidak menemukan' };
        id = String(hit.id);
        resolvedTitle = resolvedTitle || hit.title;
        resolvedYear = resolvedYear || hit.year;
      }
      if (!id) return { ok: false, skipped: true, reason: 'butuh id IMDb/TMDB' };
      const params = new URLSearchParams();
      params.set('id', String(id));
      if (want.season && want.episode) {
        params.set('season', String(want.season));
        params.set('episode', String(want.episode));
      }
      const lang = settings.subtitleLang && settings.subtitleLang !== 'all' ? settings.subtitleLang : 'id';
      params.set('language', lang);
      params.set('format', 'srt');
      params.set('encoding', 'utf-8');
      params.set('source', 'all');
      params.set('key', key);
      const res = await fetchImpl(this.base + '/search?' + params.toString(), { headers: { Accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) throw new Error('Wyzie key ditolak (HTTP ' + res.status + ')');
      if (!res.ok) throw new Error('Wyzie HTTP ' + res.status);
      const text = await res.text();
      const json = util.safeJSON ? util.safeJSON(text, null) : JSON.parse(text);
      const rows = Array.isArray(json) ? json : Array.isArray(json && json.subtitles) ? json.subtitles : [];
      const items = rows
        .map((r) => ({
          provider: 'wyzie',
          providerLabel: 'Wyzie Subs',
          id: String(r.id || r.url || ''),
          name: r.media || resolvedTitle || want.title || '',
          filename: r.fileName || ((r.media || resolvedTitle || '').replace(/[^\w\s-]+/g, '') + '.srt').trim(),
          langCode: String(r.language || 'id').slice(0, 2).toLowerCase(),
          langName: r.display || r.language || 'Indonesian',
          format: String(r.format || 'srt').toLowerCase(),
          year: want.year || resolvedYear || '',
          season: want.season ? String(want.season) : '',
          episode: want.episode ? String(want.episode) : '',
          downloads: Number(r.downloadCount || 0),
          verified: !r.ai,
          aiTranslated: !!r.ai,
          uploader: r.source || '',
          pageUrl: r.url || '',
          fileUrl: r.url || '',
          hearingImpaired: !!r.isHearingImpaired,
          release: r.release || r.matchedRelease || '',
          raw: r,
        }))
        .filter((x) => /^https?:/.test(x.fileUrl));
      return { ok: true, items, mediaId: id, mediaTitle: resolvedTitle, mediaYear: resolvedYear };
    },

    /** Fallback: resolve a clean page title to a TMDB id through Wyzie's TMDB helper. */
    async resolveTmdbByTitle(want, key, fetchImpl) {
      const q = String(want.title || '').trim();
      if (!q) return null;
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      const fetchJson = async (withKey) => {
        const params = new URLSearchParams({ q: q, language: 'en-US' });
        if (withKey) params.set('key', key);
        const res = await fetchImpl(this.base + '/api/tmdb/search?' + params.toString(), { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('Wyzie TMDB HTTP ' + res.status);
        const text = await res.text();
        return util.safeJSON ? util.safeJSON(text, null) : JSON.parse(text);
      };
      let json;
      try {
        json = await fetchJson(true);
      } catch (_) {
        try {
          json = await fetchJson(false);
        } catch (e) {
          throw new Error('Wyzie TMDB resolve gagal: ' + ((e && e.message) || e));
        }
      }
      const rows = Array.isArray(json) ? json : (json && Array.isArray(json.results) ? json.results : []);
      if (!rows.length) return null;
      const qn = norm(q);
      const scored = rows
        .map((r) => {
          const title = r.title || r.name || '';
          const tn = norm(title);
          const tokens = qn.split(' ').filter((t) => t.length > 1);
          const hit = tokens.filter((t) => tn.includes(t)).length;
          let score = tn === qn ? 60 : tn.includes(qn) ? 45 : tokens.length ? Math.round((hit / tokens.length) * 35) : 0;
          const year = String(r.release_date || r.first_air_date || '').slice(0, 4);
          if (want.year && year === String(want.year)) score += 25;
          if (!want.episode && r.media_type === 'movie') score += 8;
          if (want.episode && r.media_type === 'tv') score += 8;
          if (r.vote_average) score += Math.min(10, Number(r.vote_average));
          return { id: String(r.id || ''), title: title, year: year, mediaType: r.media_type || '', score: score };
        })
        .filter((r) => r.id && r.title)
        .sort((a, b) => b.score - a.score);
      return scored[0] || null;
    },
    async fetchFile(item, settings, ctx) {
      const f = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const key = settings.wyzieApiKey;
      let url = item.fileUrl;
      // Wyzie download URLs are direct; attach the key only if it was not embedded.
      if (key && url.indexOf('key=') < 0) {
        url += (url.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(key);
      }
      return await subs.loadSubtitleFile(url, { fetchImpl: f, want: 'id' });
    },
  };

  /** api.subdl.com — needs a free API key from https://subdl.com/panel/api */
  subs.subdl = {
    id: 'subdl',
    label: 'SubDL',
    needsKey: true,
    async search(want, settings, ctx) {
      const key = settings.subdlApiKey;
      if (!key) return { ok: false, skipped: true, reason: 'API key belum diisi' };
      const params = new URLSearchParams();
      params.set('api_key', key);
      params.set('query', want.title || '');
      if (want.year) params.set('year', String(want.year));
      if (want.imdbId) params.set('imdb_id', want.imdbId);
      if (want.tmdbId) params.set('tmdb_id', String(want.tmdbId));
      if (want.season) params.set('season_number', String(want.season));
      if (want.episode) params.set('episode_number', String(want.episode));
      params.set('formats', 'srt');
      if (settings.subtitleLang && settings.subtitleLang !== 'all') params.set('lang', settings.subtitleLang);
      params.set('pg', '1');
      const json = await getJson('https://api.subdl.com/api/v1/subtitles?' + params.toString(), {}, ctx);
      if (!json || !json.results) return { ok: false, reason: 'no results' };
      const items = json.results.map((r) => {
        const a = r.attributes || r;
        return {
          provider: 'subdl',
          providerLabel: 'SubDL',
          id: String(a.id || r.id || ''),
          name: a.name || a.movie || want.title,
          filename: a.filename || '',
          langCode: (a.lang && (a.lang.code || a.lang.locale)) || 'id',
          langName: (a.lang && a.lang.name) || 'Indonesian',
          format: (a.format || 'srt').toLowerCase(),
          year: a.year || '',
          season: a.seasonNumber || '',
          episode: a.episodeNumber || '',
          downloads: Number(a.downloadCount || a.downloads || 0),
          verified: !!a.verified,
          aiTranslated: !!a.ai,
          uploader: (a.uploader && (a.uploader.name || a.uploader.username)) || '',
          pageUrl: a.url || '',
          raw: a,
        };
      });
      return { ok: true, items };

      async function getJson(url, headers, c) {
        const fetchImpl = c.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
        const res = await fetchImpl(url, { headers: Object.assign({ Accept: 'application/json' }, headers) });
        if (!res.ok) throw new Error('SubDL HTTP ' + res.status);
        return await res.json();
      }
    },
    async fetchFile(item, settings, ctx) {
      const key = settings.subdlApiKey;
      const url = 'https://api.subdl.com/api/v1/subtitles/download?api_key=' + encodeURIComponent(key) + '&id=' + encodeURIComponent(item.id);
      const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('SubDL download HTTP ' + res.status);
      const json = await res.json();
      const link = json && json.results && json.results.attributes && json.results.attributes.link;
      if (!link) throw new Error('SubDL: no download link');
      return await subs.loadSubtitleFile(link, { fetchImpl, want: 'id' });
    },
  };

  /** api.opensubtitles.com — free "API key" (origin-bound) from the dev portal. */
  subs.opensubtitles = {
    id: 'opensubtitles',
    label: 'OpenSubtitles',
    needsKey: true,
    headers(settings) {
      const h = { Accept: 'application/json', 'User-Agent': settings.osUserAgent || 'StreamRadar/1.0' };
      if (settings.osApiKey) h.Authorization = (settings.osApiKey.indexOf('ApiKey ') === 0 ? '' : 'ApiKey ') + settings.osApiKey;
      return h;
    },
    async search(want, settings, ctx) {
      if (!settings.osApiKey) return { ok: false, skipped: true, reason: 'API key belum diisi' };
      const q = want.episode
        ? (want.show || want.title) + ' ' + (want.season ? 'S' + String(want.season).padStart(2, '0') + 'E' + String(want.episode).padStart(2, '0') : 'E' + want.episode)
        : want.title;
      const params = new URLSearchParams();
      params.set('query', q);
      if (settings.subtitleLang && settings.subtitleLang !== 'all') params.set('language_id', settings.subtitleLang);
      if (want.year) params.set('year', String(want.year));
      if (want.imdbId) params.set('imdb_id', want.imdbId);
      if (want.tmdbId) params.set('tmdb_id', String(want.tmdbId));
      if (want.season) params.set('season_number', String(want.season));
      if (want.episode) params.set('episode_number', String(want.episode));
      params.set('format', 'srt');
      params.set('featured_only', 'false');
      params.set('aggregated', 'false');
      const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const res = await fetchImpl('https://api.opensubtitles.com/api/v1/subtitles?' + params.toString(), { headers: this.headers(settings) });
      if (res.status === 401 || res.status === 403) throw new Error('OpenSubtitles: API key ditolak (401/403)');
      if (!res.ok) throw new Error('OpenSubtitles HTTP ' + res.status);
      const json = await res.json();
      const items = (json.data || []).map((d) => {
        const a = d.attributes || {};
        const files = ((d.relationships || {}).files || {}).data || [];
        const first = files[0] || {};
        return {
          provider: 'opensubtitles',
          providerLabel: 'OpenSubtitles',
          id: String(a.feature_id || (first.attributes && first.attributes.file_id) || d.id || ''),
          fileIds: files.map((f) => (f.attributes && f.attributes.file_id) || f.id).filter(Boolean),
          name: (a.movie || a.movie_name || a.caption || '').toString().trim() || q,
          filename: (first.attributes && first.attributes.cdn_url ? String(first.attributes.cdn_url).split('/').pop() : '') || '',
          langCode: a.language || '',
          langName: a.language || '',
          format: 'srt',
          year: a.year || '',
          season: a.season_number || '',
          episode: a.episode_number || '',
          downloads: Number(a.download_count || 0),
          verified: /verified|trusted/i.test(String((a.features || []).join(' '))),
          aiTranslated: /machine translated|ai/i.test(String((a.features || []).join(' '))),
          uploader: a.uploader_name || '',
          pageUrl: '',
          raw: a,
        };
      });
      return { ok: true, items, total: (json.data || []).length, infos: json.infos };
    },
    async fetchFile(item, settings, ctx) {
      const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const ids = (item.fileIds && item.fileIds.length ? item.fileIds : [item.id]).map((id) => ({ file_id: Number(id) || id }));
      const res = await fetchImpl('https://api.opensubtitles.com/api/v1/download', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, this.headers(settings)),
        body: JSON.stringify({ files: ids }),
      });
      if (!res.ok) throw new Error('OpenSubtitles download HTTP ' + res.status);
      const json = await res.json();
      const link = json && json.link;
      if (!link) throw new Error('OpenSubtitles: no download link');
      return await subs.loadSubtitleFile(link, { fetchImpl, headers: { 'User-Agent': settings.osUserAgent || '' }, want: 'id' });
    },
  };

  /**
   * YIFY Subtitles — legacy public endpoints. Kept as the third fallback:
   * no key required, but the service is intermittently offline; every failure
   * is swallowed and reported in the UI as "not available".
   */
  subs.yify = {
    id: 'yify',
    label: 'YIFY (fallback)',
    needsKey: false,
    bases: ['https://yifysubtitles.org', 'https://www.yifysubtitles.ch', 'https://yifysubtitles.ag'],
    async search(want, settings, ctx) {
      const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const lastErr = [];
      for (const base of this.bases) {
        try {
          const q = want.imdbId || want.title;
          const fetchImpl = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      const res = await fetchImpl(base + '/chrome-api?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const text = await res.text();
          const json = util.safeJSON ? util.safeJSON(text, null) : JSON.parse(text);
          if (!Array.isArray(json) || !json.length) throw new Error('no data');
          const items = json
            .map((r) => ({
              provider: 'yify',
              providerLabel: 'YIFY',
              id: String(r.id || r.subtitle_link || ''),
              name: r.movie_title || want.title,
              filename: String(r.subtitle_link || '').split('/').pop() || 'subtitle.srt',
              langCode: String(r.lang || '').slice(0, 2).toLowerCase(),
              langName: r.language || r.lang || '',
              format: 'srt',
              year: '',
              season: '',
              episode: '',
              downloads: Number(r.downloads || 0),
              verified: false,
              uploader: '',
              pageUrl: base + (r.yifysubtitles_link || ''),
              fileUrl: /^https?:/.test(String(r.subtitle_link || '')) ? r.subtitle_link : base + r.subtitle_link,
              raw: r,
            }))
            .filter((x) => subs.isIndonesian(x) || !settings.autoSubtitle);
          return { ok: true, items };
        } catch (e) {
          lastErr.push(base + ': ' + e.message);
        }
      }
      return { ok: false, skipped: true, reason: lastErr[0] || 'unreachable' };
    },
    async fetchFile(item, settings, ctx) {
      const f = ctx.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
      return await subs.loadSubtitleFile(item.fileUrl, { fetchImpl: f, want: 'id' });
    },
  };

  // Register built-ins additively so a re-load neither wipes an externally
  // added provider nor pushes the same built-in twice. Wyzie first: it searches
  // by IMDb/TMDB id and gives the best Indonesian results.
  for (const p of [subs.wyzie, subs.subdl, subs.opensubtitles, subs.yify]) {
    if (p && !subs.providers.some(x => x && x.id === p.id)) subs.providers.push(p);
  }

  /* ---------------------------------------------------------------- *
   * Orchestration
   * ---------------------------------------------------------------- */

  /**
   * Search every enabled provider in parallel, merge, filter Indonesian,
   * rank by `subs.score`.
   * @returns {{results: object[], providerInfo: object, errors: string[]}}
   */
  subs.search = async function (want, settings, opts) {
    const o = opts || {};
    const ctx = { fetchImpl: o.fetchImpl };
    const enabled = subs.providers.filter((p) => ((settings.providers || {})[p.id] !== false));
    const providerInfo = {};
    for (const p of subs.providers) if (enabled.indexOf(p) < 0) providerInfo[p.id] = { label: p.label, status: 'disabled' };
    const errors = [];
    const all = [];

    const settled = await Promise.allSettled(
      enabled.map(async (p) => {
        providerInfo[p.id] = { label: p.label, status: 'searching' };
        try {
          const r = await p.search(want, settings, ctx);
          if (r && r.skipped) {
            providerInfo[p.id] = { label: p.label, status: 'skipped', reason: r.reason };
            return [];
          }
          providerInfo[p.id] = { label: p.label, status: 'ok', count: r.items.length };
          return r.items || [];
        } catch (e) {
          providerInfo[p.id] = { label: p.label, status: 'error', reason: String((e && e.message) || e) };
          errors.push(p.label + ': ' + ((e && e.message) || e));
          return [];
        }
      })
    );
    for (const s of settled) if (s.status === 'fulfilled') all.push(...s.value);

    const seen = new Set();
    const deduped = all.filter((it) => {
      const k = subs.norm(it.name) + '|' + it.langCode + '|' + (it.filename || '') + '|' + it.provider;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const scored = deduped
      .map((it) => Object.assign(it, { score: subs.score(it, want) }))
      .sort((a, b) => b.score - a.score);

    const filtered = subs.filterIndonesian(scored, (settings.subtitleLang || 'id') !== 'all');
    const list = (filtered.length ? filtered : scored).slice(0, o.limit || 25);
    list.forEach((it, i) => (it.rank = i + 1));
    return { results: list, providerInfo, errors };
  };

  /** Download + convert the given result to WebVTT text. */
  subs.resolve = async function (item, settings, opts) {
    const o = opts || {};
    const provider = subs.providers.find((p) => p.id === item.provider);
    if (!provider) throw new Error('unknown provider ' + item.provider);
    const fetchImpl = o.fetchImpl || (util.fetchImpl ? util.fetchImpl.bind(util) : root.fetch);
    let text;
    if (item.fileUrl) text = await subs.loadSubtitleFile(item.fileUrl, { fetchImpl, want: 'id' });
    else text = await provider.fetchFile(item, settings, { fetchImpl });
    if (!subs.looksLikeSubtitle(text)) throw new Error('file is not a subtitle track');
    return subs.srtToVtt(text);
  };

  subs.buildVttFromScratch = subs.srtToVtt; // explicit alias for readers
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
