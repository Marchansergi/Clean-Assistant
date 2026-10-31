import type { WidgetApi } from '../../preload/widget';
import { CLAUDE_MODELS, DEFAULT_MODELS, OPENAI_MODEL_SUGGESTIONS, PROVIDER_LABELS, isClaudeProvider, modelLabel } from '../../shared/defaults';
import type { AgentEvent, AgentProfile, ConfirmRequest, ProviderId, PublicSettings, RunStateMsg, Settings } from '../../shared/types';
import { avatarHtml } from '../common/mascots';

declare global {
  interface Window { api: WidgetApi }
}
const api = window.api;

// ---------- utilidades DOM ----------

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Quita el prefijo "Error invoking remote method 'x': Error: " que añade Electron. */
function errText(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function avatar(agent: AgentProfile, cls: string): HTMLElement {
  return h('div', { class: cls, html: avatarHtml(agent) });
}

// ---------- estado ----------

type ChatItem =
  | { kind: 'agent'; text: string; done?: boolean; el?: HTMLElement }
  | { kind: 'user' | 'info' | 'error'; text: string; el?: HTMLElement }
  | { kind: 'thinking'; text: string; live: boolean; el?: HTMLElement }
  | { kind: 'action'; text: string; icon: string; el?: HTMLElement };

let settings: PublicSettings;
let run: RunStateMsg = { status: 'idle', agentId: null, step: 0 };
let view: 'chat' | 'agents' | 'settings' = 'chat';
let pendingConfirm: ConfirmRequest | null = null;
let editingAgentId: string | null = null;
let lastAction = '';
let doneFlash = '';
let doneTimer: number | undefined;
let isOpen = false;
let shrinkTimer: number | undefined;
const chats = new Map<string, ChatItem[]>();

const activeAgent = () => settings.agents.find((a) => a.id === settings.activeAgentId) ?? settings.agents[0];
const agentById = (id: string | null) => settings.agents.find((a) => a.id === id);
const chatFor = (id: string) => {
  if (!chats.has(id)) chats.set(id, []);
  return chats.get(id)!;
};

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

function applyTheme() {
  // Siempre negro; el acento es el color del agente que trabaja (o del activo).
  const a = agentById(run.agentId) ?? activeAgent();
  const root = document.documentElement;
  const accent = luminance(a.color) > 0.85 ? '#f4fbff' : a.color;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-fg', luminance(accent) > 0.6 ? '#1d1a1f' : '#ffffff');
  root.style.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 18%, transparent)`);
}

// ---------- cabecera y selector ----------

function renderHeader() {
  const a = activeAgent();
  $('heroAvatar').innerHTML = avatarHtml(a);
  $('heroName').textContent = a.name;
  const label = $('heroStatus').querySelector('.label')!;
  const runningAgent = agentById(run.agentId);
  if (run.status === 'running') {
    label.textContent = runningAgent && runningAgent.id !== a.id
      ? `${runningAgent.name} está usando tu ordenador`
      : `Usando tu ordenador${run.step ? ` · paso ${run.step}` : ''}`;
  } else if (run.status === 'stopping') {
    label.textContent = 'Deteniendo…';
  } else {
    label.textContent = `Lista · ${PROVIDER_LABELS[a.provider]}`;
  }
  const busy = run.status !== 'idle';
  document.body.classList.toggle('running', busy);
  // El notch recogido muestra al agente que trabaja y lo que está haciendo ahora mismo.
  const barAgent = runningAgent ?? a;
  $('barAvatar').innerHTML = avatarHtml(barAgent);
  $('barName').textContent = barAgent.name;
  $('barStatus').textContent = run.status === 'stopping'
    ? 'Deteniendo…'
    : busy ? (lastAction || 'Pensando…') : doneFlash || modelLabel(a.model || DEFAULT_MODELS[a.provider]);
  document.documentElement.style.setProperty('--collapsed-w', busy ? '420px' : '248px');
  renderModelSelect();
}

/** Selector rápido de modelo en la cabecera. */
function renderModelSelect() {
  const a = activeAgent();
  const sel = $('modelSelect') as HTMLSelectElement;
  const current = a.model;
  const options: { value: string; label: string }[] = isClaudeProvider(a.provider)
    ? CLAUDE_MODELS.map((m) => ({ value: m.id, label: m.label }))
    : OPENAI_MODEL_SUGGESTIONS.map((m) => ({ value: m, label: m }));
  if (a.provider === 'claude-code' || a.provider === 'codex') options.unshift({ value: '', label: 'Por defecto' });
  if (!options.some((o) => o.value === current)) options.push({ value: current, label: modelLabel(current) });
  sel.replaceChildren(...options.map((o) => h('option', { value: o.value, selected: o.value === current }, o.label)));
  sel.disabled = run.status !== 'idle';
}

/** Mensaje breve en el notch recogido cuando un agente termina. */
function flashDone(text: string) {
  doneFlash = text.length > 60 ? text.slice(0, 57) + '…' : text;
  window.clearTimeout(doneTimer);
  doneTimer = window.setTimeout(() => {
    doneFlash = '';
    renderHeader();
  }, 7000);
  renderHeader();
}

async function setActiveModel(model: string) {
  const a = activeAgent();
  settings = await api.saveSettings({ agents: settings.agents.map((x) => (x.id === a.id ? { ...x, model } : x)) });
  renderAll();
}

function renderSwitch() {
  const nav = $('agentSwitch');
  nav.replaceChildren();
  for (const a of settings.agents) {
    const chip = h('button', {
      class: `agent-chip ${a.id === settings.activeAgentId ? 'active' : ''}`,
      title: PROVIDER_LABELS[a.provider],
      onclick: () => void selectAgent(a.id),
    }, avatar(a, 'chip-avatar'), a.name);
    chip.style.setProperty('--chip-color', luminance(a.color) > 0.85 ? '#9aa4ad' : a.color);
    nav.append(chip);
  }
  nav.append(h('button', { class: 'agent-chip add', title: 'Nuevo agente', onclick: () => { void addAgent(); } }, '＋'));
}

async function selectAgent(id: string) {
  if (id === settings.activeAgentId) return;
  settings = await api.saveSettings({ activeAgentId: id });
  renderAll();
}

// ---------- chat ----------

const SUGGESTIONS = [
  'Abre Spotify y pon una canción que me guste',
  'Busca en Google las noticias de hoy y dime los titulares',
  'Abre Firefox y mira qué tiempo hará mañana',
];

function renderMessages() {
  const box = $('messages');
  box.replaceChildren();
  const a = activeAgent();
  const items = chatFor(a.id);
  if (!items.length) {
    box.append(
      h('div', { class: 'empty' },
        avatar(a, 'empty-avatar'),
        h('h3', {}, `¡Hola! Soy ${a.name}`),
        h('p', {}, 'Puedo usar tu ratón y tu teclado por ti. ¿Qué hacemos?'),
        h('div', { class: 'suggestions' }, ...SUGGESTIONS.map((s) =>
          h('button', { class: 'suggestion', onclick: () => { ($('prompt') as HTMLTextAreaElement).value = s; void send(); } }, s))),
      ),
    );
    return;
  }
  for (const it of items) box.append(renderItem(a, it));
  box.scrollTop = box.scrollHeight;
}

function renderItem(a: AgentProfile, it: ChatItem): HTMLElement {
  let el: HTMLElement;
  switch (it.kind) {
    case 'user':
      el = h('div', { class: 'msg user' }, it.text);
      break;
    case 'agent': {
      const bubble = h('div', { class: `msg agent ${it.done ? 'done' : ''}` }, it.text);
      el = h('div', { class: 'row-agent' }, avatar(a, 'mini'), bubble);
      it.el = bubble;
      return el;
    }
    case 'thinking': {
      const body = h('div', { class: 't-body' }, it.text);
      el = h('details', { class: `thinking ${it.live ? 'live' : ''}` }, h('summary', {}, it.live ? '💭 Pensando' : '💭 Lo que pensó'), body);
      it.el = el;
      return el;
    }
    case 'action':
      el = h('div', { class: 'action' }, h('span', {}, it.icon), h('span', { class: 'a-label' }, it.text));
      break;
    case 'info':
      el = h('div', { class: 'info' }, it.text);
      break;
    case 'error':
      el = h('div', { class: 'error' }, `⚠️ ${it.text}`);
      break;
  }
  it.el = el;
  return el;
}

function closeLive(items: ChatItem[]) {
  for (const it of items) {
    if (it.kind === 'thinking' && it.live) {
      it.live = false;
      it.el?.classList.remove('live');
      const s = it.el?.querySelector('summary');
      if (s) s.textContent = '💭 Lo que pensó';
    }
  }
}

function onAgentEvent(agentId: string, ev: AgentEvent) {
  const items = chatFor(agentId);
  const visible = agentId === settings.activeAgentId && view === 'chat';
  const last = items[items.length - 1];
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  const push = (it: ChatItem) => {
    if (items.length === 0 && visible) box.replaceChildren();
    items.push(it);
    if (visible) box.append(renderItem(agentById(agentId) ?? activeAgent(), it));
  };

  switch (ev.type) {
    case 'user':
      push({ kind: 'user', text: ev.text });
      break;
    case 'thinking':
      if (last?.kind === 'thinking' && last.live) {
        last.text += ev.text;
        last.el?.querySelector('.t-body')?.append(ev.text);
      } else {
        push({ kind: 'thinking', text: ev.text, live: true });
      }
      break;
    case 'text':
      closeLive(items);
      if (last?.kind === 'agent' && !last.done) {
        last.text += ev.text;
        last.el?.append(ev.text);
      } else {
        push({ kind: 'agent', text: ev.text });
      }
      break;
    case 'action':
      closeLive(items);
      if (last?.kind === 'agent') last.done = true;
      push({ kind: 'action', text: ev.label, icon: ev.icon });
      lastAction = ev.label;
      renderHeader();
      break;
    case 'info':
      closeLive(items);
      push({ kind: 'info', text: ev.text });
      break;
    case 'error':
      closeLive(items);
      push({ kind: 'error', text: ev.text });
      break;
    case 'done': {
      closeLive(items);
      // El texto final ya llegó en streaming; solo lo añadimos si no se mostró.
      const shown = items.slice().reverse().find((i) => i.kind === 'agent');
      if (!shown || !shown.text.trim() || !ev.text.includes(shown.text.trim().slice(0, 40))) {
        if (ev.text.trim()) push({ kind: 'agent', text: ev.text, done: true });
      }
      flashDone(ev.text.trim() ? `✓ ${ev.text.trim().split('\n')[0]}` : '✓ Hecho');
      const fin = items.slice().reverse().find((i): i is Extract<ChatItem, { kind: 'agent' }> => i.kind === 'agent');
      if (fin) {
        fin.done = true;
        fin.el?.classList.add('done');
      }
      break;
    }
  }
  if (visible && nearBottom) box.scrollTop = box.scrollHeight;
}

function renderComposer() {
  const busy = run.status !== 'idle';
  $('sendBtn').classList.toggle('hidden', busy);
  $('stopBtn').classList.toggle('hidden', !busy);
  $('stopLabel').textContent = run.status === 'stopping' ? 'Deteniendo…' : `Detener (${settings.stopShortcut.replace('Control', 'Ctrl')})`;
  const ta = $('prompt') as HTMLTextAreaElement;
  ta.disabled = busy;
  ta.placeholder = busy ? `${agentById(run.agentId)?.name ?? 'El agente'} está trabajando…` : `Dile a ${activeAgent().name} qué hacer…`;
  for (const chip of document.querySelectorAll<HTMLButtonElement>('.agent-chip')) chip.disabled = busy;
}

async function send() {
  const ta = $('prompt') as HTMLTextAreaElement;
  const text = ta.value.trim();
  if (!text || run.status !== 'idle') return;
  const a = activeAgent();
  const missing = missingSetup(a);
  if (missing) {
    onAgentEvent(a.id, { type: 'error', text: missing });
    return;
  }
  ta.value = '';
  autoGrow();
  try {
    await api.runTask(a.id, text);
  } catch (e) {
    onAgentEvent(a.id, { type: 'error', text: errText(e) });
  }
}

function missingSetup(a: AgentProfile): string | null {
  if (a.provider === 'anthropic' && !settings.hasAnthropicKey) return 'Falta la API key de Anthropic. Ábrela en ⋯ → Ajustes.';
  if (a.provider === 'openai' && !settings.hasOpenAIKey) return 'Falta la API key de OpenAI. Ábrela en ⋯ → Ajustes.';
  return null;
}

function autoGrow() {
  const ta = $('prompt') as HTMLTextAreaElement;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(120, ta.scrollHeight)}px`;
}

