import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { PublicSettings, SecretName, Settings } from '../shared/types';

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');

function readJson<T>(file: string): Partial<T> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<T>;
  } catch {
    return {};
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (!cache) {
    const stored = readJson<Settings>(settingsFile());
    cache = { ...DEFAULT_SETTINGS, ...stored };
    if (!Array.isArray(cache.agents) || cache.agents.length === 0) cache.agents = DEFAULT_SETTINGS.agents;
    if (!cache.agents.some((a) => a.id === cache!.activeAgentId)) cache.activeAgentId = cache.agents[0].id;
  }
  return cache;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch };
  if (!next.agents.length) throw new Error('Debe haber al menos un agente.');
  if (!next.agents.some((a) => a.id === next.activeAgentId)) next.activeAgentId = next.agents[0].id;
  next.maxSteps = clamp(next.maxSteps, 1, 500);
  next.captureMaxEdge = clamp(next.captureMaxEdge, 640, 2000);
  next.settleMs = clamp(next.settleMs, 0, 5000);
  next.cursorAnimMs = clamp(next.cursorAnimMs, 0, 3000);
  next.typingDelayMs = clamp(next.typingDelayMs, 0, 200);
  cache = next;
  writeJson(settingsFile(), next);
  return next;
}

function clamp(v: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ---- Claves de API ----
// Se cifran con safeStorage (DPAPI en Windows, ligado a tu usuario). Si el cifrado
// no está disponible no se guardan: preferimos pedirlas otra vez a dejarlas en claro.

export function setSecret(name: SecretName, value: string) {
  const secrets = readJson<Record<string, string>>(secretsFile());
  const v = value.trim();
  if (!v) {
    delete secrets[name];
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('El cifrado del sistema no está disponible; no se puede guardar la clave de forma segura.');
    }
    secrets[name] = safeStorage.encryptString(v).toString('base64');
  }
  writeJson(secretsFile(), secrets);
}

const ENV_FALLBACK: Record<SecretName, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

/** Clave guardada en la app; si no hay, la variable de entorno estándar del proveedor. */
export function getSecret(name: SecretName): string | null {
  const enc = readJson<Record<string, string>>(secretsFile())[name];
  if (enc) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      /* clave de otro usuario o equipo: se ignora */
    }
  }
  return process.env[ENV_FALLBACK[name]]?.trim() || null;
}

export function getPublicSettings(): PublicSettings {
  return {
    ...getSettings(),
    hasAnthropicKey: !!getSecret('anthropic'),
    hasOpenAIKey: !!getSecret('openai'),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
}
