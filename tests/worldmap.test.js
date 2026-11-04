import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deflateRawSync, deflateSync, inflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { PanelClient } from '../src/panel.js';
import { decodeTile, WorldMap, WorldMapStore } from '../src/worldmap.js';
import { renderMap } from '../src/map.js';
import { run } from '../src/bot.js';
import { MARKER } from '../src/relay.js';

// Everything here uses tiny generated fixtures: game files never enter this public repository.
const KEY = `ptlc_${'a'.repeat(40)}`;
const HOOK = `https://discord.com/api/webhooks/${'1'.repeat(18)}/${'x'.repeat(24)}`;
const MESSAGE = '222222222222222222';
const REMOTE = '/media/maps/Muldraugh, KY/pyramid.zip';
const TOKEN = 'token-secreto-do-link';

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  return out; // The decoder ignores CRCs, as they would only repeat the zip's own check.
}
function tilePng(rgbAt, { type = 2, filter = 0 } = {}) {
  const channels = { 2: 3, 3: 1, 6: 4 }[type], stride = 256 * channels;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = type;
  const raw = Buffer.alloc((stride + 1) * 256);
  for (let y = 0; y < 256; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < 256; x++) {
      const color = rgbAt(x, y);
      for (let c = 0; c < channels; c++) raw[y * (stride + 1) + 1 + x * channels + c] = color[c];
    }
  }
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)];
  if (type === 3) parts.push(chunk('PLTE', Buffer.from([10, 20, 30, 200, 100, 50])));
  parts.push(chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
function zip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(content), title = Buffer.from(name, 'latin1');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(title.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(data.length, 20); entry.writeUInt16LE(title.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, title, data); central.push(entry, title);
    offset += local.length + title.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const INFO = 'VERSION=1\nbounds=0 0 512 256\nimageSize=512 256';
const WEST = [200, 40, 40], EAST = [40, 40, 200];
// Two tiles side by side: world x below 256 is reddish, from 256 on bluish.
const fixture = (info = INFO) => zip({
  'pyramid.txt': Buffer.from(info),
  '0/tile0x0.png': tilePng(() => WEST),
  '0/tile1x0.png': tilePng(() => EAST),
  '1/tile0x0.png': tilePng(x => x < 128 ? WEST : EAST),
});
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'bz-map-'));
  return { dir, zipPath: join(dir, 'pyramid.zip'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}
async function openFixture(t, info) {
  const w = await workspace();
  t.after(w.cleanup);
  await writeFile(w.zipPath, fixture(info));
  const map = WorldMap.open(w.zipPath);
  t.after(() => map.close());
  return map;
}
function pixels(png) {
  let offset = 8, width = 0; const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'IHDR') width = png.readUInt32BE(offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return (x, y) => [...raw.subarray(y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3)];
}
const near = (actual, expected, margin = 12) => actual.every((value, i) => Math.abs(value - expected[i]) <= margin);

test('tiles decode from palette, RGB and RGBA, undoing the PNG row filters', () => {
  const palette = decodeTile(tilePng(() => [1], { type: 3 }));
  assert.deepEqual([...palette.subarray(0, 3)], [200, 100, 50]);
  const rgb = decodeTile(tilePng((x, y) => [x, y, 7]));
  assert.deepEqual([...rgb.subarray((10 * 256 + 20) * 3, (10 * 256 + 20) * 3 + 3)], [20, 10, 7]);
  // Filter 2 adds the row above: a constant raw value accumulates down the column.
  const sub = decodeTile(tilePng(() => [1, 0, 0], { filter: 2 }));
  assert.equal(sub[(5 * 256) * 3], 6);
  // Filter 1 adds the pixel to the left, 4 picks the nearest of left, above and corner.
  const left = decodeTile(tilePng(() => [2, 0, 0], { filter: 1 }));
  assert.equal(left[4 * 3], 10);
  const paeth = decodeTile(tilePng(() => [1, 0, 0], { filter: 4 }));
  assert.equal(paeth[3], 2); // First row: only the left neighbour exists.
  assert.equal(paeth[(256 + 0) * 3], 2); // First column: only the row above exists.
  // Transparent pixels fall back to the land color.
  const clear = decodeTile(tilePng(() => [0, 0, 0, 0], { type: 6 }));
  assert.deepEqual([...clear.subarray(0, 3)], [189, 197, 163]);
});

test('files that would misplace the markers are refused', async t => {
  const w = await workspace();
  t.after(w.cleanup);
  for (const content of [
    Buffer.from('nada a ver'),
    zip({ 'outro.txt': Buffer.from('x') }),
    zip({ 'pyramid.txt': Buffer.from(INFO) }), // No tiles at all.
    fixture('VERSION=1\nbounds=0 0 1024 512\nimageSize=512 256'), // Half a pixel per tile.
    fixture('VERSION=2\nbounds=0 0 512 256\nimageSize=512 256'),
  ]) {
    await writeFile(w.zipPath, content);
    assert.throws(() => WorldMap.open(w.zipPath));
  }
});

test('world coordinates hit the right tile, and the area outside the map is plain land', async t => {
  const map = await openFixture(t);
  const sample = map.sampler(1);
  assert.ok(near([...sample(100, 100)], WEST, 1));
  assert.ok(near([...sample(400, 100)], EAST, 1));
  assert.ok(near([...sample(5000, 5000)], [189, 197, 163], 1));
  assert.ok(near([...sample(-50, -50)], [189, 197, 163], 1));
  // Farther zoom uses the smaller level, where each pixel covers two world tiles.
  const zoomedOut = map.sampler(2.5);
  assert.ok(near([...zoomedOut(100, 100)], WEST, 1));
  assert.ok(near([...zoomedOut(400, 100)], EAST, 1));
});

test('a damaged tile leaves that area plain instead of failing the alert', async t => {
  const w = await workspace();
  t.after(w.cleanup);
  await writeFile(w.zipPath, zip({ 'pyramid.txt': Buffer.from(INFO), '0/tile0x0.png': Buffer.from('nao e png') }));
  const map = WorldMap.open(w.zipPath);
  t.after(() => map.close());
  assert.ok(near([...map.sampler(1)(100, 100)], [189, 197, 163], 1));
});

test('the image puts the real map under the markers at the right place', async t => {
  const map = await openFixture(t);
  const event = { data: { x: 300, y: 128, count: 20, players: [{ name: 'A', x: 212, y: 128 }] } };
  const at = pixels(renderMap(event, { worldMap: map }));
  // Reach is forced to 200 tiles over 212 pixels, centered on x=212. World x=256, the seam
  // between the tiles, is about 47 pixels right of the center.
  const seam = 256 + Math.round((256 - 212) * 212 / 200);
  assert.ok(near(at(seam - 6, 180), WEST), `west of the seam: ${at(seam - 6, 180)}`);
  assert.ok(near(at(seam + 6, 180), EAST), `east of the seam: ${at(seam + 6, 180)}`);
});

test('without a map the image is the same radar as before', () => {
  const event = { data: { x: 300, y: 128, count: 20, players: [{ name: 'A', x: 212, y: 128 }] } };
  assert.deepEqual(renderMap(event), renderMap(event, { worldMap: null }));
  assert.deepEqual(pixels(renderMap(event))(5, 100), [18, 22, 28]);
});

function panelFetch({ zipBytes, nodeStatus = 200, calls = [] }) {
  return async (url, init = {}) => {
    const target = new URL(url);
    calls.push({ url: target, headers: init.headers ?? {} });
    if (target.pathname.endsWith('/files/download')) {
      return new Response(JSON.stringify({ object: 'signed_url', attributes: { url: `https://no.exemplo.com/download/file?token=${TOKEN}` } }), { status: 200 });
    }
    if (target.hostname === 'no.exemplo.com') return new Response(nodeStatus === 200 ? zipBytes : '', { status: nodeStatus });
    return new Response('', { status: 200 });
  };
}
function store(w, fetchFn, extra = {}) {
  const logs = [];
  const client = new PanelClient({ baseUrl: 'https://painel.exemplo.com', apiKey: KEY, fetchFn });
  return { logs, store: new WorldMapStore({ client, remotePath: REMOTE, localPath: w.zipPath, log: s => logs.push(s), ...extra }) };
}

test('download asks for the encoded path, keeps the key from the node and keeps the link out of the log', async t => {
  const w = await workspace();
  t.after(w.cleanup);
  const calls = [];
  const s = store(w, panelFetch({ zipBytes: fixture(), calls }));
  s.store.tick('abc12345');
  await s.store.busy;
  assert.ok(s.store.map, s.logs.join('|'));
  assert.equal(calls[0].url.searchParams.get('file'), REMOTE);
  assert.match(calls[0].url.search, /Muldraugh%2C%20KY/);
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[1].url.hostname, 'no.exemplo.com');
  assert.equal(calls[1].headers.Authorization, undefined);
  const logged = s.logs.join('|');
  assert.ok(!logged.includes(TOKEN) && !logged.includes(KEY));
  assert.ok(logged.includes('mapa real pronto'));
  await s.store.close();
});

