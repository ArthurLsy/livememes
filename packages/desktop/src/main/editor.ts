import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dialog, ipcMain, shell } from 'electron';
import {
  SOUND_MAX_BYTES,
  SOUND_MAX_SECONDS,
  type DropUploadResponse,
  type LibraryAddResponse,
  type LibraryResponse,
  type LibrarySound,
  type LibraryVideo,
  type SoundAddResponse,
  type SoundsResponse,
} from '@livememes/shared';
import { MAX_IMAGE_SECONDS, SEND_POSITIONS, SEND_SIZES, type SendOptions } from '../renderer/editor-model.ts';
import {
  gifArgs,
  OUTPUT,
  parseRenderRequest,
  parseSound,
  photoSoundArgs,
  soundArgs,
  tighten,
  UPLOAD_MAX_BYTES,
  videoArgs,
  videoBudget,
  type RenderRequest,
  type SourceKind,
} from './edit-plan.ts';
import * as editorWindow from './editor-window.ts';
import { probeAudio, RenderError, runFfmpeg } from './ffmpeg.ts';
import * as store from './store.ts';

/** Formats ouverts par l'editeur, d'apres l'extension. */
const SOURCES: Record<string, { kind: SourceKind; mime: string }> = {
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.m4v': { kind: 'video', mime: 'video/mp4' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.gif': { kind: 'gif', mime: 'image/gif' },
  '.png': { kind: 'photo', mime: 'image/png' },
  '.jpg': { kind: 'photo', mime: 'image/jpeg' },
  '.jpeg': { kind: 'photo', mime: 'image/jpeg' },
  '.webp': { kind: 'photo', mime: 'image/webp' },
};

/**
 * Fichiers acceptes comme son ajoute (#36, #37) : des sons, mais aussi des
 * videos, dont on reprend la bande son.
 */
const SOUND_FILES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** Extension du fichier ecrit pour un son telecharge depuis la banque. */
const SOUND_DOWNLOADS: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
};

/** Un son plus lourd est une erreur de manip (un film entier ?). */
const MAX_SOUND_INPUT_BYTES = 500 * 1024 * 1024;

/** Une image est transmise au renderer en memoire : au-dela, on refuse. */
const MAX_IMAGE_INPUT_BYTES = 60 * 1024 * 1024;

interface Source {
  file: string;
  name: string;
  kind: SourceKind;
  mime: string;
  /** Video piochee dans la banque : inutile de proposer de l'y ajouter. */
  fromLibrary: boolean;
}

/** Son ajoute, choisi par import ou dans la banque de sons. */
interface Sound {
  file: string;
  name: string;
  /** Son pioche dans la banque : inutile de proposer de l'y ajouter. */
  fromLibrary: boolean;
}

/** Son tel que le renderer le recoit : une URL file:// pour l'apercu. */
export interface OpenedSound {
  name: string;
  url: string;
  fromLibrary: boolean;
}

/** Source telle que le renderer la recoit : une URL pour une video, les octets pour une image. */
export interface OpenedSource {
  name: string;
  kind: SourceKind;
  mime: string;
  url: string | null;
  bytes: Uint8Array | null;
  fromLibrary: boolean;
}

export interface RenderJob {
  request: unknown;
  /** Calque texte PNG aux dimensions de la source, null sans texte. */
  overlay: Uint8Array | null;
  /** Photo deja composee par le renderer. */
  photo: Uint8Array | null;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

let source: Source | null = null;
/** La source ouverte a-t-elle une piste son ? Sonde une fois, au premier rendu qui en a besoin. */
let sourceAudio: boolean | null = null;
let sound: Sound | null = null;
let workDir: string | null = null;
let lastRender: { key: string; file: string; mime: string; ext: string } | null = null;
let lastSaved: string | null = null;
let busy = false;

async function ensureWorkDir(): Promise<string> {
  workDir ??= await fsp.mkdtemp(path.join(os.tmpdir(), 'livememes-editeur-'));
  return workDir;
}

/** Fichiers temporaires effaces a la fermeture de l'editeur et en quittant. */
export function cleanup(): void {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  workDir = null;
  lastRender = null;
  source = null;
  sourceAudio = null;
  sound = null;
}

function humanBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

/* -------------------------------------------------------------------------- */
/* Ouverture                                                                  */
/* -------------------------------------------------------------------------- */

async function openSource(file: string, displayName?: string, fromLibrary = false): Promise<Result<{ source: OpenedSource }>> {
  const type = SOURCES[path.extname(file).toLowerCase()];
  if (!type) return { ok: false, error: 'Format non supporte. Ouvre une video (mp4, mov, webm), un GIF ou une photo.' };

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    return { ok: false, error: 'Fichier introuvable.' };
  }
  if (!stat.isFile()) return { ok: false, error: 'Ce n est pas un fichier.' };

