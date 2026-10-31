// Sonidos del notch sintetizados con Web Audio: no hace falta ningún archivo de audio.

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Una nota corta con deslizamiento de tono y caída suave. */
function blip(ac: AudioContext, out: AudioNode, at: number, from: number, to: number, dur: number, peak: number, type: OscillatorType) {
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + dur * 0.6);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/** Abrir: dos notas que suben, como una burbuja. Cerrar: una nota que baja, más discreta. */
export function playNotchSound(kind: 'open' | 'close', volume: number) {
  if (volume <= 0) return;
  try {
    const ac = audio();
    const now = ac.currentTime + 0.01;
    const master = ac.createGain();
    master.gain.value = Math.min(1, volume / 100) * 0.5;
    const tone = ac.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3200;
    master.connect(tone).connect(ac.destination);
    if (kind === 'open') {
      blip(ac, master, now, 520, 780, 0.16, 0.32, 'sine');
      blip(ac, master, now + 0.065, 780, 1170, 0.22, 0.22, 'sine');
      blip(ac, master, now + 0.065, 1560, 2340, 0.12, 0.05, 'triangle');
    } else {
      blip(ac, master, now, 900, 540, 0.17, 0.26, 'sine');
      blip(ac, master, now + 0.05, 600, 400, 0.16, 0.14, 'sine');
    }
  } catch {
    /* sin salida de audio: no pasa nada */
  }
}
