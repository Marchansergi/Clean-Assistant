import type { OverlayMsg, Settings } from '../shared/types';
import { describeDisplays, geometry, modelToPhys, physToDip, physToModel, screenshot, zoom, type Geometry, type Shot } from './screen-capture';
import { splitCombo, type MouseButton, type WinInput } from './input/win-input';

/** Acción normalizada: todos los proveedores traducen sus llamadas a esto. Coordenadas en espacio de modelo. */
export type Action =
  | { kind: 'screenshot' }
  | { kind: 'zoom'; region: [number, number, number, number] }
  | { kind: 'click'; x?: number; y?: number; button: MouseButton; count: number; modifiers: string[] }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'drag'; path: { x: number; y: number }[]; modifiers: string[] }
  | { kind: 'mouse_down' }
  | { kind: 'mouse_up' }
  | { kind: 'cursor_position' }
  | { kind: 'scroll'; x?: number; y?: number; direction: 'up' | 'down' | 'left' | 'right'; amount: number; modifiers: string[] }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: string[]; repeat: number }
  | { kind: 'hold_key'; keys: string[]; seconds: number }
  | { kind: 'wait'; seconds: number }
  /** Cambia la pantalla en la que trabaja el agente (1 = principal). */
  | { kind: 'switch_screen'; screen: number };

export interface ActionResult {
  text?: string;
  image?: Shot;
}

export class StopError extends Error {
  constructor() {
    super('Detenido por el usuario.');
  }
}

export class DeniedError extends Error {
  constructor() {
    super('El usuario no ha permitido esta acción.');
  }
}

export interface DesktopDeps {
  input: WinInput;
  settings: () => Settings;
  /** Mensaje para la capa del cursor de una pantalla (sin pantalla = todas). */
  overlay: (msg: OverlayMsg, displayId?: number) => void;
  /** El agente ha pasado de una pantalla a otra. */
  onScreenChange: (fromDisplayId: number, toDisplayId: number) => void;
  /** Pide permiso al usuario; resuelve true si acepta. */
  confirm: (title: string, detail: string) => Promise<boolean>;
  onAction: (label: string, icon: string) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new StopError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new StopError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function describe(a: Action): { label: string; icon: string } {
  switch (a.kind) {
    case 'screenshot': return { label: 'Mirando la pantalla', icon: '👀' };
    case 'zoom': return { label: 'Acercándose para ver mejor', icon: '🔍' };
    case 'click': {
      const what = a.count === 2 ? 'Doble clic' : a.count === 3 ? 'Triple clic' : a.button === 'right' ? 'Clic derecho' : a.button === 'middle' ? 'Clic central' : 'Clic';
      const where = a.x !== undefined && a.y !== undefined ? ` en (${Math.round(a.x)}, ${Math.round(a.y)})` : '';
      const mods = a.modifiers.length ? ` con ${a.modifiers.join('+')}` : '';
      return { label: `${what}${where}${mods}`, icon: '🖱️' };
    }
    case 'move': return { label: `Moviendo el ratón a (${Math.round(a.x)}, ${Math.round(a.y)})`, icon: '➡️' };
    case 'drag': return { label: 'Arrastrando', icon: '✊' };
    case 'mouse_down': return { label: 'Pulsando el botón del ratón', icon: '🖱️' };
    case 'mouse_up': return { label: 'Soltando el botón del ratón', icon: '🖱️' };
    case 'cursor_position': return { label: 'Comprobando dónde está el ratón', icon: '📍' };
    case 'scroll': return { label: `Desplazando ${({ up: 'arriba', down: 'abajo', left: 'a la izquierda', right: 'a la derecha' })[a.direction]}`, icon: '🌀' };
    case 'type': return { label: `Escribiendo «${a.text.length > 60 ? a.text.slice(0, 57) + '…' : a.text}»`, icon: '⌨️' };
    case 'key': return { label: `Pulsando ${a.keys.join('+')}${a.repeat > 1 ? ` ×${a.repeat}` : ''}`, icon: '⌨️' };
    case 'hold_key': return { label: `Manteniendo ${a.keys.join('+')} ${a.seconds}s`, icon: '⌨️' };
    case 'wait': return { label: `Esperando ${a.seconds}s`, icon: '⏳' };
    case 'switch_screen': return { label: `Cambiando a la pantalla ${a.screen}`, icon: '🖥️' };
  }
}

function needsConfirm(a: Action, mode: Settings['confirmMode']): boolean {
  if (mode === 'never') return false;
  const passive = a.kind === 'screenshot' || a.kind === 'zoom' || a.kind === 'wait' || a.kind === 'cursor_position' || a.kind === 'switch_screen';
  if (mode === 'always') return !passive;
  // 'keyboard': todo lo que escribe o pulsa teclas (enviar formularios, mensajes, atajos).
  return a.kind === 'type' || a.kind === 'key' || a.kind === 'hold_key';
}

/** Ejecuta acciones en el escritorio real con animación del cursor del agente. */
export class Desktop {
  private signal: AbortSignal | undefined;
  private dipCursor: { x: number; y: number } | null = null;
  /** Pantalla en la que trabaja el agente ahora mismo (0 = principal). */
  private screenIndex = 0;

