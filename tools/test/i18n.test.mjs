/**
 * i18n: every static string must translate, both languages must carry the same
 * keys, and a duplicated key must be caught. Uses jsdom for a real document.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { checkI18n } from '../lib/i18n-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const i18nSrc = readFileSync(path.join(ROOT, 'src/shared/i18n.js'), 'utf8');

function loadI18n(lang) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://x.test/' });
  const w = dom.window;
  w.eval(readFileSync(path.join(ROOT, 'src/shared/util.js'), 'utf8'));
  w.eval(readFileSync(path.join(ROOT, 'src/shared/i18n.js'), 'utf8'));
  const SR = w.eval('SR');
  SR.i18n.set(lang);
  return { w, SR, document: w.document };
}

test('i18n dict: no duplicate keys and full en/id parity', () => {
  const { duplicates, missingIn } = checkI18n(i18nSrc);
  assert.deepEqual(duplicates, [], 'duplicate keys: ' + duplicates.map(d => d.lang + ':' + d.key).join(', '));
  assert.deepEqual(missingIn, [], 'missing keys: ' + missingIn.map(d => d.lang + ':' + d.key).join(', '));
});

test('i18n apply() translates text, title, aria-label and html hooks and document title', () => {
  const { SR, document } = loadI18n('id');
  document.documentElement.lang = 'id';
  document.title = 'x';
  document.body.innerHTML =
    '<title data-i18n-title="settings.title" id="t">old</title>' +
    '<span data-i18n="common.close" id="a">Close</span>' +
    '<button data-i18n-title="theme.dark" data-i18n-aria="common.save" id="b">x</button>' +
    '<span data-i18n-html="action.ffmpeg" id="c"></span>' +
    '<span data-i18n="does.not.exist" id="d">fallback</span>';
  // add a dict key with markup for the html hook test
  SR.i18n.dict.en['action.ffmpeg'] = 'Copy <code>ffmpeg</code> command';
  SR.i18n.dict.id['action.ffmpeg'] = 'Salin perintah <code>ffmpeg</code>';
  SR.i18n.apply(document);
  assert.equal(document.getElementById('a').textContent, 'Tutup');
  assert.equal(document.getElementById('b').getAttribute('title'), 'Gelap');
  assert.equal(document.getElementById('b').getAttribute('aria-label'), 'Simpan');
  assert.match(document.getElementById('c').innerHTML, /<code>ffmpeg<\/code>/, 'html hook keeps dict markup');
  assert.equal(document.title, 'Pengaturan Stream Radar');
});

test('i18n apply() sets English text when language is en', () => {
  const { SR, document } = loadI18n('en');
  document.body.innerHTML = '<span data-i18n="common.close" id="a">Tutup</span>';
  SR.i18n.apply(document);
  assert.equal(document.getElementById('a').textContent, 'Close', 'en value must be English, not Indonesian');
});

test('i18n guard flags a deliberately duplicated key', () => {
  const src = "const DICT = { en: {\n'a.b': 'x',\n'a.b': 'y',\n'c.d': 'z',\n },\n id: {\n'a.b': 'x',\n'c.d': 'z',\n },\n };";
  const { duplicates, missingIn } = checkI18n(src);
  assert.ok(duplicates.some(d => d.lang === 'en' && d.key === 'a.b'), 'duplicate en key must be flagged');
  assert.deepEqual(missingIn, [], 'both languages otherwise in parity');
});
