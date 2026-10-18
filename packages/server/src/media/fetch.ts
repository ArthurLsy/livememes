import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import { config } from '../config.ts';
import { MediaError } from './errors.ts';

/**
 * Telechargement des medias fournis par les utilisateurs, protege contre le SSRF.
 *
 * Une URL de /meme ne doit jamais faire requeter le serveur vers son propre reseau
 * (localhost, reseau Docker/Coolify, metadonnees cloud en 169.254.169.254) :
 * - chaque IP resolue est verifiee, et la connexion part vers cette IP-la (le
 *   `lookup` est celui de la socket) : pas de DNS rebinding entre controle et appel ;
 * - les redirections sont suivies a la main, et chaque saut repasse le controle.
 */

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Plages non routables sur Internet : prive, loopback, link-local, reserve. */
const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, metadonnees cloud
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserve + broadcast
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  // Pas de regle ::ffff:0:0/96 : BlockList applique deja les regles IPv4 aux
  // adresses mappees (::ffff:127.0.0.1), et cette regle bloquerait toute IPv4.
  ['64:ff9b::', 96], // NAT64 : embarque une IPv4 arbitraire
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4, peut embarquer une IPv4 privee
  ['fc00::', 7], // ULA
  ['fe80::', 10], // link-local
  ['fec0::', 10],
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv6');
}

/** Vrai si l'IP est joignable publiquement. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export interface FetchPolicy {
  /** Decide si une IP peut etre contactee. Par defaut : IP publiques uniquement. */
  isAllowedAddress?: (address: string) => boolean;
}

export interface FetchedMedia {
  status: number;
  contentType: string;
  contentLength: number;
  body: IncomingMessage;
}

class BlockedAddressError extends Error {}

const BLOCKED_MESSAGE = 'Adresse refusee : ce media pointe vers un reseau interne.';

/** Le domaine est-il dans MEDIA_ALLOWED_HOSTS (sous-domaines compris) ? */
function hostAllowed(hostname: string): boolean {
  const allowlist = config.media.allowedHosts;
  if (allowlist.length === 0) return true;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowlist.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Resolution DNS de la socket : refuse si une seule des IP est interne. */
function guardedLookup(isAllowed: (address: string) => boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      if (addresses.length === 0 || addresses.some((entry) => !isAllowed(entry.address))) {
        callback(new BlockedAddressError(hostname), '', 0);
        return;
      }
      if (options.all) {
        (callback as unknown as (err: null, list: dns.LookupAddress[]) => void)(null, addresses);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    });
  };
}

/** Controles faits avant toute connexion, a chaque saut. */
function checkTarget(url: URL, isAllowed: (address: string) => boolean): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MediaError('Seules les URLs http(s) sont acceptees.');
  }
  if (url.username || url.password) {
    throw new MediaError("Les URLs avec identifiants ne sont pas acceptees.");
  }
  // Une IP litterale ne passe pas par `lookup` : on la verifie ici.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0) {
    if (!isAllowed(host)) throw new MediaError(BLOCKED_MESSAGE);
  } else if (!hostAllowed(host)) {
    throw new MediaError(`Domaine non autorise (${host}).`);
  }
}

function get(url: URL, isAllowed: (address: string) => boolean, signal: AbortSignal): Promise<IncomingMessage> {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      agent: false, // pas de socket reutilisee : chaque connexion repasse par le lookup
      lookup: guardedLookup(isAllowed),
      signal,
      headers: { 'user-agent': 'livememes/0.1 (+https://github.com/livememes)' },
    });
    request.once('response', resolve);
    request.once('error', reject);
  });
}

/**
 * GET avec redirections suivies a la main. Le timeout couvre toute la chaine,
 * corps compris : le signal reste attache au stream renvoye.
 */
export async function safeGet(sourceUrl: string, policy: FetchPolicy = {}): Promise<FetchedMedia> {
  const isAllowed = policy.isAllowedAddress ?? isPublicAddress;
  const signal = AbortSignal.timeout(config.media.fetchTimeoutMs);

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new MediaError("Ce n'est pas une URL valide.");
  }

  for (let hop = 0; ; hop++) {
    checkTarget(url, isAllowed);

    let response: IncomingMessage;
    try {
      response = await get(url, isAllowed, signal);
    } catch (cause) {
      if (cause instanceof BlockedAddressError) throw new MediaError(BLOCKED_MESSAGE);
      throw new MediaError(`Impossible de telecharger le media (${(cause as Error).message}).`);
    }

    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (REDIRECT_STATUSES.has(status) && location) {
      response.resume(); // on jette le corps de la redirection
      if (hop >= MAX_REDIRECTS) throw new MediaError('Trop de redirections.');
      try {
        url = new URL(location, url);
      } catch {
        throw new MediaError('Redirection invalide.');
      }
      continue;
    }

    return {
      status,
      contentType: (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase(),
      contentLength: Number(response.headers['content-length'] ?? '0'),
      body: response,
    };
  }
}
