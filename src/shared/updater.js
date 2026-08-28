/**
 * Stream Radar â€” live rule packs + signed hot patches
 * ==================================================================
 * Goal: when something is broken (a new embed host, a new ad domain, a new SEO
 * junk word, a changed subtitle API) the fix ships from GitHub and the already
 * installed extension picks it up on its own. No uninstall, no reinstall, no
 * store review.
 *
 * Two channels, deliberately separated by risk:
 *
 *  1. RULE PACK (data only, enabled by default)
 *     `rules/rules.json` + `rules/rules.json.sig` on the `live` branch.
 *     Additive only: a pack may add hosts / extensions / junk words, it can
 *     never remove a built-in rule, so a stale or bad pack cannot blind us.
 *     Verified with an embedded ECDSA P-256 public key (WebCrypto).
 *
 *  2. CODE PATCH (JavaScript, OFF by default, opt-in in Options)
 *     `patch/patch.js` + `.sig` + `patch/meta.json`, same signature requirement.
 *     Executed with `new Function()` inside the *content script* isolated world
 *     (never in the page, never via innerHTML), versioned and revocable by
 *     deleting the file from the `live` branch.
 *
 * Verification happens ONLY in the background worker: it is always a secure
 * context, so `crypto.subtle` exists there. Content scripts simply receive the
 * already-verified payload, which also keeps http:// pages working.
 */
