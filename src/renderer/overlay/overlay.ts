import type { OverlayApi } from '../../preload/overlay';
import type { OverlayAgentInfo, OverlayMsg } from '../../shared/types';
import { avatarHtml } from '../common/mascots';

declare global {
  interface Window { overlayApi: OverlayApi }
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const cursor = $('#cursor');
const statusEl = $('.status');
const ripples = $('#ripples');
const kbWrap = $('#keyboard-wrap');
const typedBox = $('#typed');
const typedText = $('.typed-text');
const keyboard = $('#keyboard');

let pos = { x: window.innerWidth * 0.6, y: window.innerHeight * 0.55 };
let statusTimer: number | undefined;
let kbTimer: number | undefined;
let typingToken = 0;

// ---- Color del agente ----

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hexToRgba(hex: string, a: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xe8773d;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function setAgent(agent: OverlayAgentInfo | null) {
  if (!agent) return;
  const root = document.documentElement.style;
  const light = luminance(agent.color) > 0.6;
  root.setProperty('--agent', agent.color);
  // Un agente blanco brillante necesita contorno oscuro para verse sobre fondos claros.
  root.setProperty('--agent-glow', light ? 'rgba(255,255,255,.85)' : hexToRgba(agent.color, 0.55));
  root.setProperty('--outline', light ? '#1d1a1f' : '#ffffff');
  root.setProperty('--tag-fg', light ? '#1d1a1f' : '#ffffff');
  $('.tag-name').textContent = agent.name;
  $('.tag-avatar').innerHTML = avatarHtml({ ...agent, name: agent.name });
  document.body.classList.add('active');
  cursor.classList.remove('hidden');
  place(pos.x, pos.y, 0);
}

// ---- Cursor ----

function place(x: number, y: number, ms: number) {
  pos = { x, y };
  cursor.style.transitionDuration = `${Math.max(0, ms)}ms, .3s`;
  cursor.style.transform = `translate(${x}px, ${y}px)`;
}

function showStatus(text: string) {
  statusEl.textContent = text;
  statusEl.classList.add('show');
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => statusEl.classList.remove('show'), 2600);
}

function ripple(button: string, count: number) {
  cursor.classList.add('pressed');
  window.setTimeout(() => cursor.classList.remove('pressed'), 140);
  for (let i = 0; i < count; i++) {
    window.setTimeout(() => {
      const r = document.createElement('div');
      r.className = `ripple ${button === 'right' ? 'right' : ''}`;
      r.style.left = `${pos.x}px`;
      r.style.top = `${pos.y}px`;
      ripples.appendChild(r);
      window.setTimeout(() => r.remove(), 600);
    }, i * 120);
  }
}

function scrollHint(direction: string) {
  const el = document.createElement('div');
  el.className = 'scroll-hint';
  el.textContent = ({ up: '⇡', down: '⇣', left: '⇠', right: '⇢' } as Record<string, string>)[direction] ?? '⇣';
  el.style.left = `${pos.x + 14}px`;
  el.style.top = `${pos.y - 8}px`;
  el.style.setProperty('--dy', direction === 'up' ? '-18px' : '18px');
  ripples.appendChild(el);
  window.setTimeout(() => el.remove(), 750);
}

// ---- Teclado digital ----

const ROWS: { label: string; id: string; cls?: string }[][] = [
  ['Esc', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '⌫'].map((l) => ({ label: l, id: l === 'Esc' ? 'escape' : l === '⌫' ? 'backspace' : l, cls: l === '⌫' ? 'w15' : undefined })),
  [{ label: 'Tab', id: 'tab', cls: 'w15' }, ...'QWERTYUIOP'.split('').map((l) => ({ label: l, id: l.toLowerCase() }))],
  [{ label: 'Bloq', id: 'capslock', cls: 'w15' }, ...'ASDFGHJKLÑ'.split('').map((l) => ({ label: l, id: l.toLowerCase() })), { label: '↵', id: 'enter', cls: 'w15' }],
  [{ label: '⇧', id: 'shift', cls: 'w2' }, ...'ZXCVBNM'.split('').map((l) => ({ label: l, id: l.toLowerCase() })), { label: ',', id: ',' }, { label: '.', id: '.' }, { label: '-', id: '-' }],
  [
    { label: 'Ctrl', id: 'ctrl', cls: 'w15' }, { label: '⊞', id: 'win' }, { label: 'Alt', id: 'alt' },
    { label: '', id: 'space', cls: 'space' }, { label: 'AltGr', id: 'altgr', cls: 'w15' },
    { label: '←', id: 'left' }, { label: '↑', id: 'up' }, { label: '↓', id: 'down' }, { label: '→', id: 'right' },
  ],
];

const keyEls = new Map<string, HTMLElement>();
for (const row of ROWS) {
  const r = document.createElement('div');
  r.className = 'kb-row';
  for (const k of row) {
    const el = document.createElement('div');
    el.className = `key ${k.cls ?? ''}`;
    el.textContent = k.label;
    r.appendChild(el);
    keyEls.set(k.id, el);
  }
  keyboard.appendChild(r);
}

const ALIASES: Record<string, string> = {
  return: 'enter', esc: 'escape', control: 'ctrl', super: 'win', meta: 'win', cmd: 'win', windows: 'win',
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down', ' ': 'space', back: 'backspace',
  delete: 'backspace', option: 'alt', caps_lock: 'capslock',
};

function keyId(name: string): string {
  const k = name.toLowerCase();
  return ALIASES[k] ?? k;
}

function flash(ids: string[], ms = 160) {
  const els = ids.map((i) => keyEls.get(keyId(i))).filter((e): e is HTMLElement => !!e);
  els.forEach((e) => e.classList.add('on'));
  window.setTimeout(() => els.forEach((e) => e.classList.remove('on')), ms);
}

function showKeyboard(visible: boolean) {
  kbWrap.classList.toggle('hidden', !visible);
}

function keepKeyboard(ms: number) {
  window.clearTimeout(kbTimer);
  kbTimer = window.setTimeout(() => {
    showKeyboard(false);
    typedText.textContent = '';
    typedBox.classList.add('empty');
  }, ms);
}

async function typeOut(text: string, delayMs: number) {
  const token = ++typingToken;
  typedBox.classList.remove('empty');
  typedText.textContent = '';
  const step = Math.max(8, delayMs);
  for (const ch of text) {
    if (token !== typingToken) return;
    typedText.textContent += ch;
    typedBox.scrollTop = typedBox.scrollHeight;
    if (ch === '\n') flash(['enter']);
    else if (ch === ' ') flash(['space']);
    else {
      const lower = ch.toLowerCase();
      flash(ch !== lower ? ['shift', lower] : [lower], Math.max(90, step * 2));
    }
    await new Promise((r) => setTimeout(r, step));
  }
  keepKeyboard(2200);
}

// ---- Mensajes ----

window.overlayApi.onMessage((m: OverlayMsg) => {
  switch (m.type) {
    case 'agent': setAgent(m.agent); break;
    case 'move': place(m.x, m.y, m.durationMs); break;
    case 'click': ripple(m.button, m.count); break;
    case 'drag': cursor.classList.toggle('dragging', m.active); break;
    case 'scroll': scrollHint(m.direction); break;
    case 'status': showStatus(m.text); break;
    case 'keyboard':
      showKeyboard(m.visible);
      if (m.visible) keepKeyboard(4000);
      break;
    case 'type': void typeOut(m.text, m.delayMs); break;
    case 'keys': {
      typedBox.classList.remove('empty');
      typingToken++;
      typedText.textContent = m.keys.join(' + ');
      flash(m.keys, 380);
      keepKeyboard(2000);
      break;
    }
    case 'hide':
      document.body.classList.remove('active');
      cursor.classList.add('hidden');
      showKeyboard(false);
      statusEl.classList.remove('show');
      break;
  }
});
