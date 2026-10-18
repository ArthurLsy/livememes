import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';

/**
 * Mises a jour du client, publiees sur GitHub Releases (config `publish` de
 * electron-builder, qui embarque `app-update.yml` dans le paquet).
 *
 * - `auto` : telechargement en arriere-plan puis installation au redemarrage.
 *   Uniquement l'installeur NSIS (Windows) et l'AppImage (Linux).
 * - `manual` : on signale la nouvelle version et on ouvre la page de release.
 *   macOS (Squirrel.Mac refuse une app non signee) et le zip Windows (l'installeur
 *   NSIS s'installerait ailleurs que le dossier extrait).
 * - `disabled` : app lancee depuis les sources.
 *
 * Aucune erreur ne remonte : reseau coupe, release sans fichier `.yml` ou
 * binaire corrompu (sha512 verifie par electron-updater) finissent en etat
 * `error` et l'app continue de tourner sur sa version courante.
 */

const RELEASES_URL = 'https://github.com/ArthurLsy/livememes/releases';
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateMode = 'auto' | 'manual' | 'disabled';

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'upToDate' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

export interface UpdateStatus {
  mode: UpdateMode;
  currentVersion: string;
  update: UpdateState;
}

const events = new EventEmitter();
let mode: UpdateMode = 'disabled';
let current: UpdateState = { state: 'idle' };
let pendingVersion: string | null = null;

function set(next: UpdateState): void {
  current = next;
  events.emit('change');
}

export function onChange(listener: () => void): void {
  events.on('change', listener);
}

export function status(): UpdateStatus {
  return { mode, currentVersion: app.getVersion(), update: current };
}

/** Installe par NSIS : le desinstalleur est pose a cote de l'executable. */
function isNsisInstall(): boolean {
  try {
    return fs.readdirSync(path.dirname(process.execPath)).some((name) => /^Uninstall .+\.exe$/i.test(name));
  } catch {
    return false;
  }
}

function detectMode(): UpdateMode {
  if (!app.isPackaged) return 'disabled';
  if (process.platform === 'win32') return isNsisInstall() ? 'auto' : 'manual';
  // electron-updater remplace le fichier designe par APPIMAGE ; absent, l'app
  // ne tourne pas depuis une AppImage.
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'auto' : 'manual';
  return 'manual';
}

/** Message court pour l'UI ; le detail complet part dans les logs. */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_NO_PUBLISHED_VERSIONS|404/.test(text)) {
    return 'Aucune mise a jour publiee.';
  }
  if (/sha512|checksum/i.test(text)) return 'Fichier de mise a jour invalide.';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::/i.test(text)) {
    return 'Serveur de mises a jour injoignable.';
  }
  return 'La recherche de mise a jour a echoue.';
}

export function init(): void {
  mode = detectMode();
  if (mode === 'disabled') return;

  autoUpdater.autoDownload = mode === 'auto';
  autoUpdater.autoInstallOnAppQuit = mode === 'auto';
  // Une version beta (0.1.0-beta.1) active deja allowPrerelease ; on le fixe
  // pour qu'une version stable ne bascule pas d'elle-meme sur les betas.
  autoUpdater.allowPrerelease = app.getVersion().includes('-');
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => {
    if (pendingVersion === null) set({ state: 'checking' });
  });
  autoUpdater.on('update-not-available', () => set({ state: 'upToDate' }));
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    if (mode === 'manual') set({ state: 'available', version: info.version });
    else set({ state: 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (progress) => {
    if (current.state !== 'downloading') return;
    const percent = Math.floor(progress.percent);
    // download-progress tire plusieurs fois par seconde : on ne redessine le
    // menu qu'a chaque point de pourcentage.
    if (percent !== current.percent) set({ ...current, percent });
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    pendingVersion = info.version;
    set({ state: 'ready', version: info.version });
  });
  autoUpdater.on('error', (error) => {
    console.error('[updater]', error);
    // Une mise a jour deja telechargee reste installable malgre l'echec d'une
    // verification ulterieure.
    if (pendingVersion !== null) set({ state: 'ready', version: pendingVersion });
    else set({ state: 'error', message: describe(error) });
  });

  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS).unref();
}

export function check(): void {
  if (mode === 'disabled') return;
  if (current.state === 'checking' || current.state === 'downloading' || current.state === 'ready') return;
  // L'erreur est deja traitee par l'evenement `error` ; sans ce catch, la
  // promesse rejetee finirait en unhandledRejection.
  autoUpdater.checkForUpdates()?.catch(() => {});
}

/** Action principale proposee a l'utilisateur pour la mise a jour en attente. */
export function apply(): void {
  if (current.state === 'ready') {
    // Silencieux et relance : l'installeur NSIS reprend le dossier d'installation
    // existant sans reposer de questions.
    autoUpdater.quitAndInstall(true, true);
  } else if (current.state === 'available') {
    void shell.openExternal(`${RELEASES_URL}/tag/v${current.version}`);
  }
}
