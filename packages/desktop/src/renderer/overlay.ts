import type { MemeDrop, MemePosition } from '@livememes/shared';
import { initialOf } from './avatar.ts';
import { nudge } from './close.ts';
import { DropQueue, playsOnce, type View } from './queue.ts';

/** Drop tel que le main l'envoie : `closable` dit s'il faut afficher la croix. */
type OverlayDrop = MemeDrop & { closable?: boolean };

declare global {
  interface Window {
    overlay: {
      onDrop(handler: (drop: OverlayDrop) => void): void;
      setCloseZones(zones: { left: number; top: number; right: number; bottom: number }[]): void;
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

/* -------------------------------------------------------------------------- */
/* Croix de fermeture                                                         */
/* -------------------------------------------------------------------------- */

/**
 * La fenetre laisse passer tous les clics. Le main releve le curseur et ne la
 * rend cliquable que lorsqu'il survole l'une des zones declarees ici : chaque
 * changement (entree, recalage, sortie d'un meme, redimensionnement) les
 * renvoie.
 */

/** Marge autour de la croix, la meme que son `::before` dans overlay.css. */
const HIT_MARGIN = 10;

function reportZones(): void {
  const zones = [...stage.querySelectorAll<HTMLButtonElement>('.drop:not(.leaving) .drop__close')].map((button) => {
    const rect = button.getBoundingClientRect();
    return {
      left: rect.left - HIT_MARGIN,
      top: rect.top - HIT_MARGIN,
      right: rect.right + HIT_MARGIN,
      bottom: rect.bottom + HIT_MARGIN,
    };
  });
  window.overlay.setCloseZones(zones);
}

window.addEventListener('resize', reportZones);

/** Recale la croix dans l'ecran quand le meme deborde (grand meme en coin). */
function keepInside(button: HTMLButtonElement): void {
  button.style.removeProperty('translate');
  const offset = nudge(button.getBoundingClientRect(), window.innerWidth, window.innerHeight);
  if (offset.x !== 0 || offset.y !== 0) button.style.translate = `${offset.x}px ${offset.y}px`;
  reportZones();
}

const SVG = 'http://www.w3.org/2000/svg';

function buildClose(onClose: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'drop__close';
  button.setAttribute('aria-label', 'Fermer ce meme');

  const icon = document.createElementNS(SVG, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const cross = document.createElementNS(SVG, 'path');
  cross.setAttribute('d', 'M6 6l12 12M18 6L6 18');
  icon.append(cross);
  button.append(icon);

  button.addEventListener('click', onClose);
  return button;
}

function mount(drop: OverlayDrop, end: () => void): View {
  const anchor = anchorFor(drop.position);
  const element = document.createElement('div');
  element.className = 'drop';
  element.style.setProperty('--x', `${anchor.x}%`);
  element.style.setProperty('--y', `${anchor.y}%`);
  element.style.setProperty('--h', `${Math.round(drop.scale * 100)}vh`);

  const frame = document.createElement('div');
  frame.className = 'drop__frame';
  const media = buildMedia(drop, end);
  frame.append(media);
  element.append(frame);

  let close: HTMLButtonElement | null = null;
  if (drop.closable) {
    // Ne ferme que ce meme, sur cet ecran : la file passe au suivant.
    close = buildClose(() => queue.remove(drop.id));
    frame.append(close);
    const button = close;
    // Mesure une fois l'entree terminee (le scale fausserait la position) et
    // quand le media connait sa taille.
    element.addEventListener('animationend', () => keepInside(button), { once: true });
    media.addEventListener(media instanceof HTMLVideoElement ? 'loadedmetadata' : 'load', () => keepInside(button));
  }

  if (drop.caption) {
    const caption = document.createElement('div');
    caption.className = 'drop__caption';
    caption.textContent = drop.caption;
    element.append(caption);
  }

  const author = document.createElement('div');
  author.className = 'drop__author';
  // L'initiale reste dessous : visible tant que l'avatar charge, ou s'il echoue.
  const avatar = document.createElement('span');
  avatar.className = 'drop__avatar';
  avatar.textContent = initialOf(drop.author.username);
  if (drop.author.avatarUrl) {
    const image = document.createElement('img');
    image.src = drop.author.avatarUrl;
    image.alt = '';
    image.addEventListener('error', () => image.remove());
    avatar.append(image);
  }
  author.append(avatar);
  const name = document.createElement('span');
  name.textContent = drop.author.username;
  author.append(name);
  element.append(author);

  stage.append(element);
  // Zone approximative pendant l'animation d'entree, recalee a `animationend`.
  if (close) reportZones();

  return {
    leave: () => {
      element.classList.add('leaving');
      // Le son s'arrete tout de suite, sans attendre la fin de l'animation.
      if (media instanceof HTMLVideoElement) media.pause();
      if (close) reportZones();
    },
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
