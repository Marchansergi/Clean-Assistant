import OpenAI from 'openai';
import type {
  ComputerAction,
  ResponseComputerToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import { DEFAULT_MODELS } from '../../shared/defaults';
import { DeniedError, StopError, type Action } from '../desktop';
import { getSecret } from '../settings';
import { systemPrompt, taskPrompt, type RunContext } from './context';

type AnyAction = ComputerAction | NonNullable<ResponseComputerToolCall['action']>;

const BUTTONS: Record<string, 'left' | 'right' | 'middle'> = { left: 'left', right: 'right', wheel: 'middle' };

function toAction(a: AnyAction): Action {
  switch (a.type) {
    case 'screenshot': return { kind: 'screenshot' };
    case 'click': {
      const button = BUTTONS[a.button];
      if (!button) throw new Error(`Botón de ratón no soportado: ${a.button}`);
      return { kind: 'click', x: a.x, y: a.y, button, count: 1, modifiers: a.keys ?? [] };
    }
    case 'double_click': return { kind: 'click', x: a.x, y: a.y, button: 'left', count: 2, modifiers: a.keys ?? [] };
    case 'move': return { kind: 'move', x: a.x, y: a.y };
    case 'drag': return { kind: 'drag', path: a.path.map((p) => ({ x: p.x, y: p.y })), modifiers: a.keys ?? [] };
    case 'keypress': return { kind: 'key', keys: a.keys, repeat: 1 };
    case 'type': return { kind: 'type', text: a.text };
    case 'wait': return { kind: 'wait', seconds: 2 };
    case 'scroll': {
      // scroll_x/scroll_y vienen en píxeles; ~100 px por clic de rueda.
      const vertical = Math.abs(a.scroll_y) >= Math.abs(a.scroll_x);
      const amount = Math.max(1, Math.round(Math.abs(vertical ? a.scroll_y : a.scroll_x) / 100));
      const direction = vertical ? (a.scroll_y > 0 ? 'down' : 'up') : a.scroll_x > 0 ? 'right' : 'left';
      return { kind: 'scroll', x: a.x, y: a.y, direction, amount, modifiers: a.keys ?? [] };
    }
  }
}

export async function runOpenAI(ctx: RunContext): Promise<string> {
  const apiKey = getSecret('openai');
  if (!apiKey) throw new Error('Falta la API key de OpenAI. Añádela en Ajustes.');
  const client = new OpenAI({ apiKey });
  const model = ctx.agent.model || DEFAULT_MODELS.openai;
  const instructions = systemPrompt(ctx.agent, ctx.settings);

  let previousId: string | undefined;
  let input: ResponseInputItem[] = [{ role: 'user', content: taskPrompt(ctx.task, ctx.history) }];
  let lastText = '';

  for (let step = 1; step <= ctx.settings.maxSteps; step++) {
    ctx.onStep(step);
    let resp: OpenAI.Responses.Response;
    try {
      resp = await client.responses.create(
        {
          model,
          instructions,
          input,
          previous_response_id: previousId,
          tools: [{ type: 'computer' }],
          reasoning: { effort: ctx.agent.effort === 'max' || ctx.agent.effort === 'xhigh' ? 'high' : ctx.agent.effort, summary: 'auto' },
          truncation: 'auto',
        },
        { signal: ctx.signal },
      );
    } catch (e) {
      if (ctx.signal.aborted) throw new StopError();
      throw explain(e);
    }
    previousId = resp.id;

    for (const item of resp.output) {
      if (item.type === 'reasoning') {
        for (const s of item.summary ?? []) if (s.text) ctx.emit({ type: 'thinking', text: s.text + '\n' });
      } else if (item.type === 'message') {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) {
            lastText = c.text;
            ctx.emit({ type: 'text', text: c.text });
          } else if (c.type === 'refusal') {
            throw new Error(`ChatGPT ha rechazado la petición: ${c.refusal}`);
          }
        }
      }
    }

    const calls = resp.output.filter((o): o is ResponseComputerToolCall => o.type === 'computer_call');
    if (calls.length === 0) return lastText || 'Hecho.';

    input = [];
    for (const call of calls) {
      // OpenAI marca a veces acciones como sensibles: siempre se lo preguntamos al usuario.
      if (call.pending_safety_checks.length) {
        const detail = call.pending_safety_checks.map((c) => c.message || c.code || 'Comprobación de seguridad').join('\n');
        const ok = await ctx.confirm('ChatGPT pide confirmación de seguridad', detail);
        if (!ok) throw new DeniedError();
      }
      const actions: AnyAction[] = call.actions?.length ? call.actions : call.action ? [call.action] : [];
      for (const a of actions) {
        await ctx.desktop.perform(toAction(a));
      }
      const shot = await ctx.desktop.screenshot();
      input.push({
        type: 'computer_call_output',
        call_id: call.call_id,
        output: { type: 'computer_screenshot', image_url: `data:${shot.mediaType};base64,${shot.base64}` },
        acknowledged_safety_checks: call.pending_safety_checks.map((c) => ({ id: c.id, code: c.code, message: c.message })),
      });
    }
  }
  throw new Error(`He llegado al límite de ${ctx.settings.maxSteps} pasos sin terminar. Puedes subirlo en Ajustes.`);
}

function explain(e: unknown): Error {
  if (e instanceof OpenAI.AuthenticationError) return new Error('La API key de OpenAI no es válida.');
  if (e instanceof OpenAI.PermissionDeniedError) return new Error('Tu cuenta de OpenAI no tiene acceso a este modelo o a la herramienta de ordenador.');
  if (e instanceof OpenAI.NotFoundError) return new Error('Modelo no encontrado. Revisa el nombre del modelo en el agente.');
  if (e instanceof OpenAI.RateLimitError) return new Error('Límite de uso o saldo de OpenAI agotado.');
  if (e instanceof OpenAI.BadRequestError) return new Error(`Petición rechazada por OpenAI: ${e.message}`);
  if (e instanceof OpenAI.APIConnectionError) return new Error('No hay conexión con la API de OpenAI.');
  if (e instanceof OpenAI.APIError) return new Error(`Error de la API de OpenAI (${e.status ?? '?'}): ${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}