  let bytes: Uint8Array | null = null;
  if (type.kind !== 'video') {
    if (stat.size > MAX_IMAGE_INPUT_BYTES) return { ok: false, error: `Image trop lourde (${humanBytes(stat.size)}).` };
    bytes = await fsp.readFile(file);
  }

  source = { file, name: displayName ?? path.basename(file), ...type, fromLibrary };
  sourceAudio = null;
  lastRender = null;
  return {
    ok: true,
    source: {
      name: source.name,
      kind: type.kind,
      mime: type.mime,
      url: type.kind === 'video' ? pathToFileURL(file).href : null,
      bytes,
      fromLibrary,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Banque de memes (#28)                                                      */
/* -------------------------------------------------------------------------- */

/** Une video de la banque est retravaillee en clip de 30 s : au-dela, c'est une erreur de catalogue. */
const MAX_LIBRARY_BYTES = 200 * 1024 * 1024;

/** Dernier catalogue recu : l'ouverture ne telecharge que ce que le serveur a liste. */
let libraryVideos = new Map<string, LibraryVideo>();

async function fetchLibrary(): Promise<Result<{ videos: LibraryVideo[] }>> {
  const result = await fetchCatalog<LibraryVideo>(
    'library',
    (body) => (body as LibraryResponse | null)?.videos,
    'Le serveur ne propose pas encore de banque de memes.',
  );
  if (!result.ok) return result;
  libraryVideos = new Map(result.items.map((video) => [video.id, video]));
  return { ok: true, videos: result.items };
}

/** Telecharge une video de la banque dans le dossier de travail et l'ouvre comme un fichier local. */
async function openLibraryVideo(id: unknown): Promise<Result<{ source: OpenedSource }>> {
  const video = typeof id === 'string' ? libraryVideos.get(id) : undefined;
  if (!video) return { ok: false, error: 'Video introuvable dans la banque. Rouvre la banque et reessaie.' };

  try {
    const response = await fetch(video.url, { signal: AbortSignal.timeout(120_000) });
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
    const ext = Object.entries(SOURCES).find(([, meta]) => meta.kind === 'video' && meta.mime === type)?.[0];
    if (!response.ok || !ext) return { ok: false, error: 'Video de la banque indisponible.' };
    if (Number(response.headers.get('content-length') ?? 0) > MAX_LIBRARY_BYTES) {
      return { ok: false, error: 'Video de la banque trop lourde.' };
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_LIBRARY_BYTES) return { ok: false, error: 'Video de la banque trop lourde.' };

    const file = path.join(await ensureWorkDir(), `banque-${video.id}${ext}`);
    await fsp.writeFile(file, data);
    return await openSource(file, video.title, true);
  } catch {
    return { ok: false, error: 'Telechargement interrompu. Verifie ta connexion et reessaie.' };
  }
}

/* -------------------------------------------------------------------------- */
/* Son ajoute et banque de sons (#35, #36, #37)                               */
/* -------------------------------------------------------------------------- */

async function openSound(file: string, displayName?: string, fromLibrary = false): Promise<Result<{ sound: OpenedSound }>> {
  if (!SOUND_FILES[path.extname(file).toLowerCase()]) {
    return { ok: false, error: 'Format non supporte. Ouvre un son (mp3, m4a, wav, ogg) ou une video.' };
  }
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    return { ok: false, error: 'Fichier introuvable.' };
  }
  if (!stat.isFile()) return { ok: false, error: 'Ce n est pas un fichier.' };
  if (stat.size > MAX_SOUND_INPUT_BYTES) return { ok: false, error: `Fichier trop lourd (${humanBytes(stat.size)}).` };
  if (!(await probeAudio(file))) return { ok: false, error: "Ce fichier n'a pas de son." };

  sound = { file, name: displayName ?? path.basename(file), fromLibrary };
  lastRender = null;
  return { ok: true, sound: { name: sound.name, url: pathToFileURL(file).href, fromLibrary } };
}

/** Catalogue d'une banque du serveur, filtre sur la forme attendue. */
async function fetchCatalog<T extends LibraryVideo | LibrarySound>(
  route: string,
  pick: (body: unknown) => unknown,
  missing: string,
): Promise<Result<{ items: T[] }>> {
  const { token } = store.get();
  if (!token) return { ok: false, error: "Lie d'abord l'app a ton compte Discord (fenetre de reglages)." };
  const { http } = store.endpoints(store.SERVER_URL);

  let response: Response;
  try {
    response = await fetch(`${http}/api/${route}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, error: 'Serveur injoignable. Verifie ta connexion internet et reessaie.' };
  }
  if (response.status === 404) return { ok: false, error: missing };
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: payload.error ?? `Banque indisponible (HTTP ${response.status}).` };
  }

  const list = pick(await response.json().catch(() => null));
  const items = (Array.isArray(list) ? list : []).filter(
    (item): item is T =>
      typeof item?.id === 'string' &&
      /^[a-z0-9-]{1,64}$/.test(item.id) &&
      typeof item.title === 'string' &&
      Array.isArray(item.tags) &&
      typeof item.url === 'string' &&
      /^https?:\/\//.test(item.url),
  );
  return { ok: true, items };
}

let librarySounds = new Map<string, LibrarySound>();

async function fetchSounds(): Promise<Result<{ sounds: LibrarySound[] }>> {
  const result = await fetchCatalog<LibrarySound>(
    'sounds',
    (body) => (body as SoundsResponse | null)?.sounds,
    'Le serveur ne propose pas encore de banque de sons.',
  );
  if (!result.ok) return result;
  librarySounds = new Map(result.items.map((item) => [item.id, item]));
  return { ok: true, sounds: result.items };
}

/** Plafond d'un son telecharge depuis la banque : le serveur en accepte 8 Mo, l'equipe peut en deposer de plus gros. */
const MAX_LIBRARY_SOUND_BYTES = 50 * 1024 * 1024;

async function openLibrarySound(id: unknown): Promise<Result<{ sound: OpenedSound }>> {
  const item = typeof id === 'string' ? librarySounds.get(id) : undefined;
  if (!item) return { ok: false, error: 'Son introuvable dans la banque. Rouvre la banque et reessaie.' };

  try {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
    const ext = SOUND_DOWNLOADS[type];
    if (!response.ok || !ext) return { ok: false, error: 'Son de la banque indisponible.' };
    if (Number(response.headers.get('content-length') ?? 0) > MAX_LIBRARY_SOUND_BYTES) {
      return { ok: false, error: 'Son de la banque trop lourd.' };
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_LIBRARY_SOUND_BYTES) return { ok: false, error: 'Son de la banque trop lourd.' };

    const file = path.join(await ensureWorkDir(), `son-${item.id}${ext}`);
    await fsp.writeFile(file, data);
    return await openSound(file, item.title, true);
  } catch {
    return { ok: false, error: 'Telechargement interrompu. Verifie ta connexion et reessaie.' };
  }
}

/**
 * Ajoute le son a la banque : le passage choisi (a partir de `from`), 30 s au
 * plus, converti en AAC. Publie tout de suite pour tout le monde.
 */
async function addSoundToLibrary(rawMeta: unknown, rawFrom: unknown): Promise<Result<{ sound: LibrarySound }>> {
  const { token } = store.get();
  if (!token) return { ok: false, error: "Lie d'abord l'app a ton compte Discord (fenetre de reglages)." };
  if (!sound) return { ok: false, error: "Choisis d'abord un son." };
  if (sound.fromLibrary) return { ok: false, error: 'Ce son vient deja de la banque.' };

  const meta = (typeof rawMeta === 'object' && rawMeta !== null ? rawMeta : {}) as Record<string, unknown>;
  const title = typeof meta.title === 'string' ? meta.title.trim() : '';
  const tags = typeof meta.tags === 'string' ? meta.tags : '';
  if (!title) return { ok: false, error: 'Donne un titre au son.' };
  const clip = parseSound({ from: rawFrom, at: 0, gain: 1 });
  if (!clip) return { ok: false, error: 'Passage du son invalide.' };

  const file = path.join(await ensureWorkDir(), `banque-son-${Date.now()}.m4a`);
  await runFfmpeg(soundArgs(clip.from, SOUND_MAX_SECONDS, sound.file, file), SOUND_MAX_SECONDS, progress);
  const body = await fsp.readFile(file);
  await fsp.rm(file, { force: true });
  if (body.length === 0) return { ok: false, error: 'Ce passage ne contient pas de son.' };
  if (body.length > SOUND_MAX_BYTES) return { ok: false, error: `Son trop lourd (${humanBytes(body.length)}).` };

  const { http } = store.endpoints(store.SERVER_URL);
  editorWindow.push('editor:progress', null);
  let response: Response;
  try {
    response = await fetch(`${http}/api/sounds?${new URLSearchParams({ title, tags })}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/mp4' },
      body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return { ok: false, error: 'Serveur injoignable. Verifie ta connexion internet et reessaie.' };
  }
  if (response.status === 404) return { ok: false, error: "Le serveur ne permet pas encore d'ajouter des sons." };
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: payload.error ?? `Ajout refuse (HTTP ${response.status}).` };
  }
  return { ok: true, sound: ((await response.json()) as SoundAddResponse).sound };
}

/* -------------------------------------------------------------------------- */
/* Rendu                                                                      */
/* -------------------------------------------------------------------------- */

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const startsWith = (data: Uint8Array, magic: number[]) => magic.every((value, i) => data[i] === value);

function jobKey(request: RenderRequest, job: RenderJob): string {
  const hash = createHash('sha256').update(source?.file ?? '').update(JSON.stringify(request));
  if ('sound' in request && request.sound) hash.update(sound?.file ?? '');
  if (job.overlay) hash.update(job.overlay);
  if (job.photo) hash.update(job.photo);
  return hash.digest('hex');
}

const progress = (fraction: number) => editorWindow.push('editor:progress', fraction);

async function sizeOf(file: string): Promise<number> {
  return (await fsp.stat(file)).size;
}

/** Produit le fichier final, ou reprend le dernier si rien n'a change depuis. */
async function render(job: RenderJob): Promise<{ file: string; mime: string; ext: string }> {
  if (!source) throw new RenderError("Ouvre d'abord une video ou une photo.");
  const request = parseRenderRequest(job.request, source.kind);
  if (!request) throw new RenderError('Montage invalide.');

  if ('sound' in request && request.sound && !sound) throw new RenderError('Son introuvable : rechoisis-le.');

  const key = jobKey(request, job);
  if (lastRender?.key === key && fs.existsSync(lastRender.file)) return lastRender;

  const dir = await ensureWorkDir();
  const id = key.slice(0, 12);
  let overlay: string | null = null;
  if (job.overlay) {
    if (!startsWith(job.overlay, PNG)) throw new RenderError('Calque texte invalide.');
    overlay = path.join(dir, `${id}-texte.png`);
    await fsp.writeFile(overlay, job.overlay);
  }

  let result: { file: string; mime: string; ext: string };
  switch (request.kind) {
    case 'photo': {
      if (!job.photo) throw new RenderError('Photo manquante.');
      const ok = request.mime === 'image/png' ? startsWith(job.photo, PNG) : startsWith(job.photo, JPEG);
      if (!ok) throw new RenderError('Photo invalide.');
      const ext = request.mime === 'image/png' ? 'png' : 'jpg';
      const file = path.join(dir, `${id}.${ext}`);
      await fsp.writeFile(file, job.photo);
      result = { file, mime: request.mime, ext };
      break;
    }

    case 'gif': {
      const file = path.join(dir, `${id}.gif`);
      if (!overlay || !request.text) {
        // Rien a incruster : le GIF part tel quel.
        await fsp.copyFile(source.file, file);
      } else {
        await runFfmpeg(gifArgs(request, { source: source.file, overlay, output: file }), null, progress);
        if ((await sizeOf(file)) > UPLOAD_MAX_BYTES) {
          await runFfmpeg(gifArgs(request, { source: source.file, overlay, output: file }, 480), null, progress);
        }
      }
      result = { file, ...OUTPUT.gif! };
      break;
    }

    case 'video': {
      const file = path.join(dir, `${id}.mp4`);
      const seconds = request.trim.end - request.trim.start;
      // Mixer le son ajoute a celui d'origine suppose que la source en a un.
      if (request.sound && !request.muted) sourceAudio ??= await probeAudio(source.file);
      const paths = { source: source.file, overlay, output: file, sound: request.sound ? sound!.file : null };
      let budget = videoBudget(seconds, UPLOAD_MAX_BYTES, request.muted && !request.sound);
      await runFfmpeg(videoArgs(request, paths, budget, sourceAudio ?? true), seconds, progress);
      // L'encodeur peut depasser un peu sa cible : une seconde passe, plus serree.
      if ((await sizeOf(file)) > UPLOAD_MAX_BYTES) {
        budget = tighten(budget);
        await runFfmpeg(videoArgs(request, paths, budget, sourceAudio ?? true), seconds, progress);
      }
      result = { file, ...OUTPUT.video! };
      break;
    }

    case 'photo-sound': {
      // Photo composee par le renderer, puis image fixe + son en video (#36).
      if (!job.photo) throw new RenderError('Photo manquante.');
      const ok = request.mime === 'image/png' ? startsWith(job.photo, PNG) : startsWith(job.photo, JPEG);
      if (!ok) throw new RenderError('Photo invalide.');
      const still = path.join(dir, `${id}-photo.${request.mime === 'image/png' ? 'png' : 'jpg'}`);
      await fsp.writeFile(still, job.photo);
      const file = path.join(dir, `${id}.mp4`);
      const paths = { source: still, overlay: null, output: file, sound: sound!.file };
      let budget = videoBudget(request.seconds, UPLOAD_MAX_BYTES, false);
      await runFfmpeg(photoSoundArgs(request, paths, budget), request.seconds, progress);
      if ((await sizeOf(file)) > UPLOAD_MAX_BYTES) {
        budget = tighten(budget);
        await runFfmpeg(photoSoundArgs(request, paths, budget), request.seconds, progress);
      }
      result = { file, ...OUTPUT['photo-sound']! };
      break;
    }
  }

  const bytes = await sizeOf(result.file);
  if (bytes > UPLOAD_MAX_BYTES) {
    throw new RenderError(`Le resultat est trop lourd (${humanBytes(bytes)}, max ${humanBytes(UPLOAD_MAX_BYTES)}).`);
  }

  lastRender = { key, ...result };
  return result;
}

/** Une seule operation a la fois : un double clic ne lance pas deux ffmpeg. */
async function exclusive<T>(task: () => Promise<Result<T>>): Promise<Result<T>> {
  if (busy) return { ok: false, error: 'Un export est deja en cours.' };
  busy = true;
  try {
    return await task();
  } catch (error) {
    if (error instanceof RenderError) return { ok: false, error: error.message };
    console.error('[editeur] echec', error);
    return { ok: false, error: "Quelque chose a casse pendant l'export. Reessaie." };
  } finally {
    busy = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Enregistrement                                                             */
/* -------------------------------------------------------------------------- */

async function chooseDir(): Promise<string | null> {
  const window = editorWindow.get();
  const options: Electron.OpenDialogOptions = {
    title: 'Dossier des memes enregistres',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: store.get().exportDir ?? undefined,
  };
  const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const dir = picked.canceled ? null : (picked.filePaths[0] ?? null);
  if (dir) store.update({ exportDir: dir });
  return dir;
}

/** LiveMemes 2026-10-23 18-04-05.mp4, suffixe (2), (3)... si le nom est pris. */
function freeName(dir: string, ext: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  let name = `LiveMemes ${stamp}.${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `LiveMemes ${stamp} (${i}).${ext}`;
  return path.join(dir, name);
}

async function save(job: RenderJob): Promise<Result<{ name: string; dir: string }>> {
  let dir = store.get().exportDir;
  if (!dir || !fs.existsSync(dir)) dir = await chooseDir();
  if (!dir) return { ok: false, error: 'Choisis un dossier pour enregistrer.' };

  const rendered = await render(job);
  const target = freeName(dir, rendered.ext);
  await fsp.copyFile(rendered.file, target);
  lastSaved = target;
  return { ok: true, name: path.basename(target), dir };
}

/* -------------------------------------------------------------------------- */
/* Envoi                                                                      */
/* -------------------------------------------------------------------------- */

function parseSendOptions(raw: unknown): SendOptions | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { size, position, volume, duration } = raw as Record<string, unknown>;
  if (!SEND_SIZES.some((entry) => entry.value === size)) return null;
  if (!SEND_POSITIONS.some((entry) => entry.value === position)) return null;
  if (!Number.isInteger(volume) || (volume as number) < 0 || (volume as number) > 100) return null;
  if (!Number.isInteger(duration) || (duration as number) < 1 || (duration as number) > MAX_IMAGE_SECONDS) return null;
  return raw as SendOptions;
}

async function send(job: RenderJob, rawOptions: unknown): Promise<Result<{ report: DropUploadResponse }>> {
  const { token } = store.get();
  if (!token) return { ok: false, error: "Lie d'abord l'app a ton compte Discord (fenetre de reglages)." };
  const options = parseSendOptions(rawOptions);
  if (!options) return { ok: false, error: "Options d'envoi invalides." };

  const rendered = await render(job);
  const body = await fsp.readFile(rendered.file);

  const query = new URLSearchParams({ size: options.size, position: options.position });
  if (rendered.mime.startsWith('video/')) query.set('volume', String(options.volume));
  else query.set('duration', String(options.duration));

  const { http } = store.endpoints(store.SERVER_URL);
  editorWindow.push('editor:progress', null);
  let response: Response;
  try {
    response = await fetch(`${http}/api/drops?${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': rendered.mime },
      body,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return { ok: false, error: 'Serveur injoignable. Verifie ta connexion internet et reessaie.' };
  }

  if (!response.ok) {
    if (response.status === 404) {
      return { ok: false, error: "Le serveur ne connait pas encore l'envoi direct. Enregistre le meme et passe par /meme." };
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: payload.error ?? `Envoi refuse (HTTP ${response.status}).` };
  }

  return { ok: true, report: (await response.json()) as DropUploadResponse };
}

/* -------------------------------------------------------------------------- */
/* Ajout a la banque                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Ajoute la video ouverte a la banque, en version brute : le passage coupe et
 * le son choisis, mais sans le texte (la banque ne garde que des videos sans
 * phrase incrustee, chacun ajoute la sienne).
 */
async function addToLibrary(job: RenderJob, rawMeta: unknown): Promise<Result<{ video: LibraryVideo }>> {
  const { token } = store.get();
  if (!token) return { ok: false, error: "Lie d'abord l'app a ton compte Discord (fenetre de reglages)." };
  if (!source || source.kind !== 'video') return { ok: false, error: 'La banque ne prend que des videos.' };
  if (source.fromLibrary) return { ok: false, error: 'Cette video vient deja de la banque.' };

  const meta = (typeof rawMeta === 'object' && rawMeta !== null ? rawMeta : {}) as Record<string, unknown>;
  const title = typeof meta.title === 'string' ? meta.title.trim() : '';
  const tags = typeof meta.tags === 'string' ? meta.tags : '';
  if (!title) return { ok: false, error: 'Donne un titre a la video.' };

  const request = parseRenderRequest(job.request, 'video');
  if (!request || request.kind !== 'video') return { ok: false, error: 'Montage invalide.' };
  const rendered = await render({ request: { ...request, text: null }, overlay: null, photo: null });
  const body = await fsp.readFile(rendered.file);

  const { http } = store.endpoints(store.SERVER_URL);
  editorWindow.push('editor:progress', null);
  let response: Response;
  try {
    response = await fetch(`${http}/api/library?${new URLSearchParams({ title, tags })}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': rendered.mime },
      body,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return { ok: false, error: 'Serveur injoignable. Verifie ta connexion internet et reessaie.' };
  }
  if (response.status === 404) return { ok: false, error: "Le serveur ne permet pas encore d'ajouter a la banque." };
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: payload.error ?? `Ajout refuse (HTTP ${response.status}).` };
  }
  return { ok: true, video: ((await response.json()) as LibraryAddResponse).video };
}

/* -------------------------------------------------------------------------- */

export function state() {
  const settings = store.get();
  return { linked: settings.token !== null, exportDir: settings.exportDir, maxBytes: UPLOAD_MAX_BYTES };
}

export function init(): void {
  // Le preload est partage : seule la fenetre d'editeur a droit a ces canaux.
  const handle = (channel: string, listener: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!editorWindow.owns(event.sender)) throw new Error(`${channel} : expediteur refuse`);
      return listener(...args);
    });
  };

  handle('editor:state', () => state());

  handle('editor:open', async () => {
    const window = editorWindow.get();
    const options: Electron.OpenDialogOptions = {
      title: 'Ouvrir une video ou une photo',
      properties: ['openFile'],
      filters: [
        { name: 'Videos et images', extensions: Object.keys(SOURCES).map((ext) => ext.slice(1)) },
      ],
    };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return null;
    return openSource(picked.filePaths[0]);
  });

  handle('editor:openPath', (file: unknown) => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return { ok: false, error: 'Fichier illisible.' };
    return openSource(file);
  });

  handle('editor:library', () => fetchLibrary());

  handle('editor:openLibrary', (id: unknown) => openLibraryVideo(id));

  handle('editor:addToLibrary', (job: RenderJob, meta: unknown) => exclusive(() => addToLibrary(job, meta)));

  handle('editor:openSound', async () => {
    const window = editorWindow.get();
    const options: Electron.OpenDialogOptions = {
      title: 'Choisir un son',
      properties: ['openFile'],
      filters: [{ name: 'Sons et videos', extensions: Object.keys(SOUND_FILES).map((ext) => ext.slice(1)) }],
    };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return null;
    return openSound(picked.filePaths[0]);
  });

  handle('editor:clearSound', () => {
    sound = null;
    lastRender = null;
  });

  handle('editor:sounds', () => fetchSounds());

  handle('editor:openLibrarySound', (id: unknown) => openLibrarySound(id));

  handle('editor:addSoundToLibrary', (meta: unknown, from: unknown) => exclusive(() => addSoundToLibrary(meta, from)));

  handle('editor:chooseDir', async () => {
    await chooseDir();
    return state();
  });

  handle('editor:save', (job: RenderJob) => exclusive(() => save(job)));

  handle('editor:send', (job: RenderJob, options: unknown) => exclusive(() => send(job, options)));

  handle('editor:reveal', () => {
    if (lastSaved && fs.existsSync(lastSaved)) shell.showItemInFolder(lastSaved);
  });

  editorWindow.onClosed(cleanup);
}
