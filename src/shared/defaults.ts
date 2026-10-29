import type { AgentProfile, ProviderId, Settings } from './types';

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5.5',
  'claude-code': '',
  codex: '',
};

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
    provider: 'anthropic',
    model: DEFAULT_MODELS.anthropic,
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
  theme: 'auto',
};