test('a map already on disk is reused without calling the panel', async t => {
  const w = await workspace();
  t.after(w.cleanup);
  await writeFile(w.zipPath, fixture());
  const s = store(w, async () => assert.fail('should not call the panel'));
  s.store.tick('abc12345');
  await s.store.busy;
  assert.ok(s.store.map);
  await s.store.close();
});

test('a corrupt map on disk is replaced by a new download', async t => {
  const w = await workspace();
  t.after(w.cleanup);
  await writeFile(w.zipPath, 'corrompido');
  const s = store(w, panelFetch({ zipBytes: fixture() }));
  s.store.tick('abc12345');
  await s.store.busy;
  assert.ok(s.store.map, s.logs.join('|'));
  await s.store.close();
  assert.equal((await readFile(w.zipPath)).length, fixture().length);
});

test('a file missing on the server explains itself and waits hours before trying again', async t => {
  const w = await workspace();
  t.after(w.cleanup);
  let now = 1000, calls = 0;
  const fetching = panelFetch({ nodeStatus: 404 });
  const s = store(w, (...args) => { calls++; return fetching(...args); }, { clock: () => now });
  s.store.tick('abc12345');
  await s.store.busy;
  assert.equal(s.store.map, null);
  assert.ok(s.logs.at(-1).includes('WORLD_MAP_FILE'));
  assert.ok(s.logs.at(-1).includes('360 min'));
  const before = calls;
  now += 3600000;
  s.store.tick('abc12345');
  assert.equal(s.store.busy, null);
  assert.equal(calls, before);
  now += 6 * 3600000;
  s.store.tick('abc12345');
  await s.store.busy;
  assert.ok(calls > before);
});

