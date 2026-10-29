import type { MascotId } from '../../shared/types';

// Mascotas originales "inspiradas en" los logos (no son los logos oficiales).
// Si quieres usar otra imagen, cada agente admite un avatar propio en Ajustes.

function face(eyeY: number, spread: number, scale = 1): string {
  const r = 4.6 * scale;
  return `
    <g class="eyes">
      <ellipse cx="${50 - spread}" cy="${eyeY}" rx="${r}" ry="${r * 1.25}" fill="#1d1a1f"/>
      <ellipse cx="${50 + spread}" cy="${eyeY}" rx="${r}" ry="${r * 1.25}" fill="#1d1a1f"/>
      <circle cx="${50 - spread + 1.6 * scale}" cy="${eyeY - 2 * scale}" r="${1.6 * scale}" fill="#fff"/>
      <circle cx="${50 + spread + 1.6 * scale}" cy="${eyeY - 2 * scale}" r="${1.6 * scale}" fill="#fff"/>
    </g>
    <ellipse cx="${50 - spread - 6}" cy="${eyeY + 9}" rx="5" ry="3" fill="#ff8a9a" opacity=".55"/>
    <ellipse cx="${50 + spread + 6}" cy="${eyeY + 9}" rx="5" ry="3" fill="#ff8a9a" opacity=".55"/>
    <path class="mouth" d="M ${50 - 5} ${eyeY + 9} Q 50 ${eyeY + 15} ${50 + 5} ${eyeY + 9}" stroke="#1d1a1f" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
}

function claude(color: string): string {
  // Rayos finos de longitud alterna, como un destello.
  const petals = Array.from({ length: 12 }, (_, i) => {
    const long = i % 2 === 0;
    return `<rect x="${long ? 45.5 : 46}" y="${long ? 2 : 8}" width="${long ? 9 : 8}" height="${long ? 40 : 34}" rx="${long ? 4.5 : 4}" transform="rotate(${i * 30 + (i % 3) * 3} 50 50)"/>`;
  }).join('');
  return `
  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="mascot mascot-claude">
    <g class="body">
      <g class="petals" fill="${color}">${petals}</g>
      <circle cx="50" cy="50" r="28" fill="${color}"/>
      <circle cx="50" cy="52" r="23" fill="#fff" opacity=".16"/>
      ${face(48, 9)}
    </g>
  </svg>`;
}

function chatgpt(color: string): string {
  const lobes = Array.from({ length: 6 }, (_, i) =>
    `<rect x="37" y="12" width="26" height="46" rx="13" transform="rotate(${i * 60} 50 50)"/>`).join('');
  return `
  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="mascot mascot-chatgpt">
    <g class="body">
      <g class="petals" fill="${color}" stroke="#1d1a1f" stroke-width="3.2" stroke-linejoin="round">${lobes}</g>
      <circle cx="50" cy="50" r="23" fill="${color}"/>
      ${face(48, 8.5, 0.95)}
    </g>
  </svg>`;
}

export function mascotSvg(id: MascotId, color: string): string {
  return id === 'chatgpt' ? chatgpt(color) : claude(color);
}

/** Avatar del agente: imagen propia si la hay, si no la mascota. Devuelve HTML. */
export function avatarHtml(agent: { mascot: MascotId; color: string; avatarDataUrl?: string; name: string }): string {
  if (agent.avatarDataUrl && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(agent.avatarDataUrl)) {
    return `<img class="mascot mascot-img" src="${agent.avatarDataUrl}" alt="">`;
  }
  return mascotSvg(agent.mascot, agent.color);
}
