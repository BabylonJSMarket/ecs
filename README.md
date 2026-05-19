# @babylonjsmarket/ecs

The Entity-Component-System framework that powers [BabylonJS Market](https://babylonjsmarket.com) games — extracted from the in-house `CodeLibrary` and published as a standalone runtime so any project can depend on it.

## Where this fits

```
                      @babylonjsmarket/ecs              ← you are here
                                ▲
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
@babylonjsmarket/arcade   create-arcade games    your game
(curated components)     (scaffolded projects)
```

`@babylonjsmarket/ecs` is the foundation. It owns:

- **Core ECS** — `Component`, `Entity`, `System`, `World`, `EventBus`, `SceneLoader`, `SaveLoad`, `RaceDetector`.
- **The renderer contract** — `RendererAdapter` is the interface that decouples your game logic from any specific 3D engine.
- **Babylon and Three.js adapters** — `BabylonAdapter` (Havok physics, full scene support) and `ThreeAdapter` (with a pluggable JS physics integrator). Both live in this package so they evolve together, but each is behind a subpath so only the renderer you actually use gets pulled in.
- **Test infrastructure** — `MockRendererAdapter` for unit tests, and a `runMechanicContract` battery for proving a mechanic obeys the framework contract.

Everything is renderer-agnostic at the entity/system layer. Pick Babylon if you want first-class Havok physics and the full Babylon stack; pick Three if you want a leaner runtime and you're comfortable wiring physics yourself.

## Install

```bash
npm install @babylonjsmarket/ecs
```

The core entry has **zero runtime dependencies**. Renderer adapters are optional peer dependencies — install only the one you use:

```bash
# For BabylonJS
npm install @babylonjs/core @babylonjs/loaders @babylonjs/havok

# For Three.js
npm install three
```

## Entry points

| Import                                    | Contents                                                                                                                                                  | Peer deps                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `@babylonjsmarket/ecs`                    | Core: `Component`, `Entity`, `System`, `World`, `EventBus`, `SceneLoader`, `SaveLoad`, `RaceDetector`, `RendererAdapter` interface, `MockRendererAdapter`, `withRaceTracking` | none                                                            |
| `@babylonjsmarket/ecs/babylon`            | `BabylonAdapter`                                                                                                                                          | `@babylonjs/core`, `@babylonjs/loaders`, `@babylonjs/havok`     |
| `@babylonjsmarket/ecs/three`              | `ThreeAdapter` (accepts an injectable `physicsFactory`)                                                                                                   | `three`                                                         |
| `@babylonjsmarket/ecs/renderer-types`     | The full `RendererAdapter` type surface — tuple `Vec3`, handle types, spec interfaces                                                                     | none                                                            |
| `@babylonjsmarket/ecs/testing`            | `runMechanicContract` and related vitest helpers                                                                                                          | `vitest`                                                        |

## Quick start

```ts
import { World, Component, System, type ISystemQuery } from '@babylonjsmarket/ecs';
import { BabylonAdapter } from '@babylonjsmarket/ecs/babylon';

class Position extends Component {
  x = 0;
  y = 0;
  z = 0;
}

class MoveSystem extends System {
  query: ISystemQuery = { required: [Position] };
  onUpdate(dt: number) {
    for (const entity of this.entities) {
      const p = entity.get(Position)!;
      p.x += dt;
    }
  }
}

const renderer = new BabylonAdapter();
await renderer.init(canvas);

const world = new World({ renderer });
world.addSystem(new MoveSystem(world.eventBus));
const player = world.createEntity('Player');
player.add(new Position());

renderer.startLoop((dt) => world.update(dt));
```

## Concepts

### Components are data, Systems are logic

Components extend the `Component` base class and hold state. Systems extend `System`, declare a `query` (required components, excluded components, required tags), and implement `onUpdate(dt)`. The `World` matches entities to systems and runs them each frame.

### Events, not direct references

Systems publish via `eventBus.emit(name, data)` and subscribe via `eventBus.on(name, cb)`. This keeps systems decoupled — `PlayerInput` can fire `MOVE` events without knowing or caring that `Movement`, `Animation`, or `CameraShake` will listen.

### Renderer adapters are a thin port

The `RendererAdapter` interface is what every system uses to talk to the 3D engine. Adapters return opaque handles (`MeshHandle`, `LightHandle`, `CameraHandle`, …) that only the adapter that created them can interpret. This is what lets the same `MoveSystem` run unchanged under Babylon, Three, or the `MockRendererAdapter` used in unit tests.

### Race detection in development

If you pass `{ detectRaces: true }` to the `World` constructor, the renderer adapter is wrapped in a Proxy that records every handle mutation. When two systems write to the same handle in the same frame, you get a stack trace pointing at the conflict. Off in production.

## See also

- **[@babylonjsmarket/arcade](https://www.npmjs.com/package/@babylonjsmarket/arcade)** — A curated set of 14 reusable components (mesh, camera, lights, input, physics, scoring, animation) built on this framework. Start here if you want batteries included.
- **[@babylonjsmarket/create-arcade](https://www.npmjs.com/package/@babylonjsmarket/create-arcade)** — CLI scaffolder for new arcade-style games. Sets up a project that uses both packages above.
- **[BabylonJS Market](https://babylonjsmarket.com)** — Marketplace for additional components, full courses, and example games.

## Notes

- ESM only. `"type": "module"`.
- Built with TypeScript; ships `.d.ts` declarations.
- Debug viz panels (Solid.js) are not shipped from this package — they live in the consuming application or `@babylonjsmarket/arcade/viz`.
