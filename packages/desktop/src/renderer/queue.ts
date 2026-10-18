import type { MemeDrop } from '@livememes/shared';

/**
 * File d'attente des memes d'un ecran, sans DOM ni Electron : le rendu et les
 * timers sont fournis par l'hote, ce qui rend la logique testable sous Node.
 *
 * Un seul meme a l'ecran, les suivants attendent leur tour dans l'ordre
 * d'arrivee. File pleine, les nouveaux memes sont ignores plutot que d'evincer
 * ceux deja annonces ; un meme qui a trop attendu n'a plus de sens et saute.
 */

export const EXIT_MS = 320;
export const MAX_QUEUE = 8;
export const MAX_WAIT_MS = 2 * 60 * 1000;
/** Duree minimale a l'ecran, meme pour un drop tres court. */
const MIN_VISIBLE_MS = 600;

/** Un meme affiche, tel que l'hote le manipule. */
export interface View {
  /** Lance l'animation de sortie. */
  leave(): void;
  /** Retire definitivement le meme, une fois la sortie terminee. */
  destroy(): void;
}

export interface QueueHost {
  /** Affiche le drop. `end` signale une video arrivee au bout (ou illisible). */
  mount(drop: MemeDrop, end: () => void): View;
  now(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/**
 * Une video avec `maxDurationMs` est jouee une fois puis retiree a sa fin. Sans
 * (serveur ancien), elle boucle et seul le timer de `durationMs` la retire.
 */
export function playsOnce(drop: MemeDrop): boolean {
  return drop.kind === 'video' && drop.maxDurationMs !== undefined;
}

/**
 * Temps avant de lancer la sortie : l'animation doit se terminer dans la duree
 * annoncee. Pour une video jouee une fois, ce n'est qu'un filet : `end` arrive avant.
 */
export function visibleMs(drop: MemeDrop): number {
  return Math.max(MIN_VISIBLE_MS, (drop.maxDurationMs ?? drop.durationMs) - EXIT_MS);
}

interface Active {
  id: string;
  view: View;
  timer: number;
}

export class DropQueue {
  private current: Active | null = null;
  /** Vrai pendant l'animation de sortie : le suivant attend qu'elle finisse. */
  private leaving = false;
  private readonly waiting: { drop: MemeDrop; receivedAt: number }[] = [];

  constructor(private readonly host: QueueHost) {}

  /** Id du meme a l'ecran, null si aucun. */
  get showing(): string | null {
    return this.current?.id ?? null;
  }

  /** Ids en attente, dans l'ordre de passage. */
  get pending(): string[] {
    return this.waiting.map((entry) => entry.drop.id);
  }

  enqueue(drop: MemeDrop): void {
    if (this.current?.id === drop.id || this.waiting.some((entry) => entry.drop.id === drop.id)) return;
    if (this.waiting.length >= MAX_QUEUE) return;
    this.waiting.push({ drop, receivedAt: this.host.now() });
    this.next();
  }

  /** Retire un meme, qu'il soit a l'ecran ou encore en attente. */
  remove(id: string): void {
    const index = this.waiting.findIndex((entry) => entry.drop.id === id);
    if (index !== -1) this.waiting.splice(index, 1);

    if (this.current?.id !== id) return;
    const entry = this.current;
    this.current = null;
    this.leaving = true;

    this.host.clearTimeout(entry.timer);
    entry.view.leave();
    this.host.setTimeout(() => {
      entry.view.destroy();
      this.leaving = false;
      this.next();
    }, EXIT_MS);
  }

  /** Vide la file et retire le meme affiche. */
  clear(): void {
    this.waiting.length = 0;
    if (this.current) this.remove(this.current.id);
  }

  private next(): void {
    if (this.current || this.leaving) return;
    while (this.waiting.length > 0) {
      const { drop, receivedAt } = this.waiting.shift()!;
      if (this.host.now() - receivedAt <= MAX_WAIT_MS) {
        this.show(drop);
        return;
      }
    }
  }

  private show(drop: MemeDrop): void {
    const view = this.host.mount(drop, () => this.remove(drop.id));
    this.current = {
      id: drop.id,
      view,
      timer: this.host.setTimeout(() => this.remove(drop.id), visibleMs(drop)),
    };
  }
}
