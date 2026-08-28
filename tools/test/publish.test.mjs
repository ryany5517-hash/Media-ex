/**
 * Live publisher (tools/publish-live.mjs) safety contract.
 * ------------------------------------------------------------------
 * The old publisher swallowed signing failures ("signing skipped") and carried
 * on, which would publish an unsigned pack that every installed extension
 * rejects. These tests run the real publisher script in throwaway copy repos
 * (never the real repo, never a real key, never a network push -- the signing
 * step fails before any git command runs) and assert:
 *   1. with no signing key, a publish aborts (non-zero) BEFORE touching the
 *      destination worktree, and its message names the key path and kid;
 *   2. the explicit local preview flag --no-sign is allowed for dry-run;
 *   3. --no-sign together with --push is refused and still touches nothing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const PUBLISHER = path.join(REPO, 'tools/publish-live.mjs');
const SIGNER = path.join(REPO, 'tools/sign.mjs');

let scratch = null;

/** A throwaway "repo" containing only what the publisher reads before signing. */
function makeFakeRepo(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sr-publish-'));
  mkdirSync(path.join(dir, 'tools'), { recursive: true });
  mkdirSync(path.join(dir, 'rules'), { recursive: true });
  mkdirSync(path.join(dir, 'src/shared'), { recursive: true });
  copyFileSync(PUBLISHER, path.join(dir, 'tools/publish-live.mjs'));
  copyFileSync(SIGNER, path.join(dir, 'tools/sign.mjs'));
  copyFileSync(path.join(REPO, 'package.json'), path.join(dir, 'package.json'));
  copyFileSync(path.join(REPO, 'src/shared/updater.js'), path.join(dir, 'src/shared/updater.js'));
  // A valid rule source identical in shape to rules/live-rules.json.
  const pack = {
    version: 2026082802,
    minAppVersion: '1.0.0',
    embedHosts: ['example.test'],
    adHosts: [],
    junkPhrases: [],
    junkTokens: [],
    mediaExt: [],
    blockPatterns: '',
    notes: 'publish test',
  };
  mkdirSync(path.join(dir, 'rules'), { recursive: true });
  writeFileSync(path.join(dir, 'rules/live-rules.json'), JSON.stringify(pack, null, 2));
  // No private key anywhere; HOME pointed away from the real one.
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'sr-home-'));
  return { dir, fakeHome, name };
}

function run(dir, fakeHome, args) {
  return spawnSync(process.execPath, [path.join(dir, 'tools/publish-live.mjs'), ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      // No key in env, and HOME/USERPROFILE point at an empty dir so no real key.
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      STREAMRADAR_UPDATE_KEY: '',
    },
    encoding: 'utf8',
  });
}

before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'sr-publish-root-'));
});
after(() => {
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
});

test('publish aborts non-zero when signing fails and touches no worktree', () => {
  const { dir, fakeHome } = makeFakeRepo('nokey');
  const r = run(dir, fakeHome, ['--push']);
  assert.notEqual(r.status, 0, 'publisher must exit non-zero without a signing key');
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /signing rules\.json FAILED|no signing key|publish failed/i, 'must report the signing failure');
  assert.match(out, /UZ33kOys/, 'error message must name the trusted kid');
  assert.match(out, /stream-radar-update-key\.json|STREAMRADAR_UPDATE_KEY/, 'error message must name the key path checked');
  // Never got as far as creating the live worktree or staging a signature.
  assert.ok(!existsSync(path.join(dir, '.live-worktree')), 'no live worktree must be created on signing failure');
  assert.ok(!existsSync(path.join(dir, 'dist-live/rules/rules.json.sig')), 'no .sig must be left behind on failure');
  rmSync(dir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

test('--no-sign dry-run is allowed for local preview and reports it is unsigned', () => {
  const { dir, fakeHome } = makeFakeRepo('nosign-dry');
  const r = run(dir, fakeHome, ['--no-sign']);
  assert.equal(r.status, 0, '--no-sign dry-run must succeed');
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /dry run only/i, 'must state it is a dry run');
  assert.match(out, /UNSIGNED/, 'must make the unsigned state explicit');
  assert.ok(!existsSync(path.join(dir, '.live-worktree')), 'dry-run never creates a live worktree');
  rmSync(dir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

test('--no-sign together with --push is refused and writes nothing to live', () => {
  const { dir, fakeHome } = makeFakeRepo('nosign-push');
  const r = run(dir, fakeHome, ['--push', '--no-sign']);
  assert.notEqual(r.status, 0, 'pushing an unsigned pack must be refused');
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /refusing|reject/i, 'must explain the refusal');
  assert.ok(!existsSync(path.join(dir, '.live-worktree')), 'no live worktree must be created');
  rmSync(dir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});
