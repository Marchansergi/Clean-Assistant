// Empaqueta el proceso principal, los preloads, el puente MCP y las vistas con esbuild.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });

const common = { bundle: true, sourcemap: false, logLevel: 'info', target: 'es2022' };

await Promise.all([
  build({ ...common, platform: 'node', format: 'cjs', external: ['electron'], entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(out, 'main/main.js') }),
  build({ ...common, platform: 'node', format: 'cjs', external: ['electron'], entryPoints: [path.join(root, 'src/preload/widget.ts')], outfile: path.join(out, 'preload/widget.js') }),
  build({ ...common, platform: 'node', format: 'cjs', external: ['electron'], entryPoints: [path.join(root, 'src/preload/overlay.ts')], outfile: path.join(out, 'preload/overlay.js') }),
  build({ ...common, platform: 'node', format: 'cjs', entryPoints: [path.join(root, 'src/mcp-bridge/index.ts')], outfile: path.join(out, 'mcp-bridge/index.js') }),
  build({ ...common, platform: 'browser', format: 'iife', entryPoints: [path.join(root, 'src/renderer/widget/widget.ts')], outfile: path.join(out, 'renderer/widget/widget.js') }),
  build({ ...common, platform: 'browser', format: 'iife', entryPoints: [path.join(root, 'src/renderer/overlay/overlay.ts')], outfile: path.join(out, 'renderer/overlay/overlay.js') }),
]);

for (const view of ['widget', 'overlay']) {
  const dir = path.join(root, 'src/renderer', view);
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.html') || f.endsWith('.css')) fs.copyFileSync(path.join(dir, f), path.join(out, 'renderer', view, f));
  }
}
console.log('Build listo en dist/');
