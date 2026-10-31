import path from 'node:path';
import crypto from 'node:crypto';
import crossSpawn from 'cross-spawn';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import type { AgentEvent, AgentEventMsg, ConfirmRequest, OverlayMsg, ProviderId, RunStateMsg, SecretName, Settings } from '../shared/types';
import { Desktop } from './desktop';
import { WinInput } from './input/win-input';
import { Runner } from './agents/runner';
import { getPublicSettings, getSettings, saveSettings, setSecret } from './settings';

// Notch arriba en el centro: pequeño en reposo, más ancho mientras un agente trabaja
// y desplegado hacia abajo al abrirlo.
const NOTCH_IDLE = { width: 248, height: 40 };
const NOTCH_BUSY = { width: 420, height: 40 };
const EXPANDED = { width: 500, height: 660 };

let widget: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let expanded = false;
let activeAgentId: string | null = null;
let registeredShortcut: string | null = null;

const input = new WinInput();
const pendingConfirms = new Map<string, (ok: boolean) => void>();

const asset = (...p: string[]) => path.join(__dirname, '..', '..', 'assets', ...p);
const renderer = (...p: string[]) => path.join(__dirname, '..', 'renderer', ...p);

function sendWidget(channel: string, payload: unknown) {
  if (widget && !widget.isDestroyed()) widget.webContents.send(channel, payload);
}

function sendOverlay(msg: OverlayMsg) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:msg', msg);
}

function widgetBounds(isExpanded: boolean) {
  const wa = screen.getPrimaryDisplay().workArea;
  const size = isExpanded ? EXPANDED : runner.busy ? NOTCH_BUSY : NOTCH_IDLE;
  return {
    x: Math.round(wa.x + (wa.width - size.width) / 2),
    y: wa.y,
    width: size.width,
    height: size.height,
  };
}

/**
 * Al abrir, la ventana crece primero y la vista anima el notch hacia abajo.
 * Al cerrar, la vista anima y después pide encoger la ventana ('widget:shrink').
 */
function setExpanded(v: boolean) {
  expanded = v;
  if (v) {
    widget?.setBounds(widgetBounds(true));
    widget?.focus();
  }
  sendWidget('widget:expanded', v);
}

function refreshNotchSize() {
  if (!expanded) widget?.setBounds(widgetBounds(false));
}

function applyLoginItem(s: Settings) {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.openAtLogin });
}

function applyCaptureProtection(s: Settings) {
  // En Windows 10 2004+ esto excluye la ventana de las capturas (WDA_EXCLUDEFROMCAPTURE),
  // así el agente no ve su propio cursor ni el teclado digital (que dejan pasar los clics).
  // El chat sí se ve a propósito: tapa una zona real de la pantalla y el agente debe esquivarla.
  overlay?.setContentProtection(s.hideFromCapture);
}

