/**
 * Logique d'affichage de la fenetre de reglages, sans DOM : settings.ts
 * l'applique, les tests la verifient directement.
 */

export type ConnectionStatus = 'offline' | 'connecting' | 'online' | 'unauthorized';

export interface StatusInput {
  linked: boolean;
  status: ConnectionStatus;
  detail: string | null;
  muted: boolean;
}

export interface StatusView {
  /** Texte court de la pastille d'en-tete. */
  label: string;
  /** Couleur de la pastille : online pulse, connecting en orange, error en rouge. */
  cls: 'online' | 'connecting' | 'error';
  /** Explication affichee sous l'en-tete, null si rien a dire. */
  detail: string | null;
}

export function statusView({ linked, status, detail, muted }: StatusInput): StatusView {
  // Non lie : le tutoriel explique deja pourquoi (notice de revocation).
  if (!linked) return { label: 'Non lie', cls: 'error', detail: null };

  switch (status) {
    case 'online':
      return muted ? { label: 'Sourdine', cls: 'error', detail: null } : { label: 'Connecte', cls: 'online', detail: null };
    case 'connecting':
      return { label: 'Connexion', cls: 'connecting', detail: null };
    case 'offline':
      return { label: 'Deconnecte', cls: 'error', detail };
    case 'unauthorized':
      return { label: 'Refuse', cls: 'error', detail };
  }
}

/** Nombre de barres de l'egaliseur de volume, une par tranche de 10 %. */
export const VOLUME_STEPS = 10;

/** Hauteur de chaque barre en px, en dents de scie comme sur la maquette. */
export const VOLUME_BAR_HEIGHTS = [14, 20, 18, 26, 24, 32, 30, 38, 36, 44] as const;

/** Barres allumees pour un volume entre 0 et 1 (un ancien reglage a 5 % pres est arrondi). */
export function volumeLevel(volume: number): number {
  return clamp(Math.round(volume * VOLUME_STEPS), 0, VOLUME_STEPS);
}

/**
 * Niveau vise par un clic ou un glissement : la barre sous le pointeur et
 * toutes celles a sa gauche s'allument. Tout a gauche de la premiere barre = 0.
 */
export function levelFromPointer(x: number, width: number): number {
  if (width <= 0 || x <= 0) return 0;
  return clamp(Math.ceil((x / width) * VOLUME_STEPS), 0, VOLUME_STEPS);
}

/** Niveau apres une touche du clavier, null si la touche ne concerne pas le curseur. */
export function levelFromKey(key: string, level: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(level + 1, 0, VOLUME_STEPS);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(level - 1, 0, VOLUME_STEPS);
    case 'PageUp':
      return clamp(level + 3, 0, VOLUME_STEPS);
    case 'PageDown':
      return clamp(level - 3, 0, VOLUME_STEPS);
    case 'Home':
      return 0;
    case 'End':
      return VOLUME_STEPS;
    default:
      return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
