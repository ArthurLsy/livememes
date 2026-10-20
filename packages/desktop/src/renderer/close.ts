/**
 * Placement de la croix de fermeture, sans DOM : l'overlay l'applique, les
 * tests la verifient directement.
 */

/** Marge minimale entre la croix et le bord de l'ecran, en px. */
export const EDGE_MARGIN = 8;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Decalage a appliquer a la croix pour qu'elle reste dans l'ecran, meme quand
 * le meme deborde (grande taille ancree dans un coin). Le cote gauche/haut
 * l'emporte si la croix est plus grande que l'ecran.
 */
export function nudge(box: Box, width: number, height: number, margin = EDGE_MARGIN): { x: number; y: number } {
  const axis = (start: number, end: number, size: number): number => {
    if (start < margin) return margin - start;
    if (end > size - margin) return Math.max(margin - start, size - margin - end);
    return 0;
  };
  return { x: axis(box.left, box.right, width), y: axis(box.top, box.bottom, height) };
}
