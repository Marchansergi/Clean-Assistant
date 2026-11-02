import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, net } from 'electron';
import {
  PIPER_BINARY,
  PIPER_VOICES,
  STT_MODELS,
  WHISPER_BINARY,
  piperVoiceUrls,
  sttModelUrl,
  type PinnedArchive,
  type VoiceComponent,
  type VoiceProgress,
  type VoiceStatus,
} from '../../shared/voice';

const root = () => path.join(app.getPath('userData'), 'voice');
const dirs = {
  piper: () => path.join(root(), 'piper'),
  voices: () => path.join(root(), 'voices'),
  whisper: () => path.join(root(), 'whisper'),
  models: () => path.join(root(), 'models'),
  tmp: () => path.join(root(), 'tmp'),
};
const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);
const piperExe = () => path.join(dirs.piper(), 'piper', exe('piper'));
const whisperExe = () => path.join(dirs.whisper(), 'Release', exe('whisper-cli'));
const voiceFiles = (id: string) => ({
  model: path.join(dirs.voices(), `${id}.onnx`),
  config: path.join(dirs.voices(), `${id}.onnx.json`),
});
const sttFile = (id: string) => {
  const m = STT_MODELS.find((x) => x.id === id);
  return m ? path.join(dirs.models(), m.file) : null;
};

let installing: VoiceComponent | null = null;

// ---------- estado ----------

function speakersOf(voiceId: string): string[] {
  try {
    const cfg = JSON.parse(fs.readFileSync(voiceFiles(voiceId).config, 'utf8')) as { speaker_id_map?: Record<string, number> };
    return Object.keys(cfg.speaker_id_map ?? {});
  } catch {
    return [];
  }
}

export function voiceStatus(): VoiceStatus {
  const voices: VoiceStatus['voices'] = {};
  for (const v of PIPER_VOICES) {
    const f = voiceFiles(v.id);
    const installed = fs.existsSync(f.model) && fs.existsSync(f.config);
    voices[v.id] = { installed, speakers: installed ? speakersOf(v.id) : [] };
  }
  const sttModels: VoiceStatus['sttModels'] = {};
  for (const m of STT_MODELS) sttModels[m.id] = fs.existsSync(sttFile(m.id)!);
  return { piper: fs.existsSync(piperExe()), whisper: fs.existsSync(whisperExe()), voices, sttModels, installing };
}

// ---------- descargas ----------

type Progress = (p: VoiceProgress) => void;

/** SHA-256 que publica HuggingFace para un archivo LFS (cabecera x-linked-etag de la redirección). */
async function hfSha256(url: string): Promise<string | null> {
  try {
    const res = await net.fetch(url, { method: 'HEAD', redirect: 'manual' });
    const etag = res.headers.get('x-linked-etag');
    return etag && /^"?[0-9a-f]{64}"?$/i.test(etag) ? etag.replace(/"/g, '').toLowerCase() : null;
  } catch {
    return null;
  }
}

async function download(url: string, dest: string, component: VoiceComponent, onProgress: Progress, expectedSha: string | null) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let res: Response;
  try {
    res = await net.fetch(url);
  } catch (e) {
    throw new Error(`No se pudo conectar con ${new URL(url).host}. Revisa tu conexión a internet. (${(e as Error).message})`);
  }
  if (!res.ok || !res.body) throw new Error(`No se pudo descargar (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  const reader = res.body.getReader();
  let received = 0;
  let lastEmit = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      if (Date.now() - lastEmit > 150) {
        lastEmit = Date.now();
        onProgress({ component, phase: 'download', received, total });
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  onProgress({ component, phase: 'verify', received, total });
  const digest = hash.digest('hex');
  if (expectedSha && digest !== expectedSha) {
    fs.rmSync(tmp, { force: true });
    throw new Error('El archivo descargado no coincide con el esperado (SHA-256). Por seguridad no se ha instalado.');
  }
  fs.renameSync(tmp, dest);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr?.on('data', (d) => (err += String(d)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} terminó con código ${code}: ${err.slice(-300)}`))));
  });
}

/** Descomprime un .zip: tar.exe de Windows 10+, si no PowerShell; unzip fuera de Windows. */
async function extractZip(zip: string, dest: string) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'win32') {
    try {
      await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]);
    } catch {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]);
    }
  } else {
    await run('unzip', ['-q', '-o', zip, '-d', dest]);
  }
}

async function installArchive(component: VoiceComponent, archive: PinnedArchive, dest: string, onProgress: Progress) {
  const zip = path.join(dirs.tmp(), `${component}.zip`);
  await download(archive.url, zip, component, onProgress, archive.sha256);
  onProgress({ component, phase: 'extract' });
  try {
    await extractZip(zip, dest);
  } finally {
    fs.rmSync(zip, { force: true });
  }
}

async function installFile(component: VoiceComponent, url: string, dest: string, onProgress: Progress) {
  await download(url, dest, component, onProgress, await hfSha256(url));
}

