/**
 * Dev server for the adapter-comparison demo.
 *
 * - esbuild bundles compare.app.ts (+ adapter source under src/) to browser ESM,
 *   watching the whole dependency graph and rebuilding on save.
 * - A tiny static server sends `Cache-Control: no-store` for EVERYTHING, so the
 *   browser never serves a stale bundle (the reason earlier edits "did nothing").
 * - `/esbuild` is a server-sent-events channel; each rebuild pushes a `change`
 *   event and the page (see compare.html) reloads itself — true live reload.
 *
 * Engines stay external (resolved by the page's import map / CDN). Run via
 * `npm run examples` (node strips the TS types at runtime).
 */
import * as esbuild from 'esbuild';
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const PORT = 8080;
const ROOT = process.cwd(); // packages/ecs
const clients = new Set<ServerResponse>();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const ctx = await esbuild.context({
  entryPoints: ['examples/compare.app.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'examples/compare.bundle.js',
  external: ['three', '@babylonjs/*', '@dimforge/*'],
  sourcemap: true,
  plugins: [
    {
      name: 'live-reload',
      setup(build) {
        build.onEnd((result) => {
          const status = result.errors.length ? `FAILED (${result.errors.length} errors)` : 'ok';
          console.log(`[rebuild] ${status}`);
          for (const c of clients) c.write('event: change\ndata: 1\n\n');
        });
      },
    },
  ],
});

await ctx.watch();

createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  if (url === '/esbuild') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const rel = url === '/' ? '/examples/compare.html' : url;
  const path = normalize(join(ROOT, rel));
  // Stay inside the package root.
  if (path !== ROOT && !path.startsWith(ROOT + sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, () => {
  console.log(`\n  Adapter comparison (live reload, no cache):  http://localhost:${PORT}/examples/compare.html\n`);
});
