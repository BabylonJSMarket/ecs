---
name: ecs-authoring
description: Author and review code for the @babylonjsmarket/ecs framework. Use when writing or reviewing Systems, Components, scene JSON, or example markdown — including any file that imports from @babylonjsmarket/ecs, defines a class extending System/Component, or uses World/EventBus/SceneLoader.
---

# Authoring @babylonjsmarket/ecs code

This package provides a renderer-agnostic Entity-Component-System framework with Babylon and Three adapters.

## Core surface

- **`World`** — orchestrator. `world.createEntity()`, `world.addSystem(sys)`, `world.update(dt)`.
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

- Querying entities by iterating `world.entities` manually — use a System's `query` instead.
- Holding references to entities across frames without re-checking they still match a query.
- Calling renderer APIs from Components — that belongs in the renderer adapter or a System.
