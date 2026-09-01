import { REST, Routes } from 'discord.js';
import { config } from '../config.ts';
import { commands } from './commands/index.ts';

/**
 * Enregistre les slash commands aupres de Discord.
 *
 * Avec DISCORD_DEV_GUILD_ID les commandes apparaissent instantanement sur ce
 * serveur. Sans, le deploiement est global et met jusqu'a une heure a se propager.
 */
export async function deployCommands(): Promise<void> {
  const body = [...commands.values()].map((command) => command.data.toJSON());
  const rest = new REST().setToken(config.discord.token);

  const route = config.discord.devGuildId
    ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.devGuildId)
    : Routes.applicationCommands(config.discord.clientId);

  await rest.put(route, { body });

  const scope = config.discord.devGuildId ? `guilde ${config.discord.devGuildId}` : 'global';
  console.log(
    `[commands] ${body.length} commande(s) deployee(s) (${scope}) : ${body.map((c) => `/${c.name}`).join(', ')}`,
  );
}

// Execute uniquement quand le fichier est lance directement (npm run commands:deploy).
if (import.meta.filename === process.argv[1]) {
  deployCommands().catch((error: unknown) => {
    console.error('[commands] echec du deploiement :', error);
    process.exit(1);
  });
}
