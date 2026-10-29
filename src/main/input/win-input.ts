import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { INPUT_HELPER_PS1 } from './input-helper.ps1';

export type MouseButton = 'left' | 'right' | 'middle';

const VK: Record<string, number> = {
  backspace: 0x08, back: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, kp_enter: 0x0d,
  shift: 0x10, lshift: 0xa0, rshift: 0xa1, shift_l: 0xa0, shift_r: 0xa1,
  ctrl: 0x11, control: 0x11, lctrl: 0xa2, rctrl: 0xa3, control_l: 0xa2, control_r: 0xa3,
  alt: 0x12, option: 0x12, lalt: 0xa4, ralt: 0xa5, alt_l: 0xa4, alt_r: 0xa5, altgr: 0xa5,
  pause: 0x13, capslock: 0x14, caps_lock: 0x14, escape: 0x1b, esc: 0x1b, space: 0x20,
  pageup: 0x21, page_up: 0x21, prior: 0x21, pagedown: 0x22, page_down: 0x22, next: 0x22,
  end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  arrowleft: 0x25, arrowup: 0x26, arrowright: 0x27, arrowdown: 0x28,
  printscreen: 0x2c, print: 0x2c, insert: 0x2d, delete: 0x2e, del: 0x2e,
  super: 0x5b, win: 0x5b, windows: 0x5b, meta: 0x5b, cmd: 0x5b, command: 0x5b, super_l: 0x5b, super_r: 0x5c,
  menu: 0x5d, apps: 0x5d, contextmenu: 0x5d,
  numlock: 0x90, scrolllock: 0x91,
  volumemute: 0xad, audiovolumemute: 0xad, xf86audiomute: 0xad,
  volumedown: 0xae, audiovolumedown: 0xae, xf86audiolowervolume: 0xae,
  volumeup: 0xaf, audiovolumeup: 0xaf, xf86audioraisevolume: 0xaf,
  medianext: 0xb0, mediatracknext: 0xb0, xf86audionext: 0xb0,
  mediaprev: 0xb1, mediaprevious: 0xb1, mediatrackprevious: 0xb1, xf86audioprev: 0xb1,
  mediastop: 0xb2, xf86audiostop: 0xb2,
  mediaplaypause: 0xb3, playpause: 0xb3, xf86audioplay: 0xb3,
  plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe,
};

/** Convierte un nombre de tecla ("ctrl", "Return", "a", "F5", "ARROWDOWN") al token que entiende el helper. */
export function keyToken(name: string): string {
  const raw = name.trim();
  const k = raw.toLowerCase().replace(/[\s-]/g, '');
  if (k in VK) return String(VK[k]);
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(k);
  if (f) return String(0x6f + Number(f[1]));
  if (/^[a-z]$/.test(k)) return String(k.toUpperCase().charCodeAt(0));
  if (/^[0-9]$/.test(k)) return String(k.charCodeAt(0));
  if (raw.length === 1) return `c:${raw}`;
  throw new Error(`Tecla desconocida: "${name}"`);
}

/** Separa "ctrl+shift+t" (y variantes con espacios) en teclas; "+" sola es la tecla más. */
export function splitCombo(combo: string): string[] {
  const c = combo.trim();
  if (c === '+') return ['+'];
  return c.split('+').map((s) => s.trim()).filter(Boolean);
}

/**
 * Control real de ratón y teclado en Windows mediante un proceso PowerShell persistente
 * que llama a SendInput. Coordenadas en píxeles físicos de la pantalla.
 */
export class WinInput {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buffer = '';

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    if (process.platform !== 'win32') {
      this.ready = Promise.reject(new Error('El control de ratón y teclado solo está implementado para Windows.'));
      return this.ready;
    }
    const script = path.join(app.getPath('userData'), 'input-helper.ps1');
    fs.writeFileSync(script, INPUT_HELPER_PS1, 'utf8');
    this.ready = new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true },
      );
      this.proc = proc;
      let started = false;
      const timer = setTimeout(() => {
        if (!started) reject(new Error('El helper de entrada no arrancó a tiempo.'));
      }, 20000);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          if (!started && line === 'ready') {
            started = true;
            clearTimeout(timer);
            resolve();
            continue;
          }
          this.onLine(line);
        }
      });
      let stderr = '';
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d: string) => (stderr += d));
      proc.on('exit', (code) => {
        clearTimeout(timer);
        const err = new Error(`El helper de entrada terminó (código ${code}). ${stderr.slice(0, 500)}`);
        if (!started) reject(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.proc = null;
        this.ready = null;
      });
    });
    return this.ready;
  }

  private onLine(line: string) {
    const [idStr, status, ...rest] = line.split('|');
    const p = this.pending.get(Number(idStr));
    if (!p) return;
    this.pending.delete(Number(idStr));
    if (status === 'ok') p.resolve(rest.join('|'));
    else p.reject(new Error(rest.join('|') || 'Error del helper de entrada'));
  }

  private async cmd(...parts: (string | number)[]): Promise<string> {
    await this.start();
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(`${id}|${parts.join('|')}\n`);
    });
  }

  warmUp(): void {
    this.start().catch(() => undefined);
  }

  async cursorPos(): Promise<{ x: number; y: number }> {
    const [x, y] = (await this.cmd('pos')).split(',').map(Number);
    return { x, y };
  }

  async move(x: number, y: number) {
    await this.cmd('move', Math.round(x), Math.round(y));
  }

  async click(button: MouseButton, count: number) {
    await this.cmd('click', button, count);
  }

  async down(button: MouseButton) {
    await this.cmd('down', button);
  }

  async up(button: MouseButton) {
    await this.cmd('up', button);
  }

  /** clicks > 0 = arriba/derecha. */
  async wheel(clicks: number, horizontal: boolean) {
    if (clicks === 0) return;
    await this.cmd('wheel', Math.round(clicks), horizontal ? 'h' : 'v');
  }

  async keysDown(keys: string[]) {
    if (keys.length) await this.cmd('keydown', keys.map(keyToken).join(','));
  }

  async keysUp(keys: string[]) {
    if (keys.length) await this.cmd('keyup', keys.map(keyToken).join(','));
  }

  async combo(keys: string[], repeat = 1) {
    await this.cmd('combo', keys.map(keyToken).join(','), Math.max(1, Math.min(100, repeat)));
  }

  async type(text: string, delayMs: number) {
    await this.cmd('type', Buffer.from(text, 'utf8').toString('base64'), Math.max(0, Math.round(delayMs)));
  }

  async releaseAll() {
    if (!this.proc) return;
    await this.cmd('releaseall').catch(() => undefined);
  }

  dispose() {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}
