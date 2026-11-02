// Worklet de audio: pasa al hilo principal cada bloque de muestras del micrófono.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
