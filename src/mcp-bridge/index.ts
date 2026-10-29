// Servidor MCP mínimo por stdio que lanzan Claude Code / Codex CLI.
// No toca el ordenador: reenvía cada llamada a la app por HTTP local (127.0.0.1 + token).
import { BRIDGE_TOOLS } from '../shared/bridge-tools';

const PORT = process.env.CA_BRIDGE_PORT;
const TOKEN = process.env.CA_BRIDGE_TOKEN;

type Json = Record<string, unknown>;

function send(msg: Json) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function callApp(name: string, args: unknown): Promise<Json> {
  const res = await fetch(`http://127.0.0.1:${PORT}/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN ?? '' },
    body: JSON.stringify({ name, args }),
  });
  if (!res.ok) throw new Error(`La app respondió ${res.status}: ${await res.text()}`);
  return (await res.json()) as Json;
}

async function handle(msg: Json) {
  const id = msg.id as string | number | undefined;
  const method = msg.method as string;
  const params = (msg.params ?? {}) as Json;
  if (id === undefined) return; // notificación
  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: (params.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'clean-assistant-escritorio', version: '0.1.0' },
          },
        });
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: BRIDGE_TOOLS } });
      case 'tools/call': {
        const result = await callApp(params.name as string, params.arguments ?? {});
        return send({ jsonrpc: '2.0', id, result });
      }
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Método no soportado: ${method}` } });
    }
  } catch (e) {
    return send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true },
    });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line) as Json);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON no válido' } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
