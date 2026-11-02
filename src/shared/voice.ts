// Catálogo de voz: Piper (texto → voz) y whisper.cpp (voz → texto), ambos locales y gratuitos.
// Los programas se descargan de sus releases oficiales en GitHub y se comprueban con un SHA-256 fijado aquí.
// Las voces y modelos vienen de HuggingFace y se comprueban con el SHA-256 que publica HuggingFace (LFS).

export interface PinnedArchive {
  url: string;
  sha256: string;
  sizeMb: number;
}

export const PIPER_BINARY: PinnedArchive = {
  url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
  sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea',
  sizeMb: 22,
};

export const WHISPER_BINARY: PinnedArchive = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip',
  sha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a',
  sizeMb: 8,
};

export interface PiperVoice {
  id: string;
  label: string;
  /** Ruta dentro de rhasspy/piper-voices. */
  path: string;
  sizeMb: number;
}

const HF_PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

export const PIPER_VOICES: PiperVoice[] = [
  { id: 'es_ES-sharvard-medium', label: 'Sharvard · España (voz de mujer o de hombre)', path: 'es/es_ES/sharvard/medium', sizeMb: 77 },
  { id: 'es_ES-davefx-medium', label: 'Dave · España', path: 'es/es_ES/davefx/medium', sizeMb: 63 },
  { id: 'es_MX-claude-high', label: 'Claude · México (alta calidad)', path: 'es/es_MX/claude/high', sizeMb: 114 },
  { id: 'es_MX-ald-medium', label: 'Ald · México', path: 'es/es_MX/ald/medium', sizeMb: 63 },
  { id: 'es_AR-daniela-high', label: 'Daniela · Argentina (alta calidad)', path: 'es/es_AR/daniela/high', sizeMb: 114 },
];

export function piperVoiceUrls(v: PiperVoice) {
  const base = `${HF_PIPER}/${v.path}/${v.id}`;
  return { model: `${base}.onnx`, config: `${base}.onnx.json` };
}

export interface SttModel {
  id: string;
  label: string;
  file: string;
  sizeMb: number;
}

export const STT_MODELS: SttModel[] = [
  { id: 'small-q5_1', label: 'Preciso (recomendado)', file: 'ggml-small-q5_1.bin', sizeMb: 181 },
  { id: 'base-q5_1', label: 'Rápido y ligero', file: 'ggml-base-q5_1.bin', sizeMb: 57 },
];

export const sttModelUrl = (m: SttModel) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`;

/** Componentes instalables. 'voice:<id>' es una voz de Piper; 'stt:<id>' un modelo de whisper. */
export type VoiceComponent = 'piper' | 'whisper' | `voice:${string}` | `stt:${string}`;

export interface VoiceStatus {
  piper: boolean;
  whisper: boolean;
  voices: Record<string, { installed: boolean; speakers: string[] }>;
  sttModels: Record<string, boolean>;
  /** Componente que se está instalando ahora mismo. */
  installing: VoiceComponent | null;
}

export interface VoiceProgress {
  component: VoiceComponent;
  phase: 'download' | 'verify' | 'extract' | 'done' | 'error';
  received?: number;
  total?: number;
  message?: string;
}

// ---------- ElevenLabs (API de pago, opcional) ----------

export const ELEVEN_MODELS = [
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 · rápido y el más barato' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 · máxima naturalidad' },
  { id: 'eleven_v3', label: 'v3 · el más expresivo (más lento)' },
] as const;

export interface ElevenVoice {
  id: string;
  name: string;
  /** "mujer · español · joven"… según las etiquetas de la voz. */
  description: string;
}
