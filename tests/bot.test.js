import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, loadConfig, loadEnvFile } from '../src/config.js';
import { PanelClient, PanelError, RemoteTail } from '../src/panel.js';
import { run } from '../src/bot.js';
import { publicIp } from '../src/network.js';
import { MARKER } from '../src/relay.js';

// Non-secret fixtures.
const KEY = `ptlc_${'a'.repeat(40)}`;
const HOOK = `https://discord.com/api/webhooks/${'1'.repeat(18)}/${'x'.repeat(24)}`;
const ENV = { PANEL_URL: 'https://painel.exemplo.com', PANEL_API_KEY: KEY, DISCORD_WEBHOOK_URL: HOOK };
const line = (id, kind = 'created', at = Date.now()) =>
  MARKER + JSON.stringify({ v: 1, id, kind, priority: 3, at, cooldown: 60000, maxPerMinute: 6, data: { herd: id, count: 12, state: 'MERGING' } }) + '\n';
const client = sequence => {
  let i = 0;
  return { fileContents: async () => {
    const item = sequence[Math.min(i++, sequence.length - 1)];
    if (item instanceof Error) throw item;
    return Buffer.from(item);
  } };
};

test('.env parser handles quotes, comments, export and CRLF', () => {
  assert.deepEqual(parseEnv('# c\r\nA=1\r\nexport B="dois"\nC=\'tres\'\nnada\nD=a=b\n'), { A: '1', B: 'dois', C: 'tres', D: 'a=b' });
});

test('real environment values win over .env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bz-'));
  const path = join(dir, '.env');
  await writeFile(path, 'A=arquivo\nB=arquivo\n');
  const env = { A: 'real' };
  await loadEnvFile(path, env);
  assert.deepEqual(env, { A: 'real', B: 'arquivo' });
  await loadEnvFile(join(dir, 'ausente'), env); // Missing file is fine.
  await rm(dir, { recursive: true });
});

test('config defaults point at the file the mod writes', () => {
  const c = loadConfig(ENV);
  assert.equal(c.eventsFile, '/.cache/Lua/LivingHerds-discord-events.txt');
  assert.equal(c.pollMs, 20000);
  assert.equal(c.panelUrl, 'https://painel.exemplo.com');
  assert.equal(loadConfig({ ...ENV, POLL_SECONDS: '1' }).pollMs, 5000);
});

test('config errors never contain secret values', () => {
  const cases = [
    [{ ...ENV, PANEL_API_KEY: '' }],
    [{ ...ENV, PANEL_API_KEY: `ptla_${'b'.repeat(40)}` }],
    [{ ...ENV, PANEL_API_KEY: 'senha-errada-secreta' }],
    [{ ...ENV, DISCORD_WEBHOOK_URL: 'https://evil.example/segredo-webhook' }],
    [{ ...ENV, PANEL_URL: 'http://painel.exemplo.com' }],
    [{ ...ENV, PANEL_URL: 'https://user:segredo@painel.exemplo.com' }],
    [{ ...ENV, PANEL_URL: 'https://painel.exemplo.com/api/client' }],
    [{ ...ENV, SERVER_ID: '../../etc' }],
    [{ ...ENV, EVENTS_FILE: '/.cache/../../etc/passwd' }],
  ];
  for (const [env] of cases) {
    assert.throws(() => loadConfig(env), error => {
      assert.doesNotMatch(error.message, /ptl[ac]_[a-z0-9]{8}|secreta|segredo/);
      return true;
    });
  }
});

test('panel requests send the key only as a header and refuse redirects', async () => {
  let seen;
  const panel = new PanelClient({ baseUrl: 'https://painel.exemplo.com', apiKey: KEY, fetchFn: async (url, init) => {
    seen = { url: String(url), init };
    return new Response('dados', { status: 200 });
  } });
  assert.equal((await panel.fileContents('abcd1234', '/.cache/Lua/a b.txt')).toString(), 'dados');
  assert.equal(seen.url, 'https://painel.exemplo.com/api/client/servers/abcd1234/files/contents?file=%2F.cache%2FLua%2Fa%20b.txt');
  assert.equal(seen.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.headers['User-Agent'], 'BotZomboid/0.3.0');
  assert.ok(!seen.url.includes(KEY));
});

