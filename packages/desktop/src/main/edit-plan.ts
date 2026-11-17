/**
 * Plan d'export de l'editeur : validation de la demande du renderer et
 * arguments ffmpeg, sans Electron ni processus. Le main les execute, les tests
 * les verifient directement.
 */
import { MAX_CLIP_SECONDS, MAX_IMAGE_SECONDS, type Range } from '../renderer/editor-model.ts';

/**
 * Taille visee pour un export. Meme valeur que MEDIA_MAX_BYTES par defaut cote
 * serveur : un serveur regle plus bas refuse l'envoi avec un message clair.
 */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export type SourceKind = 'video' | 'gif' | 'photo';

/**
 * Son ajoute par-dessus une video ou une photo (#36, #37). Le fichier est
 * choisi cote main (import ou banque de sons) ; le renderer n'envoie que ses
 * reglages.
 */
export interface SoundClip {
  /** Debut du passage garde dans le son, en secondes. */
  from: number;
  /** Moment du clip ou le son demarre, en secondes depuis le debut du clip. */
  at: number;
  /** Volume du son ajoute : 1 = tel quel, jusqu'a 1,5. */
  gain: number;
}

/** Ce que le renderer demande d'exporter. Le calque texte arrive a part, en PNG. */
export type RenderRequest =
  | {
      kind: 'video';
      /** Dimensions affichees de la source (rotation appliquee), celles du calque texte. */
      width: number;
      height: number;
      trim: Range;
      /** Son d'origine retire. */
      muted: boolean;
      /** Plage d'apparition du texte, dans le temps de la source. Null : pas de texte. */
      text: Range | null;
      /** Son ajoute, mixe au son d'origine ou a sa place (muted). Null : aucun. */
      sound: SoundClip | null;
    }
  | { kind: 'gif'; width: number; height: number; text: boolean }
  /** Photo composee par le renderer (canvas) : le main ne fait que l'ecrire. */
  | { kind: 'photo'; mime: 'image/png' | 'image/jpeg' }
  /**
   * Photo composee par le renderer, avec un son (#36) : le main en fait une
   * video de `seconds` secondes, image fixe et son.
   */
  | {
      kind: 'photo-sound';
      mime: 'image/png' | 'image/jpeg';
      /** Dimensions de la photo composee. */
      width: number;
      height: number;
      seconds: number;
      sound: SoundClip;
    };

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

/** Plafond d'un decalage dans un son : un son de banque fait quelques secondes, une piste de film peut durer. */
const MAX_SOUND_OFFSET = 4 * 60 * 60;

export function parseSound(raw: unknown): SoundClip | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { from, at, gain } = raw as Record<string, unknown>;
  if (!finite(from) || from < 0 || from > MAX_SOUND_OFFSET) return null;
  if (!finite(at) || at < 0 || at > MAX_CLIP_SECONDS) return null;
  if (!finite(gain) || gain < 0 || gain > 1.5) return null;
  return { from, at, gain };
}

/** Revalide la demande : le renderer est le notre, mais le main ne lance pas ffmpeg sur parole. */
export function parseRenderRequest(raw: unknown, source: SourceKind): RenderRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const request = raw as Record<string, unknown>;
  // Une photo avec un son devient une video, mais reste une source photo.
  const kind = request.kind === 'photo-sound' ? 'photo' : request.kind;
  if (kind !== source) return null;

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
      // Absent : demande d'un renderer anterieur au son ajoute.
      let sound: SoundClip | null = null;
      if (request.sound !== undefined && request.sound !== null) {
        sound = parseSound(request.sound);
        if (!sound || sound.at >= trim.end - trim.start) return null;
      }
      return { kind: 'video', ...size, trim, muted: request.muted, text, sound };
    }
    case 'gif': {
      const size = parseSize(request.width, request.height);
      if (!size || typeof request.text !== 'boolean') return null;
      return { kind: 'gif', ...size, text: request.text };
    }
    case 'photo':
      if (request.mime !== 'image/png' && request.mime !== 'image/jpeg') return null;
      return { kind: 'photo', mime: request.mime };
    case 'photo-sound': {
      if (request.mime !== 'image/png' && request.mime !== 'image/jpeg') return null;
      const size = parseSize(request.width, request.height);
      const sound = parseSound(request.sound);
      const seconds = request.seconds;
      if (!size || !sound || !finite(seconds) || seconds < 1 || seconds > MAX_IMAGE_SECONDS) return null;
      return { kind: 'photo-sound', mime: request.mime, ...size, seconds, sound };
    }
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
  // `muted` : la sortie n'a aucune piste audio.
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
  /** Son ajoute (#36, #37). Absent ou null : aucun. */
  sound?: string | null;
}

/** Toute piste audio passe en stereo 48 kHz avant d'etre mixee : amix exige des formats identiques. */
const AUDIO_FORMAT = 'aformat=sample_rates=48000:channel_layouts=stereo';

/**
 * Chaine de filtres du son ajoute : volume, decalage dans le clip, puis
 * complete de silence et coupe a la duree exacte du clip.
 */
