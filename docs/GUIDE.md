# ECS — User Guide

A renderer-agnostic Entity-Component-System framework for the web. Same code runs under BabylonJS, Three.js, or no renderer at all.

## Installation

The core package has zero runtime dependencies:

```bash
npm install @babylonjsmarket/ecs
```

Pick a renderer (install only what you use):

```bash
# For BabylonJS (with Havok physics)
npm install @babylonjs/core @babylonjs/loaders @babylonjs/havok

# For Three.js
npm install three
```

Both renderers ship inside `@babylonjsmarket/ecs` already. You're only installing them as **optional peer dependencies** so you don't pay for the one you didn't pick.

## Quick Start

```ts
import { World } from '@babylonjsmarket/ecs';
import { BabylonAdapter } from '@babylonjsmarket/ecs/babylon';

const renderer = new BabylonAdapter();
await renderer.init(canvas);

const world = new World({ renderer });

// Add systems, create entities, attach components...

renderer.startLoop((dt) => world.update(dt));
```

That's the loop. The next sections cover the four pieces that fill it in.

---

## Concepts

The framework has five concrete classes you'll touch every day: `Component`, `Entity`, `System`, `World`, `EventBus`. Plus two utility classes you'll use less often: `SceneLoader` and `RaceDetector`.

### Component

A `Component` is **data attached to an entity**. Extend the base class, add fields, done.

```ts
import { Component } from '@babylonjsmarket/ecs';

class Velocity extends Component {
  x = 0;
  y = 0;
  z = 0;
}

class Health extends Component {
  current = 100;
  max = 100;
}
```

Components have optional lifecycle hooks (`onAttachOverride()`, `onDetachOverride()`) for cleanup, but most components are pure data.

### Entity

An `Entity` is a **container with a unique ID** that holds components and tags. You don't construct entities directly — the World does:

```ts
const player = world.createEntity('Player');
player.add(new Velocity());
player.add(new Health());
player.addTag('player');

// Later:
const vel = player.get(Velocity);
if (player.hasTag('player')) { /* ... */ }
```

### System

A `System` is **logic that processes entities matching a query**. Override `onUpdate(dt)` for per-frame work, override `onEntityAdded`/`onEntityRemoved` for entity lifecycle.

```ts
import { System, type ISystemQuery } from '@babylonjsmarket/ecs';

class MoveSystem extends System {
  query: ISystemQuery = {
    required: [Velocity],   // entities must have Velocity
    excluded: [],            // entities must NOT have these
    tags: ['active'],        // entities must wear all these tags
  };

  onUpdate(dt: number) {
    for (const entity of this.entities) {
      const v = entity.get(Velocity)!;
      // ...integrate position, emit events, etc.
    }
  }
}

world.addSystem(new MoveSystem(world.getEventBus()));
```

The `entities` set is maintained automatically — the World watches every entity for matching the query and adds/removes from your system's set.

### World

The `World` is **the central orchestrator**. It owns entities, systems, the EventBus, the SceneLoader, and the renderer adapter.

```ts
const world = new World({
  renderer,                  // a RendererAdapter instance
  detectRaces: true,         // optional, see Race Detection below
});

world.addSystem(new MoveSystem(world.getEventBus()));
world.addSystem(new HealthSystem(world.getEventBus()));

const player = world.createEntity('Player');
// ...

renderer.startLoop((dt) => world.update(dt));
```

`world.update(dt)` advances every system by `dt` seconds. Call it from your render loop.

### EventBus

`EventBus` is **pub/sub for systems**. It's how systems coordinate without referencing each other.

```ts
// In one system:
this.eventBus.emit('damage.dealt', { target: entityId, amount: 10 });

// In another:
this.eventBus.on('damage.dealt', (data) => {
  // react to damage
});
```

Each component package conventionally exports an `Events` object listing the event names it emits:

```ts
export const VelocityEvents = {
  MOVED: 'velocity.moved',
  STOPPED: 'velocity.stopped',
} as const;
```

This keeps event names typo-proof and discoverable.

---

## Picking a Renderer

The framework defines the `RendererAdapter` interface. Two concrete implementations ship in the package:

| Subpath | Renderer | Peer deps |
|---|---|---|
| `@babylonjsmarket/ecs/babylon` | `BabylonAdapter` | `@babylonjs/core`, `@babylonjs/loaders`, `@babylonjs/havok` |
| `@babylonjsmarket/ecs/three` | `ThreeAdapter` | `three` |

### BabylonAdapter

Best when you want first-class physics (Havok) and the full BabylonJS feature set out of the box.

```ts
import { BabylonAdapter } from '@babylonjsmarket/ecs/babylon';

const renderer = new BabylonAdapter();
await renderer.init(canvas, { clearColor: [0.05, 0.05, 0.1, 1] });
```

