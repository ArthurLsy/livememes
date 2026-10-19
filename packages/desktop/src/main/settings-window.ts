import path from 'node:path';
import { BrowserWindow } from 'electron';

let window: BrowserWindow | null = null;

export function open(): BrowserWindow {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return window;
  }

  window = new BrowserWindow({
    width: 520,
    height: 740,
    resizable: false,
    title: 'LiveMemes',
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

  void window.loadFile(path.join(__dirname, '../renderer/settings.html'));
  window.on('closed', () => {
    window = null;
  });

  return window;
}

/** Pousse l'etat courant vers la fenetre de reglages si elle est ouverte. */
export function push(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

export function isOpen(): boolean {
  return window !== null && !window.isDestroyed();
}
