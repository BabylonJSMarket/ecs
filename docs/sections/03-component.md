# Component

A `Component` is **data attached to an entity**. Extend the base class, add fields, you're done.

## The smallest possible Component

```ts
import { Component } from '@babylonjsmarket/ecs';

class Health extends Component {
  current = 100;
  max = 100;
}
```

That's a complete, valid Component. It has no logic — logic lives in Systems. Components are data containers.

## What the base class gives you

- A unique component ID
- A reference to the owning entity once attached (`this.entityId`)
- Optional lifecycle hooks: `onAttachOverride()`, `onDetachOverride()`
- An `eventBus` reference once the parent entity is created in a World

## Lifecycle hooks

Most Components don't need them. Use them when you need to allocate or release a resource that lives as long as the component is attached.

```ts
class CameraTarget extends Component {
  targetEntityId?: string;
  private unsubscribe?: () => void;

  onAttachOverride() {
    this.unsubscribe = this.eventBus.on('entity.destroyed', (data) => {
      if (data.entityId === this.targetEntityId) {
        this.targetEntityId = undefined;
      }
    });
  }

  onDetachOverride() {
    this.unsubscribe?.();
  }
}
```

`onAttachOverride` fires after the Component is added to an Entity and the Entity is in a World — `this.eventBus` is safe to use. `onDetachOverride` fires when the Component is removed or the Entity is destroyed.

These two hooks are the only ones a Component gets. `onUpdate`, `onInitialize`, `onShutdown`, `onEntityAdded` and `onEntityRemoved` belong to System, and TypeScript will happily let you declare any of them here — the method just never runs. The base class watches for that. The first time you construct a Component carrying a System hook it warns on the console and names the offending method:

```text
[ECS] SpinComponent extends Component but defines onUpdate() — System hook.
Nothing will call it on a Component. Move that logic to the matching System,
or use onAttachOverride()/onDetachOverride() if it is per-entity setup.
```

It warns once per class, not once per instance, so a pool that spawns a thousand entities still prints one line. `setHookGuardEnabled(false)` turns the check off.

## Naming convention

By convention, every Component in this ecosystem follows the same shape:

- `{Name}Component` — the data class
- `{Name}System` — the System that operates on it
- `{Name}Events` — an object with event-name constants the System **emits**
- `{Name}InputEvents` — an object with event-name constants the System **listens to**

```ts
// Position.ts
export class PositionComponent extends Component {
  x = 0;
  y = 0;
  z = 0;
}

export const PositionEvents = {
  CHANGED: 'position.changed',
  TELEPORTED: 'position.teleported',
} as const;

export const PositionInputEvents = {
  SET: 'position.set',
} as const;

export class PositionSystem extends System {
  // ...
}
```

This convention is what lets the lazy SceneLoader in `@babylonjsmarket/arcade` find your component classes by name from a JSON scene file. Stick to it and your components are JSON-loadable for free.

## Component data is just data

Don't put functions on Components. Don't put references to other entities (use IDs). Don't put renderer handles directly. The reason: state that's hard to serialize is hard to save, hard to replay, hard to test.

```ts
// ❌ Bad — function on a Component
class Bullet extends Component {
  damage = 10;
  onHit = (target: Entity) => { /* ... */ };
}

// ✅ Good — Components are data, behavior is in the System
class BulletComponent extends Component {
  damage = 10;
  ownerId = '';  // who fired it; an entity ID, not a reference
}
```

## Serialization

The base `Component` exposes a `serialize()` method that JSON-encodes the public fields. The `SceneLoader` uses this format both ways: it writes scene state to JSON and instantiates entities from JSON.

Override it if you need custom serialization, but the default is usually enough:

```ts
class CustomComponent extends Component {
  internalState = new Map();

  serialize() {
    return {
      ...super.serialize(),
      internalState: Array.from(this.internalState.entries()),
    };
  }
}
```

## Multiple components on one entity

Entities can hold any number of components, one per class. Adding a second instance of the same class replaces the first:

```ts
const player = world.createEntity('Player');
player.add(new HealthComponent());
player.add(new PositionComponent());
player.add(new VelocityComponent());

const hp = player.get(HealthComponent);     // typed, optional
const hp2 = player.get(HealthComponent)!; // typed, non-null assertion
```

## Where to next

- **[Entity](./entity)** — how Components get attached
- **[System](./system)** — how Components get processed
