/**
 * Live-update channel: signature, rule pack application, rejection paths.
 * ------------------------------------------------------------------
 * The production public key is baked into src/shared/updater.js; here we eval a
 * copy of that file with a freshly generated key pair so the whole
 * fetch → verify → apply pipeline is exercised without shipping any test key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createSign } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, 'src', rel), 'utf8');

import '../../src/shared/util.js';
import '../../src/shared/rules.js';
import '../../src/shared/title-cleaner.js';
import '../../src/shared/i18n.js';
import '../../src/shared/store.js';

const SR = globalThis.SR;

/* ---------------- key + signer for this test only ---------------- */
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });

function sign(text) {
  const der = createSign('SHA256').update(Buffer.from(text, 'utf8')).sign(privateKey);
  return Buffer.from(derToRaw(der)).toString('base64url');
}
function derToRaw(der) {
  let i = 2;
  const readInt = () => {
    i++;
    const len = der[i++];
    let slice = der.subarray(i, i + len);
    i += len;
    while (slice.length && slice[0] === 0) slice = slice.subarray(1);
    return Buffer.from(slice).toString('hex').padStart(64, '0');
  };
  return Buffer.from(readInt() + readInt(), 'hex');
}

/** eval updater.js with the test key injected */
function loadUpdater() {
  // swap the embedded public key for the freshly generated one (P-256 JWK coords
  // are exactly 43 base64url chars, so this cannot hit `kty: 'EC'`)
  const src = read('shared/updater.js')
    .replace(/\bx: ["'][A-Za-z0-9_-]{43}["']/, `x: '${pub.x}'`)
    .replace(/\by: ["'][A-Za-z0-9_-]{43}["']/, `y: '${pub.y}'`);
  if (!src.includes(`x: '${pub.x}'`) || !src.includes(`y: '${pub.y}'`)) throw new Error('key injection failed');
  // reset the live rule set IN PLACE: rules.js captured that object at init, so
  // replacing SR.dynamic would detach the classifier from the pack.
  if (!SR.dynamic) SR.dynamic = { embedHosts: [], adHosts: [], mediaExt: new Set(), junkPhrases: [], junkTokens: [], loadedAt: 0, version: 0, signatureOk: null };
  const d = SR.dynamic;
  d.embedHosts.length = 0;
  d.adHosts.length = 0;
  d.junkPhrases && (d.junkPhrases.length = 0);
  d.junkTokens && (d.junkTokens.length = 0);
  d.mediaExt.clear();
  d.blockPatterns = '';
  d.version = 0;
  d.signatureOk = null;
  vm.runInThisContext('\n;' + src, { filename: 'updater-test.js' });
  return SR.updater;
}

function fakeServer(pack, sig, extra = {}) {
  const files = { 'rules/rules.json': pack, 'rules/rules.json.sig': sig, ...extra };
  const impl = async (url) => {
    const u = String(url).replace(/^https:\/\/up\.test\/live\//, '');
    if (!(u in files)) throw new Error('404 ' + u);
    const body = files[u];
    return { ok: true, status: 200, async text() { return body; }, async json() { return JSON.parse(body); }, async arrayBuffer() { return Buffer.from(body).buffer; } };
  };
  return impl;
}

const PACK = {
  version: 2026082802,
  minAppVersion: '1.0.0',
  notes: 'test pack',
  embedHosts: ['brand-new-embed.example'],
  adHosts: ['ads.badsite.net'],
  mediaExt: ['mstr'],
  junkPhrases: ['kumpulan situs ilegal'],
  junkTokens: ['situsilegal'],
  blockPatterns: '/\\.svg$/i',
};

test('updater: signed pack is accepted, applied and persisted', async () => {
  const updater = loadUpdater();
  const body = JSON.stringify(PACK);
  const sig = sign(body);
  globalThis.__sradFetch = fakeServer(body, sig);
  SR.util.fetchImpl = (u, i) => globalThis.__sradFetch(u, i);

  let persisted = null;
  const res = await updater.checkForUpdates({
    settings: { updateEnabled: true, updateUrl: 'https://up.test/live/' },
    appVersion: '1.0.0',
    persist: async (p) => (persisted = p),
  });
  assert.equal(res.status, 'updated', JSON.stringify(res));
  assert.equal(res.version, PACK.version);
  assert.ok(persisted && persisted.pack.embedHosts.length === 1, 'persisted for offline use');
  assert.equal(SR.dynamic.signatureOk, true);
  assert.ok(SR.dynamic.embedHosts.includes('brand-new-embed.example'), 'host added to the live rule set');

  /* the new ad host is now actually classified as an ad */
  const before = SR.rules.classify('https://ads.badsite.net/spot.mp4', {});
  assert.equal(before.isAd, true, 'pack-provided ad host takes effect');

  /* the new junk phrase is stripped by the title pipeline */
  const cleaned = SR.title.clean('Frozen 2 (2019) Kumpulan Situs Ilegal situsilegal');
  assert.equal(cleaned.title, 'Frozen 2', 'got: ' + cleaned.title);

  /* a new extension is recognised as media */
  const ext = SR.rules.classify('https://cdn.test/stream/video.mstr', {});
  assert.ok(ext, 'custom media extension accepted');
});

test('updater: unsigned, tampered and incompatible payloads are rejected', async () => {
  const updater = loadUpdater();
  const body = JSON.stringify(PACK);

  // 1) no signature at all
  globalThis.__sradFetch = fakeServer(body, undefined);
  let res = await updater.checkForUpdates({ settings: { updateEnabled: true, updateUrl: 'https://up.test/live/' }, log: () => {} });
  assert.equal(res.status, 'error');
  assert.match(res.error, /no signature/);

  // 2) signature that does not match
  globalThis.__sradFetch = fakeServer(JSON.stringify({ ...PACK, adHosts: ['evil.example'] }), sign(body));
  res = await updater.checkForUpdates({ settings: { updateEnabled: true, updateUrl: 'https://up.test/live/' }, log: () => {} });
  assert.equal(res.status, 'error');
  assert.match(res.error, /bad signature/);
  assert.equal(SR.rules.classify('https://evil.example/a.mp4', {}).isAd, false, 'tampered host must NOT be applied');

  // 3) pack requires a newer app
  const fresh = JSON.stringify({ ...PACK, minAppVersion: '99.0.0' });
  globalThis.__sradFetch = fakeServer(fresh, sign(fresh));
  res = await updater.checkForUpdates({ settings: { updateEnabled: true, updateUrl: 'https://up.test/live/' }, appVersion: '1.0.0', log: () => {} });
  assert.equal(res.status, 'incompatible');
});

test('updater: sanitizePack clamps and strips hostile input', () => {
  const updater = loadUpdater();
  const evil = {
    version: '7',
    embedHosts: new Array(5000).fill('x.example').concat(['<img src=x onerror=alert(1)>', '', 42]),
    adHosts: ['a'.repeat(500)],
    mediaExt: ['toolongext', 'mk', 'hls2'],
    junkPhrases: ['ok phrase', 12, 'x'.repeat(200)],
    blockPatterns: 'r'.repeat(50000),
    notes: { nope: true },
  };
  const out = updater.sanitizePack(evil);
  assert.equal(out.version, 7);
  assert.equal(out.embedHosts.length, SR.updater.LIMITS.hosts, 'capped');
  assert.ok(out.embedHosts.includes('x.example'));
  assert.equal(out.embedHosts.some((h) => h.includes('<')), false, 'html stripped');
  assert.equal(out.mediaExt.includes('toolongext'), false, 'sane extension lengths only');
  assert.equal(out.blockPatterns.length, SR.updater.LIMITS.patternChars);
  assert.equal(out.notes, '');
  assert.equal(updater.sanitizePack('nope'), null);
  assert.equal(updater.sanitizePack(null), null);
});

test('updater: code patch needs a signature too, then runs in the content world', async () => {
  const updater = loadUpdater();
  const code = 'globalThis.__sradPatchRan = (globalThis.__sradPatchRan || 0) + 1; SR.patchMarker = "ok";';
  const meta = JSON.stringify({ file: 'patch.js', version: 5, minAppVersion: '1.0.0', changelog: 'fix' });
  const pack = JSON.stringify(PACK);
  globalThis.__sradFetch = fakeServer(pack, sign(pack), {
    'patch/meta.json': meta,
    'patch/patch.js': code,
    'patch/patch.js.sig': sign(code),
  });
  let persistedPatch = null;
  const res = await updater.checkForUpdates({
    settings: { updateEnabled: true, autoPatch: true, updateUrl: 'https://up.test/live/' },
    appVersion: '1.0.0',
    persist: async () => {},
    persistPatch: async (p) => (persistedPatch = p),
  });
  assert.ok(res.patch, 'patch delivered: ' + JSON.stringify(res));
  assert.equal(res.patch.version, 5);
  assert.ok(persistedPatch && /__sradPatchRan/.test(persistedPatch.code));

  // applyRemote runs it once per frame (the content-script entry point)
  const ok = updater.applyRemote(PACK, persistedPatch);
  assert.equal(ok, true);
  assert.equal(globalThis.__sradPatchRan, 1);
  assert.equal(SR.patchMarker, 'ok');

  // a patch without signature is never delivered
  globalThis.__sradFetch = fakeServer(pack, sign(pack), { 'patch/meta.json': meta, 'patch/patch.js': code });
  const res2 = await updater.checkForUpdates({ settings: { updateEnabled: true, autoPatch: true, updateUrl: 'https://up.test/live/' }, persist: async () => {} });
  assert.equal(res2.patch, undefined, 'unsigned patch skipped');
  assert.match(String(res2.patchError), /signature/);
  assert.equal(updater.applyRemote(PACK, { code: 'globalThis.__sradPatchRan = 99;' , version: 9 }), true); // trusted-internal path (bg verified)
});

test('updater: autoPatch off means no code is ever fetched', async () => {
  const updater = loadUpdater();
  const pack = JSON.stringify(PACK);
  let hits = [];
  globalThis.__sradFetch = (u) => {
    hits.push(String(u));
    return fakeServer(pack, sign(pack)) (u);
  };
  const res = await updater.checkForUpdates({ settings: { updateEnabled: true, autoPatch: false, updateUrl: 'https://up.test/live/' } });
  assert.equal(res.status, 'updated');
  assert.equal(hits.filter((h) => h.includes('/patch/')).length, 0, 'patch endpoints untouched');
});

test('updater: disabled switch short-circuits everything', async () => {
  const updater = loadUpdater();
  let fetched = false;
  globalThis.__sradFetch = () => {
    fetched = true;
    return Promise.reject(new Error('no'));
  };
  const res = await updater.checkForUpdates({ settings: { updateEnabled: false } });
  assert.equal(res.status, 'disabled');
  assert.equal(fetched, false);
});
