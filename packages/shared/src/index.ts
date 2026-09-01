/**
 * Protocole partage entre le serveur (relais) et l'overlay Electron.
 *
 * Tout transite en JSON sur une seule connexion WebSocket par client desktop.
 * Les champs sont volontairement courts : un drop part vers N clients a la fois.
 */

export const PROTOCOL_VERSION = 1;

/** Endroits ou un meme peut apparaitre a l'ecran. */
export const MEME_POSITIONS = [
  'center',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'random',
] as const;
export type MemePosition = (typeof MEME_POSITIONS)[number];

/** Tailles proposees dans la commande Discord, en fraction de la hauteur d'ecran. */
export const MEME_SIZES = {
  small: 0.25,
  medium: 0.45,
  large: 0.7,
  huge: 1,
} as const;
export type MemeSize = keyof typeof MEME_SIZES;

export type MemeKind = 'image' | 'video';

export interface DropAuthor {
  id: string;
  username: string;
  avatarUrl: string | null;
}

/** Un meme a afficher, tel que l'overlay le recoit. */
export interface MemeDrop {
  id: string;
  /** URL absolue servie par le backend (jamais l'URL d'origine : elle peut expirer). */
  url: string;
  kind: MemeKind;
  /** Duree d'affichage, animations d'entree/sortie comprises. */
  durationMs: number;
  position: MemePosition;
  /** Hauteur cible, en fraction de la hauteur de l'ecran (0-1). */
  scale: number;
  /** Volume de lecture pour les videos, 0-1. Ignore pour les images. */
  volume: number;
  caption: string | null;
  author: DropAuthor;
  guildName: string | null;
  sentAt: number;
}

/* -------------------------------------------------------------------------- */
/* Serveur -> client                                                          */
/* -------------------------------------------------------------------------- */

export type ServerMessage =
  | {
      t: 'hello';
      protocol: number;
      user: { id: string; username: string; avatarUrl: string | null };
      /** true si l'utilisateur s'est mis en sourdine via /livememes mute. */
      muted: boolean;
    }
  | { t: 'drop'; drop: MemeDrop }
  /** Retire un drop encore affiche (moderation, /livememes clear). */
  | { t: 'clear'; dropId: string | null }
  | { t: 'muted'; muted: boolean }
  | { t: 'pong'; ts: number }
  | { t: 'error'; code: string; message: string };

/* -------------------------------------------------------------------------- */
/* Client -> serveur                                                          */
/* -------------------------------------------------------------------------- */

export type ClientMessage =
  | { t: 'ping'; ts: number }
  /** Accuse reception : sert aux stats "vu par X personnes" renvoyees dans Discord. */
  | { t: 'shown'; dropId: string }
  | { t: 'setMuted'; muted: boolean };

export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { t?: unknown }).t;
  return t === 'ping' || t === 'shown' || t === 'setMuted';
}

/* -------------------------------------------------------------------------- */
/* HTTP : appairage du client desktop                                         */
/* -------------------------------------------------------------------------- */

export interface PairRequest {
  code: string;
  /** Nom lisible de la machine, affiche dans /livememes devices. */
  deviceName: string;
}

export interface PairResponse {
  token: string;
  user: { id: string; username: string; avatarUrl: string | null };
}

/** Longueur du code d'appairage affiche par le bot. */
export const PAIRING_CODE_LENGTH = 8;
/** Alphabet sans caracteres ambigus (pas de 0/O, 1/I/L). */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
