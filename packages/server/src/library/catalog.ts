import fs from 'node:fs';
import path from 'node:path';

/**
 * Banques de medias : la banque de memes video (#28) et la banque de sons
 * (#35). Elles vivent dans le meme dossier `LIBRARY_DIR`, chacune avec son
 * catalogue JSON qui decrit ses fichiers :
 *
 * ```json
 * library.json : { "videos": [ { "id": "chat-surpris", "title": "Chat surpris", "tags": ["chat"], "file": "chat-surpris.mp4" } ] }
 * sounds.json  : { "sounds": [ { "id": "vine-boom", "title": "Vine boom", "tags": ["boom"], "file": "vine-boom.m4a" } ] }
 * ```
 *
 * Uniquement des videos brutes, sans phrase incrustee : le texte, c'est
 * l'utilisateur qui l'ajoute dans l'editeur. Une entree invalide est ignoree
 * (avec un log) plutot que de casser toute la banque.
 */

/** Ce qui distingue une banque d'une autre : catalogue, cle de la liste, formats. */
export interface CatalogSpec {
  manifest: string;
  /** Cle de la liste dans le catalogue : "videos" ou "sounds". */
  key: string;
  /** Formats acceptes, d'apres l'extension du fichier. */
  types: Record<string, string>;
  /** Pour les messages : "mp4, webm ou mov". */
  formats: string;
  /** Slug de repli d'un titre sans lettre ni chiffre. */
  fallback: string;
}

export const VIDEOS: CatalogSpec = {
  manifest: 'library.json',
  key: 'videos',
  types: { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' },
  formats: 'mp4, webm ou mov',
  fallback: 'video',
};

/** Banque de sons (#35). L'editeur y envoie de l'AAC (.m4a) ; l'equipe peut aussi deposer du mp3. */
export const SOUNDS: CatalogSpec = {
  manifest: 'sounds.json',
  key: 'sounds',
  types: { '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' },
  formats: 'm4a, mp3, ogg ou wav',
  fallback: 'son',
};

export const MANIFEST = VIDEOS.manifest;

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

/** Catalogues deja lus, par chemin de catalogue. */
const cache = new Map<string, { mtimeMs: number; entries: LibraryEntry[] }>();

/** Valide une entree du catalogue ; renvoie la raison du refus sinon. */
export function parseEntry(raw: unknown, dir: string, spec: CatalogSpec = VIDEOS): LibraryEntry | string {
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

  const contentType = spec.types[path.extname(resolved).toLowerCase()];
  if (!contentType) return `${id} : format non supporte (${spec.formats})`;

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
export function readCatalog(
  dir: string,
  log: (message: string) => void = console.warn,
  spec: CatalogSpec = VIDEOS,
): LibraryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, spec.manifest), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(`[banque] ${spec.manifest} illisible : ${(error as Error).message}`);
    return [];
  }

  const items = (parsed as Record<string, unknown>)[spec.key];
  if (!Array.isArray(items)) {
    log(`[banque] ${spec.manifest} doit contenir { "${spec.key}": [...] }`);
    return [];
  }

  const entries: LibraryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const entry = parseEntry(raw, dir, spec);
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

/** Catalogue courant, relu seulement quand son fichier JSON a change. */
export function list(dir: string, spec: CatalogSpec = VIDEOS): LibraryEntry[] {
  const manifest = path.join(dir, spec.manifest);
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(manifest).mtimeMs;
  } catch {
    // Pas de catalogue : banque vide.
  }
  let hit = cache.get(manifest);
  if (!hit || hit.mtimeMs !== mtimeMs) {
    hit = { mtimeMs, entries: mtimeMs < 0 ? [] : readCatalog(dir, console.warn, spec) };
    cache.set(manifest, hit);
  }
  return hit.entries;
}

export function find(dir: string, id: string, spec: CatalogSpec = VIDEOS): LibraryEntry | null {
  return list(dir, spec).find((entry) => entry.id === id) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Ajouts depuis l'editeur                                                    */
/* -------------------------------------------------------------------------- */

/** Extension du fichier ecrit pour un type accepte par la banque. */
export function extensionFor(contentType: string, spec: CatalogSpec = VIDEOS): string | null {
  return Object.entries(spec.types).find(([, type]) => type === contentType)?.[0] ?? null;
}

/** "Chat surpris !" -> "chat-surpris", borne pour laisser la place au suffixe. */
export function slugify(title: string, fallback = VIDEOS.fallback): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || fallback;
}

/** Titre et tags saisis par l'utilisateur ; renvoie un message d'erreur sinon. */
export function parseSubmission(
  rawTitle: unknown,
  rawTags: unknown,
  missing = 'Donne un titre a la video.',
): { title: string; tags: string[] } | string {
  const title = typeof rawTitle === 'string' ? rawTitle.trim().replace(/\s+/g, ' ') : '';
  if (!title) return missing;
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
 * Ajoute au catalogue un fichier deja ecrit dans le dossier de la banque.
 * Ecriture atomique (fichier temporaire puis renommage) : un lecteur ne voit
 * jamais un catalogue a moitie ecrit. Les entrees existantes, meme invalides,
 * sont gardees telles quelles.
 */
export function append(
  dir: string,
  entry: { id: string; title: string; tags: string[]; file: string; addedBy: string },
  spec: CatalogSpec = VIDEOS,
): Promise<void> {
  const task = writing.then(async () => {
    const manifest = path.join(dir, spec.manifest);
    let data: Record<string, unknown> = { [spec.key]: [] };
    try {
      const parsed = JSON.parse(await fs.promises.readFile(manifest, 'utf8')) as Record<string, unknown>;
      if (!Array.isArray(parsed[spec.key])) throw new Error(`${spec.manifest} sans liste "${spec.key}"`);
      data = parsed;
    } catch (error) {
      // Un catalogue illisible ne doit pas etre ecrase par un ajout : on refuse.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    (data[spec.key] as unknown[]).push({ ...entry, addedAt: new Date().toISOString() });
    const temp = `${manifest}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
    await fs.promises.rename(temp, manifest);
  });
  writing = task.catch(() => {});
  return task;
}

/** Id libre : le slug du titre et un suffixe aleatoire court. */
export function freeId(dir: string, title: string, ext: string, random: () => string, spec: CatalogSpec = VIDEOS): string {
  const base = slugify(title, spec.fallback);
  const taken = new Set(list(dir, spec).map((entry) => entry.id));
  for (;;) {
    const id = `${base}-${random()}`;
    if (!taken.has(id) && !fs.existsSync(path.join(dir, `${id}${ext}`))) return id;
  }
}