// ---------- confirmaciones ----------

function showConfirm(req: ConfirmRequest | null) {
  pendingConfirm = req;
  $('confirm').classList.toggle('hidden', !req);
  if (!req) return;
  if (view !== 'chat') setView('chat');
  const who = agentById(req.agentId)?.name ?? 'El agente';
  $('confirmTitle').textContent = `${who} quiere: ${req.title}`;
  $('confirmDetail').textContent = req.detail;
}

async function answerConfirm(ok: boolean) {
  if (!pendingConfirm) return;
  const id = pendingConfirm.id;
  showConfirm(null);
  await api.respondConfirm(id, ok);
}

// ---------- vistas ----------

function setView(v: typeof view) {
  view = v;
  $('viewChat').classList.toggle('hidden', v !== 'chat');
  $('viewAgents').classList.toggle('hidden', v !== 'agents');
  $('viewSettings').classList.toggle('hidden', v !== 'settings');
  $('agentSwitch').classList.toggle('hidden', v !== 'chat');
  if (v === 'chat') renderMessages();
  if (v === 'agents') renderAgents();
  if (v === 'settings') renderSettings();
}

function renderAll() {
  applyTheme();
  renderHeader();
  renderSwitch();
  renderComposer();
  if (view === 'chat') renderMessages();
}

