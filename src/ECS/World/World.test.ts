import { describe, it, expect, beforeEach, vi } from 'vitest';
import { World, Entity, System, Component, EventBus } from '..';

class TestComponent extends Component {
  value: number = 0;
}

class AnotherComponent extends Component {
  name: string = 'test';
}

class TestSystem extends System {
  updateCount = 0;

  constructor(eventBus: EventBus) {
    super(eventBus);
    this.query = { required: [TestComponent] };
  }

  protected onUpdate(deltaTime: number): void {
    this.updateCount++;
  }
}

class AnotherSystem extends System {
  protected onUpdate(deltaTime: number): void {}
}

describe('World', () => {
  let world: World;

  beforeEach(() => {
    world = new World();
  });

  describe('constructor', () => {
    it('should create world with default options', () => {
      expect(world.getMaxEntities()).toBe(10000);
      expect(world.getEventBus()).toBeInstanceOf(EventBus);
    });

    it('should not register a wildcard listener (preserves the EventBus fast path)', () => {
      // The World tracks entity membership via named entity.* subscriptions,
      // never '*'. A wildcard listener would count toward getListenerCount for
      // EVERY type and force every emit off the no-allocation fast path, so an
      // unrelated type must report zero listeners on a fresh world.
      expect(world.getEventBus().getListenerCount('some.unrelated.event')).toBe(0);
    });

    it('should accept custom options', () => {
      const customEventBus = new EventBus();
      const customWorld = new World({
        maxEntities: 100,
        eventBus: customEventBus,
      });

      expect(customWorld.getMaxEntities()).toBe(100);
      expect(customWorld.getEventBus()).toBe(customEventBus);
    });

    it('should not be initialized by default', () => {
      expect(world.initialized).toBe(false);
    });
  });

  describe('initialization', () => {
    it('should initialize world', () => {
      const callback = vi.fn();
      world.getEventBus().on('world.initialized', callback);

      world.initialize();

      expect(world.initialized).toBe(true);
      expect(callback).toHaveBeenCalledWith({ world });
    });

    it('should initialize only once', () => {
      const callback = vi.fn();
      world.getEventBus().on('world.initialized', callback);

      world.initialize();
      world.initialize();

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should initialize all systems', () => {
      const system = new TestSystem(world.getEventBus());
      const initSpy = vi.spyOn(system, 'initialize');

      world.addSystem(system);
      world.initialize();

      expect(initSpy).toHaveBeenCalled();
    });

    it('accepts a system class and injects the event bus (no getEventBus needed)', () => {
      class CleanSystem extends System {
        seenBus: EventBus | undefined;
        constructor() {
          super(); // no event bus passed
          this.query = {};
        }
        protected onUpdate(): void {}
        protected onInitialize(): void {
          // The bus must already be wired by the time we initialize.
          this.seenBus = (this as unknown as { eventBus: EventBus }).eventBus;
        }
      }

      world.addSystem(CleanSystem); // pass the class itself, not an instance
      world.initialize();

      const sys = world.getSystem(CleanSystem);
      expect(sys).toBeInstanceOf(CleanSystem);
      expect((sys as unknown as { eventBus: EventBus }).eventBus).toBe(world.getEventBus());
      expect(sys!.seenBus).toBe(world.getEventBus());
    });
  });

  describe('shutdown', () => {
    it('should shutdown world', () => {
      const callback = vi.fn();
      world.getEventBus().on('world.shutdown', callback);

      world.initialize();
      world.shutdown();

      expect(world.initialized).toBe(false);
      expect(callback).toHaveBeenCalledWith({ world });
    });

    it('should only shutdown if initialized', () => {
      const callback = vi.fn();
      world.getEventBus().on('world.shutdown', callback);

      world.shutdown();

      expect(callback).not.toHaveBeenCalled();
    });

    it('should shutdown all systems', () => {
      const system = new TestSystem(world.getEventBus());
      const shutdownSpy = vi.spyOn(system, 'shutdown');

      world.addSystem(system);
      world.initialize();
      world.shutdown();

      expect(shutdownSpy).toHaveBeenCalled();
    });
  });

  describe('entity management', () => {
    describe('createEntity', () => {
      it('should create entity with unique id', () => {
        const entity1 = world.createEntity();
        const entity2 = world.createEntity();

        expect(entity1).toBeInstanceOf(Entity);
        expect(entity2).toBeInstanceOf(Entity);
        expect(entity1.id).not.toBe(entity2.id);
      });

      it('should create entity with custom id', () => {
        const entity = world.createEntity('custom-id');
        expect(entity.id).toBe('custom-id');
      });

      it('should emit entity.created event', () => {
        const callback = vi.fn();
        world.getEventBus().on('world.entity.created', callback);

        const entity = world.createEntity();

        expect(callback).toHaveBeenCalledWith({ world, entity });
      });

      it('should add entity to all systems', () => {
        const system = new TestSystem(world.getEventBus());
        world.addSystem(system);

        const entity = world.createEntity();
        entity.add(TestComponent);

        expect(system.getEntityCount()).toBe(1);
      });

      it('should throw error if max entities reached', () => {
        const smallWorld = new World({ maxEntities: 2 });
        smallWorld.createEntity();
        smallWorld.createEntity();

        expect(() => smallWorld.createEntity()).toThrow('Maximum entity limit');
      });

      it('should throw error for duplicate entity id', () => {
        world.createEntity('duplicate');
        expect(() => world.createEntity('duplicate')).toThrow('already exists');
      });
    });

    describe('getEntity', () => {
      it('should get entity by id', () => {
        const entity = world.createEntity('test-id');
        expect(world.getEntity('test-id')).toBe(entity);
      });

      it('should return undefined for non-existent entity', () => {
        expect(world.getEntity('non-existent')).toBeUndefined();
      });
    });

    describe('getEntities', () => {
      it('should return all entities', () => {
        const entity1 = world.createEntity();
        const entity2 = world.createEntity();

        const entities = world.getEntities();

        expect(entities).toHaveLength(2);
        expect(entities).toContain(entity1);
        expect(entities).toContain(entity2);
      });

      it('should return empty array when no entities', () => {
        expect(world.getEntities()).toHaveLength(0);
      });
    });

    describe('getEntitiesByTag', () => {
      it('should return entities with specific tag', () => {
        const entity1 = world.createEntity();
        const entity2 = world.createEntity();
        const entity3 = world.createEntity();

        entity1.addTag('player');
        entity2.addTag('enemy');
        entity3.addTag('player');

        const players = world.getEntitiesByTag('player');

        expect(players).toHaveLength(2);
        expect(players).toContain(entity1);
        expect(players).toContain(entity3);
      });
    });

    describe('sceneLoader setter', () => {
      it('should allow setting sceneLoader after construction', async () => {
        const { SceneLoader } = await import('../SceneLoader/SceneLoader');
        const eb = new EventBus();
        const loader = new SceneLoader(eb);

        expect(world.sceneLoader).toBeUndefined();
        world.sceneLoader = loader;
        expect(world.sceneLoader).toBe(loader);
      });
    });

    describe('getEntitiesWithComponent', () => {
      it('should return entities with a specific component', () => {
        const entity1 = world.createEntity();
        const entity2 = world.createEntity();
        const entity3 = world.createEntity();

        entity1.add(TestComponent);
        entity2.add(TestComponent);
        entity3.add(AnotherComponent);

        const withTest = world.getEntitiesWithComponent(TestComponent);

        expect(withTest).toHaveLength(2);
        expect(withTest).toContain(entity1);
        expect(withTest).toContain(entity2);
      });
    });

    describe('getEntitiesWithComponents', () => {
      it('should return entities with specific components', () => {
        const entity1 = world.createEntity();
        const entity2 = world.createEntity();
        const entity3 = world.createEntity();

        entity1.add(TestComponent);
        entity2.add(TestComponent);
        entity2.add(AnotherComponent);
        entity3.add(AnotherComponent);

        const withBoth = world.getEntitiesWithComponents(TestComponent, AnotherComponent);

        expect(withBoth).toHaveLength(1);
        expect(withBoth).toContain(entity2);
      });
    });

    describe('removeEntity', () => {
      it('should remove entity by reference', () => {
        const entity = world.createEntity();
        const removed = world.removeEntity(entity);

        expect(removed).toBe(true);
        expect(world.getEntityCount()).toBe(0);
      });

      it('should remove entity by id', () => {
        const entity = world.createEntity('test-id');
        const removed = world.removeEntity('test-id');

        expect(removed).toBe(true);
        expect(world.getEntity('test-id')).toBeUndefined();
      });

      it('should emit entity.removed event', () => {
        const callback = vi.fn();
        const entity = world.createEntity();
        world.getEventBus().on('world.entity.removed', callback);

        world.removeEntity(entity);

        expect(callback).toHaveBeenCalledWith({ world, entity });
      });

      it('should remove entity from all systems', () => {
        const system = new TestSystem(world.getEventBus());
        world.addSystem(system);

        const entity = world.createEntity();
        entity.add(TestComponent);

        world.removeEntity(entity);

        expect(system.getEntityCount()).toBe(0);
      });

      it('should call entity destroy', () => {
        const entity = world.createEntity();
        const destroySpy = vi.spyOn(entity, 'destroy');

        world.removeEntity(entity);

        expect(destroySpy).toHaveBeenCalled();
      });

      it('should return false for non-existent entity', () => {
        expect(world.removeEntity('non-existent')).toBe(false);
      });
    });

    describe('removeAllEntities', () => {
      it('should remove all entities', () => {
        world.createEntity();
        world.createEntity();
        world.createEntity();

        world.removeAllEntities();

        expect(world.getEntityCount()).toBe(0);
      });
    });
  });

  describe('system management', () => {
    describe('addSystem', () => {
      it('should add system to world', () => {
        const system = new TestSystem(world.getEventBus());
        world.addSystem(system);

        expect(world.getSystems()).toContain(system);
      });

      it('should not add duplicate system', () => {
        const system = new TestSystem(world.getEventBus());
        world.addSystem(system);
        world.addSystem(system);

        expect(world.getSystems()).toHaveLength(1);
      });

      it('should sort systems by priority', () => {
        const system1 = new TestSystem(world.getEventBus());
        const system2 = new AnotherSystem(world.getEventBus());
        system1.priority = 5;
        system2.priority = 10;

        world.addSystem(system1);
        world.addSystem(system2);

        const systems = world.getSystems();
        expect(systems[0]).toBe(system2); // Higher priority first
        expect(systems[1]).toBe(system1);
      });

      it('should initialize system if world is initialized', () => {
        world.initialize();

        const system = new TestSystem(world.getEventBus());
        const initSpy = vi.spyOn(system, 'initialize');

        world.addSystem(system);

        expect(initSpy).toHaveBeenCalled();
      });

      it('should add existing entities to new system', () => {
        const entity = world.createEntity();
        entity.add(TestComponent);

        const system = new TestSystem(world.getEventBus());
        world.addSystem(system);

        expect(system.getEntityCount()).toBe(1);
      });

      it('should emit system.added event', () => {
        const callback = vi.fn();
        world.getEventBus().on('world.system.added', callback);

        const system = new TestSystem(world.getEventBus());
        world.addSystem(system);

        expect(callback).toHaveBeenCalledWith({ world, system });
      });
    });

    describe('removeSystem', () => {
      it('should remove system from world', () => {
        const system = new TestSystem(world.getEventBus());
        world.addSystem(system);

        const removed = world.removeSystem(system);

        expect(removed).toBe(true);
        expect(world.getSystems()).not.toContain(system);
      });

      it('should shutdown system when removed', () => {
        const system = new TestSystem(world.getEventBus());
        const shutdownSpy = vi.spyOn(system, 'shutdown');

        world.addSystem(system);
        world.initialize();
        world.removeSystem(system);

        expect(shutdownSpy).toHaveBeenCalled();
      });

      it('should emit system.removed event', () => {
        const callback = vi.fn();
        const system = new TestSystem(world.getEventBus());
        world.addSystem(system);
        world.getEventBus().on('world.system.removed', callback);

        world.removeSystem(system);

        expect(callback).toHaveBeenCalledWith({ world, system });
      });

      it('should return false for non-existent system', () => {
        const system = new TestSystem(world.getEventBus());
        expect(world.removeSystem(system)).toBe(false);
      });
    });

    describe('getSystem', () => {
      it('should get system by class', () => {
        const system = new TestSystem(world.getEventBus());
        world.addSystem(system);

        const retrieved = world.getSystem(TestSystem);
        expect(retrieved).toBe(system);
      });

      it('should return undefined for non-existent system', () => {
        expect(world.getSystem(TestSystem)).toBeUndefined();
      });
    });
  });

  describe('update', () => {
    it('should initialize world if not initialized', () => {
      const initSpy = vi.spyOn(world, 'initialize');
      world.update(0.016);

      expect(initSpy).toHaveBeenCalled();
    });

    it('should update all enabled systems', () => {
      const system1 = new TestSystem(world.getEventBus());
      const system2 = new TestSystem(world.getEventBus());

      world.addSystem(system1);
      world.addSystem(system2);

      world.update(0.016);

      expect(system1.updateCount).toBe(1);
      expect(system2.updateCount).toBe(1);
    });

    it('should not update disabled systems', () => {
      const system = new TestSystem(world.getEventBus());
      system.enabled = false;

      world.addSystem(system);
      world.update(0.016);

      expect(system.updateCount).toBe(0);
    });

    it('should emit update events', () => {
      const startCallback = vi.fn();
      const endCallback = vi.fn();

      world.getEventBus().on('world.update.start', startCallback);
      world.getEventBus().on('world.update.end', endCallback);

      world.update(0.016);

      expect(startCallback).toHaveBeenCalledWith({ world, deltaTime: 0.016 });
      expect(endCallback).toHaveBeenCalledWith({ world, deltaTime: 0.016 });
    });

    it('should set running state', () => {
      expect(world.isRunning()).toBe(false);
      world.update(0.016);
      expect(world.isRunning()).toBe(true);
    });

    it('should skip pauseable systems when world is paused', () => {
      const pauseableSystem = new TestSystem(world.getEventBus());
      pauseableSystem.pauseable = true;

      const nonPauseableSystem = new TestSystem(world.getEventBus());
      nonPauseableSystem.pauseable = false;

      world.addSystem(pauseableSystem);
      world.addSystem(nonPauseableSystem);

      world.pause();
      world.update(0.016);

      expect(pauseableSystem.updateCount).toBe(0);
      expect(nonPauseableSystem.updateCount).toBe(1);
    });

    it('should toggle pause state', () => {
      expect(world.paused).toBe(false);

      world.togglePause();
      expect(world.paused).toBe(true);

      world.togglePause();
      expect(world.paused).toBe(false);
    });
  });

  describe('event integration', () => {
    it('should refresh systems when component added', () => {
      const system = new TestSystem(world.getEventBus());
      world.addSystem(system);

      const entity = world.createEntity();
      expect(system.getEntityCount()).toBe(0);

      entity.add(TestComponent);
      expect(system.getEntityCount()).toBe(1);
    });

    it('should refresh systems when component removed', () => {
      const system = new TestSystem(world.getEventBus());
      world.addSystem(system);

      const entity = world.createEntity();
      entity.add(TestComponent);
      expect(system.getEntityCount()).toBe(1);

      entity.remove(TestComponent);
      expect(system.getEntityCount()).toBe(0);
    });

    it('should handle entity activation', () => {
      const system = new TestSystem(world.getEventBus());
      world.addSystem(system);

      const entity = world.createEntity();
      entity.add(TestComponent);
      entity.active = false;

      expect(system.getEntityCount()).toBe(0);

      entity.active = true;
      expect(system.getEntityCount()).toBe(1);
    });

    it('should handle entity deactivation', () => {
      const system = new TestSystem(world.getEventBus());
      world.addSystem(system);

      const entity = world.createEntity();
      entity.add(TestComponent);
      expect(system.getEntityCount()).toBe(1);

      entity.active = false;
      expect(system.getEntityCount()).toBe(0);
    });

    it('should refresh systems when tags change', () => {
      const eventBus = world.getEventBus();
      const system = new (class extends System {
        constructor() {
          super(eventBus);
          this.query = { tags: ['player'] };
        }
        protected onUpdate(deltaTime: number): void {}
      })();

      world.addSystem(system);

      const entity = world.createEntity();
      expect(system.getEntityCount()).toBe(0);

      entity.addTag('player');
      expect(system.getEntityCount()).toBe(1);

      entity.removeTag('player');
      expect(system.getEntityCount()).toBe(0);
    });
  });

  describe('destroy', () => {
    it('should clean up world completely', () => {
      const system = new TestSystem(world.getEventBus());
      world.addSystem(system);
      world.createEntity();
      world.initialize();

      world.destroy();

      expect(world.getEntityCount()).toBe(0);
      expect(world.getSystems()).toHaveLength(0);
      expect(world.initialized).toBe(false);
    });

    it('should clear event bus', () => {
      const eventBus = world.getEventBus();
      const clearSpy = vi.spyOn(eventBus, 'clear');

      world.destroy();

      expect(clearSpy).toHaveBeenCalled();
    });
  });

  describe('toJSON', () => {
    it('should serialize world state', () => {
      const system = new TestSystem(world.getEventBus());
      world.addSystem(system);

      const entity = world.createEntity();
      entity.name = 'TestEntity';
      entity.add(TestComponent);

      world.initialize();
      world.update(0.016);

      const json = world.toJSON();

      expect(json.entityCount).toBe(1);
      expect(json.maxEntities).toBe(10000);
      expect(json.systems).toEqual(['TestSystem']);
      expect(json.entities).toHaveLength(1);
      expect(json.entities[0].name).toBe('TestEntity');
      expect(json.running).toBe(true);
      expect(json.initialized).toBe(true);
    });
  });

  describe('getters', () => {
    it('should get entity count', () => {
      world.createEntity();
      world.createEntity();
      expect(world.getEntityCount()).toBe(2);
    });

    it('should get max entities', () => {
      expect(world.getMaxEntities()).toBe(10000);
    });

    it('should get event bus', () => {
      expect(world.getEventBus()).toBeInstanceOf(EventBus);
    });

    it('should get running state', () => {
      expect(world.isRunning()).toBe(false);
      world.update(0.016);
      expect(world.isRunning()).toBe(true);
    });
  });

  describe('frame tracking', () => {
    it('should call eventBus.startFrame() on each update', () => {
      const eventBus = world.getEventBus();
      expect(eventBus.currentFrame).toBe(0);

      world.update(0.016);
      expect(eventBus.currentFrame).toBe(1);

      world.update(0.016);
      expect(eventBus.currentFrame).toBe(2);

      world.update(0.016);
      expect(eventBus.currentFrame).toBe(3);
    });

    it('should increment frame before emitting world.update.start', () => {
      const eventBus = world.getEventBus();
      let frameAtUpdateStart = -1;

      eventBus.on('world.update.start', () => {
        frameAtUpdateStart = eventBus.currentFrame;
      });

      world.update(0.016);

      // Frame should have been incremented before the event was emitted
      expect(frameAtUpdateStart).toBe(1);
    });
  });
});
