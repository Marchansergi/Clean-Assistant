import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AgentEventMsg, ConfirmRequest, ProviderId, PublicSettings, RunStateMsg, SecretName, Settings } from '../shared/types';

function on<T>(channel: string, cb: (payload: T) => void) {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  getSettings: (): Promise<PublicSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: Partial<Settings>): Promise<PublicSettings> => ipcRenderer.invoke('settings:save', patch),
  setSecret: (name: SecretName, value: string): Promise<PublicSettings> => ipcRenderer.invoke('secret:set', name, value),
  runTask: (agentId: string, text: string): Promise<void> => ipcRenderer.invoke('task:run', agentId, text),
  stopTask: (): Promise<void> => ipcRenderer.invoke('task:stop'),
  clearHistory: (agentId: string): Promise<void> => ipcRenderer.invoke('history:clear', agentId),
  setExpanded: (v: boolean): Promise<void> => ipcRenderer.invoke('widget:expand', v),
  shrink: (): Promise<void> => ipcRenderer.invoke('widget:shrink'),
  respondConfirm: (id: string, ok: boolean): Promise<void> => ipcRenderer.invoke('confirm:respond', id, ok),
  checkCli: (p: ProviderId): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('cli:check', p),
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  listScreens: (): Promise<string[]> => ipcRenderer.invoke('screens:list'),
  onRunState: (cb: (s: RunStateMsg) => void) => on('run:state', cb),
  onAgentEvent: (cb: (m: AgentEventMsg) => void) => on('agent:event', cb),
  onConfirm: (cb: (r: ConfirmRequest) => void) => on('confirm:request', cb),
  onConfirmCancel: (cb: (id: string) => void) => on('confirm:cancel', cb),
  onExpanded: (cb: (v: boolean) => void) => on('widget:expanded', cb),
  onBlur: (cb: () => void) => on('widget:blur', cb),
};

export type WidgetApi = typeof api;
contextBridge.exposeInMainWorld('api', api);