// ---------- panel de agentes ----------

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

async function addAgent() {
  const a: AgentProfile = {
    id: newId(),
    name: 'Nuevo agente',
    provider: 'anthropic',
    model: DEFAULT_MODELS.anthropic,
    color: '#7C6CF2',
    mascot: 'claude',
    effort: 'medium',
    extraInstructions: '',
  };
  settings = await api.saveSettings({ agents: [...settings.agents, a] });
  editingAgentId = a.id;
  setView('agents');
  renderSwitch();
}

function renderAgents() {
  const body = $('agentsBody');
  body.replaceChildren();
  const editing = settings.agents.find((a) => a.id === editingAgentId);
  if (editing) {
    body.append(agentEditor(editing));
    return;
  }
  for (const a of settings.agents) {
    body.append(
      h('div', { class: 'agent-card', onclick: () => { editingAgentId = a.id; renderAgents(); } },
        avatar(a, 'ac-avatar'),
        h('div', { class: 'ac-text' },
          h('div', { class: 'ac-name' }, a.name),
          h('div', { class: 'ac-sub' }, `${PROVIDER_LABELS[a.provider]}${a.model ? ` · ${a.model}` : ''}`)),
        h('span', {}, '›')),
    );
  }
  body.append(h('button', { class: 'btn primary', onclick: () => void addAgent() }, '＋ Crear agente'));
}

