import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODELS } from '../../shared/defaults';
import { DeniedError, StopError, parseModifiers, type Action, type ActionResult } from '../desktop';
import { getSecret } from '../settings';
import { systemPrompt, taskPrompt, type RunContext } from './context';

type Input = Record<string, unknown>;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const coord = (v: unknown): [number, number] | undefined =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') ? [v[0], v[1]] : undefined;

/** Traduce un miembro del toolset `computer_toolset_20260801` a una acción normalizada. */
function toAction(name: string, input: Input): Action {
  const c = coord(input.coordinate);
  const mods = parseModifiers(input.text);
  const click = (button: 'left' | 'right' | 'middle', count: number): Action => ({
    kind: 'click', x: c?.[0], y: c?.[1], button, count, modifiers: mods,
  });
  switch (name) {
    case 'screenshot': return { kind: 'screenshot' };
    case 'zoom': {
      const r = input.region;
      if (!Array.isArray(r) || r.length !== 4) throw new Error('zoom necesita region [x0, y0, x1, y1]');
      return { kind: 'zoom', region: r as [number, number, number, number] };
    }
    case 'left_click': return click('left', 1);
    case 'right_click': return click('right', 1);
    case 'middle_click': return click('middle', 1);
    case 'double_click': return click('left', 2);
    case 'triple_click': return click('left', 3);
    case 'left_click_drag': {
      const start = coord(input.start_coordinate);
      if (!start || !c) throw new Error('left_click_drag necesita start_coordinate y coordinate');
      return { kind: 'drag', path: [{ x: start[0], y: start[1] }, { x: c[0], y: c[1] }], modifiers: mods };
    }
    case 'mouse_move':
      if (!c) throw new Error('mouse_move necesita coordinate');
      return { kind: 'move', x: c[0], y: c[1] };
    case 'left_mouse_down': return { kind: 'mouse_down' };
    case 'left_mouse_up': return { kind: 'mouse_up' };
    case 'cursor_position': return { kind: 'cursor_position' };
    case 'scroll': {
      const dir = input.scroll_direction;
      if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') throw new Error('scroll_direction no válido');
      return { kind: 'scroll', x: c?.[0], y: c?.[1], direction: dir, amount: num(input.scroll_amount) ?? 3, modifiers: mods };
    }
    case 'type':
      if (typeof input.text !== 'string') throw new Error('type necesita text');
      return { kind: 'type', text: input.text };
    case 'key':
      if (typeof input.text !== 'string') throw new Error('key necesita text');
      return { kind: 'key', keys: parseModifiers(input.text), repeat: num(input.repeat) ?? 1 };
    case 'hold_key':
      if (typeof input.text !== 'string') throw new Error('hold_key necesita text');
      return { kind: 'hold_key', keys: parseModifiers(input.text), seconds: num(input.duration) ?? 1 };
    case 'wait': return { kind: 'wait', seconds: num(input.duration) ?? 1 };
  }
  throw new Error(`Herramienta no soportada: ${name}`);
}

function toContent(r: ActionResult): Anthropic.ToolResultBlockParam['content'] {
  if (r.image) {
    return [{ type: 'image', source: { type: 'base64', media_type: r.image.mediaType, data: r.image.base64 } }];
  }
  return [{ type: 'text', text: r.text ?? 'OK' }];
}

