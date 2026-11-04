import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

// The game's own map: pyramid.zip holds 256 px tiles where level 0 has one pixel per world
// tile, so a pixel coordinate is a world coordinate. Each level above halves the resolution.
const TILE = 256;
const BASE = [189, 197, 163]; // Same land color the game fills behind this layer.
const MAX_CACHED_TILES = 32; // One render touches about 16; 32 tiles use around 6 MB.
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_MS = 20 * 60 * 1000;
const FINAL_RETRY_MS = 6 * 60 * 60 * 1000;
const FIRST_RETRY_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;

class InvalidMap extends Error {}

const tileKey = (level, x, y) => level * 1e8 + x * 1e4 + y;

function readAt(fd, length, position) {
  const buffer = Buffer.alloc(length);
  if (readSync(fd, buffer, 0, length, position) !== length) throw new InvalidMap('short read');
  return buffer;
}

function readDirectory(fd) {
  const size = fstatSync(fd).size;
  const tailSize = Math.min(65557, size);
  if (tailSize < 22) throw new InvalidMap('not a zip');
  const tail = readAt(fd, tailSize, size - tailSize);
  const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  if (end < 0 || end + 22 > tail.length) throw new InvalidMap('not a zip');
  const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), start = tail.readUInt32LE(end + 16);
  if (start + length > size) throw new InvalidMap('bad directory');
  const directory = readAt(fd, length, start);
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > directory.length || directory.readUInt32LE(p) !== 0x02014b50) throw new InvalidMap('bad entry');
    const nameLength = directory.readUInt16LE(p + 28);
    entries.set(directory.toString('latin1', p + 46, p + 46 + nameLength), {
      method: directory.readUInt16LE(p + 10), size: directory.readUInt32LE(p + 20), offset: directory.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + directory.readUInt16LE(p + 30) + directory.readUInt16LE(p + 32);
  }
  return entries;
}

function readEntry(fd, entry) {
  if (entry.size > MAX_ENTRY_BYTES) throw new InvalidMap('entry too large');
  const header = readAt(fd, 30, entry.offset);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new InvalidMap('bad entry');
  const data = readAt(fd, entry.size, entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28));
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new InvalidMap('unknown compression');
  return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
}