function createWidget() {
  widget = new BrowserWindow({
    ...widgetBounds(false),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: 'Clean Assistant',
    icon: asset('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'widget.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  widget.setAlwaysOnTop(true, 'floating');
  widget.loadFile(renderer('widget', 'index.html'));
  widget.once('ready-to-show', () => widget?.showInactive());
  // Como la Dynamic Island: si haces clic fuera, la vista decide si se recoge.
  widget.on('blur', () => {
    if (!runner.busy) sendWidget('widget:blur', null);
  });
  widget.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  widget.on('closed', () => (widget = null));
}

function createOverlay() {
  const b = screen.getPrimaryDisplay().bounds;
  overlay = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile(renderer('overlay', 'index.html'));
  overlay.on('closed', () => (overlay = null));
}

function createTray() {
  const img = nativeImage.createFromPath(asset('icon.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('Clean Assistant');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir', click: () => { widget?.show(); setExpanded(true); } },
      { label: 'Detener agente', click: () => runner.stop() },
      { type: 'separator' },
      { label: 'Salir', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => {
    widget?.show();
    setExpanded(!expanded);
  });
}

function registerStopShortcut() {
  const accel = getSettings().stopShortcut;
  try {
    if (globalShortcut.register(accel, () => runner.stop())) registeredShortcut = accel;
  } catch {
    registeredShortcut = null;
  }
}

function unregisterStopShortcut() {
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
  registeredShortcut = null;
}

function confirm(agentId: string, title: string, detail: string): Promise<boolean> {
  const id = crypto.randomUUID();
  if (!expanded) setExpanded(true);
  const req: ConfirmRequest = { id, agentId, title, detail };
  sendWidget('confirm:request', req);
  return new Promise((resolve) => pendingConfirms.set(id, resolve));
}

function rejectPendingConfirms() {
  for (const [id, resolve] of pendingConfirms) {
    resolve(false);
    sendWidget('confirm:cancel', id);
  }
  pendingConfirms.clear();
}

const desktop = new Desktop({
  input,
  settings: getSettings,
  overlay: sendOverlay,
  confirm: (title, detail) => confirm(activeAgentId ?? '', title, detail),
  onAction: (label, icon) => {
    if (activeAgentId) sendWidget('agent:event', { agentId: activeAgentId, taskId: '', event: { type: 'action', label, icon } } satisfies AgentEventMsg);
  },
});

const runner = new Runner({
  desktop,
  emit: (agentId: string, taskId: string, event: AgentEvent) => sendWidget('agent:event', { agentId, taskId, event } satisfies AgentEventMsg),
  state: (s: RunStateMsg) => {
    if (s.status === 'stopping') rejectPendingConfirms();
    sendWidget('run:state', s);
    refreshNotchSize();
  },
  confirm,
  onRunChange: (running, agentId) => {
    activeAgentId = agentId;
    if (running) {
      const s = getSettings();
      const agent = s.agents.find((a) => a.id === agentId);
      if (agent) sendOverlay({ type: 'agent', agent: { name: agent.name, color: agent.color, mascot: agent.mascot, avatarDataUrl: agent.avatarDataUrl } });
      overlay?.showInactive();
      overlay?.setAlwaysOnTop(true, 'screen-saver');
      registerStopShortcut();
      // El chat no debe quedarse con el foco del teclado mientras el agente escribe en otras apps.
      widget?.setFocusable(false);
      widget?.blur();
    } else {
      rejectPendingConfirms();
      unregisterStopShortcut();
      widget?.setFocusable(true);
      sendOverlay({ type: 'hide' });
      setTimeout(() => {
        if (!runner.busy) overlay?.hide();
      }, 900);
    }
  },
});

function checkCli(provider: ProviderId): Promise<{ ok: boolean; message: string }> {
  const s = getSettings();
  const cmd = provider === 'codex' ? s.codexCliPath || 'codex' : s.claudeCliPath || 'claude';
  return new Promise((resolve) => {
    let out = '';
    const child = crossSpawn(cmd, ['--version'], { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, message: 'No respondió a tiempo.' });
    }, 15000);
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (out += String(d)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, message: `No encuentro "${cmd}".` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, message: out.trim().split('\n')[0] || 'Instalado' } : { ok: false, message: out.trim().slice(0, 300) || `Código ${code}` });
    });
  });
}

function registerIpc() {
  ipcMain.handle('settings:get', () => getPublicSettings());
  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => {
    const s = saveSettings(patch);
    applyCaptureProtection(s);
    applyLoginItem(s);
    return getPublicSettings();
  });
  ipcMain.handle('secret:set', (_e, name: SecretName, value: string) => {
    if (name !== 'anthropic' && name !== 'openai') throw new Error('Clave desconocida');
    setSecret(name, String(value ?? ''));
    return getPublicSettings();
  });
  ipcMain.handle('task:run', (_e, agentId: string, text: string) => {
    const task = String(text ?? '').trim();
    if (!task) return;
    if (runner.busy) throw new Error('Ya hay un agente trabajando.');
    void runner.run(agentId, task);
  });
  ipcMain.handle('task:stop', () => runner.stop());
  ipcMain.handle('history:clear', (_e, agentId: string) => runner.clearHistory(agentId));
  ipcMain.handle('widget:expand', (_e, v: boolean) => setExpanded(!!v));
  ipcMain.handle('widget:shrink', () => refreshNotchSize());
  ipcMain.handle('confirm:respond', (_e, id: string, ok: boolean) => {
    const resolve = pendingConfirms.get(id);
    pendingConfirms.delete(id);
    resolve?.(!!ok);
  });
  ipcMain.handle('cli:check', (_e, provider: ProviderId) => checkCli(provider));
  ipcMain.handle('app:quit', () => app.quit());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    widget?.show();
    setExpanded(true);
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.cleanassistant.app');
    registerIpc();
    createWidget();
    createOverlay();
    createTray();
    applyCaptureProtection(getSettings());
    applyLoginItem(getSettings());
    input.warmUp();
    screen.on('display-metrics-changed', () => {
      widget?.setBounds(widgetBounds(expanded));
      const b = screen.getPrimaryDisplay().bounds;
      overlay?.setBounds(b);
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    runner.stop();
    globalShortcut.unregisterAll();
    input.dispose();
  });
}
