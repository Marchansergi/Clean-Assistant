import { desktopCapturer, screen, type NativeImage } from 'electron';

/**
 * Geometría de la pantalla principal. Hay tres espacios de coordenadas:
 *  - físico: píxeles reales (lo que usa SendInput),
 *  - DIP: píxeles lógicos de Electron (lo que usa la capa del cursor),
 *  - modelo: píxeles de la captura reducida que ve el agente.
 */
export interface Geometry {
  physW: number;
  physH: number;
  scaleFactor: number;
  /** modelo = físico * scale */
  scale: number;
  shotW: number;
  shotH: number;
}

export function geometry(maxEdge: number): Geometry {
  const d = screen.getPrimaryDisplay();
  const physW = Math.round(d.size.width * d.scaleFactor);
  const physH = Math.round(d.size.height * d.scaleFactor);
  const scale = Math.min(1, maxEdge / Math.max(physW, physH));
  return {
    physW,
    physH,
    scaleFactor: d.scaleFactor,
    scale,
    shotW: Math.round(physW * scale),
    shotH: Math.round(physH * scale),
  };
}

export function modelToPhys(g: Geometry, x: number, y: number) {
  return {
    x: clamp(Math.round(x / g.scale), 0, g.physW - 1),
    y: clamp(Math.round(y / g.scale), 0, g.physH - 1),
  };
}

export function physToModel(g: Geometry, x: number, y: number) {
  return { x: Math.round(x * g.scale), y: Math.round(y * g.scale) };
}

export function physToDip(g: Geometry, x: number, y: number) {
  return { x: x / g.scaleFactor, y: y / g.scaleFactor };
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

export interface Shot {
  base64: string;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
}

async function captureFull(g: Geometry): Promise<NativeImage> {
  const d = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: g.physW, height: g.physH },
  });
  const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('No se pudo capturar la pantalla.');
  return src.thumbnail;
}

function encode(img: NativeImage): Shot {
  const size = img.getSize();
  return {
    base64: img.toJPEG(82).toString('base64'),
    mediaType: 'image/jpeg',
    width: size.width,
    height: size.height,
  };
}

export async function screenshot(g: Geometry): Promise<Shot> {
  const full = await captureFull(g);
  const img = g.scale < 1 ? full.resize({ width: g.shotW, height: g.shotH, quality: 'best' }) : full;
  return encode(img);
}

/** Recorte ampliado de una región (en coordenadas de modelo), escalado al tamaño de una captura normal. */
export async function zoom(g: Geometry, region: [number, number, number, number]): Promise<Shot> {
  const full = await captureFull(g);
  const a = modelToPhys(g, Math.min(region[0], region[2]), Math.min(region[1], region[3]));
  const b = modelToPhys(g, Math.max(region[0], region[2]), Math.max(region[1], region[3]));
  const rect = { x: a.x, y: a.y, width: Math.max(8, b.x - a.x), height: Math.max(8, b.y - a.y) };
  const crop = full.crop(rect);
  const fit = Math.min(g.shotW / rect.width, g.shotH / rect.height);
  const img = crop.resize({
    width: Math.max(1, Math.round(rect.width * fit)),
    height: Math.max(1, Math.round(rect.height * fit)),
    quality: 'best',
  });
  return encode(img);
}
