import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { app } from 'electron';
import { DeniedError, StopError, parseModifiers, type Action, type ActionResult } from '../desktop';
import { systemPrompt, taskPrompt, type RunContext } from './context';

// ---- Servidor local que recibe las llamadas del puente MCP ----

type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

const n = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function bridgeToAction(name: string, a: Record<string, unknown>): Action {
  switch (name) {
    case 'screenshot': return { kind: 'screenshot' };
    case 'zoom': return { kind: 'zoom', region: [n(a.x0), n(a.y0), n(a.x1), n(a.y1)] };
    case 'click': {
      const b = a.button === 'right' || a.button === 'middle' ? a.button : 'left';
      return { kind: 'click', x: n(a.x), y: n(a.y), button: b, count: Math.min(3, Math.max(1, n(a.clicks, 1))), modifiers: parseModifiers(a.modifiers) };
    }
    case 'move_mouse': return { kind: 'move', x: n(a.x), y: n(a.y) };
    case 'drag': return { kind: 'drag', path: [{ x: n(a.from_x), y: n(a.from_y) }, { x: n(a.to_x), y: n(a.to_y) }], modifiers: [] };
    case 'scroll': {
      const d = a.direction;
      if (d !== 'up' && d !== 'down' && d !== 'left' && d !== 'right') throw new Error('direction no válida');
      return { kind: 'scroll', x: n(a.x), y: n(a.y), direction: d, amount: n(a.amount, 3), modifiers: [] };
    }
    case 'type_text':
      if (typeof a.text !== 'string') throw new Error('Falta text');
      return { kind: 'type', text: a.text };
    case 'press_keys':
      if (typeof a.keys !== 'string') throw new Error('Falta keys');
      return { kind: 'key', keys: parseModifiers(a.keys), repeat: n(a.repeat, 1) };
    case 'wait': return { kind: 'wait', seconds: Math.min(30, n(a.seconds, 1)) };
  }
  throw new Error(`Herramienta desconocida: ${name}`);
}

async function runBridgeCall(ctx: RunContext, name: string, args: Record<string, unknown>): Promise<{ content: McpContent[]; isError?: boolean }> {
  try {
    const action = bridgeToAction(name, args);
    const r: ActionResult = await ctx.desktop.perform(action);
    const content: McpContent[] = [];
    if (r.text) content.push({ type: 'text', text: r.text });
    // Tras una acción devolvemos captura para que el agente vea el resultado sin otra llamada.
    const img = r.image ?? (action.kind === 'cursor_position' ? undefined : await ctx.desktop.screenshot());
    if (img) content.push({ type: 'image', data: img.base64, mimeType: img.mediaType });
    return { content };
  } catch (e) {
    if (e instanceof StopError) return { content: [{ type: 'text', text: 'El usuario ha detenido la tarea. Para ya.' }], isError: true };
    if (e instanceof DeniedError) return { content: [{ type: 'text', text: 'El usuario ha rechazado esta acción. No la repitas; pregunta qué prefiere.' }], isError: true };
    return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
  }
}

function startBridgeServer(ctx: RunContext): Promise<{ port: number; token: string; close: () => void }> {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tool' || req.headers['x-bridge-token'] !== token) {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const { name, args } = JSON.parse(body) as { name: string; args: Record<string, unknown> };
        const out = await runBridgeCall(ctx, name, args ?? {});
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400).end((e as Error).message);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('No se pudo abrir el puerto del puente.'));
      resolve({ port: addr.port, token, close: () => server.close() });
    });
  });
}

function bridgeScriptPath(): string {
  // Dentro del instalador el script está desempaquetado fuera del .asar.
  return path.join(__dirname, '..', 'mcp-bridge', 'index.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

/** Recibe cada línea JSONL del CLI; si lanza un error, se corta el proceso y la tarea falla con ese error. */
type LineHandler = (obj: Record<string, unknown>) => void;

async function runCli(ctx: RunContext, command: string, args: string[], stdinText: string, onLine: LineHandler): Promise<void> {
  const child = crossSpawn(command, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    cwd: app.getPath('home'),
  });
  const onAbort = () => killTree(child);
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  let buf = '';
  let stderr = '';
  let handlerError: Error | undefined;
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // línea que no es JSON
      }
      try {
        onLine(obj);
      } catch (e) {
        handlerError ??= e as Error;
        killTree(child);
      }
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (d: string) => (stderr = (stderr + d).slice(-4000)));
  child.stdin!.end(stdinText, 'utf8');

  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', (e: NodeJS.ErrnoException) => {
        reject(e.code === 'ENOENT' ? new Error(`No encuentro "${command}". Instálalo o pon la ruta completa en Ajustes.`) : e);
      });
      child.on('close', (code) => {
        if (ctx.signal.aborted) return reject(new StopError());
        if (handlerError) return reject(handlerError);
        if (code === 0) resolve();
        else reject(new Error(`${path.basename(command)} terminó con código ${code}. ${stderr.trim().slice(-800)}`));
      });
    });
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

