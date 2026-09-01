import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { MEME_POSITIONS, type MemePosition, type MemeSize } from '@livememes/shared';
import { config } from '../../config.ts';
import { MediaError } from '../../media/cache.ts';
import * as tenor from '../../media/tenor.ts';
import { cooldownRemaining, deliver, resolveVoiceChannel, startCooldown } from '../drop.ts';

/** Options d'affichage communes aux trois sous-commandes. */
function withDisplayOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return sub
    .addStringOption((option) =>
      option
        .setName('texte')
        .setDescription('Legende affichee sous le meme')
        .setMaxLength(120),
    )
    .addIntegerOption((option) =>
      option
        .setName('duree')
        .setDescription(`Duree d'affichage en secondes (max ${config.drops.maxDurationMs / 1000})`)
        .setMinValue(1)
        .setMaxValue(Math.floor(config.drops.maxDurationMs / 1000)),
    )
    .addStringOption((option) =>
      option
        .setName('taille')
        .setDescription("Taille a l'ecran")
        .addChoices(
          { name: 'Petit', value: 'small' },
          { name: 'Moyen', value: 'medium' },
          { name: 'Grand', value: 'large' },
          { name: 'Plein ecran', value: 'huge' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('position')
        .setDescription("Ou afficher le meme a l'ecran")
        .addChoices(
          { name: 'Centre', value: 'center' },
          { name: 'Haut gauche', value: 'top-left' },
          { name: 'Haut droite', value: 'top-right' },
          { name: 'Bas gauche', value: 'bottom-left' },
          { name: 'Bas droite', value: 'bottom-right' },
          { name: 'Aleatoire', value: 'random' },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName('volume')
        .setDescription('Volume pour les videos, 0-100 (defaut 60)')
        .setMinValue(0)
        .setMaxValue(100),
    );
}

export const data = new SlashCommandBuilder()
  .setName('meme')
  .setDescription("Balance un meme sur l'ecran de tous les membres du salon vocal")
  // La commande cible un salon vocal : elle n'a aucun sens en MP.
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    withDisplayOptions(
      sub
        .setName('gif')
        .setDescription('Cherche un GIF sur Tenor et balance-le')
        .addStringOption((option) =>
          option
            .setName('recherche')
            .setDescription('Tape pour chercher, puis choisis dans la liste')
            .setRequired(true)
            .setAutocomplete(true),
        ) as SlashCommandSubcommandBuilder,
    ),
  )
  .addSubcommand((sub) =>
    withDisplayOptions(
      sub
        .setName('url')
        .setDescription("Balance une image, un GIF ou une video depuis une URL")
        .addStringOption((option) =>
          option.setName('url').setDescription('Lien direct vers le media').setRequired(true),
        ) as SlashCommandSubcommandBuilder,
    ),
  )
  .addSubcommand((sub) =>
    withDisplayOptions(
      sub
        .setName('fichier')
        .setDescription('Balance un fichier depuis ton disque')
        .addAttachmentOption((option) =>
          option.setName('fichier').setDescription('Image, GIF ou video courte').setRequired(true),
        ) as SlashCommandSubcommandBuilder,
    ),
  );

/* -------------------------------------------------------------------------- */

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const query = interaction.options.getFocused().trim();

  if (!tenor.tenorEnabled()) {
    await interaction.respond([
      { name: 'Recherche Tenor desactivee - configure TENOR_API_KEY', value: 'disabled' },
    ]);
    return;
  }
  if (query.length < 2) {
    await interaction.respond([{ name: 'Tape au moins 2 caracteres...', value: 'noop' }]);
    return;
  }

  try {
    const gifs = await tenor.search(query, 20);
    await interaction.respond(
      gifs.slice(0, 25).map((gif) => ({
        name: gif.title.slice(0, 100),
        // La valeur doit tenir en 100 caracteres : l'ID Tenor, pas l'URL.
        value: `tenor:${gif.id}`,
      })),
    );
  } catch {
    // Autocomplete rate : Discord affiche simplement "aucun resultat".
    await interaction.respond([]).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */

/** Resout la sous-commande vers une URL source telechargeable. */
async function resolveSource(interaction: ChatInputCommandInteraction): Promise<string> {
  switch (interaction.options.getSubcommand()) {
    case 'gif': {
      const raw = interaction.options.getString('recherche', true);
      if (raw === 'noop' || raw === 'disabled') {
        throw new MediaError('Choisis un GIF dans la liste proposee par Discord.');
      }
      if (!raw.startsWith('tenor:')) {
        // L'utilisateur a valide son texte sans choisir : on prend le 1er resultat.
        const [first] = await tenor.search(raw, 1);
        if (!first) throw new MediaError(`Aucun GIF trouve pour "${raw}".`);
        return first.url;
      }
      const gif = await tenor.byId(raw.slice('tenor:'.length));
      if (!gif) throw new MediaError("Ce GIF n'existe plus sur Tenor.");
      return gif.url;
    }

    case 'url':
      return interaction.options.getString('url', true).trim();

    case 'fichier': {
      const attachment = interaction.options.getAttachment('fichier', true);
      if (attachment.size > config.media.maxBytes) {
        throw new MediaError(
          `Fichier trop lourd (${(attachment.size / 1024 / 1024).toFixed(1)} Mo, max ${
            config.media.maxBytes / 1024 / 1024
          } Mo).`,
        );
      }
      return attachment.url;
    }

    default:
      throw new MediaError('Sous-commande inconnue.');
  }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const remaining = cooldownRemaining(interaction.user.id);
  if (remaining > 0) {
    await interaction.reply({
      content: `Doucement. Encore ${Math.ceil(remaining / 1000)}s avant ton prochain meme.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await resolveVoiceChannel(interaction);
  if (!channel) {
    await interaction.reply({
      content: "Tu dois etre dans un salon vocal pour balancer un meme.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  let sourceUrl: string;
  try {
    sourceUrl = await resolveSource(interaction);
  } catch (error) {
    await interaction.editReply(
      error instanceof MediaError ? error.message : 'Impossible de resoudre ce meme.',
    );
    return;
  }

  const durationSeconds = interaction.options.getInteger('duree');
  const durationMs = Math.min(
    durationSeconds ? durationSeconds * 1000 : config.drops.defaultDurationMs,
    config.drops.maxDurationMs,
  );

  const position = (interaction.options.getString('position') ?? 'center') as MemePosition;
  const size = (interaction.options.getString('taille') ?? 'medium') as MemeSize;
  const volumeOption = interaction.options.getInteger('volume');

  try {
    const report = await deliver(interaction, channel, {
      sourceUrl,
      durationMs,
      position: MEME_POSITIONS.includes(position) ? position : 'center',
      size,
      volume: (volumeOption ?? 60) / 100,
      caption: interaction.options.getString('texte'),
    });

    startCooldown(interaction.user.id);

    const lines = [`**${report.drop.author.username}** balance un meme dans ${channel}`];
    if (report.reached.length > 0) {
      lines.push(`Affiche sur **${report.screens}** ecran(s) — ${report.reached.length} personne(s).`);
    } else {
      lines.push("Personne n'a l'overlay ouvert dans ce vocal. Le meme est tombe dans le vide.");
    }
    if (report.offline.length > 0) {
      lines.push(`${report.offline.length} membre(s) sans overlay connecte.`);
    }
    if (report.muted.length > 0) {
      lines.push(`${report.muted.length} membre(s) en sourdine.`);
    }
    if (report.audience.length > 0 && report.reached.length === 0 && report.offline.length > 0) {
      lines.push('Ils peuvent installer le client puis faire `/livememes link`.');
    }

    await interaction.editReply({ content: lines.join('\n') });
  } catch (error) {
    await interaction.editReply(
      error instanceof MediaError ? error.message : "Erreur pendant l'envoi du meme.",
    );
    if (!(error instanceof MediaError)) console.error('[meme] echec du drop', error);
  }
}
