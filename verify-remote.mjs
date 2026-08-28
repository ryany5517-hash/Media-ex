import fs from "node:fs";
import { webcrypto } from "node:crypto";

const base = "https://raw.githubusercontent.com/ryany5517-hash/Media-ex/live/rules/";
const bg = fs.readFileSync("dist/chrome/background.js", "utf8");

const x = /x:\s*"([A-Za-z0-9_-]{43})"/.exec(bg)?.[1];
const y = /y:\s*"([A-Za-z0-9_-]{43})"/.exec(bg)?.[1];
if (!x || !y) throw new Error("Gagal extract x/y dari dist/chrome/background.js");

const jwk = { kty: "EC", crv: "P-256", x, y, ext: true };

const key = await webcrypto.subtle.importKey(
  "jwk",
  jwk,
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["verify"]
);

const rulesRes = await fetch(base + "rules.json?t=" + Date.now());
const sigRes   = await fetch(base + "rules.json.sig?t=" + Date.now());

const rulesBuf = await rulesRes.arrayBuffer();
const sigBuf   = await sigRes.arrayBuffer();

const ok = await webcrypto.subtle.verify(
  { name: "ECDSA", hash: "SHA-256" },
  key,
  sigBuf,
  rulesBuf
);

console.log("verify(remote) =", ok);
console.log("http rules =", rulesRes.status, "sig =", sigRes.status);
