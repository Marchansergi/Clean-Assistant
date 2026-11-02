import { net } from 'electron';
import type { ElevenVoice } from '../../shared/voice';
import { speakableText } from './manager';

// API REST de ElevenLabs (https://api.elevenlabs.io). Se usa net.fetch para respetar el proxy de Windows.
const BASE = process.env.ELEVENLABS_BASE_URL?.replace(/\/$/, '') || 'https://api.elevenlabs.io';

async function call(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await net.fetch(`${BASE}${path}`, { ...init, headers: { 'xi-api-key': key, ...(init.headers ?? {}) } });
  } catch (e) {
    throw new Error(`No se pudo conectar con ElevenLabs. Revisa tu conexión. (${(e as Error).message})`);
  }
  if (res.ok) return res;
  let detail = '';
  try {
    const j = (await res.json()) as { detail?: { message?: string; status?: string } | string };
    detail = typeof j.detail === 'string' ? j.detail : j.detail?.message ?? j.detail?.status ?? '';
  } catch {
    /* sin cuerpo JSON */
  }
  if (res.status === 401) throw new Error('La API key de ElevenLabs no es válida o no tiene permisos.');
  if (res.status === 402 || /quota|credits/i.test(detail)) throw new Error('Te has quedado sin créditos de ElevenLabs.');
  if (res.status === 429) throw new Error('ElevenLabs está limitando las peticiones; espera un momento.');
  throw new Error(`ElevenLabs respondió ${res.status}${detail ? `: ${detail}` : ''}`);
}

const GENDER: Record<string, string> = { female: 'mujer', male: 'hombre', neutral: 'neutra' };

/** Voces de tu cuenta (las tuyas y las añadidas desde la biblioteca). */
export async function listElevenVoices(key: string): Promise<ElevenVoice[]> {
  const res = await call('/v1/voices', key);
  const j = (await res.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] };
  return (j.voices ?? [])
    .map((v) => {
      const l = v.labels ?? {};
      const bits = [GENDER[l.gender ?? ''] ?? l.gender, l.accent, l.age, l.descriptive ?? l.description].filter(Boolean);
      return { id: v.voice_id, name: v.name, description: bits.join(' · ') };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

/** Sintetiza con ElevenLabs y devuelve un MP3. */
export async function synthesizeEleven(text: string, voiceId: string, model: string, rate: number, key: string): Promise<Buffer | null> {
  const clean = speakableText(text);
  if (!clean) return null;
  const body: Record<string, unknown> = { text: clean, model_id: model };
  // language_code fuerza el español, pero los modelos multilingual_v2 no lo admiten.
  if (!model.startsWith('eleven_multilingual_v2')) body.language_code = 'es';
  if (Math.abs(rate - 1) > 0.01) body.voice_settings = { speed: Math.min(1.2, Math.max(0.7, rate)) };
  const res = await call(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, key, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  });
  return Buffer.from(await res.arrayBuffer());
}
