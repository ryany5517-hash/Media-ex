import fs from "node:fs";
import { webcrypto } from "node:crypto";

const bg = fs.readFileSync("dist/chrome/background.js", "utf8");
const x = /x:\s*"([A-Za-z0-9_-]{43})"/.exec(bg)?.[1];
const y = /y:\s*"([A-Za-z0-9_-]{43})"/.exec(bg)?.[1];

const key = await webcrypto.subtle.importKey(
  "jwk",
  { kty: "EC", crv: "P-256", x, y, ext: true },
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["verify"]
);

const data = fs.readFileSync("dist-live/rules/rules.json");
const sigB64 = fs.readFileSync("dist-live/rules/rules.json.sig", "utf8").trim();
const sig = Buffer.from(sigB64, "base64url");

const ok = await webcrypto.subtle.verify(
  { name: "ECDSA", hash: "SHA-256" },
  key,
  sig,
  data
);

console.log("verify(local) =", ok, "| sigLen decoded =", sig.length);
