import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { payload, Relay } from '../src/relay.js';
import { renderMap } from '../src/map.js';

const HOOK = `https://discord.com/api/webhooks/${'1'.repeat(18)}/${'x'.repeat(24)}`;
const MESSAGE = '222222222222222222';
const PLAYER = { name: 'Raidoxx', x: 7926, y: 11489 };
const herdEvent = (n, { x = 7900 + n, y = 11450 + n, count = 20 + n, estimated = true, priority = 1, level = 1, kind = 'nearby', at = Date.now(), player = PLAYER, ...data } = {}) => ({
  v: 1, id: `e:${n}`, kind, priority, at, cooldown: 600000, maxPerMinute: 6,
  data: { herd: `epoca:h${n}`, count, state: 'MIGRATING', x, y, level, players: [{ ...player, distance: Math.round(Math.hypot(x - player.x, y - player.y)), level, estimated }], ...data },
});
function relayWith(fetchFn, extra = {}) {
  const logs = [];
  const state = { version: 1, queue: [], seen: {}, cooldowns: {}, sent: [], nextRequest: 0, disabledUntil: 0 };
  let now = 1793787973000;
  const relay = new Relay({ url: HOOK, state, fetchFn, log: s => logs.push(s), maxPerMinute: 30, clock: () => now, ...extra });
  return { relay, state, logs, advance: ms => { now += ms; }, now: () => now };
}
const ok = () => new Response(JSON.stringify({ id: MESSAGE }), { status: 200 });
const realEvents = (r, list) => list.forEach(e => assert.ok(r.relay.ingest({ ...e, at: r.now() })));
function pixels(png) {
  let offset = 8; const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return (x, y) => [...raw.subarray(y * 1537 + 1 + x * 3, y * 1537 + 4 + x * 3)];
}

test('the 13 alerts of one scan arrive as one message with one image', async () => {
  const sent = [];
  const r = relayWith(async (_, init) => { sent.push(init.body); return ok(); });
  realEvents(r, Array.from({ length: 13 }, (_, i) => herdEvent(i + 1)));
  assert.equal(await r.relay.pump(), false, 'should wait for the rest of the scan');
  r.advance(25000);
  assert.equal(await r.relay.pump(), true);
  r.advance(2000);
  assert.equal(await r.relay.pump(), false, 'nothing left to send');
  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof FormData);
  const embed = JSON.parse(sent[0].get('payload_json')).embeds[0];
  assert.match(embed.title, /POSSÍVEIS HORDAS/);
  assert.match(embed.description, /13 hordas/);
  const rows = embed.fields.filter(f => f.name.startsWith('Hordas')).map(f => f.value).join('\n').split('\n');
  assert.equal(rows.length, 13);
  assert.match(rows[0], /^🟡 h\d+ — \d+ walkers, \d+ tiles a /);
  assert.equal(embed.fields.find(f => f.name === 'Nível').value, 'NÃO CONFIRMADO');
  assert.equal(r.state.queue.length, 0);
  assert.ok(r.logs.at(-1).includes('alertas agrupados=13'));
});

test('alerts spread over two updates of the mod still join the same message', async () => {
  const sent = [];
  const r = relayWith(async (_, init) => { sent.push(init.body); return ok(); });
  realEvents(r, Array.from({ length: 8 }, (_, i) => herdEvent(i + 1)));
  r.advance(10000);
  await r.relay.pump();
  realEvents(r, Array.from({ length: 5 }, (_, i) => herdEvent(i + 9)));
  r.advance(15000);
  assert.equal(await r.relay.pump(), true);
  assert.equal(sent.length, 1);
  assert.match(JSON.parse(sent[0].get('payload_json')).embeds[0].description, /13 hordas/);
});

test('after the message, more herds at the same level stay quiet but a higher level still alerts', async () => {
  const sent = [];
  const r = relayWith(async (_, init) => { sent.push(init.body); return ok(); });
  realEvents(r, [herdEvent(1), herdEvent(2)]);
  r.advance(25000);
  await r.relay.pump();
  r.advance(2000);
  assert.equal(r.relay.ingest({ ...herdEvent(3), at: r.now() }), false);
  assert.equal(r.relay.ingest({ ...herdEvent(4, { level: 2, priority: 2, estimated: false }), at: r.now() }), true);
});

