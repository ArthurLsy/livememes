import { contextBridge, ipcRenderer } from 'electron';
import type { MemeDrop } from '@livememes/shared';

/**
 * API exposee a l'overlay. Il ne fait qu'afficher, a une exception pres : il
 * declare ou sont ses croix de fermeture, pour que le main ne rende la fenetre
 * cliquable qu'au-dessus d'elles.
 */
contextBridge.exposeInMainWorld('overlay', {
  onDrop: (handler: (drop: MemeDrop & { closable?: boolean }) => void) => {
    ipcRenderer.on('overlay:drop', (_event, drop: MemeDrop & { closable?: boolean }) => handler(drop));
  },
  setCloseZones: (zones: { left: number; top: number; right: number; bottom: number }[]) =>
    ipcRenderer.send('overlay:closeZones', zones),
  onClear: (handler: (dropId: string | null) => void) => {
    ipcRenderer.on('overlay:clear', (_event, dropId: string | null) => handler(dropId));
  },
  onIdentify: (handler: (payload: { number: number; durationMs: number }) => void) => {
    ipcRenderer.on('overlay:identify', (_event, payload: { number: number; durationMs: number }) => handler(payload));
  },
});

/** API de la fenetre de reglages. */
contextBridge.exposeInMainWorld('livememes', {
  getState: () => ipcRenderer.invoke('app:state'),
  pair: (code: string) => ipcRenderer.invoke('app:pair', { code }),
  unlink: () => ipcRenderer.invoke('app:unlink'),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('app:setSettings', patch),
  preview: () => ipcRenderer.invoke('app:preview'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  applyUpdate: () => ipcRenderer.invoke('app:applyUpdate'),
  identifyDisplays: () => ipcRenderer.invoke('app:identifyDisplays'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onState: (handler: (state: unknown) => void) => {
    ipcRenderer.on('app:state', (_event, state) => handler(state));
  },
});
