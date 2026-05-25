---
name: ecs-authoring
description: Author and review code for the @babylonjsmarket/ecs framework. Use when writing or reviewing Systems, Components, scene JSON, or example markdown — including any file that imports from @babylonjsmarket/ecs, defines a class extending System/Component, or uses World/EventBus/SceneLoader.
---

# Authoring @babylonjsmarket/ecs code

This package provides a renderer-agnostic Entity-Component-System framework with Babylon and Three adapters.

## Core surface

- **`World`** — orchestrator. `world.createEntity()`, `world.addSystem(sys)`, `world.update(dt)`. **Entity pools:** `world.registerPool(name, { size, build, reset })` pre-allocates reusable entities; `world.acquire(name, data)` un-parks + resets one; `world.release(entity)` (and `removeEntity` on a pooled entity) parks it (`active=false`, kept alive) instead of destroying.
- **`Entity`** — id + components + tags. `entity.add(c)`, `entity.get(C)`, `entity.hasTag(t)`.
- **`Component`** — pure data. Extend `Component`. Lifecycle hooks: `onAttachOverride()`, `onDetachOverride()`.
- **`System`** — per-frame logic. Set `this.query = { required, excluded, tags }` in constructor. Override `onUpdate(dt)`, `onEntityAdded(e)`, `onEntityRemoved(e)`.
- **`EventBus`** — pub/sub passed into each system constructor. `eventBus.emit(name, data)`, `eventBus.on(name, cb)`.
- **`SceneLoader`** — turns scene JSON into entities/components.

## Conventions

- Components export `{Name}Component`, `{Name}System`, `{Name}Events`, `{Name}InputEvents`.
- Reuse `_temp` Vector3/etc inside `onUpdate` instead of allocating per frame.
- Systems communicate via EventBus, never direct cross-system references.
- Serialization: components implement `serialize()`; SceneLoader handles deserialization.
- **`Foo.core.ts` + `Foo.ts` split.** Pure data — Component class, `*Input` interface, `*Events` constants, request-payload interfaces — lives in `Foo.core.ts` with zero renderer-types or sibling-component imports. The System (and any renderer-coupled types) lives in `Foo.ts`, which re-exports the core surface: `export { FooComponent, type FooInput, FooEvents } from './Foo.core'`.
- **No runtime state on Components.** Mesh handles, `Set<string>` of live ids, one-shot init flags — anything non-serializable — lives in a `WeakMap<FooComponent, FooRuntime>` on the System. Frame caches (cooldown timers, last facing vector) can stay on the Component since they serialize fine.
- **Debug panels follow the `{Name}DebuggerComponent` + `{Name}DebuggerSystem` pair** in a sibling `Foo.viz.tsx`, registered via `vizStore` from `@babylonjsmarket/arcade/viz`. Activated by `activationKey` (e.g. `'Digit5'`), persisted to `localStorage` automatically. See `ecs-api` for the full registration + state-persistence API.

## Event naming — pick the canonical name, don't invent synonyms

EventBus is a string-keyed bus. A typo or a synonym makes two systems silently fail to communicate. **Before emitting or subscribing to an event, grep the codebase for the noun** (e.g. `score.`, `enemy.`, `physics.`) and reuse the exact existing name. Synonyms that have bitten us:

| ❌ Don't use   | ✅ Use            | Why |
|----------------|-------------------|-----|
| `score.updated` | `score.changed`   | Score system already emits `score.changed` — `score.updated` looks plausible but produces a silent broken chain. |
| `enemy.hurt`   | `enemy.hit`       | Bullet+Enemy talk via `enemy.hit`; `enemy.damaged` / `enemy.hurt` are dead names. |
| `enemy.died`   | `enemy.killed`    | Spawners listen for `enemy.killed`. |
| `world.entity.spawned` | `world.entity.created` | World fires `world.entity.created` / `world.entity.removed`. |
| `keyboard.down` | `keyboard.keydown` | Input layer uses the full `keydown` / `keyup` suffix. |

**Naming pattern:** `<noun>.<verbPast>` for things that have happened (`score.changed`, `enemy.killed`, `physics.body.created`); `<noun>.<verbImperative>` for direct requests on the bus (`score.add`, `score.resetRequest`). Don't use `-ed` for requests or `-Request` for events — keep tense and the imperative form distinct.

**When defining a new event:** declare it in the component's `{Name}Events` (emitted) or `{Name}InputEvents` (listened-to) constant object and import the constant everywhere — never sprinkle the string literal across files. Cross-system listeners that import the emitter's `{Name}Events` get the actual emitted name for free; listeners that hardcode a string are how synonyms creep in.

## Renderer adapters

Import `@babylonjsmarket/ecs/babylon` or `@babylonjsmarket/ecs/three` for the engine adapter, or `@babylonjsmarket/ecs/testing` for the mock adapter used in unit tests.

## Scene JSON

```json
{
  "gameTitle": "My Game",
  "sceneTitle": "Level 1",
  "entities": {
    "Player": {
      "tags": ["player"],
      "components": {
        "MeshPrimitive": { "primitive": "capsule", "height": 2 }
      }
    }
  }
}
```

## Anti-patterns to avoid

- `createEntity` per spawn + `removeEntity` per death for things that spawn/die in gameplay (bullets, enemies, particles) — that's per-frame entity+mesh alloc/dispose churn. Use a `world.registerPool` + `acquire`/`release` pool (size = peak concurrent). Resource-owning systems must be **park-aware**: in `onEntityRemoved`, if `!entity.active` keep+hide the handle (dispose only on true destroy); reuse it on `onEntityAdded`. See `ecs-api` → "Pooling spawned entities".
- Querying entities by iterating `world.entities` manually — use a System's `query` instead.
- Holding references to entities across frames without re-checking they still match a query.
- Calling renderer APIs from Components — that belongs in the renderer adapter or a System.
- Storing a `MeshHandle` / `Set` / `initialized: boolean` flag on a Component — move it to the System's `WeakMap<FooComponent, FooRuntime>` so `serialize()` round-trips.
- Casting `world.renderer` to `BabylonAdapterLike` to poke `mesh.scaling`, `mesh.billboardMode`, `scene.pick`, `scene.activeCamera.detachControl`, `body.physicsBody.setLinearVelocity`, etc. The `RendererAdapter` has `setMeshScale`, `setMeshBillboardMode`, `pickAtScreenPoint`, `setCameraControlsEnabled`, `physicsSetBodyVelocity`, `physicsResizeBoxBody`, `physicsSetGravity`, `replaceMeshGeometry`, and friends for these exact cases.
- Seeding a Solid `createSignal` with the scene-default value for a panel slider — it'll reset on every page reload. Use `vizStore.getPanelData<T>(panelId, key, fallback)` for the seed and `vizStore.setPanelData(panelId, key, v)` in the setter (see `ecs-api`).
