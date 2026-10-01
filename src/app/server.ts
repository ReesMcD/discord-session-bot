/**
 * npm run app
 *
 * Serves the web app, its API and (when DISCORD_TOKEN is set) the Discord bot. Open
 * http://localhost:4400, or the Mac's Tailscale name from your phone. Requires APP_PASSWORD in .env.
 */
import { resolve } from 'node:path';
import { loadDotEnv } from '../util/env.js';
import { startServer } from './startServer.js';
import { BotService } from '../bot/BotService.js';

loadDotEnv();
const password = process.env.APP_PASSWORD;
if (!password || password.length < 8) {
  console.error('Set APP_PASSWORD in .env (at least 8 characters). The app controls a recording bot, so it always needs a password.');
  process.exit(1);
}
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const configPath = resolve(process.env.CONFIG_PATH ?? 'config.yaml');
const bot = new BotService({ dataDir, configPath });

const server = await startServer({
  password,
  port: Number(process.env.APP_PORT ?? 4400),
  host: process.env.APP_HOST ?? '0.0.0.0',
  dataDir,
  configPath,
  webDist: process.env.WEB_DIST ?? 'web/dist',
  corsOrigins: (process.env.APP_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  bot,
});
console.log(`Session bot app on ${server.url}`);
console.log(`From your phone: http://<this Mac's Tailscale name>:${server.port}`);

if (process.env.DISCORD_TOKEN) {
  bot.start(process.env.DISCORD_TOKEN).catch((err: Error) => console.error(`Discord: ${err.message}`));
} else {
  console.log('DISCORD_TOKEN not set: recording from the app is off (everything else works).');
}

const shutdown = async () => {
  await bot.shutdown();
  await server.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
