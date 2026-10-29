import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { OverlayMsg } from '../shared/types';

const api = {
  onMessage: (cb: (m: OverlayMsg) => void) => {
    ipcRenderer.on('overlay:msg', (_e: IpcRendererEvent, m: OverlayMsg) => cb(m));
  },
};

export type OverlayApi = typeof api;
contextBridge.exposeInMainWorld('overlayApi', api);
