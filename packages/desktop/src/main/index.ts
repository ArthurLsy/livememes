import path from 'node:path';
import os from 'node:os';
import { app, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import type { PairResponse } from '@livememes/shared';
import * as store from './store.ts';
import * as overlay from './overlay.ts';
import * as settingsWindow from './settings-window.ts';
import { Connection, type ConnectionStatus } from './connection.ts';

// Instance unique : deux overlays afficheraient chaque meme en double.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Sans fenetre visible dans le dock, l'app se pilote uniquement depuis la barre de menus.
app.dock?.hide();

const connection = new Connection();
let tray: Tray | null = null;
let lastStatus: ConnectionStatus = 'offline';
let lastDetail: string | null = null;
let quitting = false;

/* -------------------------------------------------------------------------- */
/* Etat partage avec la fenetre de reglages                                   */
/* -------------------------------------------------------------------------- */

function appState() {
  const settings = store.get();
  return {
    serverUrl: store.SERVER_URL,
    linked: settings.token !== null,
    user: settings.user,
    volume: settings.volume,
    muted: settings.muted,
    displays: settings.displays,
    displayList: overlay.listDisplays(),
    launchAtLogin: settings.launchAtLogin,
    status: lastStatus,
    detail: lastDetail,
  };
}

function broadcastState(): void {
  settingsWindow.push('app:state', appState());
  renderTray();
}

/* -------------------------------------------------------------------------- */
/* Barre de menus                                                             */
/* -------------------------------------------------------------------------- */

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  offline: 'Deconnecte',
  connecting: 'Connexion...',
  online: 'Connecte',
  unauthorized: 'Appareil non lie',
};

function renderTray(): void {
  if (!tray) return;
  const settings = store.get();

  tray.setToolTip(`LiveMemes — ${STATUS_LABEL[lastStatus]}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: settings.user ? `${STATUS_LABEL[lastStatus]} — ${settings.user.username}` : STATUS_LABEL[lastStatus],
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Sourdine',
        type: 'checkbox',
        checked: settings.muted,
        click: (item) => setMuted(item.checked),
      },
      {
        label: 'Afficher sur tous les ecrans',
        type: 'checkbox',
        checked: settings.displays === 'all',
        click: (item) => {
          store.update({ displays: item.checked ? 'all' : 'primary' });
          overlay.sync();
          broadcastState();
        },
      },
      { type: 'separator' },
      { label: 'Apercu', click: () => overlay.preview() },
      { label: 'Reglages...', click: () => settingsWindow.open() },
      { type: 'separator' },
      {
        label: 'Quitter LiveMemes',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function setMuted(muted: boolean): void {
  store.update({ muted });
  connection.send({ t: 'setMuted', muted });
  broadcastState();
}

function isDisplayChoice(value: unknown): value is store.DisplayChoice {
  if (value === 'primary' || value === 'all') return true;
  return Array.isArray(value) && value.every((id) => Number.isInteger(id));
}

/* -------------------------------------------------------------------------- */
/* Appairage                                                                  */
/* -------------------------------------------------------------------------- */

async function pair(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let http: string;
  try {
    ({ http } = store.endpoints(store.SERVER_URL));
  } catch {
    return { ok: false, error: "Adresse de serveur invalide." };
  }

  let response: Response;
  try {
    response = await fetch(`${http}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: `${os.hostname()} (${process.platform})` }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, error: "Serveur injoignable. Verifie l'adresse et ta connexion." };
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `Le serveur a repondu ${response.status}.` };
  }

  const data = (await response.json()) as PairResponse;
  store.update({ token: data.token, user: data.user });
  connection.restart();
  broadcastState();
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Demarrage                                                                  */
/* -------------------------------------------------------------------------- */

app.whenReady().then(() => {
  store.load();
  overlay.init();

  const icon = nativeImage
    .createFromPath(path.join(__dirname, '../../assets/tray.png'))
    .resize({ width: 16, height: 16 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', () => settingsWindow.open());

  connection.on('status', (status, detail) => {
    lastStatus = status;
    lastDetail = detail;
    broadcastState();
  });
  connection.on('drop', (drop) => overlay.show(drop));
  connection.on('clear', (dropId) => overlay.clear(dropId));
  connection.on('muted', () => broadcastState());

  // La liste des ecrans affichee dans les reglages suit les branchements.
  screen.on('display-added', () => broadcastState());
  screen.on('display-removed', () => broadcastState());
  screen.on('display-metrics-changed', () => broadcastState());

  renderTray();

  if (store.get().token) {
    connection.start();
  } else {
    settingsWindow.open();
  }

  /* ---------------------------------------------------------------------- */

  ipcMain.handle('app:state', () => appState());

  ipcMain.handle('app:pair', (_event, payload: { code: string }) => pair(payload.code));

  ipcMain.handle('app:unlink', () => {
    store.update({ token: null, user: null });
    connection.stop();
    broadcastState();
  });

  ipcMain.handle('app:setSettings', (_event, patch: Partial<store.Settings>) => {
    const previous = store.get();
    // Valeur ecrite telle quelle dans settings.json puis lue par overlay.sync().
    if (patch.displays !== undefined && !isDisplayChoice(patch.displays)) delete patch.displays;
    store.update(patch);

    if (patch.muted !== undefined && patch.muted !== previous.muted) {
      connection.send({ t: 'setMuted', muted: patch.muted });
    }
    if (patch.displays !== undefined) {
      overlay.sync();
    }
    if (patch.launchAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    }

    broadcastState();
    return appState();
  });

  ipcMain.handle('app:preview', () => overlay.preview());

  ipcMain.handle('app:identifyDisplays', () => overlay.identify());

  ipcMain.handle('app:quit', () => {
    quitting = true;
    app.quit();
  });
});

app.on('second-instance', () => settingsWindow.open());

// L'app vit dans la barre de menus : la seule presence de ce listener empeche
// Electron de quitter quand la fenetre de reglages se ferme.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
  connection.stop();
  overlay.destroyAll();
});

// Aucune navigation ni ouverture de fenetre depuis les renderers.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => event.preventDefault());
});
