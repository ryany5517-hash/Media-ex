/**
 * i18n dictionary guard (B5).
 * ------------------------------------------------------------------
 * Two failure modes made translations feel half-done:
 *   1. A key declared twice in one language block: a JS object literal keeps
 *      only the LAST value, so the earlier string is dead with no error.
 *   2. A key present in one language but missing in the other: switching to
 *      Indonesian falls back to English for that key (or English shows a key).
 *
 * This static scan returns the exact offenders. It does not execute the file.
 */

function langBlock(src, lang) {
  // Find "<lang>: {" then walk brace depth, ignoring braces inside strings and
  // escaped quotes, until the matching closing brace. This is robust to the
  // 2-space vs 4-space indentation used by real source and test fixtures.
  const key = new RegExp("\\b" + lang + ":\\s*\\{", 'g');
  const m = key.exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index);
  let depth = 0;
  let inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  return src.slice(m.index);
}

function entries(block) {
  // lines like:      'some.key': 'value',
  const out = [];
  const re = /^\s*'([A-Za-z0-9_.]+)'\s*:/gm;
  let m;
  while ((m = re.exec(block))) out.push(m[1]);
  return out;
}

/** @returns {{duplicates: {lang:string,key:string}[], missingIn: {lang:string,key:string}[]}} */
export function checkI18n(src) {
  const enKeys = entries(langBlock(src, 'en'));
  const idKeys = entries(langBlock(src, 'id'));

  const dup = (keys, lang) => {
    const seen = new Set();
    const d = [];
    for (const k of keys) {
      if (seen.has(k)) d.push({ lang, key: k });
      seen.add(k);
    }
    return d;
  };
  const duplicates = [...dup(enKeys, 'en'), ...dup(idKeys, 'id')];

  const enSet = new Set(enKeys);
  const idSet = new Set(idKeys);
  const missingIn = [];
  for (const k of enKeys) if (!idSet.has(k)) missingIn.push({ lang: 'id', key: k });
  for (const k of idKeys) if (!enSet.has(k)) missingIn.push({ lang: 'en', key: k });

  return { duplicates, missingIn };
}
