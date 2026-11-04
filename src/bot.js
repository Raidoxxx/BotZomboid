import { rename } from 'node:fs/promises';
import { atomicState, loadState, Relay } from './relay.js';
import { PanelClient, RemoteTail } from './panel.js';

const LONG_PAUSE_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 60 * 1000;

const MESSAGES = {
  ok: 'lendo o arquivo de eventos',
  missing: 'servidor ou arquivo nao encontrado. O mod so cria o arquivo com DiscordWebhookEnabled=true; confira EVENTS_FILE e SERVER_ID',
  auth: 'o painel recusou a chave (HTTP 401). Confira PANEL_API_KEY',
  forbidden: 'a chave nao tem acesso a este servidor (HTTP 403). Confira SERVER_ID e a lista de IPs da chave',
  blocked: 'HTTP 403 sem resposta da API: um firewall do painel pode estar bloqueando este bot. Peca a hospedagem para liberar /api/client',
  rate: 'limite de requisicoes do painel atingido; aguardando',
  'too-large': 'o painel recusou o arquivo por tamanho',
  network: 'sem conexao com o painel; tentando de novo',
  server: 'o painel respondeu com erro; tentando de novo',
  http: 'resposta inesperada do painel; tentando de novo',
  'invalid-response': 'PANEL_URL respondeu, mas nao parece um Pterodactyl',
};

// A corrupt state must not stop a hosted bot forever. Starting clean is safe:
// the relay ignores events older than 30 minutes.
async function openState(path, log) {
  try { return await loadState(path); } catch {
    await rename(path, `${path}.invalid`).catch(() => {});
    log('[BotZomboid] estado invalido guardado como .invalid; iniciando do zero');
    return loadState(path);
  }
}

function delayFor(error, failures) {
  if (['auth', 'forbidden', 'blocked', 'too-large', 'invalid-response'].includes(error.kind)) return LONG_PAUSE_MS;
  if (error.kind === 'rate') return error.retryAfterMs;
  return Math.min(MAX_BACKOFF_MS, 5000 * 2 ** Math.min(failures, 6));
}

// Only state changes reach the log: an outage must not write one line per poll.
function reporter(log) {
  let last = null;
  return (status, detail = '') => {
    if (status === last) return;
    last = status;
    log(`[BotZomboid] ${MESSAGES[status] || status}${detail}`);
  };
}

async function resolveServer(config, client, log) {
  if (config.serverId) return config.serverId;
  const servers = await client.listServers();
  if (servers.length === 1 && servers[0].id) {
    log(`[BotZomboid] servidor encontrado: ${servers[0].id}`);
    return servers[0].id;
  }
  if (!servers.length) throw new Error('a chave nao tem nenhum servidor');
  throw new Error(`defina SERVER_ID; a conta tem varios: ${servers.map(s => s.id).join(', ')}`);
}

export async function run(config, {
  signal, log = console.log, panelFetch = fetch, discordFetch = fetch, clock = Date.now, tickMs = 1000,
} = {}) {
  const state = await openState(config.stateFile, log);
  const relay = new Relay({ url: config.webhook, state, clock, fetchFn: discordFetch, log, serverName: config.serverName, maxPerMinute: config.maxPerMinute });
  const client = new PanelClient({ baseUrl: config.panelUrl, apiKey: config.apiKey, fetchFn: panelFetch });
  const report = reporter(log);
  log(`[BotZomboid] iniciado; Node ${process.versions.node}; painel ${new URL(config.panelUrl).host}; credenciais nunca sao registradas`);

  let tail = null, failures = 0, nextPoll = 0, polls = 0, read = 0, nextBeat = clock() + HEARTBEAT_MS;
  let saved = JSON.stringify(state);
  const save = async () => {
    const current = JSON.stringify(state);
    if (current === saved) return;
    await atomicState(config.stateFile, state);
    saved = current;
  };

  while (!signal?.aborted) {
    const now = clock();
    if (now >= nextPoll) {
      try {
        if (!tail) {
          const serverId = await resolveServer(config, client, log);
          state.cursor = state.cursor || {};
          tail = new RemoteTail(client, serverId, config.eventsFile, state.cursor);
        }
        const result = await tail.poll(event => relay.ingest(event));
        polls++; read += result.events; failures = 0;
        report(result.missing ? 'missing' : 'ok');
        nextPoll = clock() + config.pollMs;
      } catch (error) {
        // Account errors from resolveServer are final for this configuration.
        if (!error.kind && !tail) throw error;
        failures++;
        report(error.kind || 'http');
        nextPoll = clock() + delayFor(error, failures);
      }
    }
    try {
      await save();
      await relay.pump();
      await save();
    } catch {
      log('[BotZomboid] nao foi possivel gravar o estado; continuando em memoria');
    }
    if (clock() >= nextBeat) {
      nextBeat = clock() + HEARTBEAT_MS;
      log(`[BotZomboid] ativo; leituras=${polls} eventos=${read} fila=${state.queue.length}`);
    }
    if (!signal?.aborted) {
      await new Promise(resolve => {
        const timer = setTimeout(done, tickMs);
        function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
  await save().catch(() => {});
  log('[BotZomboid] encerrado');
}
