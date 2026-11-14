import type { PresenceMember, PresenceState, ServerMessage } from '@livememes/shared';
import { isMuted } from '../store/devices.ts';
import * as hub from './hub.ts';

/**
 * Colonne de presence (#22) : qui, dans mon salon vocal, va voir mes memes.
 *
 * Le bot declare le contenu des salons vocaux (`setChannel`), le hub et la
 * sourdine signalent les changements d'etat (`touch`). Les mises a jour sont
 * groupees puis poussees a tous les membres du salon concerne. Tout est en
 * memoire : apres un redemarrage, le bot redeclare les salons et les overlays
 * se reconnectent, la liste se reconstruit seule.
 *
 * Aucune dependance a discord.js : les tests alimentent ce module directement.
 */

/** Membre eligible tel que le bot le declare, sans son etat. */
export interface ChannelMember {
  id: string;
  avatarUrl: string | null;
}

/** Fenetre de regroupement : une rafale (salon qui se remplit) part en un message. */
export const FLUSH_MS = 250;

const channels = new Map<string, ChannelMember[]>();
const userChannel = new Map<string, string>();
const dirty = new Set<string>();
/** Utilisateurs sortis de tout salon : ils recoivent une liste vide. */
const left = new Set<string>();
let timer: NodeJS.Timeout | null = null;

function schedule(): void {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_MS);
  timer.unref();
}

function stateOf(userId: string): PresenceState {
  if (!hub.isOnline(userId)) return 'offline';
  return isMuted(userId) ? 'muted' : 'online';
}

function membersOf(channelId: string): PresenceMember[] {
  return (channels.get(channelId) ?? []).map((member) => ({ ...member, state: stateOf(member.id) }));
}

/**
 * Remplace la liste des membres eligibles d'un salon vocal (bots exclus, role
 * requis verifie par l'appelant). Une liste vide oublie le salon.
 */
export function setChannel(channelId: string, members: ChannelMember[]): void {
  const previous = channels.get(channelId) ?? [];
  const current = new Set(members.map((member) => member.id));

  for (const member of previous) {
    if (current.has(member.id) || userChannel.get(member.id) !== channelId) continue;
    userChannel.delete(member.id);
    left.add(member.id);
  }
  for (const member of members) {
    userChannel.set(member.id, channelId);
    left.delete(member.id);
  }

  if (members.length > 0) channels.set(channelId, members);
  else channels.delete(channelId);
  dirty.add(channelId);
  schedule();
}

/** L'etat d'un utilisateur a change (overlay connecte ou deconnecte, sourdine). */
export function touch(userId: string): void {
  const channelId = userChannel.get(userId);
  if (!channelId) return;
  dirty.add(channelId);
  schedule();
}

hub.onOnlineChange(touch);

/** Liste a envoyer a un overlay qui vient de se connecter. */
export function snapshotFor(userId: string): PresenceMember[] {
  const channelId = userChannel.get(userId);
  return channelId ? membersOf(channelId) : [];
}

/** Pousse les changements en attente. Exporte pour les tests. */
export function flush(): void {
  if (timer) clearTimeout(timer);
  timer = null;

  for (const channelId of dirty) {
    const members = membersOf(channelId);
    if (members.length === 0) continue;
    const message: ServerMessage = { t: 'presence', members };
    for (const member of members) hub.sendToUser(member.id, message);
  }
  dirty.clear();

  for (const userId of left) {
    if (!userChannel.has(userId)) hub.sendToUser(userId, { t: 'presence', members: [] });
  }
  left.clear();
}

/** Remet le module a zero (tests). */
export function reset(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  channels.clear();
  userChannel.clear();
  dirty.clear();
  left.clear();
}
