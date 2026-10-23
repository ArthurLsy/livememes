import path from 'node:path';
import { BrowserWindow, screen } from 'electron';

let window: BrowserWindow | null = null;
const closedHandlers: (() => void)[] = [];

export function open(): BrowserWindow {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return window;
  }

  const area = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    width: Math.min(1180, area.width - 40),
    height: Math.min(820, area.height - 40),
    minWidth: 900,
    minHeight: 640,
    useContentSize: true,
    title: 'LiveMemes - Editeur',
    backgroundColor: '#0d1226',
    // Ignore sur macOS (icone du bundle), utilise par Windows et Linux.
    icon: path.join(__dirname, '../../assets/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void window.loadFile(path.join(__dirname, '../renderer/editor.html'));
  window.on('closed', () => {
    window = null;
    for (const handler of closedHandlers) handler();
  });

  return window;
}

/** Vrai si l'evenement IPC vient de la fenetre d'editeur : le preload est partage. */
export function owns(sender: Electron.WebContents): boolean {
  return window !== null && !window.isDestroyed() && window.webContents === sender;
}

export function push(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

export function get(): BrowserWindow | null {
  return window && !window.isDestroyed() ? window : null;
}

export function onClosed(handler: () => void): void {
  closedHandlers.push(handler);
}
