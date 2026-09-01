import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, isClientMessage } from '@livememes/shared';
import { findDeviceByToken, isMuted, setMuted, touchDevice } from '../store/devices.ts';
import * as hub from './hub.ts';

const HEARTBEAT_MS = 30_000;

/** Compteur "vu par N ecrans" par drop, alimente par les accuses de reception. */
const shownCounts = new Map<string, Set<string>>();

export function seenBy(dropId: string): number {
  return shownCounts.get(dropId)?.size ?? 0;
}

export function trackDrop(dropId: string): void {
  shownCounts.set(dropId, new Set());
  setTimeout(() => shownCounts.delete(dropId), 60_000).unref();
}

export function attachGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/ws', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const device = findDeviceByToken(token);

    if (!device) {
      hub.send(socket, {
        t: 'error',
        code: 'unauthorized',
        message: "Cet appareil n'est plus lie. Refais /livememes link dans Discord.",
      });
      socket.close(4003, 'unauthorized');
      return;
    }

    alive.set(socket, true);
    hub.add(socket, device.id, device.deviceName, device.token);
    touchDevice(device.token);

    hub.send(socket, {
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      user: { id: device.id, username: device.username, avatarUrl: device.avatarUrl },
      muted: isMuted(device.id),
    });

    socket.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isClientMessage(parsed)) return;

      switch (parsed.t) {
        case 'ping':
          hub.send(socket, { t: 'pong', ts: parsed.ts });
          break;

        case 'shown': {
          const seen = shownCounts.get(parsed.dropId);
          // Un utilisateur compte pour un, meme avec trois ecrans.
          if (seen) seen.add(device.id);
          break;
        }

        case 'setMuted':
          setMuted(device.id, parsed.muted);
          hub.sendToUser(device.id, { t: 'muted', muted: parsed.muted });
          break;
      }
    });

    socket.on('pong', () => alive.set(socket, true));

    socket.on('close', () => {
      touchDevice(device.token);
      hub.remove(socket);
    });

    socket.on('error', () => hub.remove(socket));
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        hub.remove(socket);
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
