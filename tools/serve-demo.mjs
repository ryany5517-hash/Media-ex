/** Tiny static server for the detection demo page (no dependencies). */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8088);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '/demo' || p === '/demo/') p = '/demo/index.html';
  if (p.endsWith('.ts')) {
    // a "segment": 64 KB of junk so the extension can show real byte counts
    res.writeHead(200, { 'content-type': TYPES['.ts'], 'content-length': String(65536), 'access-control-allow-origin': '*' });
    return res.end(Buffer.alloc(65536));
  }
  if (p.endsWith('.mp4')) {
    res.writeHead(200, { 'content-type': TYPES['.mp4'], 'content-length': '3145728', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' });
    return res.end(Buffer.alloc(1024));
  }
  try {
    const body = await readFile(path.join(ROOT, p.replace(/^\/+/, '')));
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'access-control-allow-origin': '*' });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404 ' + p);
  }
}).listen(PORT, '0.0.0.0', () => console.log(`demo → http://localhost:${PORT}/demo/index.html`));
