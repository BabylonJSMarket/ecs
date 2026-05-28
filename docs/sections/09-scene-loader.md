# SceneLoader

`SceneLoader` parses JSON scene files into entities. It's renderer-agnostic — same JSON, same loading, whether your renderer is Babylon, Three, or Mock.

## Why a scene loader

Game levels are data, not code. Hard-coding entity creation makes:

- **Iteration slow** — change a position, rebuild the whole game
- **Authoring hostile** — non-programmers can't touch the level
- **Save/load awkward** — you've already invented half a serialization format ad-hoc

A scene loader fixes all three. Describe the world in JSON. Load it. Save mutations back to JSON. Reload anywhere.

## The basics

```ts
import { World, EventBus, SceneLoader } from '@babylonjsmarket/ecs';
import { BabylonAdapter } from '@babylonjsmarket/ecs/babylon';
import { Velocity, MoveSystem } from './my-game';

// Wire it up
const eventBus = new EventBus();
const sceneLoader = new SceneLoader(eventBus);
sceneLoader.registerComponent('Velocity', Velocity, MoveSystem);

const renderer = new BabylonAdapter();
await renderer.init(canvas);
const world = new World({ eventBus, sceneLoader, renderer });

// Load
const sceneData = await fetch('/scenes/level1.json').then((r) => r.json());
sceneLoader.loadSceneFromData(sceneData);

// Instantiate
const { entities, systems } = sceneLoader.instantiateScene(sceneData.name, world);
for (const system of systems) world.addSystem(system);
```

## The scene JSON shape

```json
{
  "name": "Level1",
  "entities": {
    "Player": {
      "tags": ["player"],
      "components": {
        "Velocity": { "x": 0, "y": 0, "z": 0 },
        "Health": { "current": 100, "max": 100 }
      }
    },
    "Enemy1": {
      "tags": ["enemy", "alive"],
      "components": {
        "Velocity": { "x": -1, "y": 0, "z": 0 }
      }
    }
  }
}
```

Top-level:
- `name` (required) — identifier for `instantiateScene(name, world)`
- `entities` (required) — map of entity-name → entity definition

Per-entity:
- `tags` (optional) — string array applied via `entity.addTag()`
- `components` (required) — map of component-name → component data
- The component-name keys must match what you passed to `registerComponent`

## Registering components

The SceneLoader has to know **which class corresponds to which name in the JSON**. You tell it:

```ts
sceneLoader.registerComponent('Velocity', VelocityComponent, VelocitySystem);
```

Arguments:
1. The string name as it appears in JSON
2. The `Component` subclass
3. (Optional) The `System` subclass — gets auto-instantiated when `instantiateScene` runs

Or in bulk:

```ts
sceneLoader.registerComponents({
  Velocity: { component: VelocityComponent, system: VelocitySystem },
  Health: { component: HealthComponent, system: HealthSystem },
  Position: { component: PositionComponent },  // no system
});
```

## What instantiateScene returns

```ts
const { entities, systems, worldEntity } = sceneLoader.instantiateScene(
  sceneData.name,
  world,
  { createSystems: true } // default true
);
```

- `entities` — `Map<string, Entity>` keyed by the entity-name in the JSON
- `systems` — `System[]` that were auto-created (one per registered Component-with-System that appeared in the scene). You still need to add these to the World.
- `worldEntity` — the entity whose name matches `sceneData.worldEntity` (used for global state like score-tracker components)

## Loading from a URL

The SceneLoader can fetch directly:

```ts
const sceneData = await sceneLoader.loadSceneFromUrl('/scenes/level1.json');
sceneLoader.instantiateScene(sceneData.name, world);
```

`loadSceneFromUrl` is a thin wrapper around `fetch` + `loadSceneFromData`. No magic. If you need custom headers or a non-fetch transport (cached scenes from IndexedDB, scenes embedded in another bundle), call `loadSceneFromData(data)` directly.

## Multiple scenes loaded at once

You can load many scenes and instantiate one at a time:

```ts
sceneLoader.loadSceneFromData(level1Json);
sceneLoader.loadSceneFromData(level2Json);
sceneLoader.loadSceneFromData(level3Json);

// later
sceneLoader.instantiateScene('Level1', world);
```

The loader stores parsed scene data by name. `instantiateScene` looks it up and builds entities.

## Lazy component resolution

`SceneLoader.registerComponent` requires the Component class **already imported** — the SceneLoader doesn't know how to find it on disk. This is intentional: it keeps the loader renderer-agnostic and zero-dependency.

If you want **lazy on-demand imports** — "when the JSON references `MeshPrimitive`, only then pull in the MeshPrimitive module" — that lives in the `ArcadeGame` class in [@babylonjsmarket/arcade](/tools/bjs-arcade). It wraps SceneLoader and adds a name → `() => import(...)` registry.

## Errors

The SceneLoader emits events on its EventBus while loading:

```ts
import { SceneLoaderEvents } from '@babylonjsmarket/ecs';

eventBus.on(SceneLoaderEvents.LOADING, ({ name }) => { /* show spinner */ });
eventBus.on(SceneLoaderEvents.LOADED,  ({ name, entityCount }) => { /* hide spinner */ });
eventBus.on(SceneLoaderEvents.ERROR,   ({ name, error }) => { /* show error */ });
```

A component name in the JSON that's not in the registry produces a warning in the console but doesn't throw — the entity is still created, missing components are silently skipped. Decide whether that's what you want for your project.

## Where to next

- **[Testing](./testing)** — running scene-loaded games in vitest
