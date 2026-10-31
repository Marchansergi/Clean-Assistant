import type { AgentProfile, ProviderId, Settings } from './types';

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5.5',
  'claude-code': 'claude-haiku-5-5',
  codex: '',
};

/** Modelos de Claude que se pueden elegir (API y suscripción). */
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'El más listo. Gasta más límite.' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'Equilibrado entre velocidad y calidad.' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'El más rápido y el que menos límite gasta.' },
] as const;

/** Sugerencias para los proveedores de OpenAI (se puede escribir otro). */
export const OPENAI_MODEL_SUGGESTIONS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

export const isClaudeProvider = (p: ProviderId) => p === 'anthropic' || p === 'claude-code';

/** Nombre corto para mostrar un modelo ("Haiku 5.5", "gpt-5.5" o "Por defecto"). */
export function modelLabel(model: string): string {
  return CLAUDE_MODELS.find((m) => m.id === model)?.label ?? (model || 'Por defecto');
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Claude · API key',
  openai: 'ChatGPT · API key',
  'claude-code': 'Claude · suscripción (Claude Code)',
  codex: 'ChatGPT · suscripción (Codex CLI, experimental)',
};

export const DEFAULT_AGENTS: AgentProfile[] = [
  {
    id: 'clau',
    name: 'Clau',
    provider: 'claude-code',
    model: DEFAULT_MODELS['claude-code'],
    color: '#E8773D',
    mascot: 'claude',
    effort: 'medium',
    extraInstructions: '',
  },
  {
    id: 'chati',
    name: 'Chati',
    provider: 'openai',
    model: DEFAULT_MODELS.openai,
    color: '#F4FBFF',
    mascot: 'chatgpt',
    effort: 'medium',
    extraInstructions: '',
  },
];

export const DEFAULT_SETTINGS: Settings = {
  agents: DEFAULT_AGENTS,
  activeAgentId: 'clau',
  aboutMe: '',
  confirmMode: 'never',
  maxSteps: 60,
  returnCursor: true,
  cursorAnimMs: 380,
  showKeyboard: true,
  hideFromCapture: true,
  stopShortcut: 'Control+Alt+Q',
  captureMaxEdge: 1568,
  settleMs: 450,
  typingDelayMs: 14,
  claudeCliPath: 'claude',
  codexCliPath: 'codex',
  openAtLogin: false,
};
