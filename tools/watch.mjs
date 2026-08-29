/**
 * Dev loop: rebuild dist/ on every src/ change and ping a stamp server so the
 * unpacked extension can chrome.runtime.reload() itself. You load dist/chrome
 * once; after that you should not need chrome://extensions → Reload.
 *
 *   npm run watch
 */
import { createServer } from 'node:http';
import { watch as fsWatch } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.STREAMRADAR_WATCH_PORT || 18765);
const DIRS = ['src', 'rules', 'userscript'].map((d) => path.join(ROOT, d));

let stamp = String(Date.now());
let building = false;
let queued = false;
let lastError = '';

function log(...a) {
  console.log('\x1b[36m▸\x1b[0m', ...a);
}
function ok(...a) {
  console.log('\x1b[32m✓\x1b[0m', ...a);
}
function fail(...a) {
  console.error('\x1b[31m✗\x1b[0m', ...a);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
}

const server = createServer((req, res) => {
  cors(res);
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  if (u.pathname === '/stamp' || u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: stamp, error: lastError || null, building }));
    return;
  }
  res.writeHead(404);
  res.end('nope');
});

function bumpStamp() {
  stamp = String(Date.now());
  writeFile(path.join(ROOT, 'dist', '.dev-stamp'), stamp + '\n').catch(() => {});
}

function build() {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  queued = false;
  const t0 = Date.now();
  log('rebuild…');
  const child = spawn(process.execPath, [path.join(HERE, 'build.mjs'), '--no-zip', '--dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => {
    building = false;
    if (code === 0) {
      lastError = '';
      bumpStamp();
      ok('rebuilt in', Date.now() - t0, 'ms — extension will self-reload (stamp', stamp + ')');
    } else {
      lastError = 'build exit ' + code;
      fail('build failed (extension not reloaded)');
    }
    if (queued) build();
  });
}

function onChange(event, filename) {
  if (!filename) return;
  const name = String(filename).replace(/\\/g, '/');
  if (name.includes('node_modules') || name.endsWith('.log') || name.includes('.dev-stamp')) return;
  log('change:', name);
  clearTimeout(onChange._t);
  onChange._t = setTimeout(build, 180);
}

await mkdir(path.join(ROOT, 'dist'), { recursive: true });

await new Promise((resolve, reject) => {
  server.listen(PORT, '127.0.0.1', resolve);
  server.on('error', reject);
});
ok('watch server http://127.0.0.1:' + PORT + '/stamp');
log('Load unpacked ONCE: dist/chrome  (or dist/firefox). Leave this process running.');

for (const dir of DIRS) {
  try {
    fsWatch(dir, { recursive: true }, onChange);
    log('watching', path.relative(ROOT, dir) + '/');
  } catch (e) {
    fail('cannot watch', dir, e.message);
  }
}

build();