export async function runAnthropic(ctx: RunContext): Promise<string> {
  const apiKey = getSecret('anthropic');
  if (!apiKey) throw new Error('Falta la API key de Anthropic. Añádela en Ajustes.');
  const client = new Anthropic({ apiKey });
  const model = ctx.agent.model || DEFAULT_MODELS.anthropic;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: taskPrompt(ctx.task, ctx.history) }];
  let lastText = '';

  for (let step = 1; step <= ctx.settings.maxSteps; step++) {
    ctx.onStep(step);
    const stream = client.messages.stream(
      {
        model,
        max_tokens: 32000,
        system: systemPrompt(ctx.agent, ctx.settings),
        messages,
        tools: [{ type: 'computer_toolset_20260801' }],
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: ctx.agent.effort },
        // Las capturas se reenvían en cada turno: la caché abarata mucho el bucle.
        cache_control: { type: 'ephemeral' },
      },
      { signal: ctx.signal },
    );
    stream.on('thinking', (delta) => ctx.emit({ type: 'thinking', text: delta }));
    stream.on('text', (delta) => ctx.emit({ type: 'text', text: delta }));

    let msg: Anthropic.Message;
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      if (ctx.signal.aborted) throw new StopError();
      throw explain(e);
    }

    messages.push({ role: 'assistant', content: msg.content });
    const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) lastText = text;

    if (msg.stop_reason === 'refusal') {
      throw new Error(`Claude ha rechazado continuar con esta petición${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : '.'}`);
    }
    if (msg.stop_reason === 'max_tokens') {
      ctx.emit({ type: 'info', text: 'La respuesta se cortó por longitud; sigo.' });
    }

    const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (uses.length === 0) {
      if (msg.stop_reason === 'pause_turn') continue;
      return lastText || 'Hecho.';
    }

    // Las acciones de un mismo turno se ejecutan en orden y se para en el primer fallo.
    const results: Anthropic.ToolResultBlockParam[] = [];
    let failed = false;
    for (const use of uses) {
      const base = { type: 'tool_result' as const, tool_use_id: use.id, toolset_name: use.toolset_name ?? undefined };
      if (failed) {
        results.push({ ...base, is_error: true, content: 'Not executed: an earlier computer action in this turn failed.' });
        continue;
      }
      if (use.toolset_name !== 'computer') {
        results.push({ ...base, is_error: true, content: `Herramienta desconocida: ${use.name}` });
        failed = true;
        continue;
      }
      try {
        const r = await ctx.desktop.perform(toAction(use.name, (use.input ?? {}) as Input));
        results.push({ ...base, content: toContent(r) });
      } catch (e) {
        if (e instanceof StopError) throw e;
        failed = true;
        const denied = e instanceof DeniedError;
        results.push({
          ...base,
          is_error: true,
          content: denied
            ? 'El usuario ha rechazado esta acción. No la repitas; pregunta qué prefiere hacer.'
            : `Error: ${(e as Error).message}`,
        });
      }
    }
    // Si el lote no terminó con una captura, adjuntamos una para que el modelo vea el resultado.
    const lastUse = uses[uses.length - 1];
    if (!failed && lastUse.name !== 'screenshot' && lastUse.name !== 'zoom') {
      const shot = await ctx.desktop.screenshot();
      const last = results[results.length - 1];
      const content = Array.isArray(last.content) ? last.content : [];
      last.content = [...content, { type: 'image', source: { type: 'base64', media_type: shot.mediaType, data: shot.base64 } }];
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error(`He llegado al límite de ${ctx.settings.maxSteps} pasos sin terminar. Puedes subirlo en Ajustes.`);
}

function explain(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError) return new Error('La API key de Anthropic no es válida.');
  if (e instanceof Anthropic.PermissionDeniedError) return new Error('Tu cuenta de Anthropic no tiene acceso a este modelo o función.');
  if (e instanceof Anthropic.NotFoundError) return new Error('Modelo no encontrado. Revisa el nombre del modelo en el agente.');
  if (e instanceof Anthropic.RateLimitError) return new Error('Límite de uso de la API alcanzado. Espera un poco y vuelve a intentarlo.');
  if (e instanceof Anthropic.BadRequestError) return new Error(`Petición rechazada por la API: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new Error('No hay conexión con la API de Anthropic.');
  if (e instanceof Anthropic.APIError) return new Error(`Error de la API de Anthropic (${e.status ?? '?'}): ${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}