function agentEditor(a: AgentProfile): HTMLElement {
  const draft: AgentProfile = { ...a };
  const preview = h('div', { class: 'ep-avatar', html: avatarHtml(draft) });
  const refresh = () => { preview.innerHTML = avatarHtml(draft); };

  const name = h('input', { type: 'text', value: draft.name, maxlength: 24 });
  name.addEventListener('input', () => { draft.name = name.value; });

  const provider = h('select', { class: 'input' }, ...(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((p) =>
    h('option', { value: p, selected: p === draft.provider }, PROVIDER_LABELS[p])));
  // Modelo: tarjetas para Claude (Opus / Sonnet / Haiku) y texto libre para OpenAI.
  const modelBox = h('div');
  const renderModelPicker = () => {
    modelBox.replaceChildren();
    if (isClaudeProvider(draft.provider)) {
      if (!CLAUDE_MODELS.some((m) => m.id === draft.model)) draft.model = DEFAULT_MODELS[draft.provider];
      modelBox.append(h('div', { class: 'model-cards' }, ...CLAUDE_MODELS.map((m) =>
        h('button', {
          class: `model-card ${draft.model === m.id ? 'active' : ''}`,
          onclick: () => { draft.model = m.id; renderModelPicker(); },
        }, h('b', {}, m.label), h('span', {}, m.hint)))));
      if (draft.provider === 'claude-code') {
        modelBox.append(h('div', { class: 'hint', style: 'margin-top:6px' }, 'Con la suscripción, Haiku es el que menos límite gasta.'));
      }
    } else {
      const input = h('input', { type: 'text', value: draft.model, list: 'openaiModels', placeholder: DEFAULT_MODELS[draft.provider] || 'Por defecto del CLI' });
      input.addEventListener('input', () => { draft.model = input.value.trim(); });
      modelBox.append(input, h('datalist', { id: 'openaiModels' }, ...OPENAI_MODEL_SUGGESTIONS.map((m) => h('option', { value: m }))));
    }
  };
  renderModelPicker();
  const providerHint = h('div', { class: 'hint' });
  const updateProviderHint = () => {
    providerHint.textContent = ({
      anthropic: 'Usa tu API key de Anthropic (pago por uso, aparte de la suscripción). Modelos con computer use: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5.',
      openai: 'Usa tu API key de OpenAI (pago por uso). El modelo debe admitir la herramienta "computer" de la Responses API.',
      'claude-code': 'Usa Claude Code instalado en tu PC con tu sesión de Pro/Max. No necesita API key.',
      codex: 'Experimental. Usa Codex CLI con tu cuenta de ChatGPT. Puede que tu versión de Codex no pase las capturas al modelo.',
    } as Record<ProviderId, string>)[draft.provider];
  };
  updateProviderHint();
  provider.addEventListener('change', () => {
    const p = provider.value as ProviderId;
    const keep = isClaudeProvider(p) && isClaudeProvider(draft.provider) && CLAUDE_MODELS.some((m) => m.id === draft.model);
    if (!keep) draft.model = DEFAULT_MODELS[p];
    draft.provider = p;
    updateProviderHint();
    renderModelPicker();
  });

  const color = h('input', { type: 'color', value: draft.color });
  color.addEventListener('input', () => { draft.color = color.value; refresh(); });
  const mascot = h('select', { class: 'input' },
    h('option', { value: 'claude', selected: draft.mascot === 'claude' }, 'Estrellita (estilo Claude)'),
    h('option', { value: 'chatgpt', selected: draft.mascot === 'chatgpt' }, 'Nudito (estilo ChatGPT)'));
  mascot.addEventListener('change', () => { draft.mascot = mascot.value as AgentProfile['mascot']; refresh(); });

  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'hidden' });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 600_000) { alert('La imagen debe pesar menos de 600 KB.'); return; }
    const reader = new FileReader();
    reader.onload = () => { draft.avatarDataUrl = String(reader.result); refresh(); };
    reader.readAsDataURL(f);
  });

  const effort = h('select', { class: 'input' }, ...(['low', 'medium', 'high', 'xhigh', 'max'] as const).map((e) =>
    h('option', { value: e, selected: e === draft.effort }, ({ low: 'Rápido', medium: 'Equilibrado', high: 'Cuidadoso', xhigh: 'Muy cuidadoso', max: 'Máximo' })[e])));
  effort.addEventListener('change', () => { draft.effort = effort.value as AgentProfile['effort']; });

  const extra = h('textarea', { class: 'input', placeholder: 'Ej.: "Usa siempre Firefox. Habla con emojis."' });
  extra.value = draft.extraInstructions;
  extra.addEventListener('input', () => { draft.extraInstructions = extra.value; });

  const save = async () => {
    if (!draft.name.trim()) { alert('Ponle un nombre.'); return; }
    settings = await api.saveSettings({ agents: settings.agents.map((x) => (x.id === draft.id ? { ...draft, name: draft.name.trim() } : x)) });
    editingAgentId = null;
    renderAll();
    renderAgents();
  };
  const remove = async () => {
    if (settings.agents.length <= 1) { alert('Necesitas al menos un agente.'); return; }
    if (!confirm(`¿Borrar a ${a.name}?`)) return;
    settings = await api.saveSettings({ agents: settings.agents.filter((x) => x.id !== a.id) });
    chats.delete(a.id);
    editingAgentId = null;
    renderAll();
    renderAgents();
  };

  return h('div', {},
    h('div', { class: 'editor-preview' }, preview),
    h('div', { class: 'group' },
      h('div', { class: 'field' }, h('label', {}, 'Nombre'), name),
      h('div', { class: 'field' }, h('label', {}, 'Mascota y color del cursor'),
        h('div', { class: 'inline' }, mascot, color)),
      h('div', { class: 'field' }, h('label', {}, 'Imagen propia (opcional)'),
        h('div', { class: 'inline' },
          h('button', { class: 'btn ghost small', onclick: () => file.click() }, 'Subir imagen'),
          h('button', { class: 'btn ghost small', onclick: () => { delete draft.avatarDataUrl; refresh(); } }, 'Quitar'),
          file),
        h('div', { class: 'hint' }, 'Puedes poner aquí el icono que quieras para tu agente.')),
    ),
    h('div', { class: 'group' },
      h('div', { class: 'field' }, h('label', {}, 'Cerebro'), provider, providerHint),
      h('div', { class: 'field' }, h('label', {}, 'Modelo'), modelBox),
      h('div', { class: 'field' }, h('label', {}, 'Esfuerzo'), effort,
        h('div', { class: 'hint' }, 'Más esfuerzo = más fiable pero más lento y caro.')),
      h('div', { class: 'field' }, h('label', {}, 'Personalidad e instrucciones'), extra),
    ),
    h('div', { class: 'row-buttons' },
      h('button', { class: 'btn danger', onclick: () => void remove() }, 'Borrar'),
      h('div', { class: 'inline' },
        h('button', { class: 'btn ghost', onclick: () => { editingAgentId = null; renderAgents(); } }, 'Cancelar'),
        h('button', { class: 'btn primary', onclick: () => void save() }, 'Guardar'))),
  );
}

