import { randomUUID } from 'node:crypto';
import type { ChatInputCommandInteraction, GuildMember, VoiceBasedChannel } from 'discord.js';
import { MEME_SIZES, type MemeDrop, type MemeKind, type MemePosition, type MemeSize } from '@livememes/shared';
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

/** Auteur de la commande, resolu en membre de la guilde. Null hors guilde. */
export async function resolveMember(
  interaction: ChatInputCommandInteraction,
): Promise<GuildMember | null> {
  if (!interaction.guild) return null;
  return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

/** Salon vocal ou se trouve l'auteur de la commande, null s'il n'est dans aucun. */
export async function resolveVoiceChannel(
  interaction: ChatInputCommandInteraction,
): Promise<VoiceBasedChannel | null> {
  return (await resolveMember(interaction))?.voice.channel ?? null;
}

/**
 * Eligibilite aux memes, envoi comme reception.
 *
 * Les roles arrivent dans les payloads de voice state, donc aucun intent
 * privilegie n'est necessaire pour ce test.
 */
export function hasDropRole(member: GuildMember): boolean {
  if (!config.drops.roleId) return true;
  return member.roles.cache.has(config.drops.roleId);
}

/** Membres humains presents dans le salon vocal, role requis ou non. */
export function humansOf(channel: VoiceBasedChannel): GuildMember[] {
  return [...channel.members.values()].filter((member) => !member.user.bot);
}

/** Membres du salon vocal qui ont le droit de recevoir un meme. */
export function audienceOf(channel: VoiceBasedChannel): GuildMember[] {
  return humansOf(channel).filter(hasDropRole);
}

export interface BuildOptions {
  sourceUrl: string;
  /** Duree demandee via l'option `duree`, null pour la valeur par defaut. */
  durationMs: number | null;
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
 * Duree d'affichage selon le type de media. Une image (GIF compris) reste
 * `durationMs` ; une video est jouee jusqu'a la fin, sous un plafond qui vaut
 * la duree demandee si l'utilisateur en a donne une.
 */
export function resolveDuration(
  kind: MemeKind,
  requestedMs: number | null,
): Pick<MemeDrop, 'durationMs' | 'maxDurationMs'> {
  const durationMs = Math.min(requestedMs ?? config.drops.defaultDurationMs, config.drops.maxDurationMs);
  if (kind !== 'video') return { durationMs };
  return {
    durationMs,
    maxDurationMs: Math.min(requestedMs ?? config.drops.maxVideoDurationMs, config.drops.maxVideoDurationMs),
  };
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
    ...resolveDuration(cached.kind, options.durationMs),
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
