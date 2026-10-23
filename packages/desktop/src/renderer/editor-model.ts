/**
 * Modele de l'editeur, sans DOM : bornes de la timeline, piste texte et
 * options d'envoi. L'editeur l'applique, le main le revalide, les tests le
 * verifient directement.
 */
import type { DropUploadResponse } from '@livememes/shared';

/** Duree maximale d'un clip exporte, en secondes. */
export const MAX_CLIP_SECONDS = 30;
/** Clip le plus court qu'on laisse exporter, en secondes. */
export const MIN_CLIP_SECONDS = 0.5;

/** Plage de temps en secondes, dans le temps de la video source. */
export interface Range {
  start: number;
  end: number;
}

export type TextFont = 'display' | 'body';

/** Polices proposees, embarquees dans renderer/fonts (CSP sans police distante). */
export const TEXT_FONTS: Record<TextFont, { label: string; family: string; weight: number }> = {
  display: { label: 'Unbounded', family: 'Unbounded', weight: 800 },
  body: { label: 'Figtree', family: 'Figtree', weight: 800 },
};

/** Couleurs du texte incruste : contenu du meme, pas chrome de l'UI. */
export const TEXT_COLORS = ['#ffffff', '#0d1226', '#c8ff3a', '#6c5cff', '#ff4d4d', '#ffd23f'] as const;

/** Piste texte unique. Position et taille relatives a l'image, pour un rendu identique a toute resolution. */
export interface TextLayer {
  content: string;
  /** Centre du bloc, fraction de la largeur (0-1). */
  x: number;
  /** Centre du bloc, fraction de la hauteur (0-1). */
  y: number;
  /** Hauteur d'une ligne, fraction de la hauteur de l'image. */
  size: number;
  font: TextFont;
  color: string;
  outline: boolean;
  /** Apparition, dans le temps de la source (ignore pour une image). */
  range: Range;
}

export const TEXT_SIZE_MIN = 0.03;
export const TEXT_SIZE_MAX = 0.25;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Coupe initiale : tout le clip, limite aux 30 premieres secondes. */
export function initialTrim(duration: number): Range {
  return { start: 0, end: Math.min(duration, MAX_CLIP_SECONDS) };
}

/** Clip le plus court autorise pour cette source (une source tres courte reste exportable). */
function minLength(duration: number): number {
  return Math.min(MIN_CLIP_SECONDS, duration);
}

/** Deplace le debut de la coupe, sans depasser 30 s ni passer sous la longueur minimale. */
export function moveTrimStart(trim: Range, start: number, duration: number): Range {
  const min = Math.max(0, trim.end - MAX_CLIP_SECONDS);
  const max = trim.end - minLength(duration);
  return { start: clamp(start, min, max), end: trim.end };
}

export function moveTrimEnd(trim: Range, end: number, duration: number): Range {
  const min = trim.start + minLength(duration);
  const max = Math.min(duration, trim.start + MAX_CLIP_SECONDS);
  return { start: trim.start, end: clamp(end, min, max) };
}

/** Glisse toute la coupe en gardant sa longueur. */
export function shiftTrim(trim: Range, start: number, duration: number): Range {
  const length = trim.end - trim.start;
  const next = clamp(start, 0, duration - length);
  return { start: next, end: next + length };
}

/**
 * Ramene la plage du texte dans la coupe. Une plage qui sort entierement de la
 * coupe reprend toute la coupe plutot que de disparaitre.
 */
export function fitTextRange(range: Range, trim: Range): Range {
  const start = clamp(range.start, trim.start, trim.end);
  const end = clamp(range.end, trim.start, trim.end);
  if (end - start < 0.1) return { ...trim };
  return { start, end };
}

/** Deplace un bord de la plage du texte, au moins 0,1 s de texte visible. */
export function moveTextEdge(range: Range, edge: 'start' | 'end', time: number, trim: Range): Range {
  if (edge === 'start') return { start: clamp(time, trim.start, range.end - 0.1), end: range.end };
  return { start: range.start, end: clamp(time, range.start + 0.1, trim.end) };
}

export function shiftTextRange(range: Range, start: number, trim: Range): Range {
  const length = range.end - range.start;
  const next = clamp(start, trim.start, trim.end - length);
  return { start: next, end: next + length };
}

/** 0:04.2, ou 1:02.0 : assez precis pour couper a la main. */
export function formatTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** Retour a la ligne mot par mot ; un mot trop long reste seul sur sa ligne. */
export function wrapLines(content: string, maxWidth: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of content.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = words[0]!;
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`;
      if (measure(candidate) <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Contour contrastant : noir sous un texte clair, blanc sous un texte fonce. */
export function outlineFor(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return '#000000';
  const value = Number.parseInt(match[1]!, 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

/* -------------------------------------------------------------------------- */
/* Options d'envoi                                                            */
/* -------------------------------------------------------------------------- */

export type SendSize = 'small' | 'medium' | 'large' | 'huge';
export type SendPosition = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'random';

/** Memes choix et memes defauts que les options de `/meme`. */
export const SEND_SIZES: { value: SendSize; label: string }[] = [
  { value: 'small', label: 'Petit' },
  { value: 'medium', label: 'Moyen' },
  { value: 'large', label: 'Grand' },
  { value: 'huge', label: 'Plein ecran' },
];

/** Dans l'ordre de la grille 3 x 2 de l'editeur : coins a gauche et au milieu, centre et aleatoire a droite. */
export const SEND_POSITIONS: { value: SendPosition; label: string }[] = [
  { value: 'top-left', label: 'Haut gauche' },
  { value: 'top-right', label: 'Haut droite' },
  { value: 'center', label: 'Centre' },
  { value: 'bottom-left', label: 'Bas gauche' },
  { value: 'bottom-right', label: 'Bas droite' },
  { value: 'random', label: 'Aleatoire' },
];

export interface SendOptions {
  size: SendSize;
  position: SendPosition;
  /** 0-100. */
  volume: number;
  /** Images seulement, en secondes. */
  duration: number;
}

export const DEFAULT_SEND: SendOptions = { size: 'medium', position: 'center', volume: 60, duration: 6 };
/** Plafond par defaut du serveur (DROP_MAX_DURATION_MS) pour une image. */
export const MAX_IMAGE_SECONDS = 20;

/** Bilan affiche apres un envoi, dans l'esprit de la reponse de `/meme`. */
export function sendSummary(report: DropUploadResponse): string {
  if (report.reached === 0) {
    return `Envoye dans ${report.channelName}, mais personne n'a l'overlay ouvert dans ce vocal.`;
  }
  const parts = [`Envoye dans ${report.channelName} : ${report.reached} personne(s), ${report.screens} ecran(s).`];
  if (report.offline > 0) parts.push(`${report.offline} sans overlay.`);
  if (report.muted > 0) parts.push(`${report.muted} en sourdine.`);
  return parts.join(' ');
}
