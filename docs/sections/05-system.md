# System

A `System` is **logic that processes entities matching a query**. Override `onUpdate(dt)` for per-frame work. Override `onEntityAdded`/`onEntityRemoved` for setup and teardown when entities enter or leave the query.

## The smallest possible System

```ts
import { System, type ISystemQuery } from '@babylonjsmarket/ecs';

class MoveSystem extends System {
  query: ISystemQuery = { required: [VelocityComponent] };

  onUpdate(dt: number) {
    for (const entity of this.entities) {
      const v = entity.get(VelocityComponent)!;
      // ...do the work
    }
  }
}
```

The base class:
- Stores `eventBus` (passed via constructor)
- Maintains `this.entities` — automatically kept in sync with the query
- Provides empty hook defaults so you only override what you need

## Query options

The `query` field has three lists. All are optional. An empty query matches **every entity**, which you almost never want.

```ts
query: ISystemQuery = {
  required: [Velocity, Health],       // entity must have ALL of these
  excluded: [Frozen, Dead],            // entity must have NONE of these
  tags: ['player', 'alive'],           // entity must wear ALL of these tags
};
```

The framework re-evaluates the query whenever a Component is added/removed or a tag changes. Entities flow in and out of `this.entities` automatically. **Never iterate `world.getAllEntities()` yourself in a System.**

## Lifecycle hooks

```ts
class HealthSystem extends System {
  query: ISystemQuery = { required: [Health] };

  onEntityAdded(entity: Entity) {
    // First time this entity matches the query — set up renderer handles,
    // event subscriptions, anything tied to this entity's lifetime.
  }

  onEntityRemoved(entity: Entity) {
    // Entity stopped matching — clean up whatever onEntityAdded set up.
  }

  onUpdate(dt: number) {
    // Per-frame.
  }

  onInitialize() {
    // Called once when the System is added to a World.
    // Use it to subscribe to global events via this.listen().
  }

  onShutdown() {
    // Called once when the System is removed. Release non-event
    // resources here (DOM listeners, handles). Subscriptions made via
    // this.listen() are unsubscribed automatically after this runs.
  }
}
```

The mirror of the Component warning applies here. `onAttachOverride` and `onDetachOverride` are Component hooks, and nothing calls them on a System — write one and the base class says so on the console the first time the System is constructed. A System reacts to entities in `onEntityAdded`/`onEntityRemoved` and sets itself up in `onInitialize`.

## Listening to events

Systems coordinate via the EventBus rather than holding references to each other. Subscribe in `onInitialize` with `this.listen()` — the subscription's lifetime is tied to the System, so it's unsubscribed automatically when the System is removed:

```ts
class DamageSystem extends System {
  query: ISystemQuery = { required: [Health] };

  onInitialize() {
    this.listen('damage.dealt', ({ targetId, amount }) => {
      const entity = this.world.getEntity(targetId);
      if (!entity || !this.entities.has(entity)) return;
      const hp = entity.get(Health)!;
      hp.current -= amount;
      if (hp.current <= 0) {
        this.eventBus.emit('entity.died', { entityId: targetId });
      }
    });
  }
}
```

Listen by name with `this.listen(name, callback)`. Emit with `this.eventBus.emit(name, data)`. Two variants cover the other subscription shapes: `this.listenOnce(name, callback)` fires once, and `this.listenForEntity(name, entityId, callback)` only fires for events about one entity. All three return an unsubscribe function for early manual removal, but you rarely need it — the base class drains every `listen()` subscription when the System shuts down. (Raw `eventBus.on` is the primitive underneath; use it outside Systems, where you own the unsubscribe yourself.)

## Reading the renderer

The System gets at the renderer adapter through `this.world.renderer`:

```ts
class RenderSyncSystem extends System {
  query: ISystemQuery = { required: [Position, MeshPrimitive] };

  onUpdate(dt: number) {
    for (const entity of this.entities) {
      const pos = entity.get(Position)!;
      const mesh = entity.get(MeshPrimitive)!;
      this.world.renderer.setMeshPosition(mesh.handle, pos.x, pos.y, pos.z);
    }
  }
}
```

The adapter is typed as `RendererAdapter`. You can write Systems that work under any adapter — Babylon, Three, or Mock — without changes.

## Order of execution

Systems run in the order they were added to the World. If `SystemA` should compute a value that `SystemB` reads, add `SystemA` first.

```ts
world.addSystem(new InputSystem(world.getEventBus()));      // 1. read input
world.addSystem(new MoveSystem(world.getEventBus()));        // 2. apply velocity
world.addSystem(new CollisionSystem(world.getEventBus()));   // 3. resolve collisions
world.addSystem(new RenderSyncSystem(world.getEventBus()));  // 4. push to renderer
```

There's no priority field — execution order is the addition order. Keep it simple.

## Why query-based filtering matters

Without an ECS, the typical pattern is:

```ts
// ❌ The OOP trap
function updateGame(dt) {
  for (const obj of allGameObjects) {
    if (obj.canMove) obj.move(dt);
    if (obj.canShoot) obj.shoot(dt);
    if (obj.canTalk)  obj.talk(dt);
  }
}
```

Every `if` is paying for itself once per object per frame. Adding a new behavior means touching the central loop. With Systems, the dispatching is the framework's job:

```ts
world.addSystem(new MoveSystem(world.getEventBus()));
world.addSystem(new ShootSystem(world.getEventBus()));
world.addSystem(new TalkSystem(world.getEventBus()));
// ...
world.update(dt);
```

Each System sees **only** the entities its query matches. New behavior is a new System; no edits to existing code.

## Where to next

- **[World](./world)** — the orchestrator that ticks Systems
- **[EventBus](./event-bus)** — the pub/sub that lets Systems coordinate