test('a critical alert does not wait and takes the queue along', async () => {
  const sent = [];
  const r = relayWith(async (_, init) => { sent.push(init.body); return ok(); });
  realEvents(r, [herdEvent(1), herdEvent(2), herdEvent(3, { priority: 3, level: 3, estimated: false })]);
  assert.equal(await r.relay.pump(), true);
  assert.equal(sent.length, 1);
  const embed = JSON.parse(sent[0].get('payload_json')).embeds[0];
  assert.match(embed.title, /JOGADOR PRÓXIMO DE HORDAS/);
  assert.equal(embed.color, 0xe74c3c);
  assert.equal(embed.fields.find(f => f.name === 'Nível').value, 'CRÍTICO');
  const rows = embed.fields.find(f => f.name.startsWith('Hordas')).value.split('\n');
  assert.match(rows[0], /^🔴 h3 /, 'an observed herd comes first');
  assert.equal(r.state.queue.length, 0);
});

test('an estimate reported as critical by an old mod never sets the alarm', () => {
  const embed = payload([herdEvent(1, { priority: 3, level: 3 }), herdEvent(2, { priority: 3, level: 3 })], 'S').embeds[0];
  assert.match(embed.title, /POSSÍVEIS HORDAS/);
  assert.equal(embed.color, 0xf1c40f);
  assert.equal(embed.fields.find(f => f.name === 'Nível').value, 'NÃO CONFIRMADO');
});

test('an observed herd and estimates: only the observed one sets the level', () => {
  const embed = payload([herdEvent(1, { priority: 3, level: 3 }), herdEvent(2, { priority: 1, level: 1, estimated: false })], 'S').embeds[0];
  assert.equal(embed.fields.find(f => f.name === 'Nível').value, 'ATENÇÃO');
  assert.match(embed.description, /1 com zumbis observados; 1 só estimada/);
});

test('players far apart get separate messages, each with its own map', async () => {
  const sent = [];
  const r = relayWith(async (_, init) => { sent.push(init.body); return ok(); });
  const far = { name: 'Stravinsky', x: 12000, y: 7000 };
  realEvents(r, [herdEvent(1), herdEvent(2), herdEvent(3, { x: 12010, y: 7010, player: far }), herdEvent(4, { x: 12020, y: 7020, player: far })]);
  r.advance(25000);
  await r.relay.pump();
  r.advance(1500);
  await r.relay.pump();
  assert.equal(sent.length, 2);
  const titles = sent.map(b => JSON.parse(b.get('payload_json')).embeds[0].fields.find(f => f.name === 'Sobreviventes').value);
  assert.match(titles[0], /Raidoxx/); assert.ok(!titles[0].includes('Stravinsky'));
  assert.match(titles[1], /Stravinsky/); assert.ok(!titles[1].includes('Raidoxx'));
});

test('a failure retries the whole group as one message', async () => {
  const sent = [];
  let calls = 0;
  const r = relayWith(async (_, init) => { sent.push(init.body); return ++calls === 1 ? new Response('', { status: 500 }) : ok(); });
  realEvents(r, [herdEvent(1), herdEvent(2), herdEvent(3)]);
  r.advance(25000);
  await r.relay.pump();
  assert.equal(r.state.queue.length, 3);
  assert.equal(await r.relay.pump(), false, 'backoff applies to everyone in the group');
  r.advance(5000);
  assert.equal(await r.relay.pump(), true);
  assert.equal(sent.length, 2);
  assert.match(JSON.parse(sent[1].get('payload_json')).embeds[0].description, /3 hordas/);
  assert.equal(r.state.queue.length, 0);
});

test('giving up after six attempts drops the whole group', async () => {
  const r = relayWith(async () => new Response('', { status: 500 }));
  realEvents(r, [herdEvent(1), herdEvent(2)]);
  for (let i = 0; i < 6; i++) { r.advance(70000); await r.relay.pump(); }
  assert.equal(r.state.queue.length, 0);
  assert.ok(r.state.seen['e:1'] && r.state.seen['e:2']);
});

