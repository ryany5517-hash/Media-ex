/**
 * Dependency-free ZIP writer (store + deflate) used to package the extension.
 * `web-ext`/`zip` CLIs would also work; keeping it in-repo means `npm run build`
 * never fails because a system tool is missing (and it runs on Windows too).
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return (((d.getHours() << 6) | d.getMinutes()) << 5) | (d.getSeconds() / 2);
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5)) | d.getDate();
}

async function walk(dir, base = '', out = []) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + ent.name : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(abs, rel, out);
    else out.push({ rel, abs });
  }
  return out;
}

/**
 * @param {string} srcDir directory to pack (paths inside the zip are relative to it)
 * @param {string} outFile .zip / .xpi destination
 */
export async function zip(srcDir, outFile) {
  const entries = await walk(srcDir);
  const now = new Date();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const data = await readFile(e.abs);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const nameBuf = Buffer.from(e.rel.replace(/\\/g, '/'), 'utf8');

    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 name flag
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime(now), 10);
    lfh.writeUInt16LE(dosDate(now), 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(lfh, 30);
    chunks.push(lfh, payload);

    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime(now), 12);
    cdh.writeUInt16LE(dosDate(now), 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    nameBuf.copy(cdh, 46);
    central.push(cdh);

    offset += lfh.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  await writeFile(outFile, Buffer.concat([...chunks, centralBuf, eocd]));
  return { files: entries.length, bytes: offset + centralBuf.length + 22 };
}
