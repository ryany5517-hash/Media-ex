/**
 * Sign an update payload with the private key (ECDSA P-256 / SHA-256).
 *
 *   node tools/sign.mjs dist-live/rules/rules.json
 *   → dist-live/rules/rules.json.sig   (raw r||s, base64url, WebCrypto-compatible)
 *
 * Key file = what `npm run keygen` wrote (default: ~/stream-radar-update-key.json,
 * or $STREAMRADAR_UPDATE_KEY pointing at a JSON file / the JSON itself in CI).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createSign, createPrivateKey } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('usage: node tools/sign.mjs <file> [keyfile]');
  process.exit(1);
}
const keyPath = process.argv[3] || process.env.STREAMRADAR_UPDATE_KEY || path.join(os.homedir(), 'stream-radar-update-key.json');
let json;
try {
  json = existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : keyPath; // env may carry the JSON itself
} catch (_) {
  json = null;
}
if (!json) {
  console.error('no signing key found at ' + keyPath);
  process.exit(1);
}
const doc = JSON.parse(json);
const key = createPrivateKey({ key: { crv: 'P-256', d: b64u(doc.private.d), x: b64u(doc.private.x), y: b64u(doc.private.y), kty: 'EC' }, format: 'jwk' });
const data = readFileSync(target);
const der = createSign('SHA256').update(data).sign(key);
const sig = derToRaw(der);
const out = target + '.sig';
writeFileSync(out, sig);
console.log('✓ signed → ' + out + ' (' + sig.length + ' bytes, raw r||s)');

function b64u(s) {
  return Buffer.from(String(s), 'base64url').toString('base64');
}
function derToRaw(der) {
  let i = 2; // skip SEQUENCE tag+len
  const readInt = () => {
    i++; // 0x02
    const len = der[i++];
    let slice = der.subarray(i, i + len);
    i += len;
    while (slice.length && slice[0] === 0x00) slice = slice.subarray(1);
    return Buffer.from(slice, 'big').toString('hex').padStart(64, '0');
  };
  const r = readInt();
  const s = readInt();
  return Buffer.from(r + s, 'hex');
}
