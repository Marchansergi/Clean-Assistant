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
  /** Voz de Piper (id del catálogo). Vacío = la primera instalada. */
  voice?: string;
  /** Hablante dentro de la voz, si tiene varios (p. ej. "F" o "M"). */
  voiceSpeaker?: string;
  /** Voz de ElevenLabs (voice_id) y su nombre, para mostrarlo sin consultar la API. */
  elevenVoiceId?: string;
  elevenVoiceName?: string;
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
  /** Abrir la app al iniciar sesión en Windows. */
  openAtLogin: boolean;
  /** Permitir que el agente use todas las pantallas (si no, solo la principal). */
  multiScreen: boolean;
  /** Sonido al abrir y cerrar el notch. */
  sounds: boolean;
  /** Volumen de los sonidos (0-100). */
  soundVolume: number;
  /** Los agentes leen en voz alta lo que dicen. */
  voiceReplies: boolean;
  /** Motor de voz: Piper (local), ElevenLabs (API, de pago) o la voz de Windows (sin descargas). */
  ttsEngine: 'piper' | 'elevenlabs' | 'system';
  /** Modelo de ElevenLabs (id de ELEVEN_MODELS). */
  elevenModel: string;
  ttsVolume: number;
  /** Velocidad de habla (1 = normal). */
  ttsRate: number;
  /** Modelo de reconocimiento de voz (id de STT_MODELS). */
  sttModel: string;
  /** Idioma en el que hablas ('es' o 'auto'). */
  sttLanguage: string;
  /** Atajo global para hablar con el agente. */
  talkShortcut: string;
  /** Lanzar la tarea en cuanto terminas de hablar (si no, se queda escrita para revisarla). */
  voiceAutoSend: boolean;
  /** Micrófono elegido (vacío = el predeterminado de Windows). */
  micDeviceId: string;
}

/** Lo que ve la vista: los ajustes más si hay claves guardadas (nunca las claves). */
export interface PublicSettings extends Settings {
  hasAnthropicKey: boolean;
  hasOpenAIKey: boolean;
  hasElevenLabsKey: boolean;
  encryptionAvailable: boolean;
}

export type SecretName = 'anthropic' | 'openai' | 'elevenlabs';

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