// ---------- panel de ajustes ----------

let saveTimer: number | undefined;
function saveLater(patch: Partial<Settings>) {
  Object.assign(settings, patch);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    settings = await api.saveSettings(patch);
    renderAll();
  }, 300);
}

function toggle(label: string, hint: string, key: keyof Settings): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: !!settings[key] });
  input.addEventListener('change', () => saveLater({ [key]: input.checked } as Partial<Settings>));
  return h('div', { class: 'toggle' },
    h('div', { class: 't-text' }, h('label', {}, label), h('span', { class: 'hint' }, hint)),
    h('label', { class: 'switch' }, input, h('span')));
}

function range(label: string, key: keyof Settings, min: number, max: number, step: number, unit: string): HTMLElement {
  const value = h('span', { class: 'hint' }, `${settings[key]} ${unit}`);
  const input = h('input', { type: 'range', min, max, step, value: Number(settings[key]) });
  input.addEventListener('input', () => {
    value.textContent = `${input.value} ${unit}`;
    saveLater({ [key]: Number(input.value) } as Partial<Settings>);
  });
  return h('div', { class: 'field' }, h('div', { class: 'inline' }, h('label', {}, label), value), input);
}

function keyField(label: string, name: 'anthropic' | 'openai', has: boolean, link: string): HTMLElement {
  const input = h('input', { type: 'password', placeholder: has ? '•••••••• (configurada)' : 'Pega aquí tu API key', autocomplete: 'off' });
  const pill = h('span', { class: `status-pill ${has ? 'ok' : ''}` }, has ? '✓ Configurada' : 'Sin clave');
  const saveBtn = h('button', { class: 'btn primary small', onclick: async () => {
    try {
      settings = await api.setSecret(name, input.value);
      input.value = '';
      renderSettings();
    } catch (e) {
      alert(errText(e));
    }
  } }, 'Guardar');
  const delBtn = has ? h('button', { class: 'btn ghost small', onclick: async () => { settings = await api.setSecret(name, ''); renderSettings(); } }, 'Borrar') : null;
  return h('div', { class: 'field' },
    h('div', { class: 'inline' }, h('label', {}, label), pill),
    h('div', { class: 'inline' }, input, saveBtn, delBtn),
    h('div', { class: 'hint', html: `Se guarda cifrada con el sistema (DPAPI). Consíguela en <a href="${link}" target="_blank">${new URL(link).host}</a>.` }));
}

