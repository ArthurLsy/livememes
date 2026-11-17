import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import {
  MEME_POSITIONS,
  MEME_SIZES,
  type DropUploadResponse,
  SOUND_MAX_BYTES,
  type LibraryAddResponse,
  type LibraryResponse,
  type LibrarySound,
  type LibraryVideo,
  type MemePosition,
  type MemeSize,
  type PairRequest,
  type PairResponse,
  type SoundAddResponse,
  type SoundsResponse,
} from '@livememes/shared';
import { findDeviceByToken, redeemPairingCode } from '../store/devices.ts';
import * as media from '../media/cache.ts';
import * as library from '../library/catalog.ts';
import { config } from '../config.ts';
import {
  cooldownRemaining,
  dispatch,
  startCooldown,
  type DisplayOptions,
  type LocateSender,
} from '../bot/drop.ts';

/** Ajouts a une banque par utilisateur : de quoi contribuer, pas de quoi la noyer. */
const LIBRARY_WINDOW_MS = 60 * 60 * 1000;
export const LIBRARY_MAX_ADDS = 10;

class AddLimiter {
  private readonly adds = new Map<string, number[]>();

  can(userId: string): boolean {
    const now = Date.now();
    const recent = (this.adds.get(userId) ?? []).filter((at) => at > now - LIBRARY_WINDOW_MS);
    this.adds.set(userId, recent);
    return recent.length < LIBRARY_MAX_ADDS;
  }

  record(userId: string): void {
    this.adds.get(userId)?.push(Date.now());
  }
}

type BankEntry = { id: string; title: string; tags: string[]; contentType: string; bytes: number };

function bankItem(entry: BankEntry, route: string): LibraryVideo & LibrarySound {
  return {
    id: entry.id,
    title: entry.title,
    tags: entry.tags,
    url: `${config.http.publicUrl}/${route}/${entry.id}`,
    contentType: entry.contentType,
    bytes: entry.bytes,
  };
}

/** Ce qui change d'une banque a l'autre : catalogue, routes, limites et textes. */
interface Bank {
  spec: library.CatalogSpec;
  /** `/api/<api>` pour le catalogue et l'ajout, `/<files>/<id>` pour les fichiers. */
  api: string;
  files: string;
  maxBytes: () => number;
  limiter: AddLimiter;
  /** Textes affiches dans l'editeur. */
  text: { missingTitle: string; wrongType: string; tooHeavy: string; tooMany: string };
  /** Corps de la reponse de liste et d'ajout. */
  listBody: (items: (LibraryVideo & LibrarySound)[]) => LibraryResponse | SoundsResponse;
  addBody: (item: LibraryVideo & LibrarySound) => LibraryAddResponse | SoundAddResponse;
}

const megabytes = (bytes: number) => Math.floor(bytes / 1024 / 1024);

const BANKS: Bank[] = [
  {
    spec: library.VIDEOS,
    api: 'library',
    files: 'library',
    maxBytes: () => config.media.maxBytes,
    limiter: new AddLimiter(),
    text: {
      missingTitle: 'Donne un titre a la video.',
      wrongType: 'La banque ne prend que des videos (mp4, webm ou mov).',
      tooHeavy: 'Video trop lourde',
      tooMany: `Tu as deja ajoute ${LIBRARY_MAX_ADDS} videos cette heure-ci. Reessaie plus tard.`,
    },
    listBody: (videos) => ({ videos }),
    addBody: (video) => ({ video }),
  },
  {
    spec: library.SOUNDS,
    api: 'sounds',
    files: 'sounds',
    maxBytes: () => Math.min(SOUND_MAX_BYTES, config.media.maxBytes),
    limiter: new AddLimiter(),
    text: {
      missingTitle: 'Donne un titre au son.',
      wrongType: 'La banque de sons ne prend que des sons (m4a ou mp3).',
      tooHeavy: 'Son trop lourd',
      tooMany: `Tu as deja ajoute ${LIBRARY_MAX_ADDS} sons cette heure-ci. Reessaie plus tard.`,
    },
    listBody: (sounds) => ({ sounds }),
    addBody: (sound) => ({ sound }),
  },
];

/** Types qu'un client peut envoyer a une banque : les sons de l'editeur sont en AAC ou mp3. */
const UPLOAD_TYPES: Record<string, string[]> = {
  library: Object.values(library.VIDEOS.types),
  sounds: ['audio/mp4', 'audio/mpeg'],
};

/** Petit garde-fou anti brute-force sur les codes d'appairage (8 caracteres). */
const pairAttempts = new Map<string, { count: number; resetAt: number }>();
const PAIR_WINDOW_MS = 10 * 60 * 1000;
const PAIR_MAX_ATTEMPTS = 10;

