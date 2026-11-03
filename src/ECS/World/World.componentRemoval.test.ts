import { describe, it, expect, beforeEach } from 'vitest';
import { World, EventBus, Component, System } from '..';
import type { Entity } from '..';
import { EntityEvents } from '../Entity/Entity';

class Config extends Component {
  knob = 1;
}
class Marker extends Component {}
class Other extends Component {}
class Shield extends Component {}

/** Records what onEntityRemoved could still read off the entity. */
class ConfigSystem extends System {
  seen: Array<Config | undefined> = [];
  constructor(eventBus: EventBus) {
    super(eventBus);
    this.query = { required: [Config] };
  }
  onUpdate(): void {}
  protected onEntityRemoved(entity: Entity): void {
    this.seen.push(entity.get(Config));
  }
}

class AnyOfSystem extends System {
  removed = 0;
  constructor(eventBus: EventBus) {
    super(eventBus);
    this.query = { anyOf: [Marker, Other] };
  }
  onUpdate(): void {}
  protected onEntityRemoved(): void {
    this.removed++;
  }
}

class UnshieldedSystem extends System {
  added = 0;
  constructor(eventBus: EventBus) {
    super(eventBus);
    this.query = { required: [Marker], excluded: [Shield] };
  }
  onUpdate(): void {}
  protected onEntityAdded(): void {
    this.added++;
  }
}

describe('removing one component from a live entity', () => {
  let world: World;
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
    world = new World({ eventBus: bus });
  });

  it('lets onEntityRemoved still read the component being removed', () => {
    const sys = new ConfigSystem(bus);
    world.addSystem(sys);
    const e = world.createEntity();
    const cfg = new Config();
    e.add(cfg);

    e.remove(Config);

    expect(sys.seen).toEqual([cfg]);
    expect(e.get(Config)).toBeUndefined();
  });

  it('emits COMPONENT_REMOVING before onDetach, then COMPONENT_REMOVED after', () => {
    const order: string[] = [];
    class Tracked extends Component {
      onDetachOverride() {
        order.push('detach');
      }
    }
    const e = world.createEntity();
    e.add(new Tracked());
    bus.on(EntityEvents.COMPONENT_REMOVING, (d: { entity: Entity }) =>
      order.push(d.entity.has(Tracked) ? 'removing:attached' : 'removing:gone'),
    );
    bus.on(EntityEvents.COMPONENT_REMOVED, (d: { entity: Entity }) =>
      order.push(d.entity.has(Tracked) ? 'removed:attached' : 'removed:gone'),
    );

    e.remove(Tracked);

    expect(order).toEqual(['removing:attached', 'detach', 'removed:gone']);
  });

  it('keeps an anyOf system while another of its components remains', () => {
    const sys = new AnyOfSystem(bus);
    world.addSystem(sys);
    const e = world.createEntity();
    e.add(new Marker());
    e.add(new Other());

    e.remove(Marker);
    expect(sys.removed).toBe(0);

    e.remove(Other);
    expect(sys.removed).toBe(1);
  });

  it('still adds the entity to a system once its excluded component is gone', () => {
    const sys = new UnshieldedSystem(bus);
    world.addSystem(sys);
    const e = world.createEntity();
    e.add(new Shield());
    e.add(new Marker());
    expect(sys.added).toBe(0);

    e.remove(Shield);

    expect(sys.added).toBe(1);
  });

  it('removes a system entity once only, not again on the removed refresh', () => {
    const sys = new ConfigSystem(bus);
    world.addSystem(sys);
    const e = world.createEntity();
    e.add(new Config());

    e.remove(Config);

    expect(sys.seen).toHaveLength(1);
  });

  it('leaves entity destruction as it was: one onEntityRemoved, component readable', () => {
    const sys = new ConfigSystem(bus);
    world.addSystem(sys);
    const e = world.createEntity();
    const cfg = new Config();
    e.add(cfg);

    world.removeEntity(e);

    expect(sys.seen).toEqual([cfg]);
  });
});
