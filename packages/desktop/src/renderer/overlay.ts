import type { MemeDrop, MemePosition } from '@livememes/shared';
import { DropQueue, playsOnce, type View } from './queue.ts';

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
 * pas etre lue (voir `playsOnce`).
 */
function buildMedia(drop: MemeDrop, onEnd: () => void): HTMLElement {
  if (drop.kind === 'video') {
    const playOnce = playsOnce(drop);
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

function mount(drop: MemeDrop, end: () => void): View {
  const anchor = anchorFor(drop.position);
  const element = document.createElement('div');
  element.className = 'drop';
  element.style.setProperty('--x', `${anchor.x}%`);
  element.style.setProperty('--y', `${anchor.y}%`);
  element.style.setProperty('--h', `${Math.round(drop.scale * 100)}vh`);

  element.append(buildMedia(drop, end));

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

  return {
    leave: () => element.classList.add('leaving'),
    destroy: () => element.remove(),
  };
}

// Chaque fenetre d'overlay (un ecran) a sa propre file.
const queue = new DropQueue({
  mount,
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (id) => window.clearTimeout(id),
});

window.overlay.onDrop((drop) => queue.enqueue(drop));

window.overlay.onClear((dropId) => {
  if (dropId) queue.remove(dropId);
  else queue.clear();
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