test('panel statuses map to kinds, and 403 tells a firewall from the API', async () => {
  const fails = async (status, type = 'application/json', headers = {}) => {
    const panel = new PanelClient({ baseUrl: 'https://p.exemplo.com', apiKey: KEY, fetchFn: async () => new Response('corpo secreto', { status, headers: { 'content-type': type, ...headers } }) });
    return panel.fileContents('abcd1234', '/a').then(() => assert.fail('should throw'), error => error);
  };
  assert.equal((await fails(401)).kind, 'auth');
  assert.equal((await fails(403)).kind, 'forbidden');
  assert.equal((await fails(403, 'text/html')).kind, 'blocked');
  assert.equal((await fails(404)).kind, 'missing');
  assert.equal((await fails(500)).kind, 'server');
  const rate = await fails(429, 'application/json', { 'retry-after': '7' });
  assert.equal(rate.kind, 'rate'); assert.equal(rate.retryAfterMs, 7000);
  assert.doesNotMatch((await fails(500)).message, /secreto/);
  const offline = new PanelClient({ baseUrl: 'https://p.exemplo.com', apiKey: KEY, fetchFn: async () => { throw new Error(`rede ${KEY}`); } });
  const error = await offline.fileContents('abcd1234', '/a').catch(e => e);
  assert.equal(error.kind, 'network'); assert.ok(!error.message.includes(KEY));
});

test('tail reads each line once and waits for partial lines', async () => {
  const a = line('a'), b = line('b');
  const tail = new RemoteTail(client([a, a, a + b.slice(0, 20), a + b]), 'id', '/f');
  const got = [];
  const poll = () => tail.poll(e => got.push(e.id));
  await poll(); assert.deepEqual(got, ['a']);
  await poll(); assert.deepEqual(got, ['a']);
  await poll(); assert.deepEqual(got, ['a']);
  await poll(); assert.deepEqual(got, ['a', 'b']);
});

test('tail restarts when the mod rewrites the file, smaller or not', async () => {
  const a = line('a'), b = line('b'), c = line('c');
  const bigger = c + line('d') + line('e');
  const tail = new RemoteTail(client([a + b, c, bigger]), 'id', '/f');
  const got = [];
  await tail.poll(e => got.push(e.id)); assert.deepEqual(got, ['a', 'b']);
  await tail.poll(e => got.push(e.id)); assert.deepEqual(got, ['a', 'b', 'c']); // Smaller.
  const regrown = new RemoteTail(client([a + b, bigger]), 'id', '/f');
  const again = [];
  await regrown.poll(e => again.push(e.id));
  await regrown.poll(e => again.push(e.id)); // Larger, with different bytes before the offset.
  assert.deepEqual(again, ['a', 'b', 'c', 'd', 'e']);
});

test('tail ignores other text and survives a missing file', async () => {
  const a = line('a');
  const tail = new RemoteTail(client([new PanelError('missing', 404), `jogador falou algo\n${MARKER}nao json\n${a}`]), 'id', '/f');
  const got = [];
  assert.equal((await tail.poll(e => got.push(e.id))).missing, true);
  assert.equal((await tail.poll(e => got.push(e.id))).events, 1);
  assert.deepEqual(got, ['a']);
});

test('tail keeps its position across a restart', async () => {
  const a = line('a'), b = line('b');
  const cursor = {};
  await new RemoteTail(client([a]), 'id', '/f', cursor).poll(() => {});
  const saved = JSON.parse(JSON.stringify(cursor));
  const got = [];
  await new RemoteTail(client([a + b]), 'id', '/f', saved).poll(e => got.push(e.id));
  assert.deepEqual(got, ['b']);
});

function harness(config) {
  const logs = [], controller = new AbortController();
  return { logs, controller, options: extra => ({ signal: controller.signal, log: s => logs.push(s), tickMs: 5, ipFetch: async () => new Response('203.0.113.7\n'), ...extra }), config };
}
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 5));
  }
};