test('a network failure retries sooner and with a growing wait', async t => {
  const w = await workspace();
  t.after(w.cleanup);
  let now = 1000;
  const s = store(w, async () => { throw new Error('offline'); }, { clock: () => now });
  s.store.tick('abc12345');
  await s.store.busy;
  assert.ok(s.logs.at(-1).includes('5 min'));
  now += 5 * 60000;
  s.store.tick('abc12345');
  await s.store.busy;
  assert.ok(s.logs.at(-1).includes('10 min'));
});

test('a bad or oversized download leaves nothing behind', async t => {
  const w = await workspace();
  t.after(w.cleanup);
  const s = store(w, panelFetch({ zipBytes: Buffer.from('<html>erro</html>') }));
  s.store.tick('abc12345');
  await s.store.busy;
  assert.equal(s.store.map, null);
  assert.ok(s.logs.at(-1).includes('nao parece o mapa'));
  assert.ok(!existsSync(w.zipPath) && !existsSync(`${w.zipPath}.tmp`));

  const client = new PanelClient({ baseUrl: 'https://painel.exemplo.com', apiKey: KEY, fetchFn: panelFetch({ zipBytes: Buffer.alloc(5000) }) });
  await assert.rejects(client.download('abc12345', REMOTE, `${w.zipPath}.big`, { maxBytes: 1000 }), e => e.kind === 'too-large');
});

