import type { MemeDrop, MemePosition } from '@livememes/shared';

declare global {
  interface Window {
    overlay: {
      onDrop(handler: (drop: MemeDrop) => void): void;
      onClear(handler: (dropId: string | null) => void): void;
      onIdentify(handler: (payload: { number: number; durationMs: number }) => void): void;
    };
  }
}

const stage = document.getElementById('stage') as HTMLDivElement;

const EXIT_MS = 320;

/**
 * File d'attente : un seul meme a l'ecran, les suivants attendent leur tour
 * dans l'ordre d'arrivee. Chaque fenetre d'overlay (un ecran) a la sienne.
 * File pleine, les nouveaux memes sont ignores plutot que d'evincer ceux deja
 * annonces ; un meme qui a trop attendu n'a plus de sens et saute.
 */
const MAX_QUEUE = 8;
const MAX_WAIT_MS = 2 * 60 * 1000;

interface Active {
  id: string;
  element: HTMLElement;
  timer: number;
}

interface Queued {
  drop: MemeDrop;
  receivedAt: number;
}

let current: Active | null = null;
/** Vrai pendant l'animation de sortie : le suivant attend qu'elle finisse. */
let leaving = false;
const queue: Queued[] = [];

/** Coordonnees du centre du meme, en pourcentage de l'ecran. */
function anchorFor(position: MemePosition): { x: number; y: number } {
  switch (position) {
    case 'top-left':
      return { x: 22, y: 24 };
    case 'top-right':
      return { x: 78, y: 24 };
    case 'bottom-left':
      return { x: 22, y: 76 };
    case 'bottom-right':
      return { x: 78, y: 76 };
    case 'random':
      // Marge interieure : le meme ne doit jamais deborder de l'ecran.
      return { x: 25 + Math.random() * 50, y: 25 + Math.random() * 50 };
    case 'center':
    default:
      return { x: 50, y: 50 };
  }
}

/**
 * `onEnd` est appele quand une video jouee jusqu'au bout se termine ou ne peut
 * pas etre lue. Sans `maxDurationMs` (serveur ancien), la video boucle et seul
 * le timer de `durationMs` la retire, comme avant.
 */
function buildMedia(drop: MemeDrop, onEnd: () => void): HTMLElement {
  if (drop.kind === 'video') {
    const playOnce = drop.maxDurationMs !== undefined;
    const video = document.createElement('video');
    video.className = 'drop__media';
    video.src = drop.url;
    video.autoplay = true;
    video.loop = !playOnce;
    if (playOnce) {
      video.addEventListener('ended', onEnd);
      video.addEventListener('error', onEnd);
    }
    video.playsInline = true;
    video.volume = Math.max(0, Math.min(1, drop.volume));
    // Chrome bloque l'autoplay sonore sans interaction : on demarre muet,
    // puis on remet le son des que la lecture est lancee.
    video.muted = true;
    // Un echec de lecture n'est pas fatal : `error` ou le timer de securite
    // retirent le meme.
    video.play().then(
      () => {
        if (drop.volume > 0) video.muted = false;
      },
      () => {},
    );
    return video;
  }

  const image = document.createElement('img');
  image.className = 'drop__media';
  image.src = drop.url;
  image.alt = '';
  return image;
}

function remove(id: string): void {
  const index = queue.findIndex((entry) => entry.drop.id === id);
  if (index !== -1) queue.splice(index, 1);

  if (current?.id !== id) return;
  const entry = current;
  current = null;
  leaving = true;

  window.clearTimeout(entry.timer);
  entry.element.classList.add('leaving');
  window.setTimeout(() => {
    entry.element.remove();
    leaving = false;
    next();
  }, EXIT_MS);
}

function next(): void {
  if (current || leaving) return;
  while (queue.length > 0) {
    const { drop, receivedAt } = queue.shift()!;
    if (Date.now() - receivedAt <= MAX_WAIT_MS) {
      render(drop);
      return;
    }
  }
}

function enqueue(drop: MemeDrop): void {
  if (current?.id === drop.id || queue.some((entry) => entry.drop.id === drop.id)) return;
  if (queue.length >= MAX_QUEUE) return;
  queue.push({ drop, receivedAt: Date.now() });
  next();
}

function render(drop: MemeDrop): void {
  const anchor = anchorFor(drop.position);
  const element = document.createElement('div');
  element.className = 'drop';
  element.style.setProperty('--x', `${anchor.x}%`);
  element.style.setProperty('--y', `${anchor.y}%`);
  element.style.setProperty('--h', `${Math.round(drop.scale * 100)}vh`);

  element.append(buildMedia(drop, () => remove(drop.id)));

  if (drop.caption) {
    const caption = document.createElement('div');
    caption.className = 'drop__caption';
    caption.textContent = drop.caption;
    element.append(caption);
  }

  const author = document.createElement('div');
  author.className = 'drop__author';
  if (drop.author.avatarUrl) {
    const avatar = document.createElement('img');
    avatar.className = 'drop__avatar';
    avatar.src = drop.author.avatarUrl;
    avatar.alt = '';
    author.append(avatar);
  }
  const name = document.createElement('span');
  name.textContent = drop.author.username;
  author.append(name);
  element.append(author);

  stage.append(element);

  // L'animation de sortie doit se terminer dans la duree annoncee. Pour une
  // video jouee une fois, le timer n'est qu'un filet : `ended` arrive avant.
  const visibleMs = Math.max(600, (drop.maxDurationMs ?? drop.durationMs) - EXIT_MS);
  current = {
    id: drop.id,
    element,
    timer: window.setTimeout(() => remove(drop.id), visibleMs),
  };
}

window.overlay.onDrop(enqueue);

window.overlay.onClear((dropId) => {
  if (dropId) {
    remove(dropId);
    return;
  }
  queue.length = 0;
  if (current) remove(current.id);
});

// Numero geant au centre de l'ecran, pour reperer quel ecran est lequel dans
// les reglages.
window.overlay.onIdentify(({ number, durationMs }) => {
  const badge = document.createElement('div');
  badge.className = 'identify';
  badge.textContent = String(number);
  stage.append(badge);
  window.setTimeout(() => badge.remove(), durationMs);
});
