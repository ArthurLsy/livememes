import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from '../config.ts';
import { commands } from './commands/index.ts';

export function createBot(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // Necessaire pour connaitre les membres presents dans un salon vocal.
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(`[bot] connecte en tant que ${ready.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      const command = commands.get(interaction.commandName);
      await command?.autocomplete?.(interaction).catch((error: unknown) => {
        console.error(`[bot] autocomplete ${interaction.commandName}`, error);
      });
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`[bot] echec de /${interaction.commandName}`, error);
      const content = "Quelque chose a casse de mon cote. Reessaie dans un instant.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content }).catch(() => {});
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  // Un token invalide doit produire un message lisible dans les logs de la
  // plateforme, pas une stack trace de discord.js suivie d'un crash brut.
  client.login(config.discord.token).catch((error: unknown) => {
    const code = (error as { code?: string }).code;
    if (code === 'TokenInvalid') {
      console.error(
        '[bot] DISCORD_TOKEN invalide. Regenere-le sur https://discord.com/developers/applications (onglet Bot > Reset Token).',
      );
    } else if (code === 'DisallowedIntents') {
      console.error(
        "[bot] Intents refuses. LiveMemes n'utilise que des intents publics : verifie que le bot est bien invite avec le scope \"bot\".",
      );
    } else {
      console.error('[bot] connexion a Discord impossible :', error);
    }
    process.exit(1);
  });

  return client;
}
