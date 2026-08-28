/**
 * Build the `live` branch payload (rule packs + optional signed code patch).
 *
 *   node tools/publish-live.mjs            → just writes dist-live/
 *   node tools/publish-live.mjs --push     → commits dist-live/ onto branch `live` and pushes
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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'dist-live');
const push = process.argv.includes('--push');

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  await mkdir(path.join(OUT, 'rules'), { recursive: true });
  await mkdir(path.join(OUT, 'patch'), { recursive: true });

  /* --- rule pack --- */
  const src = JSON.parse(await readFile(path.join(ROOT, 'rules/live-rules.json'), 'utf8'));
  src.minAppVersion = src.minAppVersion || pkg.version;
  const packPath = path.join(OUT, 'rules/rules.json');
  await writeFile(packPath, JSON.stringify(src, null, 2) + '\n');
  sign(packPath);
  console.log('✓ rules/rules.json  v' + src.version);

  /* --- optional code patch --- */
  const patchFile = path.join(ROOT, 'patch/patch.js');
  if (existsSync(patchFile)) {
    const dest = path.join(OUT, 'patch/patch.js');
    await cp(patchFile, dest);
    sign(dest);
    const meta = existsSync(path.join(ROOT, 'patch/meta.json')) ? JSON.parse(await readFile(path.join(ROOT, 'patch/meta.json'), 'utf8')) : {};
    await writeFile(
      path.join(OUT, 'patch/meta.json'),
      JSON.stringify({ file: 'patch.js', version: Number(meta.version || src.version), minAppVersion: meta.minAppVersion || pkg.version, changelog: meta.changelog || '' }, null, 2)
    );
    console.log('✓ patch/patch.js    v' + (meta.version || src.version));
  } else {
    console.log('· no patch/patch.js (code patch channel idle)');
  }

  if (!push) {
    console.log('\ndry run only. Use --push to publish onto the `live` branch.');
    return;
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
  execFileSync('bash', ['-c', `rm -rf rules patch && cp -r ${OUT}/* .`, { cwd: tmp, stdio: 'inherit' }]);
  run('git', ['-C', tmp, 'add', '-A']);
  run('git', ['-C', tmp, 'commit', '-m', `live updates ${new Date().toISOString().slice(0, 16)} (rules v${src.version})`]);
  run('git', ['push', 'origin', 'live']);
  run('git', ['worktree', 'remove', '--force', tmp]);
  console.log('✓ pushed branch live');
}

function sign(file) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools/sign.mjs'), file], { stdio: 'inherit' });
  } catch (e) {
    console.error('\x1b[33m!\x1b[0m signing skipped (no key?): ' + e.message);
  }
}
main().catch((e) => {
  console.error('publish failed:', e.message);
  process.exit(1);
});
