import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dialog, ipcMain, shell } from 'electron';
import type { DropUploadResponse } from '@livememes/shared';
import { MAX_IMAGE_SECONDS, SEND_POSITIONS, SEND_SIZES, type SendOptions } from '../renderer/editor-model.ts';
import {
  gifArgs,
  OUTPUT,
  parseRenderRequest,
  tighten,
  UPLOAD_MAX_BYTES,
  videoArgs,
  videoBudget,
  type RenderRequest,
  type SourceKind,
} from './edit-plan.ts';
import * as editorWindow from './editor-window.ts';
import { RenderError, runFfmpeg } from './ffmpeg.ts';
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

/** Une image est transmise au renderer en memoire : au-dela, on refuse. */
const MAX_IMAGE_INPUT_BYTES = 60 * 1024 * 1024;

interface Source {
  file: string;
  name: string;
  kind: SourceKind;
  mime: string;
}

/** Source telle que le renderer la recoit : une URL pour une video, les octets pour une image. */
export interface OpenedSource {
  name: string;
  kind: SourceKind;
  mime: string;
  url: string | null;
  bytes: Uint8Array | null;
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
}

function humanBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

/* -------------------------------------------------------------------------- */
/* Ouverture                                                                  */
/* -------------------------------------------------------------------------- */

async function openSource(file: string): Promise<Result<{ source: OpenedSource }>> {
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

  source = { file, name: path.basename(file), ...type };
  lastRender = null;
  return {
    ok: true,
    source: {
      name: source.name,
      kind: type.kind,
      mime: type.mime,
      url: type.kind === 'video' ? pathToFileURL(file).href : null,
      bytes,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Rendu                                                                      */
/* -------------------------------------------------------------------------- */

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const startsWith = (data: Uint8Array, magic: number[]) => magic.every((value, i) => data[i] === value);

function jobKey(request: RenderRequest, job: RenderJob): string {
  const hash = createHash('sha256').update(source?.file ?? '').update(JSON.stringify(request));
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
      let budget = videoBudget(seconds, UPLOAD_MAX_BYTES, request.muted);
      await runFfmpeg(videoArgs(request, { source: source.file, overlay, output: file }, budget), seconds, progress);
      // L'encodeur peut depasser un peu sa cible : une seconde passe, plus serree.
      if ((await sizeOf(file)) > UPLOAD_MAX_BYTES) {
        budget = tighten(budget);
        await runFfmpeg(videoArgs(request, { source: source.file, overlay, output: file }, budget), seconds, progress);
      }
      result = { file, ...OUTPUT.video! };
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
