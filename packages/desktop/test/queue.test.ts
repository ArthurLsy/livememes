import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { MemeDrop } from '@livememes/shared';
import { DropQueue, EXIT_MS, MAX_QUEUE, MAX_WAIT_MS, playsOnce, visibleMs } from '../src/renderer/queue.ts';

/** Hote factice : horloge virtuelle, timers manuels, journal des montages. */
class FakeHost {
  time = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private nextId = 1;
  mounted: string[] = [];
  destroyed: string[] = [];
  ends = new Map<string, () => void>();

  mount = (drop: MemeDrop, end: () => void) => {
    this.mounted.push(drop.id);
    this.ends.set(drop.id, end);
    return { leave: () => {}, destroy: () => this.destroyed.push(drop.id) };
  };
  now = () => this.time;
  setTimeout = (callback: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  };
  clearTimeout = (id: number) => {
    this.timers.delete(id);
  };

  /** Avance l'horloge en declenchant les timers echus, dans l'ordre. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = target;
  }
}

function drop(id: string, extra: Partial<MemeDrop> = {}): MemeDrop {
  return {
    id,
    url: `http://example.test/media/${id}`,
    kind: 'image',
    durationMs: 5000,
    position: 'center',
    scale: 0.45,
    volume: 0.6,
    caption: null,
    author: { id: '1', username: 'Test', avatarUrl: null },
    guildName: null,
    sentAt: 0,
    ...extra,
  };
}

let host: FakeHost;
let queue: DropQueue;

beforeEach(() => {
  host = new FakeHost();
  queue = new DropQueue(host);
});

describe('file d attente de l overlay', () => {
  it('affiche un seul meme a la fois, dans l ordre d arrivee', () => {
    queue.enqueue(drop('a'));
    queue.enqueue(drop('b'));
    queue.enqueue(drop('c'));
    assert.equal(queue.showing, 'a');
    assert.deepEqual(queue.pending, ['b', 'c']);

    host.advance(visibleMs(drop('a')));
    assert.equal(queue.showing, null, 'le suivant attend la fin de l animation de sortie');
    host.advance(EXIT_MS);
    assert.equal(queue.showing, 'b');
    assert.deepEqual(host.destroyed, ['a']);
  });

  it('ignore un doublon deja affiche ou en attente', () => {
    queue.enqueue(drop('a'));
    queue.enqueue(drop('b'));
    queue.enqueue(drop('a'));
    queue.enqueue(drop('b'));
    assert.deepEqual(queue.pending, ['b']);
    assert.deepEqual(host.mounted, ['a']);
  });

  it('ignore les nouveaux memes quand la file est pleine', () => {
    queue.enqueue(drop('ecran'));
    for (let i = 0; i < MAX_QUEUE + 3; i++) queue.enqueue(drop(`q${i}`));
    assert.equal(queue.pending.length, MAX_QUEUE);
    assert.equal(queue.pending.at(-1), `q${MAX_QUEUE - 1}`);
  });

  it('saute un meme qui a trop attendu', () => {
    queue.enqueue(drop('long', { durationMs: MAX_WAIT_MS + 10_000 }));
    queue.enqueue(drop('perime'));
    host.advance(MAX_WAIT_MS + 1);
    queue.enqueue(drop('frais'));

    host.advance(20_000);
    assert.deepEqual(host.mounted, ['long', 'frais']);
  });

  it('retire un meme en attente sans toucher a celui affiche', () => {
    queue.enqueue(drop('a'));
    queue.enqueue(drop('b'));
    queue.remove('b');
    assert.equal(queue.showing, 'a');
    assert.deepEqual(queue.pending, []);
  });

  it('vide tout sur clear', () => {
    queue.enqueue(drop('a'));
    queue.enqueue(drop('b'));
    queue.clear();
    host.advance(EXIT_MS);
    assert.equal(queue.showing, null);
    assert.deepEqual(host.mounted, ['a']);
    assert.deepEqual(host.destroyed, ['a']);
  });
});

describe('fin de video', () => {
  const video = drop('v', { kind: 'video', durationMs: 6000, maxDurationMs: 60_000 });

  it('joue une fois une video qui annonce un plafond', () => {
    assert.equal(playsOnce(video), true);
    assert.equal(playsOnce(drop('ancien', { kind: 'video' })), false, 'serveur ancien : boucle');
    assert.equal(playsOnce(drop('image', { maxDurationMs: 60_000 })), false);
  });

  it('retire la video a sa fin, bien avant le plafond', () => {
    queue.enqueue(video);
    queue.enqueue(drop('suivant'));
    host.advance(9000);
    assert.equal(queue.showing, 'v', 'durationMs ne coupe pas une video jouee une fois');

    host.ends.get('v')!();
    host.advance(EXIT_MS);
    assert.equal(queue.showing, 'suivant');
  });

  it('coupe une video bloquee au plafond', () => {
    queue.enqueue(video);
    host.advance(60_000);
    assert.equal(queue.showing, null);
    assert.deepEqual(host.destroyed, ['v']);
  });

  it('ignore une fin signalee apres le retrait', () => {
    queue.enqueue(video);
    queue.remove('v');
    host.advance(EXIT_MS);
    queue.enqueue(drop('suivant'));
    host.ends.get('v')!();
    assert.equal(queue.showing, 'suivant');
  });

  it('garde une duree minimale a l ecran', () => {
    assert.equal(visibleMs(drop('court', { durationMs: 100 })), 600);
    assert.equal(visibleMs(drop('img', { durationMs: 5000 })), 5000 - EXIT_MS);
    assert.equal(visibleMs(video), 60_000 - EXIT_MS);
  });
});
