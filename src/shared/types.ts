// Tipos compartidos entre el proceso principal, los preloads y las vistas.

export type ProviderId = 'anthropic' | 'openai' | 'claude-code' | 'codex';
export type MascotId = 'claude' | 'chatgpt';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ConfirmMode = 'never' | 'keyboard' | 'always';

export interface AgentProfile {
  id: string;
  name: string;
  provider: ProviderId;
  /** Vacío = modelo por defecto del proveedor. */
  model: string;
  /** Color del cursor y del acento visual. */
  color: string;
  mascot: MascotId;
  /** Imagen propia opcional (data URL) que sustituye a la mascota. */
  avatarDataUrl?: string;
  effort: Effort;
  extraInstructions: string;
}

export interface Settings {
  agents: AgentProfile[];
  activeAgentId: string;
  /** Lo que el agente sabe de ti: gustos, idioma, apps que usas... */
  aboutMe: string;
  confirmMode: ConfirmMode;
  maxSteps: number;
  /** Devuelve tu ratón a donde estaba después de cada acción del agente. */
  returnCursor: boolean;
  /** Duración de la animación del cursor del agente (ms). */
  cursorAnimMs: number;
  showKeyboard: boolean;
  /** Oculta la capa del cursor y del teclado digital de las capturas que ve el agente. */
  hideFromCapture: boolean;
  stopShortcut: string;
  /** Lado mayor máximo de las capturas enviadas al modelo (px). */
  captureMaxEdge: number;
  /** Espera tras cada acción antes de capturar (ms). */
  settleMs: number;
  typingDelayMs: number;
  claudeCliPath: string;
  codexCliPath: string;
  theme: 'auto' | 'dark' | 'light';
}

/** Lo que ve la vista: los ajustes más si hay claves guardadas (nunca las claves). */
export interface PublicSettings extends Settings {
  hasAnthropicKey: boolean;
  hasOpenAIKey: boolean;
  encryptionAvailable: boolean;
}

export type SecretName = 'anthropic' | 'openai';

export type RunStatus = 'idle' | 'running' | 'stopping';

export type AgentEvent =
  | { type: 'user'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'action'; label: string; icon: string }
  | { type: 'info'; text: string }
  | { type: 'error'; text: string }
  | { type: 'done'; text: string };

export interface RunStateMsg {
  status: RunStatus;
  agentId: string | null;
  step: number;
}

export interface AgentEventMsg {
  agentId: string;
  taskId: string;
  event: AgentEvent;
}

export interface ConfirmRequest {
  id: string;
  agentId: string;
  title: string;
  detail: string;
}

// ---- Capa (overlay) ----

export interface OverlayAgentInfo {
  name: string;
  color: string;
  mascot: MascotId;
  avatarDataUrl?: string;
}

export type OverlayMsg =
  | { type: 'agent'; agent: OverlayAgentInfo | null }
  | { type: 'move'; x: number; y: number; durationMs: number }
  | { type: 'click'; button: 'left' | 'right' | 'middle'; count: number }
  | { type: 'drag'; active: boolean }
  | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right' }
  | { type: 'type'; text: string; delayMs: number }
  | { type: 'keys'; keys: string[] }
  | { type: 'status'; text: string }
  | { type: 'keyboard'; visible: boolean }
  | { type: 'hide' };
