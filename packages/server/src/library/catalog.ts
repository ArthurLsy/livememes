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

/* -------------------------------------------------------------------------- */
/* Ajouts depuis l'editeur                                                    */
/* -------------------------------------------------------------------------- */

/** Extension du fichier ecrit pour un type video accepte. */
export function extensionFor(contentType: string): string | null {
  return Object.entries(VIDEO_TYPES).find(([, type]) => type === contentType)?.[0] ?? null;
}

/** "Chat surpris !" -> "chat-surpris", borne pour laisser la place au suffixe. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'video';
}

/** Titre et tags saisis par l'utilisateur ; renvoie un message d'erreur sinon. */
export function parseSubmission(rawTitle: unknown, rawTags: unknown): { title: string; tags: string[] } | string {
  const title = typeof rawTitle === 'string' ? rawTitle.trim().replace(/\s+/g, ' ') : '';
  if (!title) return 'Donne un titre a la video.';
  if (title.length > MAX_TITLE) return `Titre trop long (${MAX_TITLE} caracteres max).`;
  const tags = typeof rawTags === 'string' ? rawTags.split(',') : [];
  return {
    title,
    tags: [...new Set(tags.map((tag) => tag.trim().toLowerCase().replace(/^#/, '')).filter((tag) => tag && tag.length <= MAX_TAG))].slice(
      0,
      MAX_TAGS,
    ),
  };
}

/** Les ecritures du catalogue passent une par une : deux ajouts simultanes ne s'ecrasent pas. */
let writing: Promise<unknown> = Promise.resolve();

/**
 * Ajoute au catalogue une video deja ecrite dans le dossier de la banque.
 * Ecriture atomique (fichier temporaire puis renommage) : un lecteur ne voit
 * jamais un catalogue a moitie ecrit. Les entrees existantes, meme invalides,
 * sont gardees telles quelles.
 */
export function append(dir: string, entry: { id: string; title: string; tags: string[]; file: string; addedBy: string }): Promise<void> {
  const task = writing.then(async () => {
    const manifest = path.join(dir, MANIFEST);
    let data: { videos: unknown[] } & Record<string, unknown> = { videos: [] };
    try {
      const parsed = JSON.parse(await fs.promises.readFile(manifest, 'utf8')) as Record<string, unknown>;
      if (!Array.isArray(parsed.videos)) throw new Error(`${MANIFEST} sans liste "videos"`);
      data = parsed as typeof data;
    } catch (error) {
      // Un catalogue illisible ne doit pas etre ecrase par un ajout : on refuse.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    data.videos.push({ ...entry, addedAt: new Date().toISOString() });
    const temp = `${manifest}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
    await fs.promises.rename(temp, manifest);
  });
  writing = task.catch(() => {});
  return task;
}

/** Id libre : le slug du titre et un suffixe aleatoire court. */
export function freeId(dir: string, title: string, ext: string, random: () => string): string {
  const base = slugify(title);
  const taken = new Set(list(dir).map((entry) => entry.id));
  for (;;) {
    const id = `${base}-${random()}`;
    if (!taken.has(id) && !fs.existsSync(path.join(dir, `${id}${ext}`))) return id;
  }
}
