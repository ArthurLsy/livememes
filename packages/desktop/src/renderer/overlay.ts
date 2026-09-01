import type { MemeDrop, MemePosition } from '@livememes/shared';

declare global {
  interface Window {
    overlay: {
      onDrop(handler: (drop: MemeDrop) => void): void;
      onClear(handler: (dropId: string | null) => void): void;
    };
  }
}

const stage = document.getElementById('stage') as HTMLDivElement;

/** Au-dela, les memes se chevauchent trop pour rester lisibles. */
const MAX_CONCURRENT = 4;
const EXIT_MS = 320;

interface Active {
  element: HTMLElement;
  timer: number;
}

const active = new Map<string, Active>();

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

function buildMedia(drop: MemeDrop): HTMLElement {
  if (drop.kind === 'video') {
    const video = document.createElement('video');
    video.className = 'drop__media';
    video.src = drop.url;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.volume = Math.max(0, Math.min(1, drop.volume));
    // Chrome bloque l'autoplay sonore sans interaction : on demarre muet,
    // puis on remet le son des que la lecture est lancee.
    video.muted = true;
    void video.play().then(() => {
      if (drop.volume > 0) video.muted = false;
    });
    return video;
  }

  const image = document.createElement('img');
  image.className = 'drop__media';
  image.src = drop.url;
  image.alt = '';
  return image;
}

function remove(id: string): void {
  const entry = active.get(id);
  if (!entry) return;
  active.delete(id);

  window.clearTimeout(entry.timer);
  entry.element.classList.add('leaving');
  window.setTimeout(() => entry.element.remove(), EXIT_MS);
}

function render(drop: MemeDrop): void {
  if (active.has(drop.id)) return;

  // Le plus ancien sort pour laisser la place au nouveau.
  while (active.size >= MAX_CONCURRENT) {
    const oldest = active.keys().next();
    if (oldest.done) break;
    remove(oldest.value);
  }

  const anchor = anchorFor(drop.position);
  const element = document.createElement('div');
  element.className = 'drop';
  element.style.setProperty('--x', `${anchor.x}%`);
  element.style.setProperty('--y', `${anchor.y}%`);
  element.style.setProperty('--h', `${Math.round(drop.scale * 100)}vh`);

  element.append(buildMedia(drop));

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

  // L'animation de sortie doit se terminer dans la duree annoncee.
  const visibleMs = Math.max(600, drop.durationMs - EXIT_MS);
  active.set(drop.id, {
    element,
    timer: window.setTimeout(() => remove(drop.id), visibleMs),
  });
}

window.overlay.onDrop(render);

window.overlay.onClear((dropId) => {
  if (dropId) {
    remove(dropId);
    return;
  }
  for (const id of [...active.keys()]) remove(id);
});