  constructor(private deps: DesktopDeps) {}

  /** Cada tarea empieza en la pantalla principal. */
  bind(signal: AbortSignal) {
    this.signal = signal;
    this.screenIndex = 0;
    this.dipCursor = null;
  }

  geometry(): Geometry {
    const s = this.deps.settings();
    return geometry(s.captureMaxEdge, s.multiScreen ? this.screenIndex : 0);
  }

  /** Pantallas que puede usar el agente, descritas para su prompt. */
  screens(): string[] {
    const all = describeDisplays();
    return this.deps.settings().multiScreen ? all : all.slice(0, 1);
  }

  get activeDisplayId(): number {
    return this.geometry().displayId;
  }

  private ov(msg: OverlayMsg) {
    this.deps.overlay(msg, this.activeDisplayId);
  }

  private check() {
    if (this.signal?.aborted) throw new StopError();
  }

  private async animateTo(g: Geometry, phys: { x: number; y: number }) {
    const dip = physToDip(g, phys.x, phys.y);
    const ms = this.deps.settings().cursorAnimMs;
    const dist = this.dipCursor ? Math.hypot(dip.x - this.dipCursor.x, dip.y - this.dipCursor.y) : 400;
    const duration = Math.round(Math.min(ms, Math.max(ms * 0.35, dist * 0.6)));
    this.ov({ type: 'move', x: dip.x, y: dip.y, durationMs: duration });
    this.dipCursor = dip;
    await sleep(duration, this.signal);
  }

  async settle() {
    await sleep(this.deps.settings().settleMs, this.signal);
  }

  async screenshot(): Promise<Shot> {
    this.check();
    return screenshot(this.geometry());
  }

