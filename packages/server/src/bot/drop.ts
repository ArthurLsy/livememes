import { randomUUID } from 'node:crypto';
import type { ChatInputCommandInteraction, GuildMember, VoiceBasedChannel } from 'discord.js';
import { MEME_SIZES, type MemeDrop, type MemePosition, type MemeSize } from '@livememes/shared';
import { config } from '../config.ts';
import * as media from '../media/cache.ts';
import * as hub from '../realtime/hub.ts';
import { seenBy, trackDrop } from '../realtime/gateway.ts';
import { isMuted } from '../store/devices.ts';

const cooldowns = new Map<string, number>();

/** Renvoie les ms restantes avant que l'utilisateur puisse redrop, 0 s'il peut. */
export function cooldownRemaining(userId: string): number {
  const readyAt = cooldowns.get(userId);
  if (readyAt === undefined) return 0;
  return Math.max(0, readyAt - Date.now());
}

export function startCooldown(userId: string): void {
  cooldowns.set(userId, Date.now() + config.drops.cooldownMs);
}

/** Salon vocal ou se trouve l'auteur de la commande, null s'il n'est dans aucun. */
export async function resolveVoiceChannel(
  interaction: ChatInputCommandInteraction,
): Promise<VoiceBasedChannel | null> {
  if (!interaction.guild) return null;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  return member?.voice.channel ?? null;
}

/** Membres humains presents dans le salon vocal. */
export function audienceOf(channel: VoiceBasedChannel): GuildMember[] {
  return [...channel.members.values()].filter((member) => !member.user.bot);
}

export interface BuildOptions {
  sourceUrl: string;
  durationMs: number;
  position: MemePosition;
  size: MemeSize;
  volume: number;
  caption: string | null;
}

export interface DeliveryReport {
  drop: MemeDrop;
  audience: GuildMember[];
  reached: string[];
  offline: string[];
  muted: string[];
  screens: number;
}

/**
 * Ingere le media, construit le drop et le pousse a tout le salon vocal.
 * Leve MediaError si l'URL n'est pas exploitable.
 */
export async function deliver(
  interaction: ChatInputCommandInteraction,
  channel: VoiceBasedChannel,
  options: BuildOptions,
): Promise<DeliveryReport> {
  const cached = await media.ingest(options.sourceUrl);

  const drop: MemeDrop = {
    id: randomUUID(),
    url: cached.url,
    kind: cached.kind,
    durationMs: options.durationMs,
    position: options.position,
    scale: MEME_SIZES[options.size],
    volume: options.volume,
    caption: options.caption,
    author: {
      id: interaction.user.id,
      username: interaction.user.displayName || interaction.user.username,
      avatarUrl: interaction.user.displayAvatarURL({ size: 64, extension: 'png' }),
    },
    guildName: interaction.guild?.name ?? null,
    sentAt: Date.now(),
  };

  const audience = audienceOf(channel);
  const mutedUsers = new Set(audience.filter((member) => isMuted(member.id)).map((member) => member.id));

  trackDrop(drop.id);
  const result = hub.broadcast(
    audience.map((member) => member.id),
    drop,
    mutedUsers,
  );

  return { drop, audience, ...result };
}

/** Nombre d'ecrans ayant confirme l'affichage (renseigne apres ~1s). */
export const confirmedScreens = seenBy;