test('config: default path, empty disables, and paths outside the server are refused', () => {
  const env = { PANEL_URL: 'https://painel.exemplo.com', PANEL_API_KEY: KEY, DISCORD_WEBHOOK_URL: HOOK };
  assert.equal(loadConfig(env).worldMapFile, REMOTE);
  assert.equal(loadConfig({ ...env, WORLD_MAP_FILE: '' }).worldMapFile, '');
  assert.throws(() => loadConfig({ ...env, WORLD_MAP_FILE: 'relativo.zip' }), /WORLD_MAP_FILE/);
  assert.throws(() => loadConfig({ ...env, WORLD_MAP_FILE: '/a/../../b.zip' }), /WORLD_MAP_FILE/);
});

test('whole bot: downloads from a real HTTP server, then alerts carry the map', async t => {
  const w = await workspace();
  t.after(w.cleanup);
  const line = id => MARKER + JSON.stringify({ v: 1, id, kind: 'nearby', priority: 3, at: Date.now(), cooldown: 60000, maxPerMinute: 6,
    data: { herd: id, count: 20, state: 'MIGRATING', x: 300, y: 128, level: 3, players: [{ name: 'A', distance: 88, level: 3, x: 212, y: 128 }] } }) + '\n';
  const bytes = fixture();
  let auth = 'unset';
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/download/file') {
      auth = req.headers.authorization;
      res.writeHead(200, { 'content-length': bytes.length });
      return res.end(bytes);
    }
    if (url.pathname.endsWith('/files/download')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ attributes: { url: `http://127.0.0.1:${server.address().port}/download/file?token=${TOKEN}` } }));
    }
    if (url.pathname.endsWith('/files/contents')) { res.writeHead(200); return res.end(line('h1')); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const local = `http://127.0.0.1:${server.address().port}`;
  const panel = (url, init) => { const u = new URL(url); return fetch(u.hostname === '127.0.0.1' ? u : local + u.pathname + u.search, init); };
  const controller = new AbortController();
  const sent = [], logs = [];
  const discord = async (_, init) => { sent.push(init.body); return new Response(JSON.stringify({ id: MESSAGE }), { status: 200 }); };
  const config = { ...loadConfig({ PANEL_URL: 'https://painel.exemplo.com', PANEL_API_KEY: KEY, DISCORD_WEBHOOK_URL: HOOK, SERVER_ID: 'abcd1234', POLL_SECONDS: '5' }), stateFile: join(w.dir, 'state.json') };
  const running = run(config, { signal: controller.signal, log: s => logs.push(s), panelFetch: panel, discordFetch: discord, ipFetch: async () => new Response('203.0.113.9'), tickMs: 20 });
  for (let i = 0; i < 400 && !logs.some(s => s.includes('mapa real pronto')); i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(logs.some(s => s.includes('mapa real pronto')), logs.join('|'));
  for (let i = 0; i < 400 && !sent.length; i++) await new Promise(r => setTimeout(r, 25));
  controller.abort();
  await running;
  assert.equal(auth, undefined);
  assert.ok(!logs.join('|').includes(TOKEN));
  assert.ok(existsSync(join(w.dir, 'pyramid.zip')));
  assert.ok(sent[0] instanceof FormData, 'the alert should carry an image');
});
