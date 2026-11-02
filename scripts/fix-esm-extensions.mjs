#!/usr/bin/env node
/**
 * fix-esm-extensions.mjs — give dist's relative imports their file extension.
 *
 * The package is "type": "module", and tsc writes `export * from './ECS/types'`
 * just as the source has it. Bundlers resolve that; Node's ESM loader does not,
 * so anything running the build under Node (Vitest in a consumer, a server
 * script) failed with "Cannot find module …/dist/ECS/types". This rewrites each
 * relative specifier in dist/**.js and .d.ts to the file it names: `./x.js`,
 * or `./x/index.js` for a folder. Run after tsc (see "build").
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"]*)\2/g;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

let changed = 0;
for (const file of walk(dist)) {
  if (!/\.(js|d\.ts)$/.test(file)) continue;
  const here = path.dirname(file);
  const src = fs.readFileSync(file, 'utf8');
  const out = src.replace(SPEC, (all, lead, q, spec) => {
    if (/\.(m?js|json|css)$/.test(spec)) return all;
    const target = path.resolve(here, spec);
    if (fs.existsSync(`${target}.js`)) return `${lead}${q}${spec}.js${q}`;
    if (fs.existsSync(path.join(target, 'index.js'))) return `${lead}${q}${spec}/index.js${q}`;
    return all;
  });
  if (out !== src) { fs.writeFileSync(file, out); changed++; }
}
console.log(`fix-esm-extensions: ${changed} files rewritten`);
