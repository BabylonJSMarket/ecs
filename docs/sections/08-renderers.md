# Renderers

The framework defines `RendererAdapter`, an interface every renderer must implement. Three concrete adapters ship in the package: `BabylonAdapter`, `ThreeAdapter`, and `MockRendererAdapter`. Pick whichever fits your project — your game code works under all three.

## The contract

`RendererAdapter` is a flat interface — no inheritance, no event surface, no magic. Adapters return **opaque handles** (`MeshHandle`, `LightHandle`, `CameraHandle`, etc.) that only the adapter that created them can interpret. This is what keeps your game logic engine-agnostic.

Key methods (abridged):

```ts
interface RendererAdapter {
  // Lifecycle
  init(canvas: HTMLCanvasElement, opts?: RendererInitOptions): Promise<void>;
  startLoop(onFrame: (dt: number) => void): void;
  stopLoop(): void;
  dispose(): void;

  // Meshes
  createMesh(meshId: string, spec: PrimitiveSpec): MeshHandle;
  setMeshPosition(handle: MeshHandle, x: number, y: number, z: number): void;
  loadMesh(meshId: string, spec: MeshLoadSpec): Promise<MeshLoadResult>;
  // ...

  // Lights
  createDirectionalLight(spec: DirectionalLightSpec): LightHandle;
  createHemisphericLight(spec: HemisphericLightSpec): LightHandle;
  // ...

  // Physics
  physicsCreateBody(meshId: string, opts: PhysicsBodyOpts): void;
  physicsSetBodyVelocity(meshId: string, vx: number, vy: number, vz: number): void;
  physicsStep(dt: number): void;
  // ...
}
```

See the [renderer-types subpath](https://www.npmjs.com/package/@babylonjsmarket/ecs) for the full interface.

## BabylonAdapter

Best when you want first-class scene support and built-in Havok physics.

```ts
import { BabylonAdapter } from '@babylonjsmarket/ecs/babylon';

const renderer = new BabylonAdapter();
await renderer.init(canvas, {
  clearColor: [0.05, 0.05, 0.1, 1],
  antialias: true,
});
```

Under the hood, `BabylonAdapter` creates a Babylon `Engine`, a `Scene`, and lazy-initializes Havok the first time you call `physicsCreateBody`. It pulls Havok in via a dynamic import — no Havok bytes if you don't use physics.

**Peer dependencies**:
- `@babylonjs/core` (required for the engine + scene)
- `@babylonjs/loaders` (required for `.glb`/`.gltf`)
- `@babylonjs/havok` (required only if your scene uses physics)

## ThreeAdapter

Best when you want a leaner runtime. No bundled physics — bring your own integrator.

```ts
import { ThreeAdapter } from '@babylonjsmarket/ecs/three';
import { createPhysics } from './my-physics';

const renderer = new ThreeAdapter({ physicsFactory: createPhysics });
await renderer.init(canvas);
```

The `physicsFactory` option is a `() => IPhysicsInstance` — a zero-arg function that returns a physics world satisfying the interface in `@babylonjsmarket/ecs/renderer-types`. You can adapt any physics library (Rapier, cannon-es, a homegrown integrator) by writing a small wrapper.

The `@babylonjsmarket/arcade` package's `Physics.core.ts` is a working reference implementation of `IPhysicsInstance` — pure JS, no engine dependencies.

**Peer dependencies**:
- `three` (required)

## MockRendererAdapter

For unit tests. Records every method call so you can assert what your Systems did:

```ts
import { MockRendererAdapter, World } from '@babylonjsmarket/ecs';

const renderer = new MockRendererAdapter();
const world = new World({ renderer });
world.addSystem(new MoveSystem(world.getEventBus()));

const player = world.createEntity('Player');
// ... set up

world.update(0.016);

expect(renderer.calls.setMeshPosition).toHaveLength(1);
expect(renderer.calls.setMeshPosition[0]).toEqual([handle, 5, 0, 0]);
```

`MockRendererAdapter.calls` is an object keyed by adapter method name, with each value being an array of `[args, ...]` for every call to that method. Easy to assert against without a browser.

No peer dependencies. Runs in vitest under jsdom.

## Switching renderers

Because Systems only talk to the `RendererAdapter` interface, **the same Systems work under all three renderers**. Switch at the construction site:

```ts
const renderer = process.env.RENDERER === 'three'
  ? new ThreeAdapter({ physicsFactory: createPhysics })
  : new BabylonAdapter();

const world = new World({ renderer });
// ...everything else is identical
```

Game logic doesn't change. This is the headline of the framework.

## Writing your own adapter

If you want to add a third engine (PlayCanvas, A-Frame, a custom canvas, a server-only renderer for headless multiplayer), implement `RendererAdapter`. The interface is ~50 methods — most have obvious mappings. Use `MockRendererAdapter.ts` in the source as a starting template; it's the smallest complete implementation.

## Where to next

- **[SceneLoader](./scene-loader)** — load entities from JSON
- **[Testing](./testing)** — using `MockRendererAdapter` in vitest
