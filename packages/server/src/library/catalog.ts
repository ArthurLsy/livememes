import fs from 'node:fs';
import path from 'node:path';

/**
 * Banque de memes video (#28). L'equipe la remplit a la main : les videos dans
 * le dossier `LIBRARY_DIR`, et un catalogue `library.json` qui les decrit :
 *
 * ```json
 * { "videos": [ { "id": "chat-surpris", "title": "Chat surpris", "tags": ["chat", "reaction"], "file": "chat-surpris.mp4" } ] }
 * ```
 *
 * Uniquement des videos brutes, sans phrase incrustee : le texte, c'est
 * l'utilisateur qui l'ajoute dans l'editeur. Une entree invalide est ignoree
 * (avec un log) plutot que de casser toute la banque.
 */

export const MANIFEST = 'library.json';

/** Formats acceptes, d'apres l'extension du fichier. */
const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TITLE = 80;
const MAX_TAGS = 12;
const MAX_TAG = 32;

export interface LibraryEntry {
  id: string;
  title: string;
  tags: string[];
  /** Chemin absolu du fichier, toujours a l'interieur du dossier de la banque. */
  file: string;
  contentType: string;
  bytes: number;
}

let cache: { dir: string; mtimeMs: number; entries: LibraryEntry[] } | null = null;

/** Valide une entree du catalogue ; renvoie la raison du refus sinon. */
export function parseEntry(raw: unknown, dir: string): LibraryEntry | string {
  if (typeof raw !== 'object' || raw === null) return 'entree non objet';
  const { id, title, tags, file } = raw as Record<string, unknown>;

  if (typeof id !== 'string' || !ID.test(id)) return `id invalide (${String(id)}) : minuscules, chiffres et tirets`;
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE) return `${id} : titre manquant ou trop long`;
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string'))) {
    return `${id} : tags doit etre une liste de textes`;
  }
  if (typeof file !== 'string' || !file) return `${id} : fichier manquant`;

  // Le fichier doit rester dans le dossier de la banque : pas de ../ ni de chemin absolu.
  const root = path.resolve(dir);
  const resolved = path.resolve(root, file);
  if (!resolved.startsWith(root + path.sep)) return `${id} : fichier hors de la banque`;

  const contentType = VIDEO_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) return `${id} : format non supporte (mp4, webm ou mov)`;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return `${id} : fichier introuvable (${file})`;
  }
  if (!stat.isFile() || stat.size === 0) return `${id} : fichier vide ou illisible`;

  return {
    id,
    title: title.trim(),
    tags: ((tags as string[] | undefined) ?? [])
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag && tag.length <= MAX_TAG)
      .slice(0, MAX_TAGS),
    file: resolved,
    contentType,
    bytes: stat.size,
  };
}

/** Lit et valide tout le catalogue. Sans catalogue, la banque est simplement vide. */
export function readCatalog(dir: string, log: (message: string) => void = console.warn): LibraryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`[banque] ${MANIFEST} illisible : ${(error as Error).message}`);
    return [];
  }

  const videos = (parsed as { videos?: unknown }).videos;
  if (!Array.isArray(videos)) {
    log(`[banque] ${MANIFEST} doit contenir { "videos": [...] }`);
    return [];
  }

  const entries: LibraryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of videos) {
    const entry = parseEntry(raw, dir);
    if (typeof entry === 'string') {
      log(`[banque] entree ignoree : ${entry}`);
      continue;
    }
    if (seen.has(entry.id)) {
      log(`[banque] entree ignoree : id en double (${entry.id})`);
      continue;
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

/** Catalogue courant, relu seulement quand `library.json` a change. */
export function list(dir: string): LibraryEntry[] {
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(path.join(dir, MANIFEST)).mtimeMs;
  } catch {
    // Pas de catalogue : banque vide.
  }
  if (!cache || cache.dir !== dir || cache.mtimeMs !== mtimeMs) {
    cache = { dir, mtimeMs, entries: mtimeMs < 0 ? [] : readCatalog(dir) };
  }
  return cache.entries;
}

export function find(dir: string, id: string): LibraryEntry | null {
  return list(dir).find((entry) => entry.id === id) ?? null;
}