// Tiles mix palette, RGB and RGBA. Returns RGB over the land color.
export function decodeTile(png) {
  let p = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, alpha = null;
  const parts = [];
  while (p + 12 <= png.length) {
    const length = png.readUInt32BE(p), kind = png.toString('latin1', p + 4, p + 8), body = png.subarray(p + 8, p + 8 + length);
    if (kind === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') alpha = body;
    else if (kind === 'IDAT') parts.push(body);
    p += 12 + length;
  }
  const bytes = { 2: 3, 3: 1, 6: 4 }[type];
  if (width !== TILE || height !== TILE || depth !== 8 || interlace || !bytes || (type === 3 && !palette)) throw new InvalidMap('unexpected tile');
  const stride = TILE * bytes;
  const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: (stride + 1) * TILE });
  if (raw.length !== (stride + 1) * TILE) throw new InvalidMap('short tile');
  const out = new Uint8Array(TILE * TILE * 3);
  let row = Buffer.alloc(stride), previous = Buffer.alloc(stride);
  for (let y = 0; y < TILE; y++) {
    const at = y * (stride + 1), filter = raw[at];
    for (let x = 0; x < stride; x++) {
      const a = x >= bytes ? row[x - bytes] : 0, b = previous[x], c = x >= bytes ? previous[x - bytes] : 0;
      let value = raw[at + 1 + x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const estimate = a + b - c, pa = Math.abs(estimate - a), pb = Math.abs(estimate - b), pc = Math.abs(estimate - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = value & 255;
    }
    for (let x = 0; x < TILE; x++) {
      const i = (y * TILE + x) * 3;
      let r, g, b, opacity = 255;
      if (type === 3) {
        const index = row[x];
        r = palette[index * 3]; g = palette[index * 3 + 1]; b = palette[index * 3 + 2];
        if (alpha && index < alpha.length) opacity = alpha[index];
      } else {
        const s = x * bytes;
        r = row[s]; g = row[s + 1]; b = row[s + 2];
        if (type === 6) opacity = row[s + 3];
      }
      const keep = opacity / 255;
      out[i] = r * keep + BASE[0] * (1 - keep); out[i + 1] = g * keep + BASE[1] * (1 - keep); out[i + 2] = b * keep + BASE[2] * (1 - keep);
    }
    [row, previous] = [previous, row];
  }
  return out;
}

export class WorldMap {
  // Throws when the file is not a pyramid with one pixel per tile: a different
  // scale would put every marker in the wrong place, so it must not be used.
  static open(path) {
    const fd = openSync(path, 'r');
    try {
      const entries = readDirectory(fd);
      const info = entries.get('pyramid.txt');
      if (!info) throw new InvalidMap('no pyramid.txt');
      const text = readEntry(fd, info).toString('latin1');
      const bounds = text.match(/^bounds=(-?\d+) (-?\d+) (-?\d+) (-?\d+)\s*$/m)?.slice(1).map(Number);
      const image = text.match(/^imageSize=(\d+) (\d+)\s*$/m)?.slice(1).map(Number);
      if (!/^VERSION=1\s*$/m.test(text) || !bounds || !image || bounds[2] - bounds[0] !== image[0] || bounds[3] - bounds[1] !== image[1]) throw new InvalidMap('unknown format');
      const tiles = new Map();
      let maxLevel = -1;
      for (const [name, entry] of entries) {
        const match = name.match(/^(\d+)\/tile(\d+)x(\d+)\.png$/);
        if (!match) continue;
        const level = Number(match[1]);
        tiles.set(tileKey(level, Number(match[2]), Number(match[3])), entry);
        if (level > maxLevel) maxLevel = level;
      }
      if (maxLevel < 0) throw new InvalidMap('no tiles');
      return new WorldMap(fd, tiles, maxLevel, bounds[0], bounds[1]);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  constructor(fd, tiles, maxLevel, originX, originY) {
    this.fd = fd; this.tiles = tiles; this.maxLevel = maxLevel; this.originX = originX; this.originY = originY;
    this.cache = new Map(); this.lastKey = -1; this.lastTile = null;
  }
  close() {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null; this.cache.clear(); this.lastTile = null; this.lastKey = -1;
  }
  tile(level, x, y) {
    if (x < 0 || y < 0) return null;
    const key = tileKey(level, x, y);
    if (key === this.lastKey) return this.lastTile;
    let tile = this.cache.get(key);
    if (tile === undefined) {
      const entry = this.tiles.get(key);
      // A damaged or absent tile leaves that area plain; the alert still goes out.
      try { tile = entry ? decodeTile(readEntry(this.fd, entry)) : null; } catch { tile = null; }
    } else this.cache.delete(key);
    this.cache.set(key, tile);
    if (this.cache.size > MAX_CACHED_TILES) this.cache.delete(this.cache.keys().next().value);
    this.lastKey = key; this.lastTile = tile;
    return tile;
  }
  // The returned function reuses its array: read the color before the next call.
  sampler(tilesPerPixel) {
    const level = Math.max(0, Math.min(this.maxLevel, Math.floor(Math.log2(Math.max(1, tilesPerPixel)))));
    const size = 2 ** level, color = [0, 0, 0];
    const read = (px, py, channel) => {
      const tile = this.tile(level, px >> 8, py >> 8);
      return tile ? tile[((py & 255) * TILE + (px & 255)) * 3 + channel] : BASE[channel];
    };
    return (worldX, worldY) => {
      const u = (worldX - this.originX) / size - 0.5, v = (worldY - this.originY) / size - 0.5;
      const x = Math.floor(u), y = Math.floor(v), fx = u - x, fy = v - y;
      for (let c = 0; c < 3; c++) {
        const top = read(x, y, c) * (1 - fx) + read(x + 1, y, c) * fx;
        const bottom = read(x, y + 1, c) * (1 - fx) + read(x + 1, y + 1, c) * fx;
        color[c] = top * (1 - fy) + bottom * fy;
      }
      return color;
    };
  }
}

const REASONS = {
  missing: 'arquivo nao encontrado no servidor; confira WORLD_MAP_FILE no SFTP',
  invalid: 'o arquivo baixado nao parece o mapa do jogo; confira WORLD_MAP_FILE',
  disk: 'nao foi possivel gravar o arquivo no disco do bot',
  'too-large': 'o arquivo passou do limite de tamanho',
  auth: 'o painel recusou a chave',
  forbidden: 'a chave nao tem acesso a este servidor',
  blocked: 'um firewall do painel bloqueou o download',
  'invalid-response': 'o painel nao entregou um link de download',
};
const FINAL = new Set(Object.keys(REASONS));

// Keeps the alerts flowing: the download runs beside the main loop, and until it
// finishes, or if it never does, alerts simply use the radar without a background.
export class WorldMapStore {
  constructor({ client, remotePath, localPath, log = console.log, clock = Date.now, signal }) {
    this.client = client; this.remotePath = remotePath; this.localPath = localPath; this.log = log; this.clock = clock; this.signal = signal;
    this.map = null; this.busy = null; this.nextTry = 0; this.failures = 0;
  }
  tick(serverId) {
    if (this.map || this.busy || this.clock() < this.nextTry || this.signal?.aborted) return;
    this.busy = this.load(serverId).finally(() => { this.busy = null; });
  }
  async load(serverId) {
    try {
      this.map = await this.reuse() ?? await this.download(serverId);
      this.failures = 0;
    } catch (error) {
      if (this.signal?.aborted) return;
      const kind = error instanceof InvalidMap ? 'invalid' : error.kind || 'network';
      const wait = FINAL.has(kind) ? FINAL_RETRY_MS : Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** this.failures);
      this.failures++;
      this.nextTry = this.clock() + wait;
      this.log(`[BotZomboid] mapa real indisponivel: ${REASONS[kind] || 'falha de rede ou do painel'}. Alertas seguem com o radar; nova tentativa em ${Math.round(wait / 60000)} min`);
    }
  }
  async reuse() {
    try { await stat(this.localPath); } catch { return null; }
    try {
      const map = WorldMap.open(this.localPath);
      this.log('[BotZomboid] mapa real carregado do disco');
      return map;
    } catch {
      await rm(this.localPath, { force: true }).catch(() => {});
      return null;
    }
  }
  async download(serverId) {
    this.log('[BotZomboid] baixando o mapa real do servidor; os alertas continuam enquanto isso');
    const temp = `${this.localPath}.tmp`;
    const controller = new AbortController();
    const stop = () => controller.abort();
    const timer = setTimeout(stop, DOWNLOAD_MS);
    this.signal?.addEventListener('abort', stop, { once: true });
    try {
      try { await mkdir(dirname(this.localPath), { recursive: true }); } catch { throw Object.assign(new Error('disk'), { kind: 'disk' }); }
      const bytes = await this.client.download(serverId, this.remotePath, temp, { signal: controller.signal });
      WorldMap.open(temp).close(); // Validate first: a bad file must never replace a good one.
      await rename(temp, this.localPath).catch(() => { throw Object.assign(new Error('disk'), { kind: 'disk' }); });
      const map = WorldMap.open(this.localPath);
      this.log(`[BotZomboid] mapa real pronto (${Math.round(bytes / 1048576)} MB)`);
      return map;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', stop);
      await rm(temp, { force: true }).catch(() => {});
    }
  }
  async close() {
    await this.busy;
    this.map?.close();
    this.map = null;
  }
}
