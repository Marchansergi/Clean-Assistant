// Herramientas que el puente MCP expone a Claude Code / Codex CLI.
// Las coordenadas están en el espacio de píxeles de las capturas que devuelve `screenshot`.

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const xy = {
  x: { type: 'number', description: 'X en píxeles de la captura' },
  y: { type: 'number', description: 'Y en píxeles de la captura' },
};

export const BRIDGE_TOOLS: BridgeTool[] = [
  {
    name: 'screenshot',
    description: 'Captura la pantalla del usuario. Úsala al empezar y para comprobar el resultado de tus acciones.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zoom',
    description: 'Devuelve una vista ampliada de una región para leer texto pequeño. Las coordenadas siguen siendo las de la captura completa.',
    inputSchema: {
      type: 'object',
      properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } },
      required: ['x0', 'y0', 'x1', 'y1'],
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Hace clic en un punto. Devuelve una captura del resultado.',
    inputSchema: {
      type: 'object',
      properties: {
        ...xy,
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        clicks: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
        modifiers: { type: 'string', description: 'Teclas mantenidas, p. ej. "ctrl" o "ctrl+shift"' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_mouse',
    description: 'Mueve el ratón sin hacer clic (para menús que se abren al pasar por encima).',
    inputSchema: { type: 'object', properties: xy, required: ['x', 'y'], additionalProperties: false },
  },
  {
    name: 'drag',
    description: 'Arrastra con el botón izquierdo desde un punto a otro.',
    inputSchema: {
      type: 'object',
      properties: { from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description: 'Desplaza con la rueda del ratón en un punto.',
    inputSchema: {
      type: 'object',
      properties: {
        ...xy,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', minimum: 1, maximum: 30, default: 3, description: 'Clics de rueda' },
      },
      required: ['x', 'y', 'direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    description: 'Escribe texto literal donde esté el foco del teclado.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'press_keys',
    description: 'Pulsa una tecla o combinación: "enter", "ctrl+l", "alt+tab", "win", "escape", "down".',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'string' }, repeat: { type: 'integer', minimum: 1, maximum: 100, default: 1 } },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description: 'Espera unos segundos (por ejemplo mientras carga una app) y devuelve una captura.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number', minimum: 0, maximum: 30 } }, required: ['seconds'], additionalProperties: false },
  },
];
