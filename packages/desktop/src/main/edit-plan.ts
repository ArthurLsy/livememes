/**
 * Plan d'export de l'editeur : validation de la demande du renderer et
 * arguments ffmpeg, sans Electron ni processus. Le main les execute, les tests
 * les verifient directement.
 */
import { MAX_CLIP_SECONDS, type Range } from '../renderer/editor-model.ts';

/**
 * Taille visee pour un export. Meme valeur que MEDIA_MAX_BYTES par defaut cote
 * serveur : un serveur regle plus bas refuse l'envoi avec un message clair.
 */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export type SourceKind = 'video' | 'gif' | 'photo';

/** Ce que le renderer demande d'exporter. Le calque texte arrive a part, en PNG. */
export type RenderRequest =
  | {
      kind: 'video';
      /** Dimensions affichees de la source (rotation appliquee), celles du calque texte. */
      width: number;
      height: number;
      trim: Range;
      muted: boolean;
      /** Plage d'apparition du texte, dans le temps de la source. Null : pas de texte. */
      text: Range | null;
    }
  | { kind: 'gif'; width: number; height: number; text: boolean }
  /** Photo composee par le renderer (canvas) : le main ne fait que l'ecrire. */
  | { kind: 'photo'; mime: 'image/png' | 'image/jpeg' };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseRange(raw: unknown): Range | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { start, end } = raw as Record<string, unknown>;
  if (!finite(start) || !finite(end) || start < 0 || end <= start) return null;
  return { start, end };
}

function parseSize(width: unknown, height: unknown): { width: number; height: number } | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  const w = width as number;
  const h = height as number;
  if (w < 2 || h < 2 || w > 8192 || h > 8192) return null;
  return { width: w, height: h };
}

