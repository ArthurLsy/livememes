import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ClientMessage, MemeDrop, ServerMessage } from '@livememes/shared';
import * as store from './store.ts';

export type ConnectionStatus = 'offline' | 'connecting' | 'online' | 'unauthorized';

interface Events {
  status: [ConnectionStatus, string | null];
  drop: [MemeDrop];
  clear: [string | null];
  muted: [boolean];
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

/**
 * Connexion persistante au relais, avec reconnexion exponentielle.
 * Un token invalide arrete les tentatives : inutile de marteler le serveur.
 */
export class Connection extends EventEmitter<Events> {
  #socket: WebSocket | null = null;
  #timer: NodeJS.Timeout | null = null;
  #attempt = 0;
  #stopped = true;
  #status: ConnectionStatus = 'offline';

  get status(): ConnectionStatus {
    return this.#status;
  }

  start(): void {
    this.#stopped = false;
    this.#attempt = 0;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#socket?.close(1000, 'client stop');
    this.#socket = null;
    this.#setStatus('offline', null);
  }

  /** A appeler apres un changement de token ou d'URL serveur. */
  restart(): void {
    this.stop();
    if (store.get().token) this.start();
  }

  send(message: ClientMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message));
    }
  }

  #setStatus(status: ConnectionStatus, detail: string | null): void {
    this.#status = status;
    this.emit('status', status, detail);
  }

  #connect(): void {
    const settings = store.get();
    if (this.#stopped || !settings.token) return;

    let target: string;
    try {
      target = store.endpoints(store.SERVER_URL).ws;
    } catch {
      this.#setStatus('unauthorized', "URL de serveur invalide.");
      return;
    }

    this.#setStatus('connecting', null);
    const socket = new WebSocket(`${target}?token=${encodeURIComponent(settings.token)}`, {
      handshakeTimeout: 10_000,
    });
    this.#socket = socket;

    socket.on('open', () => {
      this.#attempt = 0;
    });

    socket.on('message', (raw) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.toString()) as ServerMessage;
      } catch {
        return;
      }

      switch (message.t) {
        case 'hello':
          store.update({ user: message.user, muted: message.muted });
          this.#setStatus('online', message.user.username);
          this.emit('muted', message.muted);
          break;
        case 'drop':
          this.emit('drop', message.drop);
          this.send({ t: 'shown', dropId: message.drop.id });
          break;
        case 'clear':
          this.emit('clear', message.dropId);
          break;
        case 'muted':
          store.update({ muted: message.muted });
          this.emit('muted', message.muted);
          break;
        case 'error':
          if (message.code === 'unauthorized' || message.code === 'unlinked') {
            store.update({ token: null, user: null });
            this.#stopped = true;
            this.#setStatus('unauthorized', message.message);
          }
          break;
      }
    });

    socket.on('close', () => {
      this.#socket = null;
      if (this.#stopped) return;
      this.#scheduleReconnect();
    });

    socket.on('error', (error: Error) => {
      if (this.#status !== 'unauthorized') this.#setStatus('offline', error.message);
    });
  }

  #scheduleReconnect(): void {
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)]!;
    this.#attempt++;
    this.#setStatus('offline', `Reconnexion dans ${Math.round(delay / 1000)}s`);
    this.#timer = setTimeout(() => this.#connect(), delay);
  }
}
