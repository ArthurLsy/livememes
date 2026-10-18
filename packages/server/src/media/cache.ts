import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { MemeKind } from '@livememes/shared';
import { config } from '../config.ts';
import { MediaError } from './errors.ts';
import { safeGet, type FetchPolicy } from './fetch.ts';
import { SNIFF_BYTES, matchesSignature } from './sniff.ts';

export { MediaError };

const mediaDir = path.join(config.dataDir, 'media');
fs.mkdirSync(mediaDir, { recursive: true });

/**
 * Types acceptes. Tout ce qui n'est pas la-dedans est refuse : l'overlay ne rend
 * que <img> et <video>, et on ne veut pas servir de HTML/SVG (vecteur de script).
 */
const ALLOWED: Record<string, { ext: string; kind: MemeKind }> = {
  'image/png': { ext: 'png', kind: 'image' },
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/apng': { ext: 'apng', kind: 'image' },
  'image/avif': { ext: 'avif', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
};

export interface CachedMedia {
  id: string;
  kind: MemeKind;
  contentType: string;
  bytes: number;
  /** URL absolue a envoyer aux overlays. */
  url: string;
}

const index = new Map<string, { file: string; contentType: string; kind: MemeKind }>();

function humanBytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

/**
 * Telecharge une URL distante et la re-sert depuis le backend.
 *
 * Indispensable : les URLs du CDN Discord sont signees et expirent, et les
 * overlays ne doivent pas dependre de la disponibilite d'un hote tiers.
 *
 * `policy` ne sert qu'aux tests (autoriser un serveur local).
 */
export async function ingest(sourceUrl: string, policy?: FetchPolicy): Promise<CachedMedia> {
  const id = createHash('sha256').update(sourceUrl).digest('base64url').slice(0, 22);
  const hit = index.get(id);
  if (hit && fs.existsSync(hit.file)) {
    const stat = await fsp.stat(hit.file);
    await fsp.utimes(hit.file, new Date(), new Date()); // garde le fichier chaud
    return { id, kind: hit.kind, contentType: hit.contentType, bytes: stat.size, url: publicUrlFor(id) };
  }

  const response = await safeGet(sourceUrl, policy);
  const { contentType } = response;

  if (response.status < 200 || response.status >= 300) {
    response.body.destroy();
    throw new MediaError(`Le serveur distant a repondu ${response.status}.`);
  }

  const allowed = ALLOWED[contentType];
  if (!allowed) {
    response.body.destroy();
    throw new MediaError(
      `Type de fichier non supporte (${contentType || 'inconnu'}). Images, GIFs et videos courtes uniquement.`,
    );
  }

  const declared = response.contentLength;
  if (declared > config.media.maxBytes) {
    response.body.destroy();
    throw new MediaError(`Fichier trop lourd (${humanBytes(declared)}, max ${humanBytes(config.media.maxBytes)}).`);
  }

  const file = path.join(mediaDir, `${id}.${allowed.ext}`);
  const bytes = await streamToFile(response.body, contentType, file);

  index.set(id, { file, contentType, kind: allowed.kind });
  return { id, kind: allowed.kind, contentType, bytes, url: publicUrlFor(id) };
}

const DISGUISED_MESSAGE = "Le contenu du fichier ne correspond pas a son type annonce.";

/**
 * Ecrit le corps sur disque en coupant des que la taille max est depassee, et
 * verifie la signature des premiers octets contre le type annonce.
 */
async function streamToFile(body: Readable, contentType: string, file: string): Promise<number> {
  const handle = await fsp.open(file, 'w');
  let written = 0;
  let head: Buffer | null = Buffer.alloc(0); // null une fois la signature validee
  try {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      written += chunk.byteLength;
      if (written > config.media.maxBytes) {
        throw new MediaError(`Fichier trop lourd (max ${humanBytes(config.media.maxBytes)}).`);
      }
      if (head) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= SNIFF_BYTES) {
          if (!matchesSignature(contentType, head)) throw new MediaError(DISGUISED_MESSAGE);
          head = null;
        }
      }
      await handle.write(chunk);
    }
    // Fichier plus court que SNIFF_BYTES : on tranche sur ce qu'on a.
    if (head && written > 0 && !matchesSignature(contentType, head)) {
      throw new MediaError(DISGUISED_MESSAGE);
    }
  } catch (error) {
    body.destroy();
    await handle.close();
    await fsp.rm(file, { force: true });
    throw error instanceof MediaError ? error : new MediaError('Telechargement interrompu.');
  }
  await handle.close();

  if (written === 0) {
    await fsp.rm(file, { force: true });
    throw new MediaError('Le fichier est vide.');
  }
  return written;
}

function publicUrlFor(id: string): string {
  return `${config.http.publicUrl}/media/${id}`;
}

export function resolve(id: string): { file: string; contentType: string } | null {
  const hit = index.get(id);
  if (hit && fs.existsSync(hit.file)) return { file: hit.file, contentType: hit.contentType };
  if (hit) index.delete(id);

  // Cache memoire vide apres un redemarrage : on retrouve le fichier par prefixe.
  const match = fs.readdirSync(mediaDir).find((name) => name.startsWith(`${id}.`));
  if (!match) return null;

  const ext = path.extname(match).slice(1);
  const entry = Object.entries(ALLOWED).find(([, meta]) => meta.ext === ext);
  if (!entry) return null;

  const file = path.join(mediaDir, match);
  index.set(id, { file, contentType: entry[0], kind: entry[1].kind });
  return { file, contentType: entry[0] };
}

/** Supprime les medias non consultes depuis MEDIA_TTL_HOURS. */
export async function purgeExpired(): Promise<void> {
  const cutoff = Date.now() - config.media.ttlMs;
  let names: string[];
  try {
    names = await fsp.readdir(mediaDir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(mediaDir, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.mtimeMs < cutoff) {
        await fsp.rm(file, { force: true });
        index.delete(path.basename(name, path.extname(name)));
      }
    } catch {
      // fichier deja parti : rien a faire
    }
  }
}

/** Purge au demarrage puis toutes les 30 min. */
export function startCleanup(): void {
  void purgeExpired();
  setInterval(() => void purgeExpired(), 30 * 60 * 1000).unref();
}
