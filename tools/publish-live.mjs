/**
 * Build the `live` branch payload (rule packs + optional signed code patch).
 *
 *   node tools/publish-live.mjs            â†’ just writes dist-live/
 *   node tools/publish-live.mjs --push     â†’ commits dist-live/ onto branch `live` and pushes
 *
 * The extension reads exactly these paths:
 *   rules/rules.json      + rules/rules.json.sig
 *   patch/patch.js        + patch/patch.js.sig        (only with autoPatch on)
 *   patch/meta.json
 *
 * CI runs this on every push to main (see .github/workflows/build.yml once you
 * move the workflow in place) so a rule fix on GitHub = every install updated
 * within the check interval, no store review, no reinstall.
 */
import { mkdir, writeFile, readFile, cp, access } from 'node:fs/promises';
import { existsSync, rmSync, cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'dist-live');
const argv = process.argv.slice(2);
const push = argv.includes('--push');
// Deliberate, explicit "do not sign" for local dry-run preview only. It is
// rejected together with --push because the live channel refuses unsigned packs.
const noSign = argv.includes('--no-sign');

// Where tools/sign.mjs looks for the private key. Mirrors that resolution for
// the error message only; it never opens or prints the key contents.
function signingKeyPath() {
  if (process.env.STREAMRADAR_UPDATE_KEY) return 'env STREAMRADAR_UPDATE_KEY';
  return path.join(os.homedir(), 'stream-radar-update-key.json');
}

// The 8-char key id the installed extension trusts (first chars of the PUBLIC
// jwk x). Read from source so the message stays correct if the key rotates.
function expectedKid() {
  try {
    const m = readFileSync(path.join(ROOT, 'src/shared/updater.js'), 'utf8').match(/x:\s*'([A-Za-z0-9_-]{8})/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  await mkdir(path.join(OUT, 'rules'), { recursive: true });
  await mkdir(path.join(OUT, 'patch'), { recursive: true });

  /* --- rule pack --- */
  const src = JSON.parse(await readFile(path.join(ROOT, 'rules/live-rules.json'), 'utf8'));
  src.minAppVersion = src.minAppVersion || pkg.version;
  const packPath = path.join(OUT, 'rules/rules.json');
  await writeFile(packPath, JSON.stringify(src, null, 2) + '\n');
  const packSigned = sign(packPath, 'rules.json');
  console.log('rules/rules.json  v' + src.version + (packSigned ? '  (signed)' : '  (UNSIGNED, --no-sign)'));

  /* --- optional code patch --- */
  const patchFile = path.join(ROOT, 'patch/patch.js');
  if (existsSync(patchFile)) {
    const dest = path.join(OUT, 'patch/patch.js');
    await cp(patchFile, dest);
    const patchSigned = sign(dest, 'patch.js');
    const meta = existsSync(path.join(ROOT, 'patch/meta.json')) ? JSON.parse(await readFile(path.join(ROOT, 'patch/meta.json'), 'utf8')) : {};
    await writeFile(
      path.join(OUT, 'patch/meta.json'),
      JSON.stringify({ file: 'patch.js', version: Number(meta.version || src.version), minAppVersion: meta.minAppVersion || pkg.version, changelog: meta.changelog || '' }, null, 2)
    );
    console.log('patch/patch.js    v' + (meta.version || src.version) + (patchSigned ? '  (signed)' : '  (UNSIGNED, --no-sign)'));
  } else {
    console.log('- no patch/patch.js (code patch channel idle)');
  }

  // The live channel refuses unsigned payloads, so pushing an unsigned build
  // is a hard error rather than a silent publish of unloadable rules.
  if (push && noSign) {
    throw new Error('refusing to --push with --no-sign: the live channel rejects unsigned packs; re-run without --no-sign');
  }
  if (!push) {
    console.log('\ndry run only' + (noSign ? ' (unsigned preview --no-sign; the real live channel would reject this)' : '. Use --push to publish onto the `live` branch.'));
    return;
  }
  // Defense in depth: a missing .sig must never reach a push even if no-sign was not set.
  for (const rel of ['rules/rules.json', 'patch/patch.js']) {
    if (!existsSync(path.join(OUT, rel))) continue;
    if (!existsSync(path.join(OUT, rel + '.sig'))) throw new Error(`refusing to push: ${rel} has no ${rel}.sig (signing failed; publish aborted)`);
  }

  /* publish dist-live/ as an orphan branch (fast, no history pollution) */
  const tmp = path.join(ROOT, '.live-worktree');
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  try {
    run('git', ['fetch', 'origin', 'live']);
    run('git', ['worktree', 'add', '-B', 'live', tmp, 'origin/live']);
  } catch (_) {
    run('git', ['worktree', 'add', '--orphan', '-B', 'live', tmp]);
  }
  rmSync(path.join(tmp, 'rules'), { recursive: true, force: true });
  rmSync(path.join(tmp, 'patch'), { recursive: true, force: true });
  cpSync(OUT, tmp, { recursive: true });
  run('git', ['-c', 'core.autocrlf=false', '-C', tmp, 'add', '-A']);
  run('git', ['-C', tmp, 'commit', '-m', `live updates ${new Date().toISOString().slice(0, 16)} (rules v${src.version})`]);
  run('git', ['push', 'origin', 'live']);
  run('git', ['worktree', 'remove', '--force', tmp]);
  console.log('âœ“ pushed branch live');
}

// Sign one staged file. Returns true when a signature file is produced, false
// only for the explicit --no-sign preview mode. On a real signing failure it
// throws so the process exits non-zero BEFORE anything is published; an
// unsigned pack would break every installed extension that pulls it.
function sign(file, label) {
  if (noSign) return false;
  const kid = expectedKid();
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools/sign.mjs'), file], { stdio: 'pipe' });
  } catch (e) {
    const detail = (e.stderr && e.stderr.toString().trim()) || e.message;
    const at = signingKeyPath();
    throw new Error(
      `signing ${label || path.basename(file)} FAILED (publish aborted). sign.mjs: ${detail} | looked for key at "${at}" | extension trusts kid ${kid || '(unknown)'} | set STREAMRADAR_UPDATE_KEY or place the matching private key`
    );
  }
  if (!existsSync(file + '.sig')) {
    throw new Error(`signing ${label || path.basename(file)} FAILED: no .sig file was produced (looked for key at "${signingKeyPath()}", extension trusts kid ${kid || '(unknown)'})`);
  }
  return true;
}
main().catch((e) => {
  console.error('publish failed:', e.message);
  process.exit(1);
});
