import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { compass, mapData, renderMap } from '../src/map.js';
import { payload, repair, Relay } from '../src/relay.js';

const HOOK = `https://discord.com/api/webhooks/${'1'.repeat(18)}/${'x'.repeat(24)}`;
const MESSAGE = '222222222222222222';
const R = '�';
const event = (data = {}, players) => ({
  v: 1, id: 'map:1', kind: 'nearby', priority: 3, at: Date.now(), cooldown: 60000, maxPerMinute: 6,
  data: {
    herd: 'h16', count: 56, state: 'MIGRATING', x: 10960, y: 9940, destX: 10800, destY: 10100, level: 3,
    players: players ?? [{ name: 'Raidoxx', distance: 75, level: 3, x: 10900, y: 9990 }],
    ...data,
  },
});
function decode(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8; const idat = [];
  let width, height;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'IHDR') { width = png.readUInt32BE(offset + 8); height = png.readUInt32BE(offset + 12); }
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixel = (x, y) => [...raw.subarray(y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3)];
  return { width, height, pixel };
}

test('compass uses the game axes: x east, y south', () => {
  assert.equal(compass(10, 0), 'Leste');
  assert.equal(compass(0, 10), 'Sul');
  assert.equal(compass(0, -10), 'Norte');
  assert.equal(compass(-10, 0), 'Oeste');
  assert.equal(compass(10, -10), 'Nordeste');
  assert.equal(compass(-10, 10), 'Sudoeste');
  assert.equal(compass(0, 0), null);
});

test('renders a valid image with the herd on the correct side', () => {
  const { width, height, pixel } = decode(renderMap(event({ x: 11000, y: 9990, count: 100, destX: undefined, destY: undefined })));
  assert.deepEqual([width, height], [512, 512]);
  // The herd is due east of the only player, so its red disc is right of center.
  let red = 0;
  for (let x = 300; x < 500; x++) { const [r, g] = pixel(x, 262); if (r > 200 && g < 90) red++; }
  assert.ok(red > 10, `herd disc not found east of center: ${red}`);
  for (let x = 12; x < 212; x++) { const [r, g] = pixel(x, 262); assert.ok(!(r > 200 && g < 90), 'red on the west side'); }
});

test('an estimated herd is drawn hollow, never as a confirmed red disc', () => {
  const players = [{ name: 'A', distance: 75, x: 10900, y: 9990, estimated: true }];
  const { pixel } = decode(renderMap(event({ x: 11000, y: 9990, destX: undefined, destY: undefined }, players)));
  for (let y = 0; y < 512; y += 2) for (let x = 0; x < 512; x += 2) { const [r, g, b] = pixel(x, y); assert.ok(!(r > 200 && g < 90 && b < 90), 'found confirmed-herd red'); }
});

test('survives awkward input: same spot, accents, long names, routes off the image', () => {
  const players = [
    { name: 'Stravinsky', distance: 75, x: 10900, y: 9990 }, { name: 'Raidoxx', distance: 75, x: 10900, y: 9990 },
    { name: 'João Ñandú 日本語', distance: 75, x: 10901, y: 9991 }, { name: 'x'.repeat(200), distance: 2000, x: 12900, y: 7990 },
  ];
  assert.ok(renderMap(event({ destX: 19000, destY: 900 }, players)).length > 100);
  assert.ok(renderMap(event({ x: 10900, y: 9990, destX: 10900, destY: 9990 }, players.slice(0, 1))).length > 100); // On top of the player.
  assert.ok(renderMap(event({ count: undefined }, players.slice(0, 1))).length > 100);
});

test('events without coordinates have no map: mods before 0.3.1 keep working', () => {
  assert.equal(mapData(event({ x: undefined })), null);
  assert.equal(mapData(event({}, [{ name: 'A', distance: 10 }])), null);
  assert.equal(mapData(event({ x: 'NaN' })), null);
  assert.equal(mapData(event({ x: 1e9 })), null);
  assert.equal(renderMap({ kind: 'startup', data: { session: 's' } }), null);
});

test('the exact strings seen in Discord are repaired', () => {
  assert.equal(repair(`Regi${R}o n${R}o identificada`), 'Região não identificada');
  assert.equal(repair(`proje${R}${R}o l${R}gica; presen${R}a f${R}sica n${R}o confirmada`), 'projeção lógica; presença física não confirmada');
  assert.equal(repair(`centro observado; dist${R}ncia aproximada`), 'centro observado; distância aproximada');
  assert.equal(repair(`v${R}nculos sem confirma${R}${R}o liberados`), 'vínculos sem confirmação liberados');
  assert.equal(repair(`A integra${R}${R}o Discord est${R} habilitada.`), 'A integração Discord está habilitada.');
  assert.equal(repair('Zona nativa: Nav ação'), 'Zona nativa: Nav ação');
  assert.equal(repair(`palavra${R}desconhecida`), `palavra${R}desconhecida`);
});

test('repaired text reaches the message, including from an old mod event', () => {
  const data = { herd: 'h', count: 56, state: 'ATTRACTED', region: `Regi${R}o n${R}o identificada`, positionKind: `proje${R}${R}o l${R}gica`, level: 3, players: [{ name: 'A', distance: 75, level: 3, estimated: true }] };
  const json = JSON.stringify(payload([{ kind: 'nearby', priority: 3, at: 1793710000000, data }], 'S'));
  assert.ok(!json.includes(R));
  assert.ok(json.includes('Região não identificada'));
});