function cliField(label: string, key: 'claudeCliPath' | 'codexCliPath', provider: ProviderId): HTMLElement {
  const input = h('input', { type: 'text', value: settings[key] });
  input.addEventListener('change', () => saveLater({ [key]: input.value.trim() } as Partial<Settings>));
  const pill = h('span', { class: 'status-pill' }, '—');
  const check = h('button', { class: 'btn ghost small', onclick: async () => {
    pill.textContent = 'Comprobando…';
    pill.className = 'status-pill';
    const r = await api.checkCli(provider);
    pill.textContent = r.ok ? `✓ ${r.message}` : '✗ No disponible';
    pill.title = r.message;
    pill.className = `status-pill ${r.ok ? 'ok' : 'bad'}`;
  } }, 'Comprobar');
  return h('div', { class: 'field' },
    h('div', { class: 'inline' }, h('label', {}, label), pill),
    h('div', { class: 'inline' }, input, check));
}

function renderSettings() {
  const body = $('settingsBody');
  const s = settings;

  const about = h('textarea', { class: 'input', placeholder: 'Ej.: Me gusta el indie español y el lo-fi. Uso Firefox. Vivo en Valencia.' });
  about.value = s.aboutMe;
  about.addEventListener('input', () => saveLater({ aboutMe: about.value }));

  const confirmSel = h('select', { class: 'input' },
    h('option', { value: 'never', selected: s.confirmMode === 'never' }, 'Autónomo: no preguntar nunca'),
    h('option', { value: 'keyboard', selected: s.confirmMode === 'keyboard' }, 'Preguntar antes de escribir o pulsar teclas'),
    h('option', { value: 'always', selected: s.confirmMode === 'always' }, 'Preguntar antes de cada acción'));
  confirmSel.addEventListener('change', () => saveLater({ confirmMode: confirmSel.value as Settings['confirmMode'] }));

  const maxSteps = h('input', { type: 'number', min: 1, max: 500, value: s.maxSteps });
  maxSteps.addEventListener('change', () => saveLater({ maxSteps: Number(maxSteps.value) }));

  const shortcut = h('input', { type: 'text', value: s.stopShortcut });
  shortcut.addEventListener('change', () => saveLater({ stopShortcut: shortcut.value.trim() || 'Control+Alt+Q' }));

  const quality = h('select', { class: 'input' }, ...[[1024, 'Ligera (más barata)'], [1366, 'Normal'], [1568, 'Alta (recomendada)'], [2000, 'Máxima']].map(([v, l]) =>
    h('option', { value: v, selected: s.captureMaxEdge === v }, String(l))));
  quality.addEventListener('change', () => saveLater({ captureMaxEdge: Number(quality.value) }));


  body.replaceChildren(
    h('div', { class: 'group' },
      h('h3', {}, 'Cuentas'),
      keyField('API key de Anthropic (Claude)', 'anthropic', s.hasAnthropicKey, 'https://console.anthropic.com/settings/keys'),
      keyField('API key de OpenAI (ChatGPT)', 'openai', s.hasOpenAIKey, 'https://platform.openai.com/api-keys'),
      cliField('Claude Code (suscripción Pro/Max)', 'claudeCliPath', 'claude-code'),
      cliField('Codex CLI (suscripción ChatGPT, experimental)', 'codexCliPath', 'codex'),
      h('div', { class: 'hint' }, 'Para usar tu suscripción instala el CLI, inicia sesión en él una vez desde una terminal ("claude" o "codex login") y elige ese cerebro en el agente.'),
      !s.encryptionAvailable ? h('div', { class: 'error' }, 'El cifrado del sistema no está disponible: no se pueden guardar claves.') : null,
    ),
    h('div', { class: 'group' },
      h('h3', {}, 'Sobre ti'),
      h('div', { class: 'field' }, about, h('div', { class: 'hint' }, 'Tus agentes lo usan para personalizar (por ejemplo, qué música ponerte). No pongas contraseñas.'))),
    h('div', { class: 'group' },
      h('h3', {}, 'Seguridad'),
      h('div', { class: 'field' }, h('label', {}, 'Confirmaciones'), confirmSel),
      h('div', { class: 'field' }, h('label', {}, 'Máximo de pasos por tarea'), maxSteps),
      h('div', { class: 'field' }, h('label', {}, 'Atajo para detener'), shortcut, h('div', { class: 'hint' }, 'Formato de Electron, p. ej. Control+Alt+Q. Funciona aunque la app no tenga el foco.'))),
    h('div', { class: 'group' },
      h('h3', {}, 'Cursor y teclado'),
      toggle('Devolverte el ratón', 'Tras cada clic del agente, tu puntero vuelve a donde estaba.', 'returnCursor'),
      toggle('Mostrar teclado digital', 'Ves en pantalla lo que va escribiendo.', 'showKeyboard'),
      range('Velocidad del cursor', 'cursorAnimMs', 0, 1200, 20, 'ms'),
      range('Pausa entre letras', 'typingDelayMs', 0, 80, 2, 'ms')),
    h('div', { class: 'group' },
      h('h3', {}, 'Avanzado'),
      toggle('Ocultar el cursor y el teclado en las capturas', 'El agente no ve su propio cursor ni el teclado digital (el chat sí lo ve, para no hacer clic encima).', 'hideFromCapture'),
      h('div', { class: 'field' }, h('label', {}, 'Calidad de captura'), quality),
      range('Espera tras cada acción', 'settleMs', 0, 2000, 50, 'ms'),
      toggle('Abrir al iniciar Windows', 'El notch aparece arriba en cuanto enciendes el PC.', 'openAtLogin')),
  );
}

