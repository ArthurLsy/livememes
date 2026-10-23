/**
 * Zones cliquables des croix de fermeture, sans Electron : le main les teste a
 * chaque releve du curseur, les tests les verifient directement.
 */

/** Rectangle en px CSS, relatif au coin haut-gauche de la fenetre d'overlay. */
export interface Zone {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Une fenetre n'affiche jamais autant de memes : au-dela, le message est suspect. */
const MAX_ZONES = 32;

/** Ne garde que des rectangles bien formes, venus d'un renderer qu'on ne croit pas sur parole. */
export function sanitizeZones(raw: unknown): Zone[] {
  if (!Array.isArray(raw)) return [];
  const zones: Zone[] = [];
  for (const item of raw.slice(0, MAX_ZONES)) {
    if (typeof item !== 'object' || item === null) continue;
    const { left, top, right, bottom } = item as Record<string, unknown>;
    const values = [left, top, right, bottom];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
    const zone = { left, top, right, bottom } as Zone;
    if (zone.right <= zone.left || zone.bottom <= zone.top) continue;
    zones.push(zone);
  }
  return zones;
}

/** Vrai si le point (meme repere que les zones) tombe dans l'une d'elles. */
export function hitsAny(zones: readonly Zone[], x: number, y: number): boolean {
  return zones.some((zone) => x >= zone.left && x < zone.right && y >= zone.top && y < zone.bottom);
}
