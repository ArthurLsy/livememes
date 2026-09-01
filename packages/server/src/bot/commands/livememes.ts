import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  time,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  createPairingCode,
  isMuted,
  listDevices,
  refreshDeviceUser,
  setMuted,
  unlinkAll,
} from '../../store/devices.ts';
import * as hub from '../../realtime/hub.ts';
import { audienceOf, resolveVoiceChannel } from '../drop.ts';

export const data = new SlashCommandBuilder()
  .setName('livememes')
  .setDescription('Gere ton overlay LiveMemes')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub.setName('link').setDescription('Obtiens un code pour connecter ton overlay a ce compte'),
  )
  .addSubcommand((sub) =>
    sub.setName('devices').setDescription('Liste les appareils lies a ton compte'),
  )
  .addSubcommand((sub) =>
    sub.setName('unlink').setDescription('Delie tous tes appareils'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('mute')
      .setDescription('Active ou coupe la reception des memes')
      .addBooleanOption((option) =>
        option.setName('actif').setDescription('true = plus aucun meme ne s\'affiche chez toi'),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('clear').setDescription('Efface les memes affiches dans ton salon vocal'),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Qui, dans ton vocal, peut recevoir des memes'),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  switch (interaction.options.getSubcommand()) {
    case 'link':
      return link(interaction);
    case 'devices':
      return devices(interaction);
    case 'unlink':
      return unlink(interaction);
    case 'mute':
      return mute(interaction);
    case 'clear':
      return clear(interaction);
    case 'status':
      return status(interaction);
  }
}

async function link(interaction: ChatInputCommandInteraction): Promise<void> {
  const user = {
    id: interaction.user.id,
    username: interaction.user.displayName || interaction.user.username,
    avatarUrl: interaction.user.displayAvatarURL({ size: 64, extension: 'png' }),
  };
  const { code, expiresAt } = createPairingCode(user);
  refreshDeviceUser(user.id, user);

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: [
      '**Connecte ton overlay**',
      '',
      `Code : \`${code}\``,
      `Valable jusqu'a ${time(Math.floor(expiresAt / 1000), 'T')}.`,
      '',
      "Ouvre l'app LiveMemes sur ton PC, colle ce code, et c'est fait.",
    ].join('\n'),
  });
}

async function devices(interaction: ChatInputCommandInteraction): Promise<void> {
  const list = listDevices(interaction.user.id);
  if (list.length === 0) {
    await interaction.reply({
      content: "Aucun appareil lie. Fais `/livememes link` pour en connecter un.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const online = hub.deviceCount(interaction.user.id);
  const lines = list.map((device) => {
    const seen = time(Math.floor(device.lastSeen / 1000), 'R');
    return `- **${device.deviceName}** — vu ${seen}`;
  });

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: [
      `**${list.length} appareil(s) lie(s)**, dont **${online}** connecte(s) maintenant.`,
      ...lines,
    ].join('\n'),
  });
}

async function unlink(interaction: ChatInputCommandInteraction): Promise<void> {
  const removed = unlinkAll(interaction.user.id);
  hub.disconnectUser(interaction.user.id, 'Appareil delie depuis Discord.');

  await interaction.reply({
    content:
      removed === 0
        ? "Tu n'avais aucun appareil lie."
        : `${removed} appareil(s) delie(s). Ils ne recevront plus rien.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function mute(interaction: ChatInputCommandInteraction): Promise<void> {
  const requested = interaction.options.getBoolean('actif');
  const next = requested ?? !isMuted(interaction.user.id);

  setMuted(interaction.user.id, next);
  hub.sendToUser(interaction.user.id, { t: 'muted', muted: next });

  await interaction.reply({
    content: next
      ? 'Sourdine activee : plus aucun meme ne s\'affichera chez toi.'
      : 'Sourdine coupee : tu recois de nouveau les memes.',
    flags: MessageFlags.Ephemeral,
  });
}

async function clear(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = await resolveVoiceChannel(interaction);
  if (!channel) {
    await interaction.reply({
      content: 'Tu dois etre dans un salon vocal.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Sans permission de moderation, on ne nettoie que ses propres ecrans.
  const canModerate =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;

  if (!canModerate) {
    hub.sendToUser(interaction.user.id, { t: 'clear', dropId: null });
    await interaction.reply({
      content: 'Tes ecrans sont nettoyes.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let screens = 0;
  for (const member of audienceOf(channel)) {
    screens += hub.sendToUser(member.id, { t: 'clear', dropId: null });
  }

  await interaction.reply(`Memes effaces sur ${screens} ecran(s) dans ${channel}.`);
}

async function status(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = await resolveVoiceChannel(interaction);
  if (!channel) {
    await interaction.reply({
      content: 'Tu dois etre dans un salon vocal pour voir qui peut recevoir des memes.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const audience = audienceOf(channel);
  const lines = audience.map((member) => {
    if (isMuted(member.id)) return `- ${member.displayName} — en sourdine`;
    const screens = hub.deviceCount(member.id);
    if (screens === 0) return `- ${member.displayName} — pas d'overlay connecte`;
    return `- ${member.displayName} — **${screens}** ecran(s) pret(s)`;
  });

  const ready = audience.filter((member) => !isMuted(member.id) && hub.isOnline(member.id)).length;

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: [
      `**${channel.name}** — ${ready}/${audience.length} pret(s) a recevoir des memes.`,
      ...lines,
    ].join('\n'),
  });
}
