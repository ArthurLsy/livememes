import path from 'node:path';
import { BrowserWindow, ipcMain, screen, type Display } from 'electron';
import type { MemeDrop } from '@livememes/shared';
import * as store from './store.ts';

const windows = new Map<number, BrowserWindow>();
/** Fenetres ouvertes seulement pour `identify()` : elles ne recoivent aucun meme. */
const identifyOnly = new Set<number>();

const RENDERER = path.join(__dirname, '../renderer');
const PRELOAD = path.join(__dirname, '../preload/index.cjs');

/**
 * La croix de fermeture repose sur `forward: true`, qui transmet les mouvements
 * de souris au renderer d'une fenetre traversante. Electron ne le gere pas sous
 * Linux : la croix n'y serait jamais survolable, on ne l'affiche pas.
 */
export const CLOSE_SUPPORTED = process.platform !== 'linux';

/** Etat "traversant" par defaut : les clics passent, les mouvements remontent. */
function passThrough(window: BrowserWindow): void {
  window.setIgnoreMouseEvents(true, { forward: true });
}

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
    // macOS : sans ca, le premier clic sur la croix ne ferait qu'activer la
    // fenetre. Sans effet ailleurs, et la fenetre reste traversante hors croix.
    acceptFirstMouse: true,
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
  passThrough(window);
  window.setAlwaysOnTop(true, 'screen-saver', 1);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setContentProtection(false);

  void window.loadFile(path.join(RENDERER, 'overlay.html'));
  window.once('ready-to-show', () => window.showInactive());

  return window;
}

/** Ecrans cibles selon le reglage `displays`, jamais vide. */
function targetDisplays(): Display[] {
  const choice = store.get().displays;
  if (choice === 'all') return screen.getAllDisplays();
  if (choice === 'primary') return [screen.getPrimaryDisplay()];

  const chosen = screen.getAllDisplays().filter((display) => choice.includes(display.id));
  return chosen.length > 0 ? chosen : [screen.getPrimaryDisplay()];
}

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  /** Vrai si l'overlay s'y affiche actuellement. */
  active: boolean;
}

/** Ecrans branches, dans l'ordre de `identify()`, pour la fenetre de reglages. */
export function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  const active = new Set(targetDisplays().map((display) => display.id));
  return screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    label: `${index + 1}. ${display.label || 'Ecran'} (${display.size.width}x${display.size.height})`,
    primary: display.id === primaryId,
    active: active.has(display.id),
  }));
}

/** (Re)cree les fenetres pour les ecrans cibles selon le reglage displays. */
export function sync(): void {
  const displays = targetDisplays();
  const wanted = new Set(displays.map((display) => display.id));
  identifyOnly.clear();

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
  // Le renderer survole ou quitte une croix de fermeture. On ne l'accepte que
  // d'une fenetre d'overlay : la fenetre de reglages partage le preload.
  ipcMain.on('overlay:interactive', (event, interactive: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || ![...windows.values()].includes(window)) return;
    if (interactive === true && CLOSE_SUPPORTED) window.setIgnoreMouseEvents(false);
    else passThrough(window);
  });

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
    if (identifyOnly.has(id)) continue;
    callback(window);
  }
}

export function show(drop: MemeDrop): void {
  const settings = store.get();
  if (settings.muted) return;

  // Le volume local plafonne celui demande par l'expediteur.
  const payload = {
    ...drop,
    position: settings.topLeft ? 'top-left' : drop.position,
    volume: drop.volume * settings.volume,
    closable: settings.closeButton && CLOSE_SUPPORTED,
  };

  each((window) => {
    // Un jeu passe en plein ecran peut avoir repris le dessus entre deux drops.
    window.setAlwaysOnTop(true, 'screen-saver', 1);
    window.webContents.send('overlay:drop', payload);
  });
}

export function clear(dropId: string | null): void {
  each((window) => {
    window.webContents.send('overlay:clear', dropId);
    // Un meme retire sous la souris ne doit pas laisser la fenetre cliquable.
    if (dropId === null) passThrough(window);
  });
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

const IDENTIFY_MS = 3000;
let identifyTimer: NodeJS.Timeout | null = null;

/**
 * Affiche le numero de chaque ecran, cibles ou non : les fenetres creees pour
 * l'occasion disparaissent au `sync()` qui suit.
 */
export function identify(): void {
  screen.getAllDisplays().forEach((display, index) => {
    let window = windows.get(display.id);
    if (!window || window.isDestroyed()) {
      window = createForDisplay(display);
      windows.set(display.id, window);
      identifyOnly.add(display.id);
    }
    const target = window;
    const send = () => target.webContents.send('overlay:identify', { number: index + 1, durationMs: IDENTIFY_MS });
    if (target.webContents.isLoading()) target.webContents.once('did-finish-load', send);
    else send();
  });

  if (identifyTimer) clearTimeout(identifyTimer);
  identifyTimer = setTimeout(() => {
    identifyTimer = null;
    sync();
  }, IDENTIFY_MS + 500);
}

export function destroyAll(): void {
  for (const window of windows.values()) {
    if (!window.isDestroyed()) window.destroy();
  }
  windows.clear();
}