function addedSoundChain(input: number, sound: SoundClip, length: number): string {
  const delay = Math.round(sound.at * 1000);
  let chain = `[${input}:a]${AUDIO_FORMAT},volume=${sound.gain.toFixed(2)}`;
  if (delay > 0) chain += `,adelay=${delay}|${delay}`;
  return `${chain},apad,atrim=end=${seconds(length)}`;
}

/**
 * `sourceHasAudio` : la source a une piste son. Sans elle, il n'y a rien a
 * mixer au son ajoute (ffmpeg echouerait sur `[0:a]`).
 */
export function videoArgs(
  request: Extract<RenderRequest, { kind: 'video' }>,
  paths: Paths,
  budget: VideoBudget,
  sourceHasAudio = true,
): string[] {
  const { trim } = request;
  const length = trim.end - trim.start;
  const out = fitWithin(request.width, request.height, budget.longSide);
  const args = ['-hide_banner', '-nostdin', '-y', '-ss', seconds(trim.start), '-t', seconds(length)];
  args.push('-i', paths.source);
  let inputs = 1;

  // Source et calque ramenes a la meme taille avant de les superposer : le
  // texte reste a sa place meme si ffmpeg decode une taille un peu differente
  // de celle vue par le renderer.
  const base = `[0:v]scale=${out.width}:${out.height}:flags=lanczos,setsar=1`;
  let filter = `${base},format=yuv420p[v]`;
  if (paths.overlay && request.text) {
    args.push('-i', paths.overlay);
    inputs++;
    // -ss avant -i : le temps des filtres repart de 0 au debut de la coupe.
    const from = Math.max(0, request.text.start - trim.start);
    const to = Math.min(trim.end, request.text.end) - trim.start;
    filter =
      `${base}[base];[1:v]scale=${out.width}:${out.height}[txt];` +
      `[base][txt]overlay=0:0:enable='between(t,${seconds(from)},${seconds(to)})',format=yuv420p[v]`;
  }
  const sound = request.sound && paths.sound ? request.sound : null;
  if (sound) {
    // Bande son remplacee ou mixee (#37) : le son ajoute est lu a partir de `from`.
    args.push('-ss', seconds(sound.from), '-i', paths.sound!);
    const added = addedSoundChain(inputs, sound, length);
    if (!request.muted && sourceHasAudio) {
      filter +=
        `;[0:a]${AUDIO_FORMAT},apad,atrim=end=${seconds(length)}[orig];${added}[snd];` +
        // normalize=0 : chaque piste garde son volume, amix ne les divise pas par deux.
        '[orig][snd]amix=inputs=2:duration=first:normalize=0[a]';
    } else {
      filter += `;${added}[a]`;
    }
  }
  args.push('-filter_complex', filter, '-map', '[v]');

  if (sound) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', `${budget.audioKbps}k`, '-ac', '2');
  else if (request.muted) args.push('-an');
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
/* Photo avec un son (#36)                                                    */
/* -------------------------------------------------------------------------- */

/** Une image fixe se compresse tres bien : inutile de lui donner tout le budget. */
const STILL_MAX_KBPS = 2500;

/** Image fixe en boucle pendant `seconds`, avec le son ajoute. `paths.source` est la photo composee. */
export function photoSoundArgs(
  request: Extract<RenderRequest, { kind: 'photo-sound' }>,
  paths: Paths,
  budget: VideoBudget,
): string[] {
  const out = fitWithin(request.width, request.height, budget.longSide);
  const length = request.seconds;
  const kbps = Math.min(budget.videoKbps, STILL_MAX_KBPS);
  return [
    '-hide_banner', '-nostdin', '-y',
    '-loop', '1', '-framerate', '25', '-t', seconds(length), '-i', paths.source,
    '-ss', seconds(request.sound.from), '-i', paths.sound ?? '',
    '-filter_complex',
    `[0:v]scale=${out.width}:${out.height}:flags=lanczos,setsar=1,format=yuv420p[v];` +
      `${addedSoundChain(1, request.sound, length)}[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-r', '25',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-c:a', 'aac', '-b:a', `${budget.audioKbps}k`, '-ac', '2',
    '-t', seconds(length),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    paths.output,
  ];
}

/* -------------------------------------------------------------------------- */
/* Son pour la banque (#35)                                                   */
/* -------------------------------------------------------------------------- */

/** Extrait le passage choisi d'un son (ou d'une video) en AAC, format de la banque de sons. */
export function soundArgs(from: number, length: number, source: string, output: string): string[] {
  return [
    '-hide_banner', '-nostdin', '-y',
    '-ss', seconds(from), '-t', seconds(length), '-i', source,
    '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    output,
  ];
}

/** Vrai si le journal de `ffmpeg -i` annonce une piste audio. */
export function hasAudioStream(log: string): boolean {
  return /Stream #\d+:\d+[^\n]*: Audio:/.test(log);
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
  'photo-sound': { ext: 'mp4', mime: 'video/mp4' },
  gif: { ext: 'gif', mime: 'image/gif' },
  // Depend de ce que le renderer a produit.
  photo: null,
};
