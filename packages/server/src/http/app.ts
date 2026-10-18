import express from 'express';
import type { PairRequest, PairResponse } from '@livememes/shared';
import { redeemPairingCode } from '../store/devices.ts';
import * as media from '../media/cache.ts';

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

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
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
