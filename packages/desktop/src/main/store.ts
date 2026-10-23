import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * Backend joint par l'overlay. Volontairement hors de `Settings` : l'utilisateur
 * n'a pas a le saisir, et le garder dans settings.json figerait l'ancienne valeur
 * sur les installations existantes. LIVEMEMES_SERVER reste la porte de sortie
 * pour le developpement local.
 */
export const SERVER_URL = process.env.LIVEMEMES_SERVER ?? 'https://meme.gowey.fr';

export type DisplayChoice = 'primary' | 'all' | number[];

export interface Settings {
  token: string | null;
  user: { id: string; username: string; avatarUrl: string | null } | null;
  /** Volume applique par-dessus celui demande par l'expediteur, 0-1. */
  volume: number;
  muted: boolean;
  /**
   * Ecrans d'affichage : le principal, tous, ou une liste de `display.id`.
   * Un ecran choisi mais debranche est ignore ; si plus aucun ne reste, on
   * retombe sur l'ecran principal.
   */
  displays: DisplayChoice;
  launchAtLogin: boolean;
  /** Croix discrete en haut a droite de chaque meme pour le fermer (#18). */
  closeButton: boolean;
  /** Appareil deja lie au moins une fois : le tutoriel saute alors la bienvenue. */
  onboarded: boolean;
  /** Dossier ou l'editeur enregistre les memes, choisi au premier enregistrement. */
  exportDir: string | null;
}

const DEFAULTS: Settings = {
  token: null,
  user: null,
  volume: 0.7,
  muted: false,
  displays: 'primary',
  launchAtLogin: false,
  closeButton: true,
  onboarded: false,
  exportDir: null,
};

let file: string;
let cache: Settings;

export function load(): Settings {
  file = path.join(app.getPath('userData'), 'settings.json');
  try {
    const { allDisplays, ...raw } = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings> & {
      allDisplays?: boolean;
    };
    cache = { ...DEFAULTS, ...raw };
    // Reprise de l'ancien booleen allDisplays (versions <= 0.1.0-beta.1).
    if (raw.displays === undefined && allDisplays) cache.displays = 'all';
    // Installations anterieures au tutoriel : un token prouve un appairage passe.
    if (raw.onboarded === undefined) cache.onboarded = Boolean(raw.token);
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function get(): Settings {
  return cache ?? load();
}

export function update(patch: Partial<Settings>): Settings {
  cache = { ...get(), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  return cache;
}

/** Normalise l'URL saisie par l'utilisateur et derive l'endpoint WebSocket. */
export function endpoints(serverUrl: string): { http: string; ws: string } {
  const trimmed = serverUrl.trim().replace(/\/+$/, '');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  return {
    http: url.origin,
    ws: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/ws`,
  };
}