test('end to end over real HTTP: panel file becomes one Discord message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bz-'));
  const posts = [], panelHits = [];
  let file = line('a');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (req.url.startsWith('/api/webhooks/')) {
        posts.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: '222222222222222222' }));
        return;
      }
      panelHits.push({ url: req.url, auth: req.headers.authorization });
      if (req.url === '/api/client') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ attributes: { identifier: 'abcd1234', name: 'PZ' } }] }));
      } else { res.writeHead(200); res.end(file); }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${server.address().port}`;
  const rewrite = (url, init) => { const u = new URL(url); return fetch(local + u.pathname + u.search, { ...init, redirect: 'manual' }); };
  const config = { ...loadConfig(ENV), pollMs: 10, stateFile: join(dir, 'state.json') };
  const h = harness(config);
  const running = run(config, h.options({ panelFetch: rewrite, discordFetch: rewrite }));
  await until(() => posts.length === 1);
  assert.match(panelHits.at(-1).url, /^\/api\/client\/servers\/abcd1234\/files\/contents\?file=/);
  assert.equal(panelHits[0].auth, `Bearer ${KEY}`);
  assert.equal(posts[0].auth, undefined); // The panel key never goes to Discord.
  assert.match(posts[0].body.embeds[0].title, /HORDA CRIADA/);
  h.controller.abort();
  await running;
  server.close();
  const state = JSON.parse(await readFile(config.stateFile, 'utf8'));
  assert.ok(state.cursor.offset > 0);
  assert.equal(posts.length, 1);
  const all = h.logs.join('\n');
  assert.ok(!all.includes(KEY) && !all.includes('x'.repeat(24)));
  await rm(dir, { recursive: true });
});

test('a rejected key stays quiet, stops polling and names the cause once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bz-'));
  let hits = 0;
  const panelFetch = async () => { hits++; return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }); };
  const config = { ...loadConfig({ ...ENV, SERVER_ID: 'abcd1234' }), pollMs: 5, stateFile: join(dir, 'state.json') };
  const h = harness(config);
  const running = run(config, h.options({ panelFetch, discordFetch: async () => assert.fail('no discord call') }));
  await new Promise(r => setTimeout(r, 120));
  h.controller.abort();
  await running;
  assert.equal(hits, 1);
  assert.equal(h.logs.filter(s => s.includes('HTTP 401')).length, 1);
  await rm(dir, { recursive: true });
});

test('a corrupt state file cannot stop the bot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bz-'));
  const stateFile = join(dir, 'state.json');
  await writeFile(stateFile, '{quebrado');
  const config = { ...loadConfig({ ...ENV, SERVER_ID: 'abcd1234' }), pollMs: 5, stateFile };
  const h = harness(config);
  const panelFetch = async () => new Response('', { status: 200 });
  const running = run(config, h.options({ panelFetch, discordFetch: async () => assert.fail('nothing to send') }));
  await until(() => h.logs.some(s => s.includes('lendo o arquivo')));
  h.controller.abort();
  await running;
  assert.ok(h.logs.some(s => s.includes('estado invalido')));
  await rm(dir, { recursive: true });
});

test('several servers on the account require SERVER_ID, without guessing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bz-'));
  const config = { ...loadConfig(ENV), stateFile: join(dir, 'state.json') };
  const h = harness(config);
  const panelFetch = async () => new Response(JSON.stringify({ data: [{ attributes: { identifier: 'aaaa1111' } }, { attributes: { identifier: 'bbbb2222' } }] }), { status: 200 });
  await assert.rejects(run(config, h.options({ panelFetch })), /SERVER_ID.*aaaa1111.*bbbb2222/);
  await rm(dir, { recursive: true });
});

test('public IP lookup uses the next source and never throws', async () => {
  const calls = [];
  const sources = ['https://a.exemplo.com', 'https://b.exemplo.com'];
  const reply = answers => async (url, init) => {
    calls.push({ url, init });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  assert.equal(await publicIp(reply([new Response('203.0.113.7\n')]), sources), '203.0.113.7');
  assert.equal(await publicIp(reply([new Response('2001:db8::1')]), sources), '2001:db8::1');
  assert.equal(await publicIp(reply([new Error('offline'), new Response('203.0.113.8')]), sources), '203.0.113.8');
  assert.equal(await publicIp(reply([new Response('', { status: 500 }), new Response('203.0.113.9')]), sources), '203.0.113.9');
  assert.equal(await publicIp(reply([new Response('<html>nao e ip</html>'), new Error('offline')]), sources), null);
  for (const { init } of calls) {
    assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.keys(init.headers), ['User-Agent']); // No credential leaves with this request.
  }
});

test('startup log shows the public IP, and a failed lookup does not stop the bot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bz-'));
  const config = { ...loadConfig({ ...ENV, SERVER_ID: 'abcd1234' }), pollMs: 5, stateFile: join(dir, 'state.json') };
  const panelFetch = async () => new Response('', { status: 200 });
  const discordFetch = async () => assert.fail('nothing to send');
  const ok = harness(config);
  let running = run(config, ok.options({ panelFetch, discordFetch }));
  await until(() => ok.logs.some(s => s.includes('lendo o arquivo')));
  ok.controller.abort(); await running;
  assert.ok(ok.logs.includes('[BotZomboid] IP publico: 203.0.113.7'));
  const down = harness(config);
  running = run(config, down.options({ panelFetch, discordFetch, ipFetch: async () => { throw new Error('offline'); } }));
  await until(() => down.logs.some(s => s.includes('lendo o arquivo')));
  down.controller.abort(); await running;
  assert.ok(down.logs.includes('[BotZomboid] IP publico: nao foi possivel descobrir'));
  await rm(dir, { recursive: true });
});

test('no tracked file contains a credential', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(files.includes('discloud.config'));
  assert.ok(!files.includes('.env'));
  const panelKey = new RegExp('ptl[ac]_[A-Za-z0-9]{30,}');
  const webhook = new RegExp('discord(?:app)?\\.com/api(?:/v\\d+)?/webhooks/\\d{17,20}/[A-Za-z0-9_-]{50,}');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, panelKey, file);
    assert.doesNotMatch(text, webhook, file);
  }
});
