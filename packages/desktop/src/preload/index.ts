import { contextBridge, ipcRenderer } from 'electron';
import type { MemeDrop } from '@livememes/shared';

/** API exposee a l'overlay (lecture seule : il ne fait qu'afficher). */
contextBridge.exposeInMainWorld('overlay', {
  onDrop: (handler: (drop: MemeDrop) => void) => {
    ipcRenderer.on('overlay:drop', (_event, drop: MemeDrop) => handler(drop));
  },
  onClear: (handler: (dropId: string | null) => void) => {
    ipcRenderer.on('overlay:clear', (_event, dropId: string | null) => handler(dropId));
  },
});

/** API de la fenetre de reglages. */
contextBridge.exposeInMainWorld('livememes', {
  getState: () => ipcRenderer.invoke('app:state'),
  pair: (code: string, serverUrl: string) => ipcRenderer.invoke('app:pair', { code, serverUrl }),
  unlink: () => ipcRenderer.invoke('app:unlink'),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('app:setSettings', patch),
  preview: () => ipcRenderer.invoke('app:preview'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onState: (handler: (state: unknown) => void) => {
    ipcRenderer.on('app:state', (_event, state) => handler(state));
  },
});
