import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from '@livememes/shared';
import { config } from '../config.ts';
import { db } from './db.ts';

export interface DeviceUser {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface Device extends DeviceUser {
  token: string;
  deviceName: string;
  createdAt: number;
  lastSeen: number;
}

interface DeviceRow {
  token: string;
  user_id: string;
  username: string;
  avatar_url: string | null;
  device_name: string;
  created_at: number;
  last_seen: number;
}

function toDevice(row: DeviceRow): Device {
  return {
    token: row.token,
    id: row.user_id,
    username: row.username,
    avatarUrl: row.avatar_url,
    deviceName: row.device_name,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };
}

/* -------------------------------------------------------------------------- */
/* Codes d'appairage (memoire : ils vivent 5 minutes)                         */
/* -------------------------------------------------------------------------- */

interface PendingPairing {
  user: DeviceUser;
  expiresAt: number;
}

const pending = new Map<string, PendingPairing>();

function generateCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

/** Cree un code d'appairage a saisir dans l'overlay. Un seul code actif par utilisateur. */
export function createPairingCode(user: DeviceUser): { code: string; expiresAt: number } {
  for (const [code, entry] of pending) {
    if (entry.user.id === user.id) pending.delete(code);
  }

  let code = generateCode();
  while (pending.has(code)) code = generateCode();

  const expiresAt = Date.now() + config.pairing.ttlMs;
  pending.set(code, { user, expiresAt });
  return { code, expiresAt };
}

/** Consomme un code et cree le device associe. Renvoie null si le code est invalide/expire. */
export function redeemPairingCode(rawCode: string, deviceName: string): Device | null {
  const code = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const entry = pending.get(code);
  if (!entry) return null;

  pending.delete(code);
  if (entry.expiresAt < Date.now()) return null;

  const token = randomBytes(32).toString('base64url');
  const now = Date.now();

  db.prepare(
    `INSERT INTO devices (token, user_id, username, avatar_url, device_name, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(token, entry.user.id, entry.user.username, entry.user.avatarUrl, deviceName.slice(0, 80), now, now);

  return {
    token,
    ...entry.user,
    deviceName,
    createdAt: now,
    lastSeen: now,
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pending) {
    if (entry.expiresAt < now) pending.delete(code);
  }
}, 60_000).unref();

/* -------------------------------------------------------------------------- */
/* Devices                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Recherche un device par token, en comparant a temps constant.
 *
 * Un simple `WHERE token = ?` laisserait fuiter le token par timing sur l'index ;
 * les volumes en jeu (quelques devices par utilisateur) rendent le scan gratuit.
 */
export function findDeviceByToken(token: string): Device | null {
  if (!token) return null;
  const candidate = Buffer.from(token);
  const rows = db.prepare('SELECT * FROM devices').all() as unknown as DeviceRow[];

  for (const row of rows) {
    const stored = Buffer.from(row.token);
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
      return toDevice(row);
    }
  }
  return null;
}

export function listDevices(userId: string): Device[] {
  const rows = db
    .prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at')
    .all(userId) as unknown as DeviceRow[];
  return rows.map(toDevice);
}

export function touchDevice(token: string): void {
  db.prepare('UPDATE devices SET last_seen = ? WHERE token = ?').run(Date.now(), token);
}

/** Met a jour le profil affiche (pseudo/avatar changent avec le temps). */
export function refreshDeviceUser(userId: string, user: DeviceUser): void {
  db.prepare('UPDATE devices SET username = ?, avatar_url = ? WHERE user_id = ?').run(
    user.username,
    user.avatarUrl,
    userId,
  );
}

/** Supprime tous les devices d'un utilisateur. Renvoie le nombre supprime. */
export function unlinkAll(userId: string): number {
  const result = db.prepare('DELETE FROM devices WHERE user_id = ?').run(userId);
  return Number(result.changes);
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

export function isMuted(userId: string): boolean {
  const row = db.prepare('SELECT muted FROM user_prefs WHERE user_id = ?').get(userId) as
    | { muted: number }
    | undefined;
  return row?.muted === 1;
}

export function setMuted(userId: string, muted: boolean): void {
  db.prepare(
    `INSERT INTO user_prefs (user_id, muted) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET muted = excluded.muted`,
  ).run(userId, muted ? 1 : 0);
}