export async function installComponent(component: VoiceComponent, onProgress: Progress): Promise<void> {
  if (installing) throw new Error('Ya se está instalando otro componente de voz.');
  installing = component;
  try {
    if (component === 'piper') {
      await installArchive(component, PIPER_BINARY, dirs.piper(), onProgress);
    } else if (component === 'whisper') {
      await installArchive(component, WHISPER_BINARY, dirs.whisper(), onProgress);
    } else if (component.startsWith('voice:')) {
      const v = PIPER_VOICES.find((x) => x.id === component.slice(6));
      if (!v) throw new Error('Voz desconocida.');
      const urls = piperVoiceUrls(v);
      const f = voiceFiles(v.id);
      await installFile(component, urls.config, f.config, onProgress);
      JSON.parse(fs.readFileSync(f.config, 'utf8')); // configuración válida
      await installFile(component, urls.model, f.model, onProgress);
    } else if (component.startsWith('stt:')) {
      const m = STT_MODELS.find((x) => x.id === component.slice(4));
      if (!m) throw new Error('Modelo desconocido.');
      await installFile(component, sttModelUrl(m), sttFile(m.id)!, onProgress);
    } else {
      throw new Error('Componente desconocido.');
    }
    onProgress({ component, phase: 'done' });
  } catch (e) {
    onProgress({ component, phase: 'error', message: (e as Error).message });
    throw e;
  } finally {
    installing = null;
  }
}

// ---------- texto → voz (Piper) ----------

/** Limpia el texto para leerlo: sin enlaces, markdown ni emojis. */
export function speakableText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>|~]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

/** Sintetiza con Piper y devuelve el WAV, o null si Piper o la voz no están instalados. */
export async function synthesize(text: string, voiceId: string | undefined, speaker: string | undefined, rate: number): Promise<Buffer | null> {
  const clean = speakableText(text);
  if (!clean || !fs.existsSync(piperExe())) return null;
  const st = voiceStatus();
  const id = voiceId && st.voices[voiceId]?.installed ? voiceId : PIPER_VOICES.find((v) => st.voices[v.id].installed)?.id;
  if (!id) return null;
  const f = voiceFiles(id);
  let speakerId: number | undefined;
  try {
    const cfg = JSON.parse(fs.readFileSync(f.config, 'utf8')) as { speaker_id_map?: Record<string, number> };
    const map = cfg.speaker_id_map ?? {};
    if (speaker && speaker in map) speakerId = map[speaker];
  } catch {
    /* sin hablantes */
  }
  fs.mkdirSync(dirs.tmp(), { recursive: true });
  const out = path.join(dirs.tmp(), `tts-${crypto.randomUUID()}.wav`);
  const args = ['--model', f.model, '--output_file', out, '--length_scale', String(Math.round((1 / Math.max(0.5, rate)) * 100) / 100), '--quiet'];
  if (speakerId !== undefined) args.push('--speaker', String(speakerId));
  await new Promise<void>((resolve, reject) => {
    const p = spawn(piperExe(), args, { windowsHide: true, cwd: path.dirname(piperExe()) });
    let err = '';
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Piper falló (${code}): ${err.slice(-300)}`))));
    p.stdin.end(clean + '\n', 'utf8');
  });
  try {
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

// ---------- voz → texto (whisper.cpp) ----------

/** Palabras que ayudan a whisper a escribir bien nombres frecuentes. */
const STT_HINT = 'Clau, Chati, Spotify, YouTube, Google, Firefox, Chrome, WhatsApp, Discord.';

export async function transcribe(wav: Buffer, modelId: string, language: string, agentNames: string[]): Promise<string> {
  if (!fs.existsSync(whisperExe())) throw new Error('Falta instalar el reconocimiento de voz (Ajustes → Voz).');
  const model = sttFile(modelId);
  if (!model || !fs.existsSync(model)) throw new Error('Falta descargar el modelo de reconocimiento de voz (Ajustes → Voz).');
  fs.mkdirSync(dirs.tmp(), { recursive: true });
  const file = path.join(dirs.tmp(), `stt-${crypto.randomUUID()}.wav`);
  fs.writeFileSync(file, wav);
  const threads = Math.max(1, Math.min(8, os.cpus().length));
  const hint = [...new Set([...agentNames, ...STT_HINT.split(', ')])].join(', ');
  const args = ['-m', model, '-f', file, '-l', language === 'auto' ? 'auto' : language, '-nt', '-np', '-t', String(threads), '--prompt', hint];
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(whisperExe(), args, { windowsHide: true, cwd: path.dirname(whisperExe()) });
      let stdout = '';
      let stderr = '';
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (d: string) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += String(d)));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`whisper falló (${code}): ${stderr.slice(-300)}`))));
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim()) // [BLANK_AUDIO], (música)...
      .filter(Boolean)
      .join(' ')
      .trim();
  } finally {
    fs.rmSync(file, { force: true });
  }
}
