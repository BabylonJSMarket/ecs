import { describe, it, expect, beforeEach } from 'vitest';
import { World, Entity, System, Component, EventBus } from '..';

class PooledComponent extends Component {
  hp = 0;
  x = 0;
}

class TrackingSystem extends System {
  added: string[] = [];
  removed: string[] = [];
  constructor(eventBus: EventBus) {
    super(eventBus);
    this.query = { required: [PooledComponent] };
  }
  protected onUpdate(): void {}
  protected onEntityAdded(e: Entity): void {
    this.added.push(e.id);
  }
  protected onEntityRemoved(e: Entity): void {
    this.removed.push(e.id);
  }
}

describe('World entity pools', () => {
  let world: World;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    world = new World({ eventBus, detectRaces: false });
  });

  const buildPooled = (e: Entity) => e.add(new PooledComponent());

  it('registerPool pre-allocates parked (inactive) entities', () => {
    world.registerPool('mob', { size: 4, build: buildPooled });
    const pooled = world.getEntities().filter((e) => e.has(PooledComponent));
    expect(pooled.length).toBe(4);
    // All parked: inactive, so excluded from a live query.
    expect(pooled.every((e) => !e.active)).toBe(true);
    expect(world.query({ required: [PooledComponent] }).length).toBe(0);
  });

  it('parked entities are not in a matching system; acquire adds them', () => {
    const sys = new TrackingSystem(eventBus);
    world.addSystem(sys);
    world.initialize();
    world.registerPool('mob', { size: 3, build: buildPooled });

    // Built then parked → each was briefly added, then removed.
    expect(sys.getEntityCount()).toBe(0);

    const e = world.acquire('mob');
    expect(e).not.toBeNull();
    expect(e!.active).toBe(true);
    expect(sys.getEntityCount()).toBe(1);
  });

  it('acquire runs reset with the supplied data', () => {
    world.registerPool('mob', {
      size: 2,
      build: buildPooled,
      reset: (e, data) => {
        const c = e.get(PooledComponent)!;
        const d = data as { hp: number; x: number };
        c.hp = d.hp;
        c.x = d.x;
      },
    });
    const e = world.acquire('mob', { hp: 5, x: 9 })!;
    const c = e.get(PooledComponent)!;
    expect(c.hp).toBe(5);
    expect(c.x).toBe(9);
  });

  it('release parks the entity and returns it to the pool for reuse', () => {
    world.registerPool('mob', { size: 2, build: buildPooled });
    const a = world.acquire('mob')!;
    expect(world.release(a)).toBe(true);
    expect(a.active).toBe(false);
    // Reuse: next acquire hands back a parked slot (the same entity here).
    const b = world.acquire('mob')!;
    expect(b.active).toBe(true);
    expect(world.getEntities().filter((e) => e.has(PooledComponent)).length).toBe(2);
  });

  it('removeEntity releases a pooled entity instead of destroying it', () => {
    world.registerPool('mob', { size: 2, build: buildPooled });
    const a = world.acquire('mob')!;
    const id = a.id;
    expect(world.removeEntity(a)).toBe(true);
    // Still alive (parked), not destroyed.
    expect(world.getEntity(id)).toBeDefined();
    expect(world.getEntity(id)!.active).toBe(false);
  });

  it('recycles the oldest live entity when exhausted', () => {
    world.registerPool('mob', { size: 2, build: buildPooled });
    const first = world.acquire('mob')!;
    world.acquire('mob');
    const third = world.acquire('mob')!; // exhausted → recycles `first`
    expect(third).toBe(first);
    // Still capped at the pool size.
    expect(world.query({ required: [PooledComponent] }).length).toBe(2);
  });

  it('acquire returns null for an unregistered pool', () => {
    expect(world.acquire('nope')).toBeNull();
  });

  it('release is a no-op for non-pooled entities', () => {
    const e = world.createEntity();
    e.add(new PooledComponent());
    expect(world.release(e)).toBe(false);
  });

  it('removeAllEntities destroys pooled entities', () => {
    world.registerPool('mob', { size: 3, build: buildPooled });
    world.acquire('mob');
    world.removeAllEntities();
    expect(world.getEntities().length).toBe(0);
    // Pool is cleared too — acquiring now yields nothing.
    expect(world.acquire('mob')).toBeNull();
  });

  it('registerPool is idempotent — a second call with the same name is ignored', () => {
    world.registerPool('mob', { size: 2, build: buildPooled });
    // Re-registering with a different size must not re-allocate or grow.
    world.registerPool('mob', { size: 10, build: buildPooled });
    const pooled = world.getEntities().filter((e) => e.has(PooledComponent));
    expect(pooled.length).toBe(2);
  });

  it('acquire returns null when a size-0 pool is exhausted (no entity to recycle)', () => {
    world.registerPool('empty', { size: 0, build: buildPooled });
    // No free entities and no active ones to recycle.
    expect(world.acquire('empty')).toBeNull();
  });
});
