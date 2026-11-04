import { isIP } from 'node:net';

// Only an anonymous GET: no panel key or webhook ever goes to these services.
const SOURCES = ['https://api.ipify.org', 'https://icanhazip.com'];

// The public address is what a panel API key's IP list sees. Never throws: a failed
// lookup must not stop the bot, so the caller gets null and logs that instead.
export async function publicIp(fetchFn = fetch, sources = SOURCES) {
  for (const source of sources) {
    try {
      const response = await fetchFn(source, {
        headers: { 'User-Agent': 'BotZomboid/0.3.0' },
        signal: AbortSignal.timeout(4000),
        redirect: 'error',
      });
      if (!response.ok) continue;
      const text = (await response.text()).trim();
      if (isIP(text)) return text;
    } catch { /* Try the next source. */ }
  }
  return null;
}