  async perform(a: Action): Promise<ActionResult> {
    this.check();
    const s = this.deps.settings();
    const d = describe(a);
    if (needsConfirm(a, s.confirmMode)) {
      const ok = await this.deps.confirm(d.label, a.kind === 'type' ? a.text : '');
      this.check();
      if (!ok) throw new DeniedError();
    }
    this.deps.onAction(d.label, d.icon);
    this.ov({ type: 'status', text: d.label });

    const g = this.geometry();
    const input = this.deps.input;

    switch (a.kind) {
      case 'screenshot':
        return { image: await screenshot(g) };

      case 'zoom':
        return { image: await zoom(g, a.region) };

      case 'cursor_position': {
        const p = await input.cursorPos();
        const m = physToModel(g, p.x, p.y);
        return { text: `X=${m.x}, Y=${m.y}` };
      }

      case 'wait':
        await sleep(Math.min(300, Math.max(0, a.seconds)) * 1000, this.signal);
        return { text: 'OK' };

      case 'move': {
        const p = modelToPhys(g, a.x, a.y);
        await this.animateTo(g, p);
        await input.move(p.x, p.y);
        return { text: 'OK' };
      }

      case 'click': {
        const restore = s.returnCursor ? await input.cursorPos() : null;
        if (a.x !== undefined && a.y !== undefined) {
          const p = modelToPhys(g, a.x, a.y);
          await this.animateTo(g, p);
          this.check();
          await input.move(p.x, p.y);
        }
        await input.keysDown(a.modifiers);
        try {
          this.ov({ type: 'click', button: a.button, count: a.count });
          await input.click(a.button, a.count);
        } finally {
          await input.keysUp(a.modifiers);
        }
        if (restore) await input.move(restore.x, restore.y);
        await this.settle();
        return { text: 'OK' };
      }

      case 'drag': {
        if (a.path.length < 2) throw new Error('El arrastre necesita al menos dos puntos.');
        const pts = a.path.map((p) => modelToPhys(g, p.x, p.y));
        await this.animateTo(g, pts[0]);
        await input.move(pts[0].x, pts[0].y);
        await input.keysDown(a.modifiers);
        await input.down('left');
        this.ov({ type: 'drag', active: true });
        try {
          for (let i = 1; i < pts.length; i++) {
            const from = pts[i - 1];
            const to = pts[i];
            const steps = Math.max(4, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / 40));
            for (let k = 1; k <= steps; k++) {
              const x = from.x + ((to.x - from.x) * k) / steps;
              const y = from.y + ((to.y - from.y) * k) / steps;
              const dip = physToDip(g, x, y);
              this.ov({ type: 'move', x: dip.x, y: dip.y, durationMs: 16 });
              this.dipCursor = dip;
              await input.move(x, y);
              await sleep(16);
            }
          }
        } finally {
          await input.up('left');
          await input.keysUp(a.modifiers);
          this.ov({ type: 'drag', active: false });
        }
        await this.settle();
        return { text: 'OK' };
      }

      case 'mouse_down':
        await input.down('left');
        this.ov({ type: 'drag', active: true });
        return { text: 'OK' };

      case 'mouse_up':
        await input.up('left');
        this.ov({ type: 'drag', active: false });
        await this.settle();
        return { text: 'OK' };

      case 'scroll': {
        const restore = s.returnCursor ? await input.cursorPos() : null;
        if (a.x !== undefined && a.y !== undefined) {
          const p = modelToPhys(g, a.x, a.y);
          await this.animateTo(g, p);
          await input.move(p.x, p.y);
        }
        const amount = Math.max(1, Math.min(50, Math.round(a.amount)));
        const horizontal = a.direction === 'left' || a.direction === 'right';
        const sign = a.direction === 'up' || a.direction === 'right' ? 1 : -1;
        this.ov({ type: 'scroll', direction: a.direction });
        await input.keysDown(a.modifiers);
        try {
          await input.wheel(sign * amount, horizontal);
        } finally {
          await input.keysUp(a.modifiers);
        }
        if (restore) await input.move(restore.x, restore.y);
        await this.settle();
        return { text: 'OK' };
      }

      case 'type': {
        if (s.showKeyboard) this.ov({ type: 'keyboard', visible: true });
        this.ov({ type: 'type', text: a.text, delayMs: s.typingDelayMs });
        await input.type(a.text, s.typingDelayMs);
        await this.settle();
        return { text: 'OK' };
      }

      case 'key': {
        if (s.showKeyboard) this.ov({ type: 'keyboard', visible: true });
        this.ov({ type: 'keys', keys: a.keys });
        await input.combo(a.keys, a.repeat);
        await this.settle();
        return { text: 'OK' };
      }

      case 'switch_screen': {
        const total = this.screens().length;
        if (!Number.isInteger(a.screen) || a.screen < 1 || a.screen > total) {
          throw new Error(total > 1 ? `Esa pantalla no existe: hay ${total} (de la 1 a la ${total}).` : 'Solo hay una pantalla disponible.');
        }
        const from = g.displayId;
        this.screenIndex = a.screen - 1;
        const next = this.geometry();
        this.dipCursor = null;
        if (next.displayId !== from) this.deps.onScreenChange(from, next.displayId);
        return {
          text: `Ahora estás en la pantalla ${a.screen} (${next.physW}×${next.physH}). Las coordenadas son las de esta captura.`,
          image: await screenshot(next),
        };
      }

      case 'hold_key': {
        if (s.showKeyboard) this.ov({ type: 'keyboard', visible: true });
        this.ov({ type: 'keys', keys: a.keys });
        await input.keysDown(a.keys);
        try {
          await sleep(Math.min(300, Math.max(0, a.seconds)) * 1000, this.signal);
        } finally {
          await input.keysUp(a.keys);
        }
        return { text: 'OK' };
      }
    }
  }

  /** Suelta teclas y botones por si una parada pilló algo pulsado. */
  async releaseAll() {
    await this.deps.input.releaseAll();
  }
}

/** "ctrl+shift" -> ["ctrl","shift"]; acepta cadena vacía/undefined. */
export function parseModifiers(text: unknown): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  return splitCombo(text);
}