/** Revalide la demande : le renderer est le notre, mais le main ne lance pas ffmpeg sur parole. */
export function parseRenderRequest(raw: unknown, source: SourceKind): RenderRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const request = raw as Record<string, unknown>;
  if (request.kind !== source) return null;

  switch (request.kind) {
    case 'video': {
      const size = parseSize(request.width, request.height);
      const trim = parseRange(request.trim);
      // Tolerance d'arrondi : le renderer borne deja a 30 s.
      if (!size || !trim || trim.end - trim.start > MAX_CLIP_SECONDS + 0.05) return null;
      if (typeof request.muted !== 'boolean') return null;
      let text: Range | null = null;
      if (request.text !== null) {
        text = parseRange(request.text);
        if (!text) return null;
      }
      return { kind: 'video', ...size, trim, muted: request.muted, text };
    }
    case 'gif': {
      const size = parseSize(request.width, request.height);
      if (!size || typeof request.text !== 'boolean') return null;
      return { kind: 'gif', ...size, text: request.text };
    }
    case 'photo':
      if (request.mime !== 'image/png' && request.mime !== 'image/jpeg') return null;
      return { kind: 'photo', mime: request.mime };
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Video                                                                      */
/* -------------------------------------------------------------------------- */

export interface VideoBudget {
  videoKbps: number;
  audioKbps: number;
  /** Plus grand cote de la sortie, en px. */
  longSide: number;
}

/**
 * Debit vise pour tenir sous `maxBytes` sur toute la duree, 10 % de marge pour
 * le conteneur et les ecarts de l'encodeur. Un debit bas fait baisser la
 * resolution plutot que de produire une bouillie de blocs en 1080p.
 */
export function videoBudget(seconds: number, maxBytes: number, muted: boolean): VideoBudget {
  const audioKbps = muted ? 0 : 128;
  const totalKbps = Math.floor((maxBytes * 8 * 0.9) / Math.max(seconds, 0.5) / 1000);
  const videoKbps = Math.max(250, Math.min(8000, totalKbps - audioKbps));
  const longSide = videoKbps >= 4000 ? 1920 : videoKbps >= 2000 ? 1280 : 854;
  return { videoKbps, audioKbps, longSide };
}

/** Plus petit budget pour une seconde tentative, quand la premiere a deborde. */
export function tighten(budget: VideoBudget): VideoBudget {
  const videoKbps = Math.max(200, Math.floor(budget.videoKbps * 0.7));
  return { ...budget, videoKbps, longSide: videoKbps >= 2000 ? Math.min(budget.longSide, 1280) : 854 };
}

/** Rentre dans un cadre `longSide` x `longSide * 9/16` oriente comme la source, sans agrandir, cotes pairs (H.264). */
export function fitWithin(width: number, height: number, longSide: number): { width: number; height: number } {
  const shortSide = Math.round((longSide * 9) / 16);
  const [maxW, maxH] = width >= height ? [longSide, shortSide] : [shortSide, longSide];
  const scale = Math.min(1, maxW / width, maxH / height);
  const even = (value: number) => Math.max(2, Math.floor((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** Secondes pour ffmpeg : millisecondes, sans notation exponentielle. */
function seconds(value: number): string {
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

export interface Paths {
  source: string;
  /** Calque texte PNG, aux dimensions de la source. Null : pas de texte. */
  overlay: string | null;
  output: string;
}

export function videoArgs(
  request: Extract<RenderRequest, { kind: 'video' }>,
  paths: Paths,
  budget: VideoBudget,
): string[] {
  const { trim } = request;
  const out = fitWithin(request.width, request.height, budget.longSide);
  const args = ['-hide_banner', '-nostdin', '-y', '-ss', seconds(trim.start), '-t', seconds(trim.end - trim.start)];
  args.push('-i', paths.source);

  // Source et calque ramenes a la meme taille avant de les superposer : le
  // texte reste a sa place meme si ffmpeg decode une taille un peu differente
  // de celle vue par le renderer.
  const base = `[0:v]scale=${out.width}:${out.height}:flags=lanczos,setsar=1`;
  let filter = `${base},format=yuv420p[v]`;
  if (paths.overlay && request.text) {
    args.push('-i', paths.overlay);
    // -ss avant -i : le temps des filtres repart de 0 au debut de la coupe.
    const from = Math.max(0, request.text.start - trim.start);
    const to = Math.min(trim.end, request.text.end) - trim.start;
    filter =
      `${base}[base];[1:v]scale=${out.width}:${out.height}[txt];` +
      `[base][txt]overlay=0:0:enable='between(t,${seconds(from)},${seconds(to)})',format=yuv420p[v]`;
  }
  args.push('-filter_complex', filter, '-map', '[v]');

  if (request.muted) args.push('-an');
  else args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', `${budget.audioKbps}k`, '-ac', '2');

  const kbps = budget.videoKbps;
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-fpsmax', '60',
    // L'overlay lit la video en streaming : l'index en tete permet de demarrer tout de suite.
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    paths.output,
  );
  return args;
}

/* -------------------------------------------------------------------------- */
/* GIF                                                                        */
/* -------------------------------------------------------------------------- */

/** Un GIF reste un GIF (il boucle sur l'overlay) ; texte incruste sur toutes ses images. */
export function gifArgs(request: Extract<RenderRequest, { kind: 'gif' }>, paths: Paths, longSide = 720): string[] {
  const out = fitWithin(request.width, request.height, longSide);
  const args = ['-hide_banner', '-nostdin', '-y', '-i', paths.source];
  let graph = `[0:v]scale=${out.width}:${out.height}:flags=lanczos`;
  if (paths.overlay && request.text) {
    args.push('-i', paths.overlay);
    graph += `[base];[1:v]scale=${out.width}:${out.height}[txt];[base][txt]overlay=0:0`;
  }
  graph += ',split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4[v]';
  args.push('-filter_complex', graph, '-map', '[v]', '-loop', '0', '-progress', 'pipe:1', '-nostats', paths.output);
  return args;
}

/* -------------------------------------------------------------------------- */

/** Avancement lu sur `-progress pipe:1` (out_time_us), en secondes ; null si la ligne n'en parle pas. */
export function progressSeconds(line: string): number | null {
  const match = /^out_time_us=(\d+)/.exec(line.trim());
  return match ? Number.parseInt(match[1]!, 10) / 1_000_000 : null;
}

export const OUTPUT: Record<RenderRequest['kind'], { ext: string; mime: string } | null> = {
  video: { ext: 'mp4', mime: 'video/mp4' },
  gif: { ext: 'gif', mime: 'image/gif' },
  // Depend de ce que le renderer a produit.
  photo: null,
};