test('without coordinates alerts still group, as text', async () => {
  const sent = [];
  const r = relayWith(async (_, init) => { sent.push(init); return ok(); });
  const strip = e => { const { x, y, ...data } = e.data; return { ...e, data: { ...data, players: data.players.map(({ x: px, y: py, ...p }) => p) } }; };
  realEvents(r, [strip(herdEvent(1)), strip(herdEvent(2))]);
  r.advance(25000);
  await r.relay.pump();
  assert.equal(sent.length, 1);
  assert.equal(typeof sent[0].body, 'string');
  assert.match(JSON.parse(sent[0].body).embeds[0].description, /2 hordas/);
});

test('other kinds of event are never grouped, and a lone alert keeps the single layout', async () => {
  const sent = [];
  const r = relayWith(async (_, init) => { sent.push(init.body); return ok(); });
  realEvents(r, [herdEvent(1), { ...herdEvent(2), kind: 'created', data: { herd: 'epoca:h2', count: 5, state: 'MERGING' } }]);
  r.advance(25000);
  await r.relay.pump();
  r.advance(2000);
  await r.relay.pump();
  assert.equal(sent.length, 2);
  const titles = sent.map(b => (typeof b === 'string' ? JSON.parse(b) : JSON.parse(b.get('payload_json'))).embeds[0].title).join('|');
  assert.match(titles, /POSSÍVEL HORDA POR PERTO/);
  assert.match(titles, /HORDA CRIADA/);
});

test('a same herd reported as nearby and approaching appears once', () => {
  const nearby = herdEvent(1);
  const approaching = { ...herdEvent(1, { kind: 'approaching', estimated: false, priority: 2, level: 2 }), id: 'e:1b' };
  const embed = payload([nearby, approaching, herdEvent(2)], 'S').embeds[0];
  const rows = embed.fields.find(f => f.name.startsWith('Hordas')).value.split('\n');
  assert.equal(rows.length, 2);
  assert.match(embed.title, /SE APROXIMANDO/);
});

test('the largest possible group stays inside the embed limits, even with hostile names', () => {
  const list = Array.from({ length: 32 }, (_, i) => herdEvent(i + 1, { herd: `epoca:${'*'.repeat(200)}${i}`, state: '`'.repeat(100), player: { ...PLAYER, name: `<@${'9'.repeat(300)}>${i}` } }));
  const embed = payload(list, 'S').embeds[0];
  const total = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  assert.ok(total <= 6000, `total ${total}`);
  assert.ok(embed.fields.length <= 25);
  for (const f of embed.fields) assert.ok(f.value.length <= 1024, `field ${f.value.length}`);
});

test('the image shows every herd on the correct side, observed ones in solid red', () => {
  const list = [
    herdEvent(1, { x: PLAYER.x + 200, y: PLAYER.y, count: 100, estimated: false }), // East, observed.
    herdEvent(2, { x: PLAYER.x - 200, y: PLAYER.y, count: 100 }), // West, estimated.
  ];
  const at = pixels(renderMap(list));
  const scan = (from, to, wanted) => { let hits = 0; for (let x = from; x < to; x++) { const [r, g, b] = at(x, 262); if (wanted(r, g, b)) hits++; } return hits; };
  const red = (r, g, b) => r > 200 && g < 90 && b < 90, amber = (r, g, b) => r > 200 && g > 140 && b < 90;
  assert.ok(scan(270, 500, red) > 10, 'observed herd missing on the east');
  assert.equal(scan(12, 240, red), 0, 'no red on the west');
  assert.ok(scan(12, 240, amber) > 0, 'estimated herd missing on the west');
});

test('a group image survives one player, repeated herds and missing counts', () => {
  const list = [herdEvent(1, { count: undefined }), herdEvent(1), herdEvent(2, { x: 7926, y: 11489 }), herdEvent(3, { destX: 20000, destY: 900 })];
  assert.ok(renderMap(list).length > 100);
});