test('an unconfirmed projection never reads as a critical danger', () => {
  const data = { herd: 'h', count: 56, level: 3, players: [{ name: 'A', distance: 75, level: 3, estimated: true }, { name: 'B', distance: 75, level: 3, estimated: true }] };
  const embed = payload([{ kind: 'nearby', priority: 3, at: 1793710000000, data }], 'S').embeds[0];
  assert.match(embed.title, /POSSÍVEL HORDA/);
  assert.equal(embed.fields.find(f => f.name === 'Nível').value, 'NÃO CONFIRMADO');
  assert.equal(embed.color, 0xf1c40f);
  const mixed = { ...data, players: [{ name: 'A', distance: 75, level: 3, estimated: false }] };
  const real = payload([{ kind: 'nearby', priority: 3, at: 1793710000000, data: mixed }], 'S').embeds[0];
  assert.match(real.title, /JOGADOR PRÓXIMO/);
  assert.equal(real.fields.find(f => f.name === 'Nível').value, 'CRÍTICO');
  assert.equal(real.color, 0xe74c3c);
});

test('message text says which way the herd is and where it heads', () => {
  const embed = payload([event()], 'S').embeds[0];
  const fields = Object.fromEntries(embed.fields.map(f => [f.name, f.value]));
  assert.match(fields.Sobreviventes, /Raidoxx — 75 tiles, horda a Nordeste/);
  assert.equal(fields['Rumo da horda'], 'Sudoeste');
  assert.equal(fields['Coordenadas da horda'], '10960, 9940');
});

function relayWith(fetchFn, extra = {}) {
  const logs = [];
  const state = { version: 1, queue: [], seen: {}, cooldowns: {}, sent: [], nextRequest: 0, disabledUntil: 0 };
  return { state, logs, relay: new Relay({ url: HOOK, state, fetchFn, log: s => logs.push(s), ...extra }) };
}
const ok = () => new Response(JSON.stringify({ id: MESSAGE }), { status: 200 });

test('real multipart reaches a local server in the format Discord documents', async () => {
  let received;
  const server = createServer((req, res) => {
    const parts = [];
    req.on('data', d => parts.push(d));
    req.on('end', () => {
      received = { type: req.headers['content-type'], body: Buffer.concat(parts), url: req.url };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: MESSAGE }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { relay, state, logs } = relayWith((url, init) => { const u = new URL(url); return fetch(base + u.pathname + u.search, init); });
  assert.ok(relay.ingest(event()));
  state.queue[0].nextAt = 0;
  assert.equal(await relay.pump(), true, logs.join());
  server.close();
  assert.match(received.type, /^multipart\/form-data; boundary=/);
  assert.match(received.url, /wait=true/);
  const form = await new Response(received.body, { headers: { 'content-type': received.type } }).formData();
  const json = JSON.parse(form.get('payload_json'));
  assert.equal(json.embeds[0].image.url, 'attachment://mapa.png');
  assert.deepEqual(json.attachments, [{ id: 0, filename: 'mapa.png' }]);
  assert.deepEqual(json.allowed_mentions.parse, []);
  const file = form.get('files[0]');
  assert.equal(file.name, 'mapa.png');
  assert.equal(file.type, 'image/png');
  assert.equal(decode(Buffer.from(await file.arrayBuffer())).width, 512);
});

test('a map failure still delivers the alert as text', async () => {
  let init;
  const { relay, state, logs } = relayWith(async (_, i) => { init = i; return ok(); }, { render: () => { throw new Error('boom'); } });
  relay.ingest(event()); state.queue[0].nextAt = 0;
  assert.equal(await relay.pump(), true);
  assert.equal(typeof init.body, 'string');
  assert.equal(JSON.parse(init.body).embeds[0].image, undefined);
  assert.ok(logs.some(s => s.includes('mapa nao gerado')));
  assert.ok(!logs.some(s => s.includes('boom')));
});

test('events without coordinates stay plain JSON, and report edits never carry a map', async () => {
  const inits = [];
  const { relay, state } = relayWith(async (_, i) => { inits.push(i); return ok(); });
  relay.ingest(event({ x: undefined })); state.queue[0].nextAt = 0;
  await relay.pump();
  assert.equal(inits[0].headers['Content-Type'], 'application/json');
  state.messageID = MESSAGE; state.cooldowns = {};
  const report = { ...event(), id: 'r', kind: 'report', data: { herds: 1, x: 1, y: 1, players: [{ name: 'A', x: 2, y: 2 }] } };
  relay.ingest(report); state.queue[0].nextAt = 0;
  await relay.pump();
  assert.equal(inits[1].method, 'PATCH');
  assert.equal(typeof inits[1].body, 'string');
});

test('a retry after a failure sends the map again', async () => {
  const bodies = [];
  let calls = 0;
  const { relay, state } = relayWith(async (_, i) => { bodies.push(i.body); return ++calls === 1 ? new Response('', { status: 500 }) : ok(); });
  relay.ingest(event()); state.queue[0].nextAt = 0;
  await relay.pump();
  state.queue[0].nextAt = 0; state.sent = [];
  assert.equal(await relay.pump(), true);
  assert.ok(bodies[1] instanceof FormData);
  assert.ok(bodies[1].get('files[0]').size > 100);
});
