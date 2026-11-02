// Micrófono (grabación + detección de fin de frase) y altavoz (cola de frases + nivel para la boca).

const SAMPLE_RATE = 16000;

/** WAV PCM de 16 bits mono, el formato que espera whisper.cpp. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export interface ListenOptions {
  deviceId?: string;
  onLevel?: (level: number) => void;
  /** Se ha detectado voz (para dar feedback). */
  onSpeech?: () => void;
}

/**
 * Escucha hasta que terminas de hablar (≈1,1 s de silencio tras haber hablado), hasta que se llama
 * a stop(), o 7 s sin oír nada. Devuelve las muestras a 16 kHz, o null si no habló nadie.
 */
export class Listener {
  private finish: (() => void) | null = null;
  private cancelled = false;

  get active() {
    return this.finish !== null;
  }

  /** Termina ya y transcribe lo grabado. */
  stop() {
    this.finish?.();
  }

  /** Termina sin transcribir. */
  cancel() {
    this.cancelled = true;
    this.finish?.();
  }

  async listen(opts: ListenOptions): Promise<Float32Array | null> {
    if (this.finish) throw new Error('Ya estoy escuchando.');
    this.cancelled = false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      const name = (e as DOMException).name;
      throw new Error(name === 'NotAllowedError'
        ? 'Windows no deja usar el micrófono. Actívalo en Configuración → Privacidad → Micrófono (aplicaciones de escritorio).'
        : name === 'NotFoundError' ? 'No encuentro ningún micrófono.' : `No se pudo abrir el micrófono (${name}).`);
    }
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await ctx.audioWorklet.addModule('recorder-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'recorder');
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node).connect(sink).connect(ctx.destination);

    const chunks: Float32Array[] = [];
    let total = 0;
    let floor = 0.004;
    let speechMs = 0;
    let silenceMs = 0;
    let started = false;
    const startedAt = performance.now();

    const done = new Promise<void>((resolve) => {
      this.finish = resolve;
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        const block = ev.data;
        chunks.push(block);
        total += block.length;
        let sum = 0;
        for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
        const rms = Math.sqrt(sum / block.length);
        const ms = (block.length / SAMPLE_RATE) * 1000;
        opts.onLevel?.(Math.min(1, rms * 12));
        // Umbral adaptativo: el ruido de fondo se aprende solo de los bloques sin voz
        // (si aprendiera mientras hablas, el umbral subiría por encima de tu voz).
        const threshold = Math.max(0.012, floor * 3);
        if (rms > threshold) {
          speechMs += ms;
          silenceMs = 0;
          if (!started && speechMs > 150) {
            started = true;
            opts.onSpeech?.();
          }
        } else if (started) {
          silenceMs += ms;
        } else {
          floor = floor * 0.95 + rms * 0.05;
          speechMs = Math.max(0, speechMs - ms); // un golpe suelto no cuenta como voz
        }
        const elapsed = performance.now() - startedAt;
        if ((started && silenceMs > 1100) || elapsed > 25000 || (!started && elapsed > 7000)) resolve();
      };
    });

    await done;
    this.finish = null;
    node.port.onmessage = null;
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    opts.onLevel?.(0);
    if (this.cancelled || !started) return null;
    const all = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.length;
    }
    return all;
  }
}

export interface SpeakerHooks {
  /** Nivel de voz 0..1 para mover la boca de la mascota. */
  onLevel: (level: number) => void;
  onTalking: (talking: boolean) => void;
}

/** Cola de frases: se dicen en orden y se pueden cortar en cualquier momento. */
export class Speaker {
  private ctx: AudioContext | null = null;
  private current: AudioBufferSourceNode | null = null;
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  private raf = 0;

  constructor(private hooks: SpeakerHooks) {}

  /** Corta lo que esté diciendo y vacía la cola. */
  stop() {
    this.generation++;
    try {
      this.current?.stop();
    } catch {
      /* ya había terminado */
    }
    this.current = null;
    speechSynthesis.cancel();
    this.setTalking(false);
  }

  /**
   * Encola una frase. `synth` devuelve el WAV de Piper o null para usar la voz de Windows.
   */
  say(text: string, synth: () => Promise<Uint8Array | null>, volume: number, rate: number) {
    const gen = this.generation;
    // La síntesis empieza ya (en paralelo) para que no haya silencios entre frases.
    const wav = synth().catch(() => null);
    this.chain = this.chain.then(async () => {
      if (gen !== this.generation) return;
      const data = await wav;
      if (gen !== this.generation) return;
      try {
        if (data) await this.playWav(data, volume, gen);
        else await this.speakSystem(text, volume, rate, gen);
      } catch (e) {
        // Un audio que no se puede reproducir no debe dejar la cola bloqueada.
        console.warn('No se pudo reproducir la voz:', e);
        this.setTalking(false);
      }
    });
  }

  private setTalking(on: boolean) {
    cancelAnimationFrame(this.raf);
    this.hooks.onTalking(on);
    if (!on) this.hooks.onLevel(0);
  }

  private async playWav(data: Uint8Array, volume: number, gen: number) {
    if (!this.ctx) this.ctx = new AudioContext();
    const ctx = this.ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    const buffer = await ctx.decodeAudioData(data.slice().buffer);
    if (gen !== this.generation) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume / 100;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(gain).connect(analyser).connect(ctx.destination);
    this.current = src;
    const samples = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const x of samples) sum += x * x;
      this.hooks.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 6));
      this.raf = requestAnimationFrame(tick);
    };
    this.setTalking(true);
    tick();
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
    if (this.current === src) this.current = null;
    this.setTalking(false);
  }

  /** Voz de Windows (sin descargas). La boca se anima con un vaivén suave. */
  private async speakSystem(text: string, volume: number, rate: number, gen: number) {
    const voices = speechSynthesis.getVoices();
    const voice = voices.find((v) => v.lang.toLowerCase().startsWith('es-es')) ?? voices.find((v) => v.lang.toLowerCase().startsWith('es'));
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? 'es-ES';
    u.volume = volume / 100;
    u.rate = rate;
    let t = 0;
    const tick = () => {
      t += 0.35;
      this.hooks.onLevel(0.35 + 0.35 * Math.abs(Math.sin(t)));
      this.raf = requestAnimationFrame(tick);
    };
    if (gen !== this.generation) return;
    this.setTalking(true);
    tick();
    await new Promise<void>((resolve) => {
      // Por si Windows no avisa del final: tiempo máximo según la longitud del texto.
      const guard = window.setTimeout(resolve, 4000 + text.length * 120);
      u.onend = u.onerror = () => {
        window.clearTimeout(guard);
        resolve();
      };
      speechSynthesis.speak(u);
    });
    this.setTalking(false);
  }
}

/** "para", "detente", "stop"… para detener al agente por voz. */
export const isStopCommand = (text: string) => /^\s*(para|párate|parar|detente|detén(te)?|stop|alto|cancela|cancelar)\b/i.test(text);
