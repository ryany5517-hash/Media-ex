/**
 * Stream Radar — smart title extraction & deep cleansing
 * ------------------------------------------------------------------
 * Goal: turn SEO-spam page titles such as
 *   "Nonton The Last Sunrise (2024) Subtitle Indonesia | Layarkaca21"
 *   "Dune: Part Two (2024) 1080p WEBRip x265 - LookMovie"
 * into
 *   { title: "The Last Sunrise", year: "2024", episode: null }
 *
 * Priority order (see `SR.title.collect`):
 *   1. schema.org JSON-LD (Movie / TVEpisode / VideoObject)
 *   2. Open Graph meta
 *   3. Twitter Card meta
 *   4. first <h1>
 *   5. document.title
 * The first source that yields a confident, clean result wins; weaker sources
 * are kept as fallbacks and as a cross-check for the search query.
 *
 * `clean()` is pure (no DOM) so it is unit-testable in Node.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});

  /* ---- vocabulary -------------------------------------------------- */

  /** Multi-word junk phrases — removed before single tokens. */
  const PHRASES = [
    'nonton film', 'nonton movie', 'nonton gratis', 'nonton online', 'nonton bioskop', 'nobar film',
    'tonton filem', 'watch movie', 'watch films', 'watch full', 'watch online', 'full movie',
    'full movie gratis', 'full film', 'movies online', 'film gratis', 'film penuh', 'film action',
    'subtitle indonesia', 'subtitle indonesian', 'subtitle inggris', 'subtitle english', 'subtitle msia',
    'sub indonesia', 'sub indo', 'sub inggris', 'subtitle', 'sub indo', 'sub id', 'sub forced',
    'dual subtitle', 'dual audio', 'multi subtitle', 'takarasi', 'terjemahan', 'translate Indonesia',
    'kualitas tinggi', 'high quality', 'quality hd', 'quality cam', 'best quality', 'skip intro',
    'server 1', 'server 2', 'server backup', 'primary server', 'alternate server', 'main server',
    'release year', 'tahun rilis', 'tanggal rilis', 'durasi film', 'rating imdb', 'genre film',
    'pemain film', 'sutradara', 'directed by', 'starring', 'original title', 'also known as',
    'cinema eb1', 'cinema eb1', 'bioskop online', 'bioskop kekinian', 'jadwal bioskop', 'jam tayang',
    'recently updated', 'trending', 'trending movies', 'popular movies', 'terbaru', 'terpopuler',
    'free download', 'download movie', 'unduh film', 'download link', 'link download', 'gdrive',
    'watch now', 'now streaming', 'streaming online', 'streaming gratis', 'live streaming',
    'episod', 'episode', 'season', 'musim', 'series', 'mini series', 'tv series', 'drama Korea',
    'movie streaming', 'film streaming', 'layar lebar', 'layar kaca', 'nonton di', 'tonton online',
    'please try another server', 'finding the best source', 'best sync', 'ads free', 'alternative',
    'watch movies', 'watch movie', 'watch films online', 'tv shows', 'movies & tv shows', 'movies and tv shows',
    'hd online', 'in hd online', 'in hd', 'online hd', 'nonton film gratis', 'kualitas', 'kualitas film',
    '3d', '4k', '8k', 'uhd', 'dolby vision', 'dolby atmos', 'imax enhanced', 'remux',
  ];

  /** Single junk tokens. Deliberately excludes real title words. */
  const TOKENS = [
    'nonton', 'nonton21', 'nobar', 'streaming', 'streamhd', 'stream', 'gratis', 'kuy', 'rebase',
    'lk21', 'lk21indo', 'layarkaca21', 'layarkaca21online', 'layarkaca', 'ksater21', 'indoxxi',
    'idebeg', 'idlix', 'idxlink', 'indostream', 'indofilm', 'indomoviex', 'indoplkay', 'sinemaku',
    'sinema21', 'bioskopkeren', 'bioskopkerening', 'rebahin', 'samegame', 'kinoxx', 'kinohit',
    'drakula', 'drakor', 'kubikama', 'dutasinema', 'cinemaindo', 'minisub', 'desamovie', 'ngelag',
    'mexirivip', 'mexogo', 'opeha', 'wintrik', 'wintrick', 'movies7', 'fmovies', '123movies',
    '123miweb', 'lookmovie', 'gomun', 'xemphim', 'otakudesu', 'anisya', 'samehadaku', 'oploverz',
    'kuronime', 'megabox', 'megadonwload', 'm4ufree', 'flicky', 'cinovela', 'yts', 'yifysubtitles',
    'imdb', 'rottentomatoes', 'rottentomatoes', 'tomatoes', 'trakt', 'letterboxd', 'tmdb',
    'download', 'unduh', 'downlod', 'torrent', 'magnet', 'hdtv', 'webrip', 'web-dl', 'webdl',
    'bluray', 'blu-ray', 'bdrip', 'dvdrip', 'dvdscr', 'brrip', 'hdcam', 'hdrip', 'camrip',
    'tsrip', 'telesync', 'telesync', 'screener', 'dvdcam', 'vhsrip', 'hdts', 'ts', 'tc', 'cam',
    'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'aac', 'ac3', 'eac3', 'dts', 'dd5', 'ddp5',
    '10bit', '8bit', '10-bit', '12bit', 'hdr', 'hdr10', 'hdr10+', 'sdr', 'ntsc', 'pal',
    'dual', 'audio', 'eng', 'engsub', 'sub', 'subed', 'subs', 'subtitle', 'terjemahan',
    'episode', 'season', 'episod', 'part', 'bagian', 'chapter', 'full', 'movie', 'movies',
    'film', 'films', 'serial', 'series', 'tv', 'online', 'watch', 'free', 'new', 'latest',
    'unlimited', 'adfree', 'ads', 'ad', 'skip', 'intro', 'server', 'backup', 'vip', 'premium',
    'sigrip', 'usdx', 'ptclay', 'sctv', 'indosiar', 'trans7', 'transfilm', 'globaltv', 'rvii',
    'vidio', 'wevi', 'wetv', 'iqlimax', 'wetv', 'youku', 'bilibili', 'viki', 'viu', 'iflix',
    'netflix', 'disney', 'hotstar', 'hbo', 'amazon', 'prime', 'appletv', 'crunchyroll',
    'hd', 'uhd', 'fhd', 'qhd', 'sd', 'hq', 'lq', 'xxx', 'x-x', 'mp4', 'mkv', 'avi', 'flv',
    'gdrive', 'googledrive', 'drive', 'link', 'mirror', 'host', 'upload', 'mixdrop', 'upstream',
    'shows', 'show', 'katalog', 'katalogfilm', 'semua', 'filmfilm', 'lk21online', 'lk21movies', 'xemtrim',
    'phimle', 'phimbo', 'vigetool', 'hot', 'newest', 'trailer', 'official', 'teaser', 'remaster', 'uncut',
    'dood', 'streamtape', 'filemoon', 'autoembed', 'vidlink', 'vidsrc', 'vidplay', 'vidstream',
  ];

  const TLD_RE =
    /\.(com|net|org|online|site|xyz|cyou|icu|top|vip|fun|shop|store|buzz|live|tv|movie|film|watch|cloud|rest|wiki|link|life|world|pro|app|dev|io|co|me|id|my|sg|ph|in|uk|us|ca|au|nz|de|fr|es|it|nl|ru|br|mx|za|jp|kr|cn|hk|tw|th|vn|cc|ws|to|gg|ac|page|link|click|bid|date|download|stream|date|play|plus|one|space|website|tech|info|biz|club|zone|run|fyi|media|digital|network|site)$/i;

  /** Page titles that mean "the SPA has not rendered yet" / block pages. */
  const JUNK_EXACT = [
    'just a moment', 'attention required', 'checking your browser', 'please wait', 'loading', 'redirecting',
    'access denied', 'error', '404', '403', '500', 'not found', 'enable javascript', 'security verification',
    'polaris', 'cloudflare', 'verify you are human', 'one more step', 'unusual traffic',
  ];

  /** Words that are never a standalone movie title — used to flag junk. */
  const GENERIC_WORDS = new Set([
    'online', 'hd', '4k', 'full', 'movie', 'movies', 'film', 'films', 'watch', 'nonton', 'stream',
    'streaming', 'player', 'video', 'show', 'shows', 'tv', 'free', 'gratis', 'new', 'latest', 'home',
    'search', 'catalog', 'katalog', 'episode', 'season', 'series', 'download', 'subtitle', 'sub',
    'indo', 'indonesia', 'trailer', 'official', 'page', 'error', 'untitled', 'loading', 'player',
    'server', 'source', 'media', 'embed', 'live', 'now', 'today', 'popular', 'trending', 'semua',
    'in', 'the', 'a', 'an', 'of', 'and', 'to', 'for', 'on', 'at', 'with', 'part', 'ep', 'eps',
  ]);

  const YEAR_RE = /(?:\(|\[|\s)((?:19|20)\d{2})(?:\)|\]|\s|$)/;
  const EP_RE = /\b(?:s|season[\s._-]*|musim[\s._-]*)(\d{1,2})[\s._-]*(?:e|episod[ei]?\d*[\s._-]*|ep[\s._-]*|)(\d{1,3})\b/i;
  const EP_ALT_RE = /\b(\d{1,2})\s?[xX]\s?(\d{1,2})\b/;
  const EP_LOOSE_RE = /\b(?:episode|episod|ep|chapter|part|bagian)\.?\s*(?:no\.?\s*)?(\d{1,3})\b/i;

  /** Remove dangling separators / articles left behind by token stripping. */
  function fixTail(text) {
    let out = normalize(text);
    for (let i = 0; i < 4; i++) {
      const before = out;
      out = out
        .replace(/\s*[:\-–—|·]\s*$/, '')
        .replace(/\s+\b(the|a|an|of|and|to|in|on|for|with|part|no|n[o°])\s*$/i, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .trim();
      if (out === before) break;
    }
    return out;
  }

  /* ---- cleansing pipeline ------------------------------------------ */

  function normalize(input) {
    let raw = String(input == null ? '' : input);
    // Scene release names use dots as separators: "Inception.2010.720p.BluRay.x264-YTS"
    if (/\.(?:20\d{2}|19\d{2})\.|\.(?:720|1080|2160|480)\s?p?\.|\.(?:BluRay|WEBRip|WEB-DL|x26[45]|HEVC|AAC|DVDRip|HDRip)[.\-]/i.test(raw)) {
      raw = raw.replace(/[-_.]+/g, ' ');
    }
    return raw
      .replace(/\u00a0|\u2007|\u202f/g, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;|&#0?34;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&nbsp;/gi, ' ')
      .replace(/[\u2192\u21d2\u00bb\u203a]/g, '>')
      .replace(/[\u2013\u2014\u2015\u2500\u2502\u2551]/g, '-')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Remove leading bullets / emoji / zero-width chars. */
  function trimLead(seg) {
    return String(seg)
      .replace(/^[\s\-–—•·*•‣»|/\\>]+/, '')
      .replace(/[\s\-–—•·‣|/\\>]+$/, '')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .trim();
  }

  function splitSegments(raw) {
    const norm = normalize(raw);
    // Split on separators, but keep " - " only when it is surrounded by spaces
    // (so that "Dredd - Judge" style titles survive better) and keep ":" when
    // it looks like a subtitle separator ("Alien: Romulus").
    const parts = norm.split(/\s*[|»•·]|\s+\/\s+|\s+~\s+|\s+-\s+/);
    const out = [];
    for (let p of parts) {
      p = trimLead(p);
      if (p) out.push(p);
    }
    if (!out.length && norm) out.push(norm);
    return out;
  }

  function extras() {
    const d = (SR.dynamic || {}) && SR.dynamic;
    return d ? { phrases: d.junkPhrases || [], tokens: d.junkTokens || [] } : { phrases: [], tokens: [] };
  }

  function stripPhrases(text) {
    const ex = extras();
    let out = ' ' + normalize(text) + ' ';
    for (const p of PHRASES.concat(ex.phrases)) {
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      out = out.replace(new RegExp('\\b' + esc + '\\b', 'gi'), ' ');
    }
    // patterns
    out = out
      .replace(/\b\d{3,4}\s?[pP](?![0-9a-zA-Z])/g, ' ')
      .replace(/\b\d{3,4}\s?[xX*]\s?\d{3,4}\b/g, ' ')
      .replace(/\[[^\]\n]{1,40}\]/g, ' ')
      .replace(/\((?:HD|CAM|TS|TC|DVDSCR|WEBRIP|WEB-DL|BLURAY|REPACK|PROPER|LIMITED|EXTENDED|UNRATED)\)/gi, ' ')
      .replace(/\b\d{1,3}\s?(?:MB|GB)\b/gi, ' ')
      .replace(/\b\d{1,3}\s?fps\b/gi, ' ')
      .replace(/(?:^|\s)(?:\d{1,3}%|IMDb|IMDB|Rating|Rotten)\b[:\s]?\d?[\d.]*\s?(?:\/\s?10)?/gi, ' ')
      .replace(/\b\d+(?:\.\d+)?\s?(?:fps|kbps|mbps|mbit)\b/gi, ' ')
      .replace(/[«»‹›]/g, ' ');
    return out.replace(/\s+/g, ' ').trim();
  }

  function stripTokens(text) {
    const words = normalize(text).split(' ');
    const keep = [];
    const set = new Set(TOKENS.concat(extras().tokens).map((t) => String(t).toLowerCase()));
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const bare = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      const low = bare.toLowerCase();
      if (!bare) continue;
      if (set.has(low)) {
        // keep a lone "part" when it forms "Part Two" (real sequel marker)
        if (low === 'part' && /^(one|two|three|four|v|vi|[0-9]+)$/i.test(words[i + 1] || '')) {
          keep.push(w, words[++i]);
        }
        continue;
      }
      if (TLD_RE.test(low) && low.split('.').length <= 3) continue; // bare domain token
      if (/^(19|20)\d{2}$/.test(bare)) continue;
      keep.push(w);
    }
    return keep.join(' ').replace(/\s+/g, ' ').trim();
  }

  function scoreSegment(seg) {
    const s = seg.trim();
    if (!s) return -1e9;
    let score = 0;
    const letters = (s.match(/\p{L}/gu) || []).length;
    const words = s.split(/\s+/).filter(Boolean);
    score += Math.min(40, letters); // length reward, capped
    score += Math.min(12, words.length * 3); // multi-word reward
    if (letters / Math.max(1, s.length) < 0.55) score -= 25; // too many symbols
    if (/\.(com|net|org|online|xyz|site|cyou|top|tv|watch|live|fun|vip|icu|cloud|movie|film)\b/i.test(s)) score -= 40;
    if (/(nonton|sub indo|subtitle|streaming|download|hd\b|4k\b|1080p|720p)/i.test(s)) score -= 18;
    if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) score -= 45; // pure domain segment
    if (/^[^a-z]*$/i.test(s)) score -= 30; // no letters at all
    if (s.length > 90) score -= 10;
    if (/^(watch|nonton|stream|download|film|movie)\b/i.test(s)) score -= 6;
    if (/\b(19|20)\d{2}\b/.test(s)) score += 4; // year present => usually the real title
    return score;
  }

  function extractMeta(text) {
    const src = normalize(text);
    const info = { year: null, season: null, episode: null };
    const y = src.match(YEAR_RE);
    if (y) info.year = y[1];
    let m = src.match(EP_RE);
    if (m) {
      info.season = String(parseInt(m[1], 10)).padStart(2, '0');
      info.episode = String(parseInt(m[2], 10)).padStart(2, '0');
    } else if ((m = src.match(EP_ALT_RE))) {
      info.season = String(parseInt(m[1], 10)).padStart(2, '0');
      info.episode = String(parseInt(m[2], 10)).padStart(2, '0');
    } else if ((m = src.match(EP_LOOSE_RE))) {
      info.episode = String(parseInt(m[1], 10)).padStart(2, '0');
    }
    return info;
  }

  function stripMeta(text, info) {
    let out = ' ' + normalize(text) + ' ';
    if (info.year) out = out.replace(new RegExp('[(\\[\\s]' + info.year + '[\\])]'), ' ');
    out = out
      .replace(new RegExp('\\bs\\d{1,2}\\s?[eE]\\d{1,3}\\b', 'gi'), ' ')
      .replace(new RegExp('\\b\\d{1,2}\\s?[xX]\\s?\\d{1,2}\\b', 'g'), ' ')
      .replace(/\b(season|musim)\.?\s*\d{1,2}\b/gi, ' ')
      .replace(/\b(episode|episod|ep)\.?\s*\d{1,3}\b/gi, ' ');
    return out.replace(/\s+/g, ' ').trim();
  }

  function looksLikeSiteName(seg) {
    const s = seg.trim();
    if (/^(www\.)?[a-z0-9][a-z0-9-]*([.][a-z0-9-]+)+$/i.test(s)) return true;
    return TLD_RE.test(s.replace(/\s+/g, '')) && s.split(/\s+/).length === 1;
  }

  /**
   * Main entry.
   * @param {string} raw any candidate string (document.title, og:title, h1 …)
   * @param {{extra?:string}} [opts] extra context (canonical slug, meta desc)
   */
  function clean(raw, opts) {
    const o = opts || {};
    const original = normalize(raw);
    const meta = extractMeta(original || o.extra || '');
    const out = {
      raw: original,
      title: '',
      year: meta.year,
      season: meta.season,
      episode: meta.episode,
      kind: 'unknown',
      quality: '',
      isJunk: true,
      confidence: 0,
      source: o.source || 'title',
    };
    if (!original) return out;

    if (JUNK_EXACT.some((j) => original.toLowerCase().startsWith(j))) {
      out.title = '';
      return out;
    }

    out.quality = (original.match(/\b(2160p|1080p|720p|480p|4k|uhd|hd)\b/i) || [])[1] || '';

    const segs = splitSegments(original).filter((s) => !looksLikeSiteName(s));
    const pool = (segs.length ? segs : [original]).slice();
    // merge obvious continuations ("Dune" + ":" style splits are already safe)
    pool.sort((a, b) => scoreSegment(b) - scoreSegment(a));

    let best = '';
    let bestScore = -1e9;
    for (const seg of pool) {
      const withoutMeta = stripMeta(seg, meta);
      const noPhrases = stripPhrases(withoutMeta);
      const noTokens = stripTokens(noPhrases);
      let candidate = trimLead(noTokens).replace(/\s*[:\-|]\s*$/, '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
      candidate = candidate.replace(/\s{2,}/g, ' ');
      const sc = scoreSegment(candidate) + (candidate === seg ? 6 : 0);
      if (candidate && sc > bestScore) {
        bestScore = sc;
        best = candidate;
      }
    }

    if (!best) {
      // Second pass without token stripping (aggressive pass ate everything).
      for (const seg of pool) {
        const c = fixTail(stripPhrases(stripMeta(seg, meta)));
        if (c && c.length > best.length) best = c;
      }
    }
    if (!best) {
      // Last resort: slug from URL / canonical
      const slug = (o.extra || '').match(/\/([a-z0-9][a-z0-9-]{3,60})\/?(?:\?|$)/i);
      if (slug) best = slug[1].replace(/[-_]+/g, ' ').replace(/\b\d{6,}\b/g, '').trim();
    }
    if (!best) {
      best = fixTail(normalize(original).replace(/\s*[|»•·].*$/, ''));
    }
    if (!best) {
      out.title = '';
      return out;
    }

    // Title-case fix-up for ALL-CAPS / all-lower SEO titles
    const isFlat = best === best.toUpperCase() || best === best.toLowerCase();
    if (isFlat && best.length < 80) {
      best = best
        .toLowerCase()
        .replace(/\b(\p{L})/gu, (m, c) => c.toUpperCase())
        .replace(/\b(Of|The|And|A|An|In|On|To|For|vs|Vs)\b/gi, (m, c, i) => (i === 0 ? c : c))
        .replace(/\s+/g, ' ');
    }

    out.title = fixTail(
      best
        .replace(/\s*\(\s*(?:\d{4})\s*\)\s*/g, ' ')
        .replace(/["'`]+$/g, '')
        .replace(/^["'`]+/g, '')
        .trim()
    );
    const words = out.title.split(/\s+/).filter(Boolean);
    const allGeneric = words.length > 0 && words.every((w) => GENERIC_WORDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')));
    out.isJunk = out.title.length < 2 || !/\p{L}/u.test(out.title) || allGeneric || /\b(watch|nonton)\b.*\b(movies|film)\b/i.test(out.title);
    if (out.isJunk) out.title = '';
    out.kind = /\b(episode|s\d{1,2}e\d{1,2}|\d{1,2}x\d{1,2})\b/i.test(original) || out.episode ? 'episode' : 'movie';
    out.confidence = out.isJunk ? 0 : util_clamp(bestScore);
    return out;
  }

  function util_clamp(n) {
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n + 45)));
  }

  /* ---- DOM-driven collection --------------------------------------- */

  function firstMeta(doc, selectors) {
    for (const sel of selectors) {
      try {
        const el = doc.querySelector(sel);
        const v = el && (el.getAttribute('content') || el.getAttribute('data-content') || el.textContent);
        if (v && v.trim()) return v.trim();
      } catch (_) {}
    }
    return '';
  }

  function walkJsonLd(node, sink, depth) {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const n of node) walkJsonLd(n, sink, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const types = [].concat(node['@type'] || []).map((t) => String(t).toLowerCase());
    const wanted = ['movie', 'tvepisode', 'tvseries', 'videoobject', 'clip', 'tvseason', 'episode'];
    if (types.some((t) => wanted.indexOf(t) >= 0)) {
      sink.push({
        types,
        name: node.name || node.headline || '',
        alternate: node.alternateName || '',
        episodeTitle: node.episodeTitle || '',
        datePublished: node.datePublished || '',
        year: node.datePublished ? String(node.datePublished).slice(0, 4) : '',
        season: node.seasonNumber != null ? String(node.seasonNumber) : '',
        episode: node.episodeNumber != null ? String(node.episodeNumber) : '',
        partOf: (node.partOfTVSeries && (node.partOfTVSeries.name || node.partOfTVSeries.headline)) || (node.partOfSeries && node.partOfSeries.name) || '',
        sameAs: [].concat(node.sameAs || []).join(' '),
        identifier: JSON.stringify(node.identifier || ''),
        image: typeof node.image === 'string' ? node.image : (node.image && node.image.url) || '',
        thumbnail: (node.thumbnailUrl && (Array.isArray(node.thumbnailUrl) ? node.thumbnailUrl[0] : node.thumbnailUrl)) || '',
        contentUrl: node.contentUrl || '',
        embedUrl: node.embedUrl || '',
        duration: node.duration || '',
      });
    }
    for (const k of Object.keys(node)) {
      if (k === '@graph' || k === 'mainEntity' || k === 'itemListElement' || k === 'item' || k === 'about') walkJsonLd(node[k], sink, depth + 1);
    }
  }

  /**
   * Collect title candidates from a document (top frame).
   * @returns {{candidates: Array<{text:string, source:string}>, media: string[], poster: string, info: object}}
   */
  function collect(doc) {
    const res = { candidates: [], media: [], poster: '', info: {}, links: [] };
    if (!doc) return res;
    const push = (text, source) => {
      if (text && String(text).trim()) res.candidates.push({ text: String(text).trim(), source });
    };

    /* --- 1. JSON-LD ------------------------------------------------ */
    const ld = [];
    try {
      for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
        const parsed = SR.util.safeJSON(s.textContent.replace(/<!--|-->/g, ''), null);
        if (parsed) walkJsonLd(parsed, ld, 0);
      }
    } catch (_) {}
    if (ld.length) {
      const ep = ld.find((x) => x.types.includes('tvepisode') || x.types.includes('episode') || x.types.includes('clip'));
      const mv = ld.find((x) => x.types.includes('movie') || x.types.includes('videoobject') || x.types.includes('tvseries'));
      const pick = ep || mv || ld[0];
      const showName = pick.partOf || (ep && ep.name) || '';
      const display = ep && ep.episodeTitle && pick.name ? pick.name + ': ' + ep.episodeTitle : pick.name || pick.alternate || '';
      push(display, 'json-ld');
      if (showName && showName !== display) push(showName, 'json-ld-show');
      res.info = {
        year: pick.year || '',
        season: pick.season || '',
        episode: pick.episode || '',
        imdbId: ((pick.sameAs + ' ' + pick.identifier).match(/tt\d{6,10}/i) || [])[0] || '',
        tmdbId: ((pick.sameAs + ' ' + (pick.url || '')).match(/tmdb\.org\/(?:movie|tv)\/(\d+)/i) || [])[1] || '',
        poster: pick.image || pick.thumbnail || '',
        duration: pick.duration || '',
        kind: ep ? 'episode' : mv ? 'movie' : 'unknown',
        showName,
      };
    }

    /* --- 2. Open Graph -------------------------------------------- */
    const og = firstMeta(doc, ['meta[property="og:title"]', 'meta[name="og:title"]', 'meta[property="og:title:alt"]']);
    push(og, 'og:title');
    if (!res.info.poster) res.info.poster = firstMeta(doc, ['meta[property="og:image"]', 'meta[name="og:image"]', 'meta[property="og:image:secure_url"]']);
    if (!res.info.duration) res.info.duration = firstMeta(doc, ['meta[property="video:duration"]']);
    const kinds = firstMeta(doc, ['meta[property="og:type"]']);
    if (/\b(tv|episode|series|movie|video)/i.test(kinds)) res.info.kindHint = kinds;
    for (const sel of [
      'meta[property="og:video"]', 'meta[property="og:video:url"]', 'meta[property="og:video:secure_url"]',
      'meta[name="twitter:player:stream"]', 'meta[property="video:movie"]', 'meta[property="video:url"]',
    ]) {
      const v = firstMeta(doc, [sel]);
      if (v) res.media.push({ url: v, via: 'meta' });
    }
    for (const s of doc.querySelectorAll('meta[property^="og:video"], meta[name^="twitter:player"]')) {
      const v = s.getAttribute('content');
      if (v) res.media.push({ url: v, via: 'meta' });
    }

    /* --- 3. Twitter card ------------------------------------------ */
    push(firstMeta(doc, ['meta[name="twitter:title"]', 'meta[property="twitter:title"]']), 'twitter:title');

    /* --- 4. <h1> --------------------------------------------------- */
    let h1 = '';
    try {
      const heads = doc.querySelectorAll('h1');
      for (const el of heads) {
        const t = (el.textContent || '').trim();
        if (t && t.length > 1 && t.length < 160) {
          h1 = t;
          break;
        }
      }
      if (!h1) h1 = (doc.querySelector('h2[class*="title"], .title, [class*="movie-name"], [itemprop="name"]') || {}).textContent || '';
    } catch (_) {}
    push((h1 || '').trim(), 'h1');

    /* --- 5. document.title ---------------------------------------- */
    push(doc.title || '', 'document.title');

    /* --- extras: canonical slug + breadcrumbs + IMDb id ----------- */
    res.slug = firstMeta(doc, ['link[rel="canonical"]']).replace(/^https?:\/\//, '');
    const extraImdb =
      firstMeta(doc, [
        'meta[property="imdb:id"]',
        'meta[name="imdb:id"]',
        'meta[property="video:imdb"]',
        'meta[itemprop="sameAs"]',
      ]) || '';
    const fromExtra = extraImdb.match(/tt\d{6,10}/i);
    if (fromExtra && !res.info.imdbId) res.info.imdbId = fromExtra[0];
    try {
      const crumb = [...doc.querySelectorAll('a[rel="nofollow"], .breadcrumb a, [itemprop="itemListElement"]')].map((a) => a.textContent.trim()).filter(Boolean);
      if (crumb.length) res.crumbs = crumb.slice(0, 6).join(' > ');
      res.links = [...doc.querySelectorAll('a[href*="imdb.com/title/"], a[href*="themoviedb.org/"]')]
        .slice(0, 8)
        .map((a) => a.href);
    } catch (_) {}
    return res;
  }

  function namesMatch(a, b) {
    const qn = (s) =>
      String(s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const na = qn(a);
    const nb = qn(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0) return true;
    const tokens = na.split(' ').filter((t) => t.length > 2);
    if (!tokens.length) return false;
    const hit = tokens.filter((t) => nb.indexOf(t) >= 0).length;
    return hit / tokens.length >= 0.6;
  }

  function isNoiseId(n) {
    const s = String(n || '');
    if (!s) return true;
    if (/^(19|20)\d{2}$/.test(s)) return true;
    if (/^(360|480|720|1080|1440|2160)$/.test(s)) return true;
    return false;
  }

  function mergeCatalog(into, extra) {
    if (!extra) return into;
    if (extra.imdbId && !into.imdbId) into.imdbId = extra.imdbId;
    if (extra.tmdbId && !into.tmdbId) into.tmdbId = extra.tmdbId;
    if (extra.kind && (!into.kind || into.kind === 'movie')) into.kind = extra.kind;
    return into;
  }

  /**
   * Catalog ids hiding in any watch-site URL (not 67movies-only):
   *   /watch/movie/10389  /embed/tv/1396  ?tmdb=10389  …/tt0314196  slug-10389
   */
  function idsFromUrl(raw) {
    const s = String(raw || '');
    if (!s) return {};
    const out = {};
    const imdb = s.match(/\b(tt\d{6,10})\b/i);
    if (imdb) {
      out.imdbId = imdb[1];
      out.kind = 'movie';
    } else {
      const qImdb = s.match(/[?&#](?:imdb(?:_?id)?|imdbid)\s*=\s*(tt\d{6,10}|\d{6,10})\b/i);
      if (qImdb) {
        const v = qImdb[1];
        out.imdbId = /^tt/i.test(v) ? v : 'tt' + v;
        out.kind = 'movie';
      }
    }
    const tmdbOrg = s.match(/themoviedb\.org\/(movie|tv)\/(\d{2,8})/i);
    if (tmdbOrg && !isNoiseId(tmdbOrg[2])) {
      out.tmdbId = tmdbOrg[2];
      out.kind = tmdbOrg[1].toLowerCase() === 'tv' ? 'episode' : 'movie';
      return out;
    }
    const qTmdb = s.match(/[?&#](?:tmdb(?:_?id)?|tmdbid)\s*=\s*(\d{2,8})\b/i);
    if (qTmdb && !isNoiseId(qTmdb[1])) {
      out.tmdbId = qTmdb[1];
      out.kind = out.kind || 'movie';
    }
    const tvPath = s.match(/\/(?:embed\/|player\/|play\/|watch\/|stream\/|nonton\/)?(?:tv|series|shows?|episode)\/(?:tmdb\/)?(\d{2,8})(?:\/|$|\?|#|&)/i);
    if (tvPath && !isNoiseId(tvPath[1])) {
      out.tmdbId = out.tmdbId || tvPath[1];
      out.kind = 'episode';
      return out;
    }
    const moviePath = s.match(/\/(?:embed\/|player\/|play\/|watch\/|stream\/|nonton\/)?(?:movies?|films?|title)\/(?:tmdb\/)?(\d{2,8})(?:\/|$|\?|#|&)/i);
    if (moviePath && !isNoiseId(moviePath[1])) {
      out.tmdbId = out.tmdbId || moviePath[1];
      out.kind = out.kind || 'movie';
      return out;
    }
    const unlabeled = s.match(/\/(?:watch|play|nonton|films?)\/(\d{2,8})(?:\/|$|\?|#)/i);
    if (unlabeled && !isNoiseId(unlabeled[1]) && !out.tmdbId) {
      out.tmdbId = unlabeled[1];
      out.kind = out.kind || 'movie';
    }
    if (!out.tmdbId) {
      const slug = s.match(/\/(?:movies?|films?|watch|tv|embed|play)\/[a-z0-9._-]*?(?:-|_|\/)(\d{3,8})(?:\/|$|\?|#)/i);
      if (slug && !isNoiseId(slug[1])) {
        out.tmdbId = slug[1];
        out.kind = /\/(?:tv|series|shows?)\//i.test(s) ? 'episode' : out.kind || 'movie';
      }
    }
    return out;
  }

  function idsFromToken(raw) {
    const s = String(raw || '').trim();
    if (!s) return {};
    if (/^tt\d{6,10}$/i.test(s)) return { imdbId: s, kind: 'movie' };
    if (/^\d{2,8}$/.test(s) && !isNoiseId(s)) return { tmdbId: s, kind: 'movie' };
    return idsFromUrl(s);
  }

  /** Location, canonical, og:url, iframes, data-imdb / data-tmdb — any site. */
  function idsFromDoc(doc) {
    const acc = {};
    if (!doc) return acc;
    const blobs = [];
    const push = (v) => {
      if (!v) return;
      const s = String(v).trim();
      if (s && blobs.length < 40) blobs.push(s);
    };
    push((doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || (doc.location && doc.location.href) || doc.URL || '');
    push(firstMeta(doc, ['link[rel="canonical"]', 'meta[property="og:url"]', 'meta[name="og:url"]']));
    try {
      const nodes = doc.querySelectorAll(
        'iframe[src], iframe[data-src], embed[src], object[data], [data-imdb], [data-tmdb], [data-imdb-id], [data-tmdb-id], [data-media-id], a[href*="imdb.com"], a[href*="themoviedb.org"], a[href*="/embed/"], a[href*="/watch/"]'
      );
      for (const el of nodes) {
        if (blobs.length >= 38) break;
        push(el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data') || el.getAttribute('href') || '');
        push(el.getAttribute('data-imdb') || el.getAttribute('data-imdb-id') || '');
        push(el.getAttribute('data-tmdb') || el.getAttribute('data-tmdb-id') || el.getAttribute('data-media-id') || '');
      }
    } catch (_) {}
    for (let i = 0; i < blobs.length; i++) {
      mergeCatalog(acc, i === 0 ? idsFromUrl(blobs[i]) : idsFromToken(blobs[i]));
      if (acc.imdbId && acc.tmdbId) break;
    }
    return acc;
  }

  function parseTmdbHtml(html) {
    const src = String(html || '');
    let name = '';
    const og = src.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || src.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (og) name = og[1];
    if (!name) {
      const t = src.match(/<title>([^<]+)<\/title>/i);
      if (t) name = t[1];
    }
    name = String(name || '')
      .replace(/\s*[—–|-]\s*The Movie Database.*$/i, '')
      .replace(/\s*\|\s*TMDB.*$/i, '')
      .trim();
    const year = (name.match(/\(((?:19|20)\d{2})\)/) || [])[1] || '';
    name = name.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim();
    const imdb = (src.match(/imdb\.com\/title\/(tt\d{6,10})/i) || [])[1] || '';
    return { name: name, year: year, imdbId: imdb };
  }

  /**
   * Best-of-all-sources resolution.
   * @param {Document} doc
   */
  function resolve(doc) {
    const coll = collect(doc);
    let best = null;
    for (const c of coll.candidates) {
      const info = clean(c.text, { source: c.source, extra: coll.slug || '' });
      info.source = c.source;
      if (!info.title) continue;
      const bonus =
        c.source === 'json-ld' ? 45 : c.source === 'og:title' ? 26 : c.source === 'twitter:title' ? 14 : c.source === 'h1' ? 8 : 0;
      info.score = info.confidence + bonus;
      if (!best || info.score > best.score) best = info;
    }
    if (!best) best = clean(coll.slug ? coll.slug.replace(/-/g, ' ') : (doc && doc.title) || '', { source: 'fallback' });

    const href =
      (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) ||
      (doc.location && doc.location.href) ||
      doc.URL ||
      '';
    let fromUrl = idsFromDoc(doc);
    if (!fromUrl.tmdbId && !fromUrl.imdbId) fromUrl = idsFromUrl(coll.slug ? 'https://x/' + coll.slug : '');
    if (fromUrl.tmdbId) best.urlTmdbId = fromUrl.tmdbId;
    if (fromUrl.imdbId && !best.imdbId) best.imdbId = fromUrl.imdbId;
    if (fromUrl.kind && (best.kind === 'unknown' || !best.title)) best.kind = fromUrl.kind;
    if (fromUrl.tmdbId && !best.title) best.tmdbId = fromUrl.tmdbId;
    if (href) best.url = best.url || href;

    if (coll.info && Object.keys(coll.info).length) {
      best.year = best.year || coll.info.year || null;
      best.season = best.season || (coll.info.season ? String(coll.info.season).padStart(2, '0') : null);
      best.episode = best.episode || (coll.info.episode ? String(coll.info.episode).padStart(2, '0') : null);
      best.poster = coll.info.poster || coll.slug || '';
      best.imdbId = coll.info.imdbId || best.imdbId || '';
      best.kind = coll.info.kind && coll.info.kind !== 'unknown' ? coll.info.kind : best.kind;
      const fromLinks = (coll.links.join(' ').match(/tt\d{6,10}/i) || [])[0];
      if (!best.imdbId && fromLinks) best.imdbId = fromLinks;
      const tmdb = (coll.links.join(' ').match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i) || [])[1];
      if (tmdb) best.tmdbId = tmdb;
    }
    best.mediaFromMeta = coll.media;
    return best;
  }

  async function hydrateTmdb(id, kind, fetchImpl) {
    const num = String(id || '').replace(/\D/g, '');
    if (!num || !fetchImpl) return {};
    const first = kind === 'episode' || kind === 'tv' || kind === 'series' ? 'tv' : 'movie';
    const paths = first === 'tv' ? ['tv', 'movie'] : ['movie', 'tv'];
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      try {
        const res = await fetchImpl('https://www.themoviedb.org/' + path + '/' + num, { headers: { Accept: 'text/html' } });
        if (!res || !res.ok) continue;
        const html = typeof res.text === 'function' ? await res.text() : '';
        const parsed = parseTmdbHtml(html);
        if (!parsed.name) continue;
        return { tmdbId: num, name: parsed.name, year: parsed.year, imdbId: parsed.imdbId, kind: path === 'tv' ? 'episode' : 'movie' };
      } catch (_) {}
    }
    return {};
  }

  /**
   * Resolve IMDb/TMDB ids from a cleaned title when the page has none.
   * Catalog ids in the page URL (67movies /watch/movie/10389) are verified
   * against the TMDB page name. Uses IMDb's public suggestion endpoint (no key). Fail-soft.
   */
  async function lookupIds(want, opts) {
    const o = opts || {};
    const fetchImpl = o.fetchImpl || (SR.util && SR.util.fetchImpl ? SR.util.fetchImpl.bind(SR.util) : null) || (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) return {};
    const urlTmdb = String((want && (want.urlTmdbId || want.tmdbId)) || '').replace(/\D/g, '');
    let hydrated = {};
    if (urlTmdb) hydrated = await hydrateTmdb(urlTmdb, want && want.kind, fetchImpl);
    const title = String((want && want.title) || hydrated.name || '').trim();
    const out = {};
    if (urlTmdb) {
      const pageTitle = String((want && want.title) || '').trim();
      const keepId = !pageTitle || (hydrated.name && namesMatch(pageTitle, hydrated.name));
      if (keepId) {
        out.tmdbId = urlTmdb;
        if (hydrated.name) out.name = hydrated.name;
        if (hydrated.year) out.year = hydrated.year;
        if (hydrated.imdbId) out.imdbId = hydrated.imdbId;
        if (hydrated.kind) out.kind = hydrated.kind;
      }
    }
    if (!title || title.length < 2) return out;
    const slug = title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 48);
    if (!slug) return out;
    const url = 'https://v2.sg.media-imdb.com/suggestion/' + slug[0] + '/' + encodeURIComponent(slug) + '.json';
    const wantYear = want.year ? String(want.year) : '';
    const wantEp = !!(want.season || want.episode);
    const qn = (s) =>
      String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const q = qn(title);
    const scoreName = (nameRaw, yearRaw, kindRaw) => {
      const name = qn(nameRaw);
      if (!name) return -1e9;
      let sc = 0;
      if (name === q) sc += 80;
      else if (name.indexOf(q) >= 0 || q.indexOf(name) >= 0) sc += 50;
      else {
        const tokens = q.split(' ').filter((t) => t.length > 2);
        const hit = tokens.filter((t) => name.indexOf(t) >= 0).length;
        sc += tokens.length ? Math.round((hit / tokens.length) * 40) : 0;
      }
      if (wantYear && String(yearRaw || '') === wantYear) sc += 25;
      else if (wantYear && yearRaw && Math.abs(Number(yearRaw) - Number(wantYear)) > 1) sc -= 20;
      const kind = String(kindRaw || '').toLowerCase();
      if (wantEp && /tv|series|episode/.test(kind)) sc += 12;
      if (!wantEp && /movie|feature|video/.test(kind)) sc += 8;
      return sc;
    };
    const readJson = async (res) => {
      if (!res || !res.ok) return null;
      const text = typeof res.text === 'function' ? await res.text() : '';
      return SR.util && SR.util.safeJSON ? SR.util.safeJSON(text, null) : JSON.parse(text || '{}');
    };
    try {
      const json = await readJson(await fetchImpl(url, { headers: { Accept: 'application/json' } }));
      const rows = (json && json.d) || [];
      let best = null;
      let bestScore = -1e9;
      for (const r of rows) {
        const id = String(r.id || '');
        if (!/^tt\d{6,10}$/i.test(id)) continue;
        const kind = String(r.qid || r.q || '').toLowerCase();
        if (/game|podcast/.test(kind)) continue;
        const sc = scoreName(r.l || r.s || '', r.y, kind);
        if (sc > bestScore) {
          bestScore = sc;
          best = r;
        }
      }
      if (best && bestScore >= 28) {
        return Object.assign({}, out, {
          imdbId: String(best.id),
          year: (best.y ? String(best.y) : '') || out.year || '',
          name: best.l || out.name || title,
          kind: /tv|series|episode/.test(String(best.qid || '')) ? 'episode' : out.kind || 'movie',
          tmdbId: out.tmdbId || '',
        });
      }
    } catch (_) {}
    try {
      const kind = wantEp ? 'series' : 'movie';
      const cUrl =
        'https://v3-cinemeta.strem.io/catalog/' + kind + '/top/search=' + encodeURIComponent(title) + '.json';
      const json = await readJson(await fetchImpl(cUrl, { headers: { Accept: 'application/json' } }));
      const rows = (json && json.metas) || [];
      let best = null;
      let bestScore = -1e9;
      for (const r of rows) {
        const id = String(r.imdb_id || r.imdbId || '');
        if (!/^tt\d{6,10}$/i.test(id)) continue;
        const sc = scoreName(r.name || r.title || '', r.year || r.releaseInfo, r.type);
        if (sc > bestScore) {
          bestScore = sc;
          best = r;
        }
      }
      if (!best || bestScore < 28) return out;
      return Object.assign({}, out, {
        imdbId: String(best.imdb_id || best.imdbId),
        tmdbId: out.tmdbId || (best.id && /^\d+$/.test(String(best.id)) ? String(best.id) : ''),
        year: (best.year ? String(best.year) : '') || out.year || '',
        name: best.name || out.name || title,
        kind: /series|tv/.test(String(best.type || '')) ? 'episode' : out.kind || 'movie',
      });
    } catch (_) {
      return out;
    }
  }

  /** Build a search-friendly query for subtitle providers. */
  function searchQuery(info) {
    if (!info || !info.title) return '';
    let q = info.title;
    return q.trim();
  }

  /** S01E02-style label used in the UI and by subtitle lookups. */
  function episodeLabel(info) {
    if (!info) return null;
    if (!info.episode) return null;
    return (info.season ? 'S' + info.season : '') + 'E' + info.episode;
  }

  SR.title = {
    clean,
    collect,
    resolve,
    lookupIds,
    idsFromUrl,
    idsFromDoc,
    namesMatch,
    hydrateTmdb,
    normalize,
    searchQuery,
    episodeLabel,
    extractMeta,
    stripPhrases,
    _lists: { PHRASES, TOKENS, JUNK_EXACT, TLD_RE },
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