// ---- Claude Code (suscripción Pro/Max) ----

export async function runClaudeCode(ctx: RunContext): Promise<string> {
  const bridge = await startBridgeServer(ctx);
  const cfgPath = path.join(app.getPath('temp'), `clean-assistant-mcp-${bridge.token.slice(0, 8)}.json`);
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      mcpServers: {
        escritorio: {
          command: process.execPath,
          args: [bridgeScriptPath()],
          env: { ELECTRON_RUN_AS_NODE: '1', CA_BRIDGE_PORT: String(bridge.port), CA_BRIDGE_TOKEN: bridge.token },
        },
      },
    }),
    { encoding: 'utf8', mode: 0o600 },
  );

  // El prompt de sistema va por stdin: cmd.exe no admite saltos de línea en argumentos.
  const prompt = `${systemPrompt(ctx.agent, ctx.settings)}\n\nTienes las herramientas mcp__escritorio__* para ver y controlar la pantalla. No uses ninguna otra.\n\n---\n\n${taskPrompt(ctx.task, ctx.history)}`;
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', cfgPath,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__escritorio',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task',
    '--max-turns', String(ctx.settings.maxSteps),
  ];
  if (ctx.agent.model) args.push('--model', ctx.agent.model);

  let finalText = '';
  let step = 0;
  try {
    await runCli(ctx, ctx.settings.claudeCliPath || 'claude', args, prompt, (obj) => {
      if (obj.type === 'assistant') {
        const content = ((obj.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            finalText = block.text;
            ctx.emit({ type: 'text', text: block.text + '\n' });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            ctx.emit({ type: 'thinking', text: block.thinking + '\n' });
          } else if (block.type === 'tool_use') {
            ctx.onStep(++step);
          }
        }
      } else if (obj.type === 'result') {
        if (obj.is_error) throw new Error(`Claude Code: ${String(obj.result ?? obj.subtype ?? 'error')}`);
        if (typeof obj.result === 'string' && obj.result) finalText = obj.result;
      }
    });
  } finally {
    bridge.close();
    fs.rmSync(cfgPath, { force: true });
  }
  return finalText || 'Hecho.';
}

// ---- Codex CLI (suscripción ChatGPT) — experimental ----

const toml = (s: string) => JSON.stringify(s); // las cadenas básicas TOML usan los mismos escapes

export async function runCodex(ctx: RunContext): Promise<string> {
  const bridge = await startBridgeServer(ctx);
  const env = `{ ELECTRON_RUN_AS_NODE = "1", CA_BRIDGE_PORT = ${toml(String(bridge.port))}, CA_BRIDGE_TOKEN = ${toml(bridge.token)} }`;
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox', 'read-only',
    '-c', `mcp_servers.escritorio.command=${toml(process.execPath)}`,
    '-c', `mcp_servers.escritorio.args=[${toml(bridgeScriptPath())}]`,
    '-c', `mcp_servers.escritorio.env=${env}`,
  ];
  if (ctx.agent.model) args.push('-m', ctx.agent.model);
  args.push('-');
  const prompt = `${systemPrompt(ctx.agent, ctx.settings)}\n\nUsa solo las herramientas MCP del servidor "escritorio" para ver y controlar la pantalla. No ejecutes comandos de terminal.\n\n---\n\n${taskPrompt(ctx.task, ctx.history)}`;

  let finalText = '';
  let step = 0;
  try {
    await runCli(ctx, ctx.settings.codexCliPath || 'codex', args, prompt, (obj) => {
      const item = obj.item as Record<string, unknown> | undefined;
      if (obj.type === 'item.completed' && item) {
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          finalText = item.text;
          ctx.emit({ type: 'text', text: item.text + '\n' });
        } else if (item.type === 'reasoning' && typeof item.text === 'string') {
          ctx.emit({ type: 'thinking', text: item.text + '\n' });
        } else if (item.type === 'mcp_tool_call') {
          ctx.onStep(++step);
        }
      } else if (obj.type === 'error' || obj.type === 'turn.failed') {
        const err = (obj.error as { message?: string } | undefined)?.message ?? obj.message;
        throw new Error(`Codex: ${String(err ?? 'error')}`);
      }
    });
  } finally {
    bridge.close();
  }
  return finalText || 'Hecho.';
}