(function (root) {
  'use strict';
  const SR = (root.SR = root.SR || {});
  const util = SR.util;

  const PUBLIC_KEY_JWK = {
    kty: 'EC',
    crv: 'P-256',
    x: 'UZ33kOysXiijfF9rVCLCU6s0JHFtlRKx3xHer-0pDmE',
    y: '3m66hI6NDl_cJb4vE_rLEIATjYMB_T3v2i3jLSPF2kc',
    ext: true,
    key_ops: ['verify'],
  };

  const LIMITS = { hosts: 400, ext: 40, phrases: 200, tokens: 400, patternChars: 4000, patchChars: 120000 };

  let keyPromise = null;
  function importKey() {
    if (!root.crypto || !root.crypto.subtle) return Promise.reject(new Error('WebCrypto unavailable in this context'));
    if (!keyPromise) {
      keyPromise = root.crypto.subtle.importKey('jwk', PUBLIC_KEY_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    }
    return keyPromise;
  }

  /** DER â†’ raw r||s (WebCrypto wants the raw form; node's crypto.sign gives DER). */
  function normaliseSignature(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u.length === 64) return u;
    // ECDSA-Sig-Value: SEQUENCE { INTEGER r, INTEGER s }
    try {
      let i = 0;
      if (u[i++] !== 0x30) throw new Error('bad seq');
      i++; // total length
      const readInt = () => {
        if (u[i++] !== 0x02) throw new Error('bad int');
        const len = u[i++];
        const slice = u.subarray(i, i + len);
        i += len;
        return slice;
      };
      const r = readInt();
      const s = readInt();
      const out = new Uint8Array(64);
      out.set(r.slice(-64), 64 - Math.min(64, r.length));
      out.set(s.slice(-64), 128 - Math.min(64, s.length));
      return out;
    } catch (_) {
      return null;
    }
  }

  function b64ToBytes(s) {
    const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
    try {
      const bin = atob(t);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (_) {
      return null;
    }
  }

  const updater = (SR.updater = {
    PUBLIC_KEY_JWK,
    LIMITS,
    b64ToBytes,
    normaliseSignature,

    /** @returns {Promise<boolean>} */
    async verify(text, sigB64) {
      try {
        const key = await importKey();
        const sig = normaliseSignature(b64ToBytes(sigB64));
        if (!sig) return false;
        const data = new TextEncoder().encode(String(text));
        return await root.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
      } catch (e) {
        return false;
      }
    },

    /** Shape-check + clamp a raw pack so a malicious/typo payload can't DoS us. */
    sanitizePack(raw) {
      const out = {
        version: 0,
        minAppVersion: '0.0.0',
        embedHosts: [],
        adHosts: [],
        mediaExt: [],
        junkPhrases: [],
        junkTokens: [],
        blockPatterns: '',
        notes: '',
      };
      if (!raw || typeof raw !== 'object') return null;
      const strList = (v, max) =>
        Array.isArray(v)
          ? v
              .filter((x) => typeof x === 'string' && x.length > 1 && x.length < 120)
              .map((x) => x.toLowerCase().replace(/[^a-z0-9.*_\- ]/g, '').trim())
              .filter(Boolean)
              .slice(0, max)
          : [];
      out.version = Number(raw.version) || 0;
      out.minAppVersion = String(raw.minAppVersion || '0.0.0').slice(0, 20);
      out.embedHosts = strList(raw.embedHosts, LIMITS.hosts);
      out.adHosts = strList(raw.adHosts, LIMITS.hosts);
      out.mediaExt = strList(raw.mediaExt, LIMITS.ext).map((x) => x.replace(/[^a-z0-9]/g, '')).filter((x) => x.length >= 2 && x.length <= 5);
      out.junkPhrases = (Array.isArray(raw.junkPhrases) ? raw.junkPhrases : []).filter((x) => typeof x === 'string' && x.length > 1 && x.length < 80).slice(0, LIMITS.phrases);
      out.junkTokens = strList(raw.junkTokens, LIMITS.tokens);
      out.blockPatterns = typeof raw.blockPatterns === 'string' ? raw.blockPatterns.slice(0, LIMITS.patternChars) : '';
      out.notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 400) : '';
      return out;
    },

    /** Merge a pack into SR.dynamic (idempotent + additive). Returns counts. */
    applyPack(pack) {
      const dyn = SR.dynamic;
      if (!dyn || !pack) return null;
      const add = (list, items) => {
        let n = 0;
        for (const v of items || []) if (v && list.indexOf(v) < 0) (list.push(v), n++);
        return n;
      };
      const added = {
        embedHosts: add(dyn.embedHosts, pack.embedHosts),
        adHosts: add(dyn.adHosts, pack.adHosts),
        junkPhrases: add((dyn.junkPhrases = dyn.junkPhrases || []), pack.junkPhrases),
        junkTokens: add((dyn.junkTokens = dyn.junkTokens || []), pack.junkTokens),
        mediaExt: 0,
      };
      for (const e of pack.mediaExt || []) if (!dyn.mediaExt.has(e)) (dyn.mediaExt.add(e), added.mediaExt++);
      dyn.blockPatterns = pack.blockPatterns || '';
      dyn.version = pack.version || dyn.version || 0;
      dyn.loadedAt = Date.now();
      return added;
    },

    /** Compare a pack against the app version via semver-ish tuple. */
    compatible(pack, appVersion) {
      const cmp = (a, b) => {
        const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
        const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
        for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
        return 0;
      };
      return cmp(appVersion || SR.VERSION, pack.minAppVersion || '0.0.0') >= 0;
    },

    /**
     * Background only: fetch, verify, apply, persist.
     * @param {{settings:object, appVersion?:string, force?:boolean, log?:Function}} o
     */
    async checkForUpdates(o) {
      const opts = o || {};
      const settings = opts.settings || {};
      const log = opts.log || function () {};
      if (settings.updateEnabled === false) return { status: 'disabled' };
      const base = (settings.updateUrl || 'https://raw.githubusercontent.com/ryany5517-hash/Media-ex/live/').replace(/\/?$/, '/');
      const res = { status: 'error', at: Date.now() };
      try {
        const body = await util.fetchText(base + 'rules/rules.json', { timeoutMs: 15000, maxBytes: 400000, credentials: 'omit' });
        const pack = updater.sanitizePack(util.safeJSON(body, null));
        if (!pack) throw new Error('pack unreadable');
        let sigText = '';
        try {
          sigText = (await util.fetchText(base + 'rules/rules.json.sig', { timeoutMs: 10000, maxBytes: 4096, credentials: 'omit' })).trim();
        } catch (_) {
          sigText = '';
        }
        if (!sigText) throw new Error('no signature (refusing unsigned rules)');
        const ok = await updater.verify(body, sigText);
        if (!ok) throw new Error('bad signature');
        if (!updater.compatible(pack, opts.appVersion || SR.VERSION)) return Object.assign(res, { status: 'incompatible', version: pack.version });
        SR.dynamic.signatureOk = true;
        updater.applyPack(pack);
        res.status = pack.version > (settings.rulesVersion || 0) ? 'updated' : 'current';
        res.version = pack.version;
        res.notes = pack.notes;
        if (res.status === 'updated' && opts.persist) await opts.persist({ pack: pack, fetchedAt: Date.now(), version: pack.version });
        // optional code patch
        if (settings.autoPatch) {
          try {
            const meta = util.safeJSON(await util.fetchText(base + 'patch/meta.json', { timeoutMs: 10000, maxBytes: 4096, credentials: 'omit' }), null);
            if (meta && meta.file && Number(meta.version) > Number(settings.patchVersion || 0) && updater.compatible(meta, opts.appVersion || SR.VERSION)) {
              const code = await util.fetchText(base + 'patch/' + meta.file, { timeoutMs: 15000, maxBytes: LIMITS.patchChars, credentials: 'omit' });
              let psig = '';
              try {
                psig = (await util.fetchText(base + 'patch/' + meta.file + '.sig', { timeoutMs: 10000, maxBytes: 4096, credentials: 'omit' })).trim();
              } catch (_) {
                psig = '';
              }
              if (!psig) throw new Error('signature');
              if (code.length <= LIMITS.patchChars && (await updater.verify(code, psig))) {
                res.patch = { version: meta.version, code: code, changelog: String(meta.changelog || '').slice(0, 300) };
                if (opts.persistPatch) await opts.persistPatch(res.patch);
              } else {
                log('patch rejected: signature');
                res.patchError = 'signature';
              }
            }
          } catch (e) {
            res.patchError = String((e && e.message) || e);
          }
        }
        return res;
      } catch (e) {
        res.error = String((e && e.message) || e);
        log('update check failed', res.error);
        return res;
      }
    },

    /**
     * Content script side: apply the pack the background already verified.
     * Kept separate so no content script ever parses remote JSON directly.
     */
    applyRemote(pack, patch, settings) {
      const p = updater.sanitizePack(pack);
      if (p) {
        SR.dynamic.signatureOk = true;
        updater.applyPack(p);
      }
      const allowed = settings ? settings.autoPatch === true : true;
      if (allowed && patch && patch.code && typeof patch.code === 'string' && patch.code.length <= LIMITS.patchChars) {
        // The signature was verified by the background worker before storage.
        try {
          // Declare BOTH parameters: new Function(body)(SR, root) discards the
          // arguments because the function body never names them, so a patch
          // using `root` threw ReferenceError inside this try/catch with no
          // visible effect. The declared-parameter form passes SR and root.
          new Function('SR', 'root', '"use strict";\n' + patch.code)(SR, root);
          SR.patchApplied = patch.version || 0;
          return true;
        } catch (e) {
          SR.patchError = String((e && e.message) || e);
          return false;
        }
      }
      return false;
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
