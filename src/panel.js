import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseLine } from './relay.js';

const USER_AGENT = 'BotZomboid/0.3.0';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

// Kinds, never bodies: an error response could echo headers or file contents.
export class PanelError extends Error {
  constructor(kind, status = 0, retryAfterMs = 0) {
    super(`painel: ${kind}${status ? ` (HTTP ${status})` : ''}`);
    this.kind = kind; this.status = status; this.retryAfterMs = retryAfterMs;
  }
}

export class PanelClient {
  constructor({ baseUrl, apiKey, fetchFn = fetch }) {
    this.baseUrl = baseUrl; this.apiKey = apiKey; this.fetch = fetchFn;
  }
  async request(path) {
    let response;
    try {
      response = await this.fetch(new URL(path, this.baseUrl), {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15000),
        redirect: 'error', // A redirect must never carry the key to another host.
      });
    } catch { throw new PanelError('network'); }
    if (response.ok) return response;
    const { status } = response;
    const type = response.headers.get('content-type') || '';
    await response.body?.cancel().catch(() => {});
    if (status === 401) throw new PanelError('auth', status);
    if (status === 403) throw new PanelError(type.includes('json') ? 'forbidden' : 'blocked', status);
    if (status === 404) throw new PanelError('missing', status);
    if (status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw new PanelError('rate', status, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000);
    }
    if (status === 400 || status === 413) throw new PanelError('too-large', status);
    throw new PanelError(status >= 500 ? 'server' : 'http', status);
  }
  async listServers() {
    const response = await this.request('/api/client');
    let json;
    try { json = await response.json(); } catch { throw new PanelError('invalid-response'); }
    if (!Array.isArray(json?.data)) throw new PanelError('invalid-response');
    return json.data.map(item => ({ id: item.attributes?.identifier, name: item.attributes?.name }));
  }
  async fileContents(serverId, path) {
    const response = await this.request(`/api/client/servers/${encodeURIComponent(serverId)}/files/contents?file=${encodeURIComponent(path)}`);
    const bytes = Buffer.from(await response.arrayBuffer().catch(() => { throw new PanelError('network'); }));
    if (bytes.length > MAX_FILE_BYTES) throw new PanelError('too-large');
    return bytes;
  }
  async downloadUrl(serverId, path) {
    const response = await this.request(`/api/client/servers/${encodeURIComponent(serverId)}/files/download?file=${encodeURIComponent(path)}`);
    let url;
    try { url = new URL((await response.json()).attributes.url); } catch { throw new PanelError('invalid-response'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new PanelError('invalid-response');
    return url;
  }
  // Streams to disk, so a large file does not use memory. The link is signed by the panel:
  // the API key is never sent to the node, and the link itself is never logged.
  async download(serverId, path, file, { signal, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
    const url = await this.downloadUrl(serverId, path);
    let response;
    try { response = await this.fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal }); } catch { throw new PanelError('network'); }
    if (!response.ok) {
      const { status } = response;
      await response.body?.cancel().catch(() => {});
      throw new PanelError(status === 404 ? 'missing' : status >= 500 ? 'server' : 'http', status);
    }
    if (!response.body) throw new PanelError('invalid-response');
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new PanelError('too-large');
    }
    let bytes = 0;
    try {
      await pipeline(Readable.fromWeb(response.body), async function* (source) {
        for await (const part of source) {
          bytes += part.length;
          if (bytes > maxBytes) throw new PanelError('too-large');
          yield part;
        }
      }, createWriteStream(file, { mode: 0o600 }));
    } catch (error) {
      if (error instanceof PanelError) throw error;
      throw new PanelError(error.syscall ? 'disk' : 'network');
    }
    return bytes;
  }
}

function anchorOf(bytes, offset) {
  return bytes.subarray(Math.max(0, offset - 64), offset).toString('base64');
}

// The API only returns whole files. The mod rewrites this one every 512 lines, so a
// smaller file or different bytes before the offset both mean "start over"; the relay
// then discards anything older than 30 minutes or already delivered.
export class RemoteTail {
  constructor(client, serverId, path, cursor = {}) {
    this.client = client; this.serverId = serverId; this.path = path; this.cursor = cursor;
  }
  async poll(onEvent) {
    let bytes;
    try { bytes = await this.client.fileContents(this.serverId, this.path); } catch (error) {
      if (error.kind === 'missing') return { missing: true, events: 0 };
      throw error;
    }
    let offset = this.cursor.offset || 0;
    if (offset > bytes.length || (offset > 0 && anchorOf(bytes, offset) !== this.cursor.anchor)) offset = 0;
    const end = bytes.lastIndexOf(10) + 1; // Only whole lines: a partial one comes back next poll.
    let events = 0;
    if (end > offset) {
      let start = offset;
      for (let i = offset; i < end; i++) {
        if (bytes[i] !== 10) continue;
        const event = parseLine(bytes.subarray(start, i).toString('utf8'));
        if (event) { onEvent(event); events++; }
        start = i + 1;
      }
      offset = end;
    }
    this.cursor.offset = offset;
    this.cursor.anchor = anchorOf(bytes, offset);
    return { missing: false, events };
  }
}
