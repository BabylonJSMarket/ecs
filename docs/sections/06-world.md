# World

The `World` is **the orchestrator**. It owns the entities, the systems, the EventBus, the SceneLoader, the renderer adapter, and the per-frame tick. Everything else in the framework flows through it.

## Constructing a World

```ts
import { World } from '@babylonjsmarket/ecs';
import { BabylonAdapter } from '@babylonjsmarket/ecs/babylon';

const renderer = new BabylonAdapter();
await renderer.init(canvas);

const world = new World({ renderer });
```

That's the minimum. You can pass more:

```ts
const world = new World({
  renderer,
  detectRaces: true,        // wraps the adapter in a race-detection Proxy
  eventBus: customEventBus, // optional — usually let the World create one
  sceneLoader: customSceneLoader, // same
});
```

The World creates its own `EventBus` and `SceneLoader` if you don't supply them. Supplying your own is useful in tests or when you want to share an EventBus across multiple Worlds (rare, but supported).

## What's on the World

```ts
world.getEventBus()  // EventBus instance, shared with every System
world.renderer       // RendererAdapter — what Systems use to draw
world.sceneLoader    // SceneLoader — for JSON scene loading
world.raceDetector   // RaceDetector — used when detectRaces: true
```

The `eventBus` field itself is `protected` — call `world.getEventBus()` from the outside.

## Ticking

`world.update(dt)` advances every System by `dt` seconds. Call it from your render loop:

```ts
renderer.startLoop((dt) => world.update(dt));
```

Internally, `update(dt)` does:

1. Flushes any pending entity creates/destroys
2. Re-evaluates queries for entities that changed components or tags
3. Calls `onEntityAdded`/`onEntityRemoved` on every affected System
4. Calls `onUpdate(dt)` on every System in addition order
5. Dispatches any events queued during the frame

The `dt` value is in **seconds**, not milliseconds — divide your raw frame time accordingly if your timing source uses milliseconds.

## Creating entities

```ts
const player = world.createEntity('Player');
```

`createEntity(name)` mints a new Entity with a unique ID and the right EventBus reference. The entity is live immediately — you can add components, query for it, etc.

## Destroying entities

```ts
world.destroyEntity(player);
world.destroyEntityById(player.id);
```

Destruction happens at the **end of the frame**. The entity remains in `world.getAllEntities()` until the next `world.update()` call. This avoids the classic bug where iterating over entities and destroying mid-loop corrupts the iterator.

## Adding systems

```ts
world.addSystem(new MoveSystem(world.getEventBus()));
world.addSystem(new RenderSyncSystem(world.getEventBus()));
```

Add Systems in **dependency order** — Systems that produce values first, Systems that consume them later. The World runs Systems in addition order with no parallelism.

Once added, a System can't be removed (this is intentional — System hot-swap leads to a lot of subtle bugs in practice). Create a new World if you need a clean state.

## Querying outside Systems

Sometimes you need to look up entities from outside a System — UI code, debug commands, multiplayer sync, etc.

```ts
const player = world.getEntityById('ent_a7...');
const enemies = world.getEntitiesByTag('enemy');
const named = world.getEntitiesByName('Boss');
const all = world.getAllEntities();
```

For per-frame iteration, **stay inside a System** — `system.entities` is pre-filtered and cached. The `getEntitiesByX` methods scan the master list each call.

## The full constructor options

```ts
interface IWorldOptions {
  renderer?: RendererAdapter;
  eventBus?: EventBus;
  sceneLoader?: SceneLoader;
  detectRaces?: boolean;
}
```

`renderer` is optional — a World can run "headless" with no rendering, useful in tests. Systems that reach for `this.world.renderer` will fail if it's `undefined`, so make sure your test World registers only Systems that work without a renderer (or use `MockRendererAdapter`).

## Multiple Worlds

You can run multiple Worlds in the same process — useful for split-screen, networked games where you need to simulate "their" view, or running a deterministic test World alongside the live game.

Each World has its own entities, Systems, EventBus, and renderer. They don't share state unless you wire it up explicitly.

## Where to next

- **[EventBus](./event-bus)** — the pub/sub between Systems
- **[Race Detection](./race-detection)** — what `detectRaces: true` catches