function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const entry = pairAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    pairAttempts.set(ip, { count: 1, resetAt: now + PAIR_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > PAIR_MAX_ATTEMPTS;
}

// Sans purge, chaque IP vue resterait en memoire indefiniment.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of pairAttempts) {
    if (entry.resetAt < now) pairAttempts.delete(ip);
  }
}, 60 * 1000).unref();

/**
 * Options d'affichage d'un envoi direct, memes bornes et memes defauts que
 * `/meme`. Renvoie un message d'erreur si une valeur est hors bornes.
 */
export function parseDisplayOptions(query: Record<string, unknown>): DisplayOptions | string {
  const text = (name: string): string | undefined => (typeof query[name] === 'string' ? query[name] : undefined);
  const integer = (name: string): number | null | undefined => {
    const raw = text(name);
    if (raw === undefined || raw === '') return null;
    return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
  };

  const size = text('size') ?? 'medium';
  if (!Object.hasOwn(MEME_SIZES, size)) return 'Taille inconnue.';

  const position = text('position') ?? 'center';
  if (!MEME_POSITIONS.includes(position as MemePosition)) return 'Position inconnue.';

  const volume = integer('volume');
  if (volume === undefined || (volume !== null && volume > 100)) return 'Le volume va de 0 a 100.';

  const maxSeconds = Math.floor(Math.max(config.drops.maxDurationMs, config.drops.maxVideoDurationMs) / 1000);
  const duration = integer('duration');
  if (duration === undefined || (duration !== null && (duration < 1 || duration > maxSeconds))) {
    return `La duree va de 1 a ${maxSeconds} secondes.`;
  }

  return {
    durationMs: duration === null ? null : duration * 1000,
    position: position as MemePosition,
    size: size as MemeSize,
    volume: (volume ?? 60) / 100,
    caption: null,
  };
}

function bearer(header: string | undefined): string {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1] ?? '';
}

export interface AppOptions {
  /** Absent (tests d'appairage), l'envoi direct repond 503. */
  locateSender?: LocateSender;
}

export function createApp(options: AppOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  /** Echange un code affiche dans Discord contre un token persistant. */
  app.post('/api/pair', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (tooManyAttempts(ip)) {
      res.status(429).json({ error: 'Trop de tentatives. Reessaie dans quelques minutes.' });
      return;
    }

    const body = req.body as Partial<PairRequest>;
    const code = typeof body.code === 'string' ? body.code : '';
    const deviceName = typeof body.deviceName === 'string' && body.deviceName.trim()
      ? body.deviceName.trim()
      : 'Appareil inconnu';

    const device = redeemPairingCode(code, deviceName);
    if (!device) {
      res.status(400).json({ error: 'Code invalide ou expire. Refais /livememes link dans Discord.' });
      return;
    }

    pairAttempts.delete(ip);
    const payload: PairResponse = {
      token: device.token,
      user: { id: device.id, username: device.username, avatarUrl: device.avatarUrl },
    };
    res.json(payload);
  });

  /**
   * Envoi direct depuis l'editeur du client : meme chemin que `/meme` (salon
   * vocal de l'auteur, role, cooldown, sourdine), sans passer par Discord.
   */
  app.post('/api/drops', async (req, res) => {
    // Refus avant lecture du corps : on ferme la connexion plutot que d'ecouter
    // jusqu'au bout un fichier qu'on ne gardera pas.
    const refuse = (status: number, error: string): void => {
      res.set('Connection', 'close').status(status).json({ error });
      req.resume();
    };

    const device = findDeviceByToken(bearer(req.headers.authorization));
    if (!device) {
      refuse(401, "Cet appareil n'est plus lie. Refais /livememes link dans Discord.");
      return;
    }
    if (!options.locateSender) {
      refuse(503, "L'envoi direct n'est pas disponible sur ce serveur.");
      return;
    }

    const remaining = cooldownRemaining(device.id);
    if (remaining > 0) {
      refuse(429, `Doucement. Encore ${Math.ceil(remaining / 1000)}s avant ton prochain meme.`);
      return;
    }

    const display = parseDisplayOptions(req.query as Record<string, unknown>);
    if (typeof display === 'string') {
      refuse(400, display);
      return;
    }

    const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!media.isAllowedType(contentType)) {
      refuse(415, 'Type de fichier non supporte. Images, GIFs et videos courtes uniquement.');
      return;
    }

    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > config.media.maxBytes) {
      refuse(413, `Fichier trop lourd (max ${Math.floor(config.media.maxBytes / 1024 / 1024)} Mo).`);
      return;
    }

    const located = await options.locateSender(device.id);
    if (!located.ok) {
      refuse(
        located.reason === 'no-role' ? 403 : 409,
        located.reason === 'no-role'
          ? "Il te manque le role requis sur le serveur pour balancer un meme."
          : 'Tu dois etre dans un salon vocal pour balancer un meme.',
      );
      return;
    }

    let cached: media.CachedMedia;
    try {
      cached = await media.store(req, contentType);
    } catch (error) {
      if (!(error instanceof media.MediaError)) console.error('[drops] echec du stockage', error);
      const message = error instanceof media.MediaError ? error.message : 'Envoi interrompu.';
      if (!res.headersSent) res.set('Connection', 'close').status(400).json({ error: message });
      return;
    }

    const report = dispatch(cached, located.sender, display);
    startCooldown(device.id);

    const payload: DropUploadResponse = {
      channelName: located.channelName,
      audience: report.audience.length,
      reached: report.reached.length,
      offline: report.offline.length,
      muted: report.muted.length,
      screens: report.screens,
    };
    res.json(payload);
  });

  for (const bank of BANKS) mountBank(app, bank);

  /** Sert les medias mis en cache. Les overlays ne tapent que cette route. */
  app.get('/media/:id', (req, res) => {
    const id = req.params.id;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      res.status(400).end();
      return;
    }

    const found = media.resolve(id);
    if (!found) {
      res.status(404).end();
      return;
    }

    res.type(found.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(found.file);
  });

  return app;
}

