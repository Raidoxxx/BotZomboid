import { readFile } from 'node:fs/promises';
import { webhookURL } from './relay.js';

const DEFAULT_EVENTS_FILE = '/.cache/Lua/LivingHerds-discord-events.txt';
const DEFAULT_WORLD_MAP_FILE = '/media/maps/Muldraugh, KY/pyramid.zip';

export function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

// Discloud generates .env at runtime on GitHub deploys. Real environment values win.
export async function loadEnvFile(path, env = process.env) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('.env nao pode ser lido');
  }
  for (const [key, value] of Object.entries(parseEnv(text))) if (env[key] === undefined) env[key] = value;
}

function panelBase(raw) {
  if (!raw) throw new Error('defina PANEL_URL');
  let url;
  try { url = new URL(raw); } catch { throw new Error('PANEL_URL invalido'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('PANEL_URL deve ser somente https://dominio-do-painel');
  }
  return url.origin;
}

function integer(raw, min, max, fallback) {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export function loadConfig(env = process.env) {
  const apiKey = env.PANEL_API_KEY || '';
  if (!apiKey) throw new Error('defina PANEL_API_KEY');
  if (apiKey.startsWith('ptla_')) throw new Error('PANEL_API_KEY e uma chave de aplicacao; use uma chave de cliente (ptlc_)');
  if (!/^ptlc_[A-Za-z0-9]+$/.test(apiKey)) throw new Error('PANEL_API_KEY nao parece uma chave de cliente (ptlc_)');
  if (!env.DISCORD_WEBHOOK_URL) throw new Error('defina DISCORD_WEBHOOK_URL');
  webhookURL(env.DISCORD_WEBHOOK_URL); // Its error text never includes the URL.
  const serverId = env.SERVER_ID || null;
  if (serverId && !/^[0-9a-f]{8}(?:-[0-9a-f-]{27})?$/i.test(serverId)) throw new Error('SERVER_ID invalido');
  const eventsFile = env.EVENTS_FILE || DEFAULT_EVENTS_FILE;
  if (!eventsFile.startsWith('/') || eventsFile.split('/').includes('..')) throw new Error('EVENTS_FILE deve ser um caminho absoluto dentro do servidor');
  // An empty value turns the real map off; alerts then use the plain radar.
  const worldMapFile = env.WORLD_MAP_FILE === undefined ? DEFAULT_WORLD_MAP_FILE : env.WORLD_MAP_FILE;
  if (worldMapFile && (!worldMapFile.startsWith('/') || worldMapFile.split('/').includes('..'))) throw new Error('WORLD_MAP_FILE deve ser um caminho absoluto dentro do servidor');
  return {
    panelUrl: panelBase(env.PANEL_URL), apiKey, serverId, eventsFile, worldMapFile,
    webhook: env.DISCORD_WEBHOOK_URL,
    serverName: env.SERVER_NAME || 'Living Herds',
    pollMs: integer(env.POLL_SECONDS, 5, 300, 20) * 1000,
    maxPerMinute: integer(env.MAX_PER_MINUTE, 1, 30, 6),
    stateFile: env.STATE_FILE || 'data/state.json',
  };
}