// ---------- arranque ----------

async function init() {
  settings = await api.getSettings();

  $('bar').addEventListener('click', () => void api.setExpanded(true));
  $('barStop').addEventListener('click', (e) => {
    e.stopPropagation();
    void api.stopTask();
  });
  $('minBtn').addEventListener('click', () => void api.setExpanded(false));
  ($('modelSelect') as HTMLSelectElement).addEventListener('change', (e) => void setActiveModel((e.target as HTMLSelectElement).value));
  $('menuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('menu').classList.toggle('hidden');
  });
  document.addEventListener('click', () => $('menu').classList.add('hidden'));
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-menu]')) {
    b.addEventListener('click', () => {
      const m = b.dataset.menu;
      if (m === 'new') {
        const a = activeAgent();
        chats.delete(a.id);
        void api.clearHistory(a.id);
        setView('chat');
      } else if (m === 'agents') { editingAgentId = null; setView('agents'); }
      else if (m === 'settings') setView('settings');
      else if (m === 'quit') void api.quit();
    });
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-back]')) b.addEventListener('click', () => setView('chat'));

  const ta = $('prompt') as HTMLTextAreaElement;
  ta.addEventListener('input', autoGrow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  $('sendBtn').addEventListener('click', () => void send());
  $('stopBtn').addEventListener('click', () => void api.stopTask());
  $('confirmYes').addEventListener('click', () => void answerConfirm(true));
  $('confirmNo').addEventListener('click', () => void answerConfirm(false));

  api.onRunState((s) => {
    if (s.status === 'running' && run.status === 'idle') lastAction = '';
    run = s;
    applyTheme();
    renderHeader();
    renderComposer();
  });
  api.onAgentEvent((m) => onAgentEvent(m.agentId, m.event));
  api.onConfirm((r) => showConfirm(r));
  api.onConfirmCancel((id) => { if (pendingConfirm?.id === id) showConfirm(null); });
  api.onExpanded((v) => {
    isOpen = v;
    window.clearTimeout(shrinkTimer);
    if (v) {
      // La ventana ya ha crecido: en el siguiente frame el notch se despliega con la animación.
      requestAnimationFrame(() => document.body.classList.add('open'));
      ta.focus();
    } else {
      $('menu').classList.add('hidden');
      document.body.classList.remove('open');
      // Cuando termina la animación de recoger, la ventana vuelve al tamaño del notch.
      shrinkTimer = window.setTimeout(() => { if (!isOpen) void api.shrink(); }, 380);
    }
  });
  // Clic fuera: se recoge solo si no hay nada a medias (chat vacío, sin confirmación, sin paneles abiertos).
  api.onBlur(() => {
    if (!isOpen || run.status !== 'idle' || pendingConfirm || view !== 'chat' || ta.value.trim()) return;
    void api.setExpanded(false);
  });

  renderAll();
}

void init();
