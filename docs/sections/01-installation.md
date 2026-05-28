# Installation

`@babylonjsmarket/ecs` ships as a single ESM-only npm package. The core has **zero runtime dependencies** — renderer adapters and physics engines are optional peer dependencies that you install only when you need them.

## The core package

```bash
npm install @babylonjsmarket/ecs
```

That's enough to start writing Components, Entities, Systems, and a World. You can run the full ECS in vitest without touching a browser — useful for unit-testing game logic.

## Picking a renderer

The framework defines the `RendererAdapter` interface. Two concrete adapters ship inside `@babylonjsmarket/ecs`, behind subpath imports. Install the underlying engine only for the one you actually use.

### BabylonJS (recommended)

First-class scene support and built-in Havok physics.

```bash
npm install @babylonjs/core @babylonjs/loaders @babylonjs/havok
```

```ts
import { BabylonAdapter } from '@babylonjsmarket/ecs/babylon';
```

### Three.js

Leaner runtime. No bundled physics — bring your own integrator via the `physicsFactory` constructor option.

```bash
npm install three
```

```ts
import { ThreeAdapter } from '@babylonjsmarket/ecs/three';
```

### MockRendererAdapter (tests)

No install. Lives in the core entry. Used in vitest to assert that systems made the right renderer calls without a browser:

```ts
import { MockRendererAdapter } from '@babylonjsmarket/ecs';
```

## Module resolution

The package is **ESM only**. Your project's `package.json` should include `"type": "module"` or your bundler must support ESM imports.

The subpath exports use modern conditional exports:

```
@babylonjsmarket/ecs              → core + Mock + race tracking
@babylonjsmarket/ecs/babylon      → BabylonAdapter
@babylonjsmarket/ecs/three        → ThreeAdapter
@babylonjsmarket/ecs/renderer-types → RendererAdapter interface + Vec3/Color tuples
@babylonjsmarket/ecs/testing      → runMechanicContract helper
```

Every modern bundler — Vite, esbuild, Rollup, webpack 5+ — resolves these correctly. If you're stuck on an older toolchain that doesn't honor `exports`, upgrade.

## TypeScript

The package ships full `.d.ts` declarations. No separate `@types/...` package needed. The `RendererAdapter` interface is fully typed; opaque handles like `MeshHandle` use phantom types to keep handles from one adapter from leaking into another.

## What's next

The [Quick Start](./quick-start) walks through wiring all this together — adapter, World, a couple of Systems, a moving capsule on screen.
