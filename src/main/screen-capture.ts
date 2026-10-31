import { desktopCapturer, screen, type Display, type NativeImage } from 'electron';

/**
 * Geometría de una pantalla. Hay tres espacios de coordenadas:
 *  - físico: píxeles reales del escritorio virtual de Windows (lo que usa SendInput),
 *  - DIP: píxeles lógicos de Electron, relativos a la pantalla (lo que usa su capa del cursor),
 *  - modelo: píxeles de la captura reducida de esa pantalla que ve el agente.
 */
export interface Geometry {
  displayId: number;
  /** Posición en la lista de pantallas (0 = principal). */
  index: number;
  physX: number;
  physY: number;
  physW: number;
  physH: number;
  scaleFactor: number;
  /** modelo = (físico - origen) * scale */
  scale: number;
  shotW: number;
  shotH: number;
}

/** Pantallas ordenadas: la principal primero y el resto de izquierda a derecha. */
export function listDisplays(): Display[] {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays()
    .filter((d) => d.id !== primary.id)
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  return [primary, ...others];
}

function physRect(d: Display) {
  // En Windows con pantallas de distinto escalado, solo el sistema sabe dónde cae cada una en píxeles reales.
  if (process.platform === 'win32') return screen.dipToScreenRect(null, d.bounds);
  return {
    x: Math.round(d.bounds.x * d.scaleFactor),
    y: Math.round(d.bounds.y * d.scaleFactor),
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
  };
}

export function geometry(maxEdge: number, index = 0): Geometry {
  const displays = listDisplays();
  const i = index >= 0 && index < displays.length ? index : 0;
  const d = displays[i];
  const r = physRect(d);
  const scale = Math.min(1, maxEdge / Math.max(r.width, r.height));
  return {
    displayId: d.id,
    index: i,
    physX: r.x,
    physY: r.y,
    physW: r.width,
    physH: r.height,
    scaleFactor: d.scaleFactor,
    scale,
    shotW: Math.round(r.width * scale),
    shotH: Math.round(r.height * scale),
  };
}

/** Descripción para el agente: "Pantalla 2: 2560×1440, a la derecha de la principal". */
export function describeDisplays(): string[] {
  const displays = listDisplays();
  const p = displays[0].bounds;
  return displays.map((d, i) => {
    const r = physRect(d);
    let where = 'principal';
    if (i > 0) {
      const b = d.bounds;
      where = b.x >= p.x + p.width ? 'a la derecha de la principal'
        : b.x + b.width <= p.x ? 'a la izquierda de la principal'
        : b.y + b.height <= p.y ? 'encima de la principal'
        : 'debajo de la principal';
    }
    return `Pantalla ${i + 1}: ${r.width}×${r.height}, ${where}`;
  });
}

export function modelToPhys(g: Geometry, x: number, y: number) {
  return {
    x: g.physX + clamp(Math.round(x / g.scale), 0, g.physW - 1),
    y: g.physY + clamp(Math.round(y / g.scale), 0, g.physH - 1),
  };
}

export function physToModel(g: Geometry, x: number, y: number) {
  return { x: Math.round((x - g.physX) * g.scale), y: Math.round((y - g.physY) * g.scale) };
}

/** Coordenadas DIP relativas a la pantalla, para su capa del cursor. */
export function physToDip(g: Geometry, x: number, y: number) {
  return { x: (x - g.physX) / g.scaleFactor, y: (y - g.physY) / g.scaleFactor };
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
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: g.physW, height: g.physH },
  });
  const src = sources.find((s) => s.display_id === String(g.displayId)) ?? sources[g.index] ?? sources[0];
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
  const size = full.getSize();
  const needsResize = size.width !== g.shotW || size.height !== g.shotH;
  return encode(needsResize ? full.resize({ width: g.shotW, height: g.shotH, quality: 'best' }) : full);
}

/** Recorte ampliado de una región (en coordenadas de modelo), escalado al tamaño de una captura normal. */
export async function zoom(g: Geometry, region: [number, number, number, number]): Promise<Shot> {
  let full = await captureFull(g);
  const size = full.getSize();
  if (size.width !== g.physW || size.height !== g.physH) full = full.resize({ width: g.physW, height: g.physH, quality: 'best' });
  const a = modelToPhys(g, Math.min(region[0], region[2]), Math.min(region[1], region[3]));
  const b = modelToPhys(g, Math.max(region[0], region[2]), Math.max(region[1], region[3]));
  // El recorte es sobre la imagen de esta pantalla: coordenadas relativas a su origen.
  const rect = { x: a.x - g.physX, y: a.y - g.physY, width: Math.max(8, b.x - a.x), height: Math.max(8, b.y - a.y) };
  const crop = full.crop(rect);
  const fit = Math.min(g.shotW / rect.width, g.shotH / rect.height);
  const img = crop.resize({
    width: Math.max(1, Math.round(rect.width * fit)),
    height: Math.max(1, Math.round(rect.height * fit)),
    quality: 'best',
  });
  return encode(img);
}
