/**
 * Colonne de presence (#22), sans DOM : ce que l'overlay doit afficher a partir
 * de la liste envoyee par le serveur. Partage par le main et les tests.
 */
import type { PresenceMember, PresenceState } from '@livememes/shared';

/** Au-dela, les avatars restants sont resumes en "+N". */
export const MAX_AVATARS = 8;

export interface PresenceView {
  shown: PresenceMember[];
  /** Membres non affiches, resumes en "+N". */
  hidden: number;
}

/** Ceux qui recoivent d'abord, puis ceux en sourdine, puis ceux sans overlay. */
const ORDER: Record<PresenceState, number> = { online: 0, muted: 1, offline: 2 };

/**
 * Null quand il n'y a personne d'autre que soi dans le salon : la colonne
 * repond a "qui va voir mon meme ?", elle n'a rien a dire dans ce cas.
 */
export function presenceView(
  members: readonly PresenceMember[],
  selfId: string | null,
  max = MAX_AVATARS,
): PresenceView | null {
  const others = members
    .filter((member) => member.id !== selfId)
    // Tri stable : l'ordre du serveur est garde a etat egal.
    .sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  if (others.length === 0) return null;

  // "+1" prendrait autant de place qu'un avatar : autant l'afficher.
  if (others.length <= max) return { shown: others, hidden: 0 };
  return { shown: others.slice(0, max - 1), hidden: others.length - (max - 1) };
}
