# EventBus

The `EventBus` is **pub/sub** for Systems. It's how Systems coordinate without referencing each other.

## Basics

```ts
// Subscribe
const unsubscribe = eventBus.on('damage.dealt', (data) => {
  console.log('damage dealt:', data);
});

// Emit
eventBus.emit('damage.dealt', { targetId: 'ent_a7...', amount: 10 });

// Unsubscribe when you're done
unsubscribe();
```

Every System receives the EventBus in its constructor (`new MySystem(world.getEventBus())`) and stores it on `this.eventBus`. From inside a System you'd write:

```ts
class DamageSystem extends System {
  private unsubscribes: Array<() => void> = [];

  onInitialize() {
    this.unsubscribes.push(
      this.eventBus.on('damage.dealt', (data) => {
        // ...
      })
    );
  }

  onShutdown() {
    this.unsubscribes.forEach((unsub) => unsub());
    this.unsubscribes = [];
  }

  someMethod() {
    this.eventBus.emit('enemy.died', { entityId: '...' });
  }
}
```

Collect the unsubscribe functions returned by `on()` and call them in `onShutdown` so listeners don't leak when the System is removed.

## Naming convention

Event names are dotted strings: `'<emitter>.<event>'`. Each component package conventionally exports a constants object so callers don't typo names:

```ts
export const HealthEvents = {
  CHANGED: 'health.changed',
  DEPLETED: 'health.depleted',
  HEALED: 'health.healed',
} as const;

export const HealthInputEvents = {
  DAMAGE: 'health.damage',
  HEAL: 'health.heal',
} as const;
```

- `*Events` — names the System **emits**
- `*InputEvents` — names the System **listens to**

Importing the constants gives you autocomplete and typo-protection:

```ts
import { HealthEvents } from './Health';
eventBus.emit(HealthEvents.DEPLETED, { entityId });  // typo-safe
```

## What's in event data

The second argument to `emit` is arbitrary — JSON-serializable shapes are best. Keep the data small. **Don't** put renderer handles, function references, or live Entity objects in event payloads. Use IDs and primitives:

```ts
// ❌ Bad — entity reference doesn't survive save/load, networking, replay
eventBus.emit('player.spawned', { entity: player });

// ✅ Good — IDs survive everything
eventBus.emit('player.spawned', { entityId: player.id, position: [x, y, z] });
```

## Wildcards and pattern matching

The EventBus supports glob-style listeners for debugging and viz tools:

```ts
eventBus.on('damage.*', (data, eventName) => {
  console.log(eventName, data);
});

eventBus.on('*.died', (data) => {
  // ...
});
```

The second argument to the callback is the **actual event name** that triggered the call — useful when a wildcard catches multiple events.

Don't lean on wildcards for production logic. They make event flow hard to trace. Use them for the EventBus debugger viz panel and similar tooling.

## Backpressure and ordering

The EventBus is **synchronous**. When you call `emit`, every subscriber's callback fires before `emit` returns. This means:

- Order is preserved: subscribers called in subscription order
- No queue, no async — events don't pile up between frames
- A subscriber that's slow blocks the emitter

If a subscriber emits another event from inside its callback, that recursive emit also runs synchronously. Be careful with loops — `A` emits, `B` listens and emits `B`, `A` listens to `B` and emits again. Use a circuit breaker (`if (this.processing) return;`) for events that can cycle.

## Off and once

```ts
// Subscribe and auto-unsubscribe after the first fire
eventBus.once('game.started', () => {
  console.log('game has started');
});

// Manual unsubscribe of a specific callback
const cb = (data) => { /* ... */ };
eventBus.on('damage.dealt', cb);
eventBus.off('damage.dealt', cb);

// Remove all listeners for a name
eventBus.removeAllListeners('damage.dealt');
```

## Inspecting traffic

In development, the EventBus viz panel (in `@babylonjsmarket/arcade/viz`) shows live event traffic grouped by emitter. Wire it up during development to spot:

- Events being emitted with no listeners (typo on the listener side)
- Event storms (one event triggering 200 emits per frame)
- Missing emissions (a subscriber that never fires because the emit path is dead)

## Where to next

- **[Renderers](./renderers)** — the adapter interface and how to pick one
- **[SceneLoader](./scene-loader)** — loading entities from JSON
