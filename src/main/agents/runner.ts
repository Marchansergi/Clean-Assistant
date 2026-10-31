import crypto from 'node:crypto';
import type { AgentEvent, RunStateMsg } from '../../shared/types';
import { DeniedError, StopError, type Desktop } from '../desktop';
import { getSettings } from '../settings';
import { runAnthropic } from './anthropic';
import { runClaudeCode, runCodex } from './cli';
import type { HistoryTurn, RunContext } from './context';
import { runOpenAI } from './openai';

export interface RunnerDeps {
  desktop: Desktop;
  emit: (agentId: string, taskId: string, e: AgentEvent) => void;
  state: (s: RunStateMsg) => void;
  confirm: (agentId: string, title: string, detail: string) => Promise<boolean>;
  /** Se llama al empezar y al terminar (p. ej. para mostrar/ocultar la capa y el atajo de parada). */
  onRunChange: (running: boolean, agentId: string | null) => void;
}

/**
 * Solo un agente trabaja a la vez: hay un único ratón y un único teclado reales,
 * y dos agentes a la vez se pelearían por ellos.
 */
export class Runner {
  private controller: AbortController | null = null;
  private current: { agentId: string; taskId: string } | null = null;
  private history = new Map<string, HistoryTurn[]>();

  constructor(private deps: RunnerDeps) {}

  get busy() {
    return this.current !== null;
  }

  clearHistory(agentId: string) {
    this.history.delete(agentId);
  }

  stop() {
    if (!this.controller || this.controller.signal.aborted) return;
    this.controller.abort();
    if (this.current) this.deps.state({ status: 'stopping', agentId: this.current.agentId, step: 0 });
  }

  async run(agentId: string, task: string): Promise<void> {
    if (this.current) throw new Error('Ya hay un agente trabajando. Detenlo o espera a que termine.');
    const settings = getSettings();
    const agent = settings.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error('Agente no encontrado.');

    const taskId = crypto.randomUUID();
    const controller = new AbortController();
    this.controller = controller;
    this.current = { agentId, taskId };
    const emit = (e: AgentEvent) => this.deps.emit(agentId, taskId, e);

    this.deps.desktop.bind(controller.signal);
    this.deps.onRunChange(true, agentId);
    this.deps.state({ status: 'running', agentId, step: 0 });
    emit({ type: 'user', text: task });

    const history = this.history.get(agentId) ?? [];
    const ctx: RunContext = {
      agent,
      settings,
      task,
      history,
      desktop: this.deps.desktop,
      signal: controller.signal,
      emit,
      confirm: (title, detail) => this.deps.confirm(agentId, title, detail),
      onStep: (step) => this.deps.state({ status: 'running', agentId, step }),
      screens: this.deps.desktop.screens(),
    };

    let result = '';
    try {
      switch (agent.provider) {
        case 'anthropic': result = await runAnthropic(ctx); break;
        case 'openai': result = await runOpenAI(ctx); break;
        case 'claude-code': result = await runClaudeCode(ctx); break;
        case 'codex': result = await runCodex(ctx); break;
      }
      emit({ type: 'done', text: result });
    } catch (e) {
      if (e instanceof StopError || controller.signal.aborted) {
        result = '(Detenido por el usuario)';
        emit({ type: 'info', text: 'Detenido. Tu ratón y teclado vuelven a ser solo tuyos.' });
      } else if (e instanceof DeniedError) {
        result = '(El usuario rechazó una acción)';
        emit({ type: 'info', text: 'Vale, no lo hago. Dime cómo prefieres seguir.' });
      } else {
        result = `(Error: ${(e as Error).message})`;
        emit({ type: 'error', text: (e as Error).message });
      }
    } finally {
      await this.deps.desktop.releaseAll().catch(() => undefined);
      history.push({ task, result: result.slice(0, 600) });
      this.history.set(agentId, history.slice(-10));
      this.controller = null;
      this.current = null;
      this.deps.onRunChange(false, null);
      this.deps.state({ status: 'idle', agentId: null, step: 0 });
    }
  }
}
