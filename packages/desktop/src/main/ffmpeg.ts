import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { progressSeconds } from './edit-plan.ts';

const OS: Record<string, string> = { win32: 'win', darwin: 'mac', linux: 'linux' };

/**
 * Binaire ffmpeg : celui embarque par electron-builder (extraResources), en dev
 * celui de `npm run ffmpeg` (vendor/), a defaut celui du PATH.
 * LIVEMEMES_FFMPEG force un chemin, pour le developpement.
 */
export function ffmpegPath(): string {
  if (process.env.LIVEMEMES_FFMPEG) return process.env.LIVEMEMES_FFMPEG;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', exe)
    : path.join(__dirname, '../../vendor/ffmpeg', `${OS[process.platform]}-${process.arch}`, exe);
  return fs.existsSync(bundled) ? bundled : exe;
}

/** Erreur affichable telle quelle dans l'editeur. */
export class RenderError extends Error {}

/**
 * Lance ffmpeg et remonte l'avancement (0-1) d'apres `-progress pipe:1`.
 * `durationS` est la duree attendue de la sortie, null si inconnue (GIF).
 */
export function runFfmpeg(
  args: string[],
  durationS: number | null,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const seconds = progressSeconds(line);
        if (seconds !== null && durationS) onProgress(Math.min(1, seconds / durationS));
      }
    });

    // Seule la fin du journal sert a diagnostiquer un echec.
    let tail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-4000);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new RenderError("ffmpeg est introuvable. Reinstalle LiveMemes, ou lance `npm run ffmpeg` en dev.")
          : error,
      );
    });

    child.on('close', (code) => {
      if (code === 0) {
        onProgress(1);
        resolve();
        return;
      }
      console.error(`[editeur] ffmpeg a echoue (code ${code}) :\n${tail}`);
      reject(new RenderError("L'export a echoue. Ce format n'est peut-etre pas supporte."));
    });
  });
}
