/**
 * Generate the update-signing key pair (ECDSA P-256 + SHA-256).
 *
 *   node tools/keygen.mjs
 *
 * The PUBLIC key is embedded in src/shared/updater.js (verification only).
 * The PRIVATE key is written OUTSIDE the repo (~/stream-radar-update-key.json)
 * and must end up in the GitHub Actions secret `STREAMRADAR_UPDATE_KEY` so CI can
 * sign rule packs / patches. Losing it = users just stop receiving hot rule
 * updates; nothing breaks.
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
pub.key_ops = ['verify'];
delete pub.ext;
pub.ext = true;
const priv = privateKey.export({ format: 'jwk' });

const out = path.join(os.homedir(), 'stream-radar-update-key.json');
if (existsSync(out) && !process.argv.includes('--force')) {
  console.error('refusing to overwrite ' + out + ' (pass --force to rotate the key)');
  process.exit(1);
}
writeFileSync(out, JSON.stringify({ crv: 'P-256', private: priv, public: pub }, null, 2), { mode: 0o600 });

console.log('private key  → ' + out + '  (mode 600, keep out of git)');
console.log('\nGitHub secret STREAMRADAR_UPDATE_KEY = contents of that file (base64 or raw JSON)\n');
console.log('public key   → paste into src/shared/updater.js as PUBLIC_KEY_JWK:');
console.log(JSON.stringify(pub, null, 2));
