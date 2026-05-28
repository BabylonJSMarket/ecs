# Quick Start

A minimal example: a player capsule, a directional light, and a Movement system that ticks every frame. All in one file.

## The full example

```ts
import { World, Component, System, type ISystemQuery } from '@babylonjsmarket/ecs';
import { BabylonAdapter } from '@babylonjsmarket/ecs/babylon';

// 1. A data Component
class Velocity extends Component {
  x = 0;
  y = 0;
  z = 0;
}

// 2. A System that processes entities with that Component
class MoveSystem extends System {
  query: ISystemQuery = { required: [Velocity] };

  onUpdate(dt: number) {
    for (const entity of this.entities) {
      const v = entity.get(Velocity)!;
      // ...integrate position, talk to the renderer, emit events
    }
  }
}

// 3. Wire it all together
const canvas = document.getElementById('game') as HTMLCanvasElement;

const renderer = new BabylonAdapter();
await renderer.init(canvas, { clearColor: [0.05, 0.05, 0.1, 1] });

const world = new World({ renderer });
world.addSystem(new MoveSystem(world.getEventBus()));

const player = world.createEntity('Player');
const vel = new Velocity();
vel.x = 5;
player.add(vel);

// 4. Drive the loop with the renderer's frame ticker
renderer.startLoop((dt) => world.update(dt));
```

## What just happened

Read top to bottom:

1. **`Velocity extends Component`** — a plain data class. The base `Component` gives it a lifecycle (`onAttachOverride`, `onDetachOverride`) and an entity ID once it's attached.
2. **`MoveSystem extends System`** — declares a `query` saying "give me every entity that has a Velocity component." The framework maintains `this.entities` for you. `onUpdate(dt)` is called once per `world.update(dt)` call.
3. **`new BabylonAdapter()`** — concrete renderer adapter. `init(canvas, opts)` creates the BabylonJS engine, scene, and default camera. No work happens before that.
4. **`new World({ renderer })`** — the orchestrator. It owns the `EventBus`, the `SceneLoader`, the `RaceDetector`, the list of systems, the list of entities.
5. **`world.addSystem(new MoveSystem(world.getEventBus()))`** — Systems take the EventBus in their constructor so they can emit and subscribe to events without holding a reference to the World.
6. **`world.createEntity('Player')`** — entities are minted by the World so they get a unique ID and the right EventBus reference. You can add Components after creation.
7. **`renderer.startLoop((dt) => world.update(dt))`** — every adapter exposes `startLoop` / `stopLoop`. The callback fires each frame with the delta time in seconds. Pass that delta straight into `world.update`.

## What's missing from this example

This doesn't actually move anything on screen yet — `MoveSystem` would need to call `renderer.setMeshPosition(handle, x, y, z)` on a mesh handle the player owns. That's where the `MeshPrimitive` component from [@babylonjsmarket/arcade](/tools/bjs-arcade) comes in. The 14 components in that package spawn meshes, hook up cameras, wire keyboard input, etc.

If you want batteries included, jump to `@babylonjsmarket/arcade`. If you want to understand each piece, the rest of these sections walk through `Component`, `Entity`, `System`, `World`, and `EventBus` one at a time.

## Where to next

- **[Component](./component)** — what they are, how to write one
- **[System](./system)** — query options, lifecycle, event handling
- **[World](./world)** — ticking, options, the full constructor
- **[Renderers](./renderers)** — Babylon vs Three vs Mock
