import path from 'node:path';
import { BrowserWindow, screen, type Display } from 'electron';
import type { MemeDrop } from '@livememes/shared';
import * as store from './store.ts';

const windows = new Map<number, BrowserWindow>();

const RENDERER = path.join(__dirname, '../renderer');
const PRELOAD = path.join(__dirname, '../preload/index.cjs');

/**
 * Fenetre plein ecran, transparente et traversante par la souris.
 *
 * `focusable: false` evite de voler le focus au jeu en cours, et le niveau
 * 'screen-saver' fait passer l'overlay au-dessus des applications plein ecran.
 */
function createForDisplay(display: Display): BrowserWindow {
  const window = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    fullscreenable: false,
    acceptFirstMouse: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // La souris traverse l'overlay : on ne veut jamais bloquer un clic dans le jeu.
  window.setIgnoreMouseEvents(true, { forward: true });
  window.setAlwaysOnTop(true, 'screen-saver', 1);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setContentProtection(false);

  void window.loadFile(path.join(RENDERER, 'overlay.html'));
  window.once('ready-to-show', () => window.showInactive());

  return window;
}

/** (Re)cree les fenetres pour les ecrans cibles selon le reglage allDisplays. */
export function sync(): void {
  const settings = store.get();
  const displays = settings.allDisplays
    ? screen.getAllDisplays()
    : [screen.getPrimaryDisplay()];
  const wanted = new Set(displays.map((display) => display.id));

  for (const [id, window] of windows) {
    if (!wanted.has(id)) {
      window.destroy();
      windows.delete(id);
    }
  }

  for (const display of displays) {
    const existing = windows.get(display.id);
    if (existing && !existing.isDestroyed()) {
      existing.setBounds(display.bounds);
      continue;
    }
    windows.set(display.id, createForDisplay(display));
  }
}

export function init(): void {
  sync();
  screen.on('display-added', sync);
  screen.on('display-removed', sync);
  screen.on('display-metrics-changed', sync);
}

function each(callback: (window: BrowserWindow) => void): void {
  for (const [id, window] of windows) {
    if (window.isDestroyed()) {
      windows.delete(id);
      continue;
    }
    callback(window);
  }
}

export function show(drop: MemeDrop): void {
  const settings = store.get();
  if (settings.muted) return;

  // Le volume local plafonne celui demande par l'expediteur.
  const payload = { ...drop, volume: drop.volume * settings.volume };

  each((window) => {
    // Un jeu passe en plein ecran peut avoir repris le dessus entre deux drops.
    window.setAlwaysOnTop(true, 'screen-saver', 1);
    window.webContents.send('overlay:drop', payload);
  });
}

export function clear(dropId: string | null): void {
  each((window) => window.webContents.send('overlay:clear', dropId));
}

/** Affiche un meme de test local, sans passer par le serveur. */
export function preview(): void {
  show({
    id: `preview-${Date.now()}`,
    url: `file://${path.join(RENDERER, 'preview.svg')}`,
    kind: 'image',
    durationMs: 4000,
    position: 'center',
    scale: 0.45,
    volume: 0,
    caption: 'Ceci est un apercu local',
    author: { id: '0', username: 'LiveMemes', avatarUrl: null },
    guildName: null,
    sentAt: Date.now(),
  });
}

export function destroyAll(): void {
  for (const window of windows.values()) {
    if (!window.isDestroyed()) window.destroy();
  }
  windows.clear();
}
