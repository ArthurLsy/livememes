import { createServer } from 'node:http';
import { config } from './config.ts';
import { createApp } from './http/app.ts';
import { attachGateway } from './realtime/gateway.ts';
import { createBot } from './bot/client.ts';
import { deployCommands } from './bot/deploy-commands.ts';
import { senderLocator } from './bot/locate.ts';
import { startCleanup } from './media/cache.ts';

const bot = createBot();
const server = createServer(createApp({ locateSender: senderLocator(bot) }));
const gateway = attachGateway(server);

startCleanup();

server.listen(config.http.port, () => {
  console.log(`[http] ecoute sur le port ${config.http.port}`);
  console.log(`[http] URL publique : ${config.http.publicUrl}`);
  if (config.http.publicUrl.includes('localhost')) {
    console.log('[http] PUBLIC_URL pointe sur localhost : seuls les overlays de cette machine verront les medias.');
  }
});

if (config.discord.deployOnBoot) {
  // Non bloquant : un echec de deploiement ne doit pas empecher le relais de tourner.
  deployCommands().catch((error: unknown) => {
    console.error('[commands] deploiement au demarrage echoue :', error);
  });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[app] arret (${signal})...`);

  gateway.close();
  for (const socket of gateway.clients) socket.close(1001, 'server shutdown');
  await bot.destroy();
  server.close(() => process.exit(0));

  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