/**
 * Routes d'une banque (videos #28, sons #35) :
 * - `GET /api/<api>` : le catalogue, pour l'editeur du client ;
 * - `POST /api/<api>` : ajout depuis l'editeur, publie tout de suite pour tout
 *   le monde, d'ou la limite par utilisateur ;
 * - `GET /<files>/:id` : les fichiers, publics comme /media. L'editeur les lit
 *   en apercu (requetes Range comprises) puis les telecharge.
 */
function mountBank(app: express.Express, bank: Bank): void {
  const { spec, text } = bank;

  app.get(`/api/${bank.api}`, (req, res) => {
    if (!findDeviceByToken(bearer(req.headers.authorization))) {
      res.status(401).json({ error: "Cet appareil n'est plus lie. Refais /livememes link dans Discord." });
      return;
    }
    const items = library.list(config.library.dir, spec).map((entry) => bankItem(entry, bank.files));
    res.setHeader('Cache-Control', 'no-store');
    res.json(bank.listBody(items));
  });

  app.post(`/api/${bank.api}`, async (req, res) => {
    const refuse = (status: number, error: string): void => {
      res.set('Connection', 'close').status(status).json({ error });
      req.resume();
    };

    const device = findDeviceByToken(bearer(req.headers.authorization));
    if (!device) {
      refuse(401, "Cet appareil n'est plus lie. Refais /livememes link dans Discord.");
      return;
    }

    const submission = library.parseSubmission(req.query.title, req.query.tags, text.missingTitle);
    if (typeof submission === 'string') {
      refuse(400, submission);
      return;
    }

    const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const ext = UPLOAD_TYPES[bank.api]!.includes(contentType) ? library.extensionFor(contentType, spec) : null;
    if (!ext) {
      refuse(415, text.wrongType);
      return;
    }
    const maxBytes = bank.maxBytes();
    if (Number(req.headers['content-length'] ?? 0) > maxBytes) {
      refuse(413, `${text.tooHeavy} (max ${megabytes(maxBytes)} Mo).`);
      return;
    }
    if (!bank.limiter.can(device.id)) {
      refuse(429, text.tooMany);
      return;
    }

    const dir = config.library.dir;
    let file: string;
    let bytes: number;
    let id: string;
    try {
      await fsp.mkdir(dir, { recursive: true });
      id = library.freeId(dir, submission.title, ext, () => randomBytes(3).toString('hex'), spec);
      file = path.join(dir, `${id}${ext}`);
      bytes = await media.streamToFile(req, contentType, file, maxBytes);
    } catch (error) {
      if (!(error instanceof media.MediaError)) console.error(`[banque ${bank.api}] echec du stockage`, error);
      const message = error instanceof media.MediaError ? error.message : 'Envoi interrompu.';
      if (!res.headersSent) res.set('Connection', 'close').status(400).json({ error: message });
      return;
    }

    try {
      await library.append(dir, { id, ...submission, file: path.basename(file), addedBy: device.id }, spec);
    } catch (error) {
      console.error(`[banque ${bank.api}] catalogue non mis a jour`, error);
      await fsp.rm(file, { force: true });
      res.status(500).json({ error: "La banque n'a pas pu etre mise a jour. Reessaie plus tard." });
      return;
    }

    bank.limiter.record(device.id);
    console.log(`[banque ${bank.api}] ${device.username} (${device.id}) a ajoute "${submission.title}" (${id})`);
    res.status(201).json(bank.addBody(bankItem({ id, ...submission, contentType, bytes }, bank.files)));
  });

  app.get(`/${bank.files}/:id`, (req, res) => {
    const entry = library.find(config.library.dir, String(req.params.id ?? ''), spec);
    if (!entry) {
      res.status(404).end();
      return;
    }
    res.type(entry.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(entry.file);
  });
}
