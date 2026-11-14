/**
 * Placement d'un meme a l'ecran, sans DOM : l'overlay l'applique, les tests la
 * verifient directement.
 *
 * Une position est un couple de fractions (fx, fy) entre 0 et 1, applique a la
 * fois au point d'ancrage dans l'ecran et au point du meme qui s'y accroche :
 * (0, 0) colle le coin haut gauche du meme au coin haut gauche de l'ecran,
 * (0.5, 0.5) centre, (1, 1) colle les coins bas droits. Le meme reste donc
 * toujours dans l'ecran quelle que soit sa taille, la ou un ancrage par le
 * centre le coupait a moitie dans les coins (#27).
 */
import type { MemePosition } from '@livememes/shared';

export interface Anchor {
  fx: number;
  fy: number;
}

/** Bornes du placement aleatoire : jamais colle aux bords. */
const RANDOM_MIN = 0.1;
const RANDOM_SPAN = 0.8;

export function anchorFor(position: MemePosition, random: () => number = Math.random): Anchor {
  switch (position) {
    case 'top-left':
      return { fx: 0, fy: 0 };
    case 'top-right':
      return { fx: 1, fy: 0 };
    case 'bottom-left':
      return { fx: 0, fy: 1 };
    case 'bottom-right':
      return { fx: 1, fy: 1 };
    case 'random':
      return { fx: RANDOM_MIN + random() * RANDOM_SPAN, fy: RANDOM_MIN + random() * RANDOM_SPAN };
    case 'center':
    default:
      return { fx: 0.5, fy: 0.5 };
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Marge entre le meme et le bord de l'ecran, en px (`--edge` dans overlay.css). */
export function edgeFor(viewportHeight: number): number {
  return Math.round(clamp(viewportHeight * 0.03, 16, 40));
}

/** Epaisseur du cadre, en px : miroir de `--ring` dans overlay.css. */
export function ringFor(viewportHeight: number): number {
  return clamp(viewportHeight * 0.0045, 4, 8);
}

/** En dessous, un meme n'est plus lisible : on accepte alors de deborder. */
export const MIN_MEDIA_HEIGHT = 80;

export interface FitInput {
  /** Hauteur demandee, en fraction de la hauteur d'ecran. */
  scale: number;
  viewportHeight: number;
  /** Hauteur occupee par le reste du meme : legende, auteur, espacements. */
  extra: number;
}

/**
 * Hauteur du media en px, plafonnee pour que le meme entier (cadre, legende et
 * auteur compris) tienne dans l'ecran marges deduites. Une taille "enorme"
 * (100 % de l'ecran) ne peut pas tenir telle quelle avec son auteur dessous.
 */
export function fitHeight({ scale, viewportHeight, extra }: FitInput): number {
  const wanted = scale * viewportHeight;
  const room = viewportHeight - 2 * edgeFor(viewportHeight) - ringFor(viewportHeight) - extra;
  return Math.round(Math.max(MIN_MEDIA_HEIGHT, Math.min(wanted, room)));
}
