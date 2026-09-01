import type { WebSocket } from 'ws';
import type { MemeDrop, ServerMessage } from '@livememes/shared';

interface Connection {
  socket: WebSocket;
  userId: string;
  deviceName: string;
  token: string;
}

/**
 * Registre des overlays connectes, indexe par utilisateur Discord.
 * Un utilisateur peut avoir plusieurs machines connectees en meme temps.
 */
const byUser = new Map<string, Set<Connection>>();
const bySocket = new WeakMap<WebSocket, Connection>();

export function add(socket: WebSocket, userId: string, deviceName: string, token: string): Connection {
  const connection: Connection = { socket, userId, deviceName, token };
  let set = byUser.get(userId);
  if (!set) {
    set = new Set();
    byUser.set(userId, set);
  }
  set.add(connection);
  bySocket.set(socket, connection);
  return connection;
}

export function remove(socket: WebSocket): void {
  const connection = bySocket.get(socket);
  if (!connection) return;
  bySocket.delete(socket);

  const set = byUser.get(connection.userId);
  if (!set) return;
  set.delete(connection);
  if (set.size === 0) byUser.delete(connection.userId);
}

export function get(socket: WebSocket): Connection | undefined {
  return bySocket.get(socket);
}

export function isOnline(userId: string): boolean {
  return (byUser.get(userId)?.size ?? 0) > 0;
}

export function deviceCount(userId: string): number {
  return byUser.get(userId)?.size ?? 0;
}

export function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

/** Envoie a toutes les machines d'un utilisateur. Renvoie le nombre d'ecrans touches. */
export function sendToUser(userId: string, message: ServerMessage): number {
  const set = byUser.get(userId);
  if (!set) return 0;

  // Le payload est identique pour tout le monde : on ne serialise qu'une fois.
  const payload = JSON.stringify(message);
  let delivered = 0;
  for (const connection of set) {
    if (connection.socket.readyState !== connection.socket.OPEN) continue;
    connection.socket.send(payload);
    delivered++;
  }
  return delivered;
}

export interface BroadcastResult {
  /** Utilisateurs ayant recu le drop sur au moins un ecran. */
  reached: string[];
  /** Cibles sans overlay connecte. */
  offline: string[];
  /** Cibles ayant coupe les memes via /livememes mute. */
  muted: string[];
  /** Nombre total d'ecrans touches. */
  screens: number;
}

/**
 * Diffuse un drop a une liste d'utilisateurs.
 * `mutedUsers` est fourni par l'appelant pour eviter un aller-retour SQLite par cible.
 */
export function broadcast(
  userIds: Iterable<string>,
  drop: MemeDrop,
  mutedUsers: ReadonlySet<string>,
): BroadcastResult {
  const result: BroadcastResult = { reached: [], offline: [], muted: [], screens: 0 };
  const message: ServerMessage = { t: 'drop', drop };

  for (const userId of userIds) {
    if (mutedUsers.has(userId)) {
      result.muted.push(userId);
      continue;
    }
    const screens = sendToUser(userId, message);
    if (screens === 0) {
      result.offline.push(userId);
      continue;
    }
    result.reached.push(userId);
    result.screens += screens;
  }
  return result;
}

/** Ferme les connexions d'un utilisateur (utilise par /livememes unlink). */
export function disconnectUser(userId: string, reason: string): void {
  const set = byUser.get(userId);
  if (!set) return;
  for (const connection of [...set]) {
    send(connection.socket, { t: 'error', code: 'unlinked', message: reason });
    connection.socket.close(4001, reason);
  }
}
