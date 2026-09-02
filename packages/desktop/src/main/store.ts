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

export interface Settings {
  token: string | null;
  user: { id: string; username: string; avatarUrl: string | null } | null;
  /** Volume applique par-dessus celui demande par l'expediteur, 0-1. */
  volume: number;
  muted: boolean;
  /** Afficher les memes sur tous les ecrans ou seulement le principal. */
  allDisplays: boolean;
  launchAtLogin: boolean;
}

const DEFAULTS: Settings = {
  token: null,
  user: null,
  volume: 0.7,
  muted: false,
  allDisplays: false,
  launchAtLogin: false,
};

let file: string;
let cache: Settings;

export function load(): Settings {
  file = path.join(app.getPath('userData'), 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>;
    cache = { ...DEFAULTS, ...raw };
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
