import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

// Le .env vit a la racine du repo, pas dans le package.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variable d'environnement manquante : ${name}. Copie .env.example vers .env et remplis-la.`,
    );
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} doit etre un entier, recu "${raw}".`);
  return parsed;
}

/**
 * TRUST_PROXY, transmis tel quel a `app.set('trust proxy')` d'Express : un nombre
 * de proxys, true/false, ou une liste d'IP/sous-reseaux separes par des virgules.
 */
function trustProxy(): boolean | number | string {
  const raw = (process.env.TRUST_PROXY ?? '').trim();
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return raw;
}

export const config = {
  repoRoot,
  dataDir: process.env.DATA_DIR ?? path.join(repoRoot, 'data'),

  discord: {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    /** Si defini, les commandes sont deployees sur ce serveur uniquement (instantane). */
    devGuildId: process.env.DISCORD_DEV_GUILD_ID || null,
    /**
     * Deploie les slash commands au demarrage. Pratique sur un PaaS ou lancer une
     * commande one-shot est penible. Laisse a false par defaut : Discord limite la
     * creation de commandes globales a 200/jour, et un conteneur qui redemarre en
     * boucle epuiserait ce quota.
     */
    deployOnBoot: process.env.DEPLOY_COMMANDS_ON_BOOT === 'true',
  },

  http: {
    port: int('PORT', 8787),
    /** URL publique du backend : c'est ce que l'overlay recoit dans MemeDrop.url. */
    publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${int('PORT', 8787)}`).replace(/\/$/, ''),
    /**
     * Proxys de confiance devant le backend, pour que `req.ip` soit l'IP du client
     * (limite anti brute-force de l'appairage). Desactive par defaut : expose en
     * direct, faire confiance a X-Forwarded-For permettrait de falsifier son IP.
     */
    trustProxy: trustProxy(),
  },

  media: {
    /** Au-dela, on refuse le meme : l'overlay doit rester instantane. */
    maxBytes: int('MEDIA_MAX_BYTES', 25 * 1024 * 1024),
    /** Duree de conservation du cache disque. */
    ttlMs: int('MEDIA_TTL_HOURS', 24) * 60 * 60 * 1000,
    fetchTimeoutMs: int('MEDIA_FETCH_TIMEOUT_MS', 10_000),
    /** Domaines autorises (sous-domaines compris). Vide : tout domaine public. */
    allowedHosts: (process.env.MEDIA_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean),
  },

  drops: {
    defaultDurationMs: int('DROP_DEFAULT_DURATION_MS', 6_000),
    maxDurationMs: int('DROP_MAX_DURATION_MS', 20_000),
    /** Plafond d'une video jouee jusqu'a la fin : au-dela, elle est coupee. */
    maxVideoDurationMs: int('DROP_MAX_VIDEO_DURATION_MS', 60_000),
    /** Delai minimum entre deux drops d'un meme utilisateur. */
    cooldownMs: int('DROP_COOLDOWN_MS', 8_000),
    /**
     * Role requis pour envoyer ET recevoir des memes. Non defini, tout le monde
     * est eligible. Filtre a la fois /meme et l'audience du salon vocal : un
     * membre sans le role ne peut pas balancer et ne voit rien s'afficher.
     */
    roleId: process.env.DROP_ROLE_ID || null,
  },

  pairing: {
    ttlMs: int('PAIRING_TTL_MS', 5 * 60 * 1000),
  },
} as const;

export type Config = typeof config;