### ThreeAdapter

Best when you want a leaner runtime. Three doesn't ship with physics, so you inject a pure-JS integrator:

```ts
import { ThreeAdapter } from '@babylonjsmarket/ecs/three';
import { createPhysics } from './my-physics-core';

const renderer = new ThreeAdapter({ physicsFactory: createPhysics });
await renderer.init(canvas);
```

You can adapt any physics library (Rapier, cannon-es, a homegrown integrator) by satisfying the `IPhysicsInstance` interface.

### MockRendererAdapter (tests)

Use this in vitest to assert renderer calls without a browser:

```ts
import { MockRendererAdapter, World } from '@babylonjsmarket/ecs';

const renderer = new MockRendererAdapter();
const world = new World({ renderer });
world.addSystem(new MoveSystem(world.getEventBus()));

// ...do something...

world.update(0.016);
expect(renderer.calls.setMeshPosition).toHaveLength(1);
```

---

## Testing Game Logic

The biggest practical advantage of an ECS: **your game runs in vitest**. No headless browser, no WebGL stub, no Puppeteer.

```ts
import { describe, it, expect } from 'vitest';
import { World, MockRendererAdapter } from '@babylonjsmarket/ecs';
import { MoveSystem, Velocity } from './my-game';

describe('MoveSystem', () => {
  it('integrates velocity into position', () => {
    const world = new World({ renderer: new MockRendererAdapter() });
    world.addSystem(new MoveSystem(world.getEventBus()));

    const e = world.createEntity('test');
    const v = new Velocity();
    v.x = 5;
    e.add(v);

    world.update(1); // 1 second

    // expect position has moved 5 on the x axis
  });
});
```

The `@babylonjsmarket/ecs/testing` subpath ships a `runMechanicContract` helper for a deeper compliance check — proves your component honors the framework contract (lifecycle, events, serialization).

---

## Race Detection

Enable it in development to catch a class of bug that's miserable to reproduce by hand: **two systems writing to the same mesh in the same frame**.

```ts
const world = new World({ renderer, detectRaces: true });
```

When a conflict happens, you get a stack trace pointing at both writes. In production, leave the flag off — the Proxy adds a tiny overhead per renderer call.

---

## Scene Loading

`SceneLoader` lets you describe a scene in JSON and instantiate it into a World:

```ts
import { World, EventBus, SceneLoader } from '@babylonjsmarket/ecs';
import { BabylonAdapter } from '@babylonjsmarket/ecs/babylon';
import { Velocity, MoveSystem } from './my-game';

const eventBus = new EventBus();
const sceneLoader = new SceneLoader(eventBus);

// Tell the loader which class corresponds to which name in the JSON
sceneLoader.registerComponent('Velocity', Velocity, MoveSystem);

const world = new World({ eventBus, sceneLoader, renderer });

const sceneData = await fetch('/scenes/level1.json').then((r) => r.json());
sceneLoader.loadSceneFromData(sceneData);
const { systems } = sceneLoader.instantiateScene(sceneData.name, world);

for (const system of systems) world.addSystem(system);
```

A scene JSON looks like:

```json
{
  "name": "Level1",
  "entities": {
    "Player": {
      "tags": ["player"],
      "components": {
        "Velocity": { "x": 0, "y": 0, "z": 0 }
      }
    }
  }
}
```

Want this with **lazy component loading** so bundlers only pull in what each scene uses? That's what `@babylonjsmarket/arcade` adds — the `ArcadeGame` class wraps World + SceneLoader and dynamically imports component modules on demand.

---

## SaveLoad

`SaveLoad` serializes a World's state to JSON and restores it later. Useful for checkpoints, replays, sharing exact states for bug reports.

```ts
import { SaveLoadSystem, SaveLoadComponent } from '@babylonjsmarket/ecs';

world.addSystem(new SaveLoadSystem(world.getEventBus()));
const saveSlot = world.createEntity('save');
saveSlot.add(new SaveLoadComponent());

// Emit a save event:
world.getEventBus().emit('saveload.save', { slot: 'auto' });

// Or load a previous state:
world.getEventBus().emit('saveload.load', { slot: 'auto', data: previousJson });
```

---

## Where to Go Next

- **[@babylonjsmarket/arcade](/tools/bjs-arcade)** — Curated starter components (camera, lighting, input, physics, score, animation) plus a lazy JSON scene loader. Install when you want batteries included.
- **[@babylonjsmarket/create-arcade](https://www.npmjs.com/package/@babylonjsmarket/create-arcade)** — CLI scaffolder that bootstraps a working arcade-style game using both packages above.
- **[GitHub source](https://github.com/babylonjsmarket/bjsm)** — the framework is small. Reading it is a good way to learn.

---

## License

MIT. No tracking, no telemetry, no rug-pulls.
