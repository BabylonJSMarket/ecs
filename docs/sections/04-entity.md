# Entity

An `Entity` is **a container with a unique ID** that holds Components and tags. You don't construct entities directly — the World does.

## Creating an entity

```ts
const player = world.createEntity('Player');
```

The string argument is a **logical name** — it appears in scene JSON, in debug panels, and helps when reading test failures. It's not required to be unique. The Entity also gets an auto-assigned `id` (a UUID) which **is** unique.

```ts
console.log(player.name);   // 'Player'
console.log(player.id);     // 'ent_a7b3c9...'
```

## Adding and getting components

```ts
import { Component } from '@babylonjsmarket/ecs';

class Health extends Component {
  current = 100;
  max = 100;
}

player.add(new Health());

const hp = player.get(Health);              // Health | undefined
const hp2 = player.get(Health)!;             // Health (non-null assertion)
const has = player.has(Health);             // boolean
```

`get()` returns `undefined` when the component isn't on the entity, so the type system forces you to handle the missing case. The `entity.get(X)!` non-null assertion is the shorter form when you've already filtered in a System query — you know the component is there because the query required it.

## Removing components

```ts
player.remove(Health);  // returns true if removed, false if not present
```

When a Component is removed, its `onDetachOverride()` hook fires (if defined) and any System whose query depended on that Component automatically drops the entity from its working set.

## Tags

Tags are **lightweight string markers** for fast filtering. Use them when you don't need a full Component — when the presence of a label is the entire signal.

```ts
player.addTag('player');
player.addTag('alive');

player.hasTag('alive');       // true
player.removeTag('alive');
player.getTags();              // ['player']
```

Tags are first-class in System queries:

```ts
class AISystem extends System {
  query: ISystemQuery = {
    required: [BrainComponent],
    tags: ['enemy', 'alive'],   // entity must have BOTH tags
  };
}
```

Use tags for category-style filters (`'player'`, `'enemy'`, `'projectile'`, `'pickup'`) and Components for data-bearing state.

## Destroying an entity

```ts
world.destroyEntity(player);
// or
world.destroyEntityById(player.id);
```

Destroying:
1. Fires each Component's `onDetachOverride()` hook
2. Removes the entity from every System's working set
3. Emits `'entity.destroyed'` on the EventBus
4. Releases the entity ID

Systems can subscribe to `'entity.destroyed'` to clean up renderer handles or external references they hold. The `EntityEvents` constant gives you the event name without typos:

```ts
import { EntityEvents } from '@babylonjsmarket/ecs';

this.listen(EntityEvents.DESTROYED, ({ entityId }) => {
  // clean up — listen() auto-unsubscribes when the System is removed
});
```

## Finding entities

The World maintains the master entity list. Most lookups go through it:

```ts
world.getEntityById('ent_a7b3c9...');
world.getEntitiesByName('Player');         // [] of any entities named 'Player'
world.getEntitiesByTag('alive');
world.getAllEntities();
```

For per-frame iteration, **prefer Systems** — `system.entities` is a pre-computed working set that respects the query. Looping over `world.getAllEntities()` every frame defeats the point of an ECS.

## Entity ID stability

Entity IDs are stable across `world.update()` calls. They're also stable across **save/load** — the `SaveLoad` component serializes the IDs along with the rest of the state, so a restored World restores its references.

If you need to refer to an entity across frames, **store the ID, not the Entity**. The Entity object may be garbage-collected if destroyed; the ID is a string.

## Where to next

- **[System](./system)** — how Systems pick up the entities they care about
- **[World](./world)** — entity creation/destruction, batching, ticking
