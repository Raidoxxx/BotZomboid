import { loadConfig, loadEnvFile } from './src/config.js';
import { run } from './src/bot.js';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`[BotZomboid] Node ${process.versions.node} nao suportado; use 20 ou superior.`);
  process.exit(1);
}

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

try {
  await loadEnvFile('.env');
  await run(loadConfig(), { signal: controller.signal });
} catch (error) {
  // Config errors carry only variable names, never their values.
  console.error(`[BotZomboid] parado: ${error.message}`);
  process.exitCode = 1;
}
