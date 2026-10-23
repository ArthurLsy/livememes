import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { MemeDrop } from '@livememes/shared';

/**
 * API exposee a l'overlay. Il ne fait qu'afficher, a une exception pres : la
 * croix de fermeture demande a capter la souris pendant qu'on la survole.
 */
contextBridge.exposeInMainWorld('overlay', {
  onDrop: (handler: (drop: MemeDrop & { closable?: boolean }) => void) => {
    ipcRenderer.on('overlay:drop', (_event, drop: MemeDrop & { closable?: boolean }) => handler(drop));
  },
  setInteractive: (interactive: boolean) => ipcRenderer.send('overlay:interactive', interactive === true),
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
  openEditor: () => ipcRenderer.invoke('app:openEditor'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  applyUpdate: () => ipcRenderer.invoke('app:applyUpdate'),
  identifyDisplays: () => ipcRenderer.invoke('app:identifyDisplays'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onState: (handler: (state: unknown) => void) => {
    ipcRenderer.on('app:state', (_event, state) => handler(state));
  },
});

/** API de l'editeur. Les fichiers deposes sont resolus ici : le renderer ne voit pas les chemins. */
contextBridge.exposeInMainWorld('editor', {
  getState: () => ipcRenderer.invoke('editor:state'),
  open: () => ipcRenderer.invoke('editor:open'),
  openFile: (file: File) => ipcRenderer.invoke('editor:openPath', webUtils.getPathForFile(file)),
  chooseDir: () => ipcRenderer.invoke('editor:chooseDir'),
  save: (job: unknown) => ipcRenderer.invoke('editor:save', job),
  send: (job: unknown, options: unknown) => ipcRenderer.invoke('editor:send', job, options),
  reveal: () => ipcRenderer.invoke('editor:reveal'),
  onProgress: (handler: (fraction: number | null) => void) => {
    ipcRenderer.on('editor:progress', (_event, fraction: number | null) => handler(fraction));
  },
  onState: (handler: (state: unknown) => void) => {
    ipcRenderer.on('editor:state', (_event, state) => handler(state));
  },
});
