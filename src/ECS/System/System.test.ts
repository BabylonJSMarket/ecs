import { describe, it, expect, beforeEach, vi } from 'vitest';
import { System, Entity, Component, EventBus } from '..';
import type { ISystemQuery } from '..';

class TestComponent extends Component {
  value: number = 0;
}

class AnotherComponent extends Component {
  name: string = 'test';
}

class ExcludedComponent extends Component {
  flag: boolean = false;
}

class TestSystem extends System {
  updateCalled = false;
  updateCount = 0;
  lastDeltaTime = 0;
  addedEntities: Entity[] = [];
  removedEntities: Entity[] = [];
  initializeCalled = false;
  shutdownCalled = false;

  constructor(eventBus: EventBus, query: ISystemQuery = {}) {
    super(eventBus);
    this.query = query;
  }

  protected onInitialize(): void {
    this.initializeCalled = true;
  }

  protected onShutdown(): void {
    this.shutdownCalled = true;
  }

  protected onEntityAdded(entity: Entity): void {
    this.addedEntities.push(entity);
  }

  protected onEntityRemoved(entity: Entity): void {
    this.removedEntities.push(entity);
  }

  protected onUpdate(deltaTime: number): void {
    this.updateCalled = true;
    this.updateCount++;
    this.lastDeltaTime = deltaTime;
  }
}

describe('System', () => {
  let system: TestSystem;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    system = new TestSystem(eventBus);
  });

  describe('properties', () => {
    it('should be enabled by default', () => {
      expect(system.enabled).toBe(true);
    });

    it('should emit event when enabled state changes', () => {
      const callback = vi.fn();
      eventBus.on('system.TestSystem.disabled', callback);

      system.enabled = false;

      expect(callback).toHaveBeenCalledWith({ system });
    });

    it('should not emit event if enabled state does not change', () => {
      const callback = vi.fn();
      eventBus.on('system.TestSystem.enabled', callback);

      system.enabled = true; // Already true

      expect(callback).not.toHaveBeenCalled();
    });

    it('should have priority 0 by default', () => {
      expect(system.priority).toBe(0);
    });

    it('should set priority', () => {
      system.priority = 10;
      expect(system.priority).toBe(10);
    });

    it('should be pauseable by default', () => {
      expect(system.pauseable).toBe(true);
    });

    it('should set pauseable', () => {
      system.pauseable = false;
      expect(system.pauseable).toBe(false);
    });

    it('should not be initialized by default', () => {
      expect(system.initialized).toBe(false);
    });
  });

  describe('initialization', () => {
    it('should initialize only once', () => {
      system.initialize();
      system.initialize();

      expect(system.initializeCalled).toBe(true);
      expect(system.initialized).toBe(true);
    });

    it('should call onInitialize', () => {
      system.initialize();
      expect(system.initializeCalled).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('should only shutdown if initialized', () => {
      system.shutdown();
      expect(system.shutdownCalled).toBe(false);

      system.initialize();
      system.shutdown();
      expect(system.shutdownCalled).toBe(true);
    });

    it('should clear entities on shutdown', () => {
      system.initialize();
      const entity = new Entity(eventBus);
      entity.add(TestComponent);
      system.addEntity(entity);

      system.shutdown();

      expect(system.getEntityCount()).toBe(0);
      expect(system.initialized).toBe(false);
    });
  });

  describe('listen (auto-disposed subscriptions)', () => {
    class ListeningSystem extends System {
      received: any[] = [];

      protected onInitialize(): void {
        this.listen('test.event', (data) => this.received.push(data));
      }

      protected onUpdate(): void {}

      // Expose the protected helpers for direct testing
      listenPublic<T>(type: string, cb: (data: T) => void) {
        return this.listen(type, cb);
      }
      listenOncePublic<T>(type: string, cb: (data: T) => void) {
        return this.listenOnce(type, cb);
      }
      listenForEntityPublic(type: string, entityId: string, cb: (data: any) => void) {
        return this.listenForEntity(type, entityId, cb);
      }
    }

    let listening: ListeningSystem;

    beforeEach(() => {
      listening = new ListeningSystem(eventBus);
    });

    it('should receive events subscribed via listen', () => {
      listening.initialize();
      eventBus.emit('test.event', { value: 1 });
      expect(listening.received).toEqual([{ value: 1 }]);
    });

    it('should unsubscribe automatically on shutdown', () => {
      listening.initialize();
      listening.shutdown();

      eventBus.emit('test.event', { value: 1 });

      expect(listening.received).toEqual([]);
      expect(eventBus.getListenerCount('test.event')).toBe(0);
    });

    it('should re-subscribe when re-initialized after shutdown', () => {
      listening.initialize();
      listening.shutdown();
      listening.initialize();

      eventBus.emit('test.event', { value: 2 });

      expect(listening.received).toEqual([{ value: 2 }]);
    });

    it('should not double-fire after a shutdown/initialize cycle', () => {
      listening.initialize();
      listening.shutdown();
      listening.initialize();

      eventBus.emit('test.event', 'once');

      expect(listening.received).toHaveLength(1);
    });

    it('should support manual unsubscribe before shutdown', () => {
      listening.initialize();
      const unsub = listening.listenPublic('other.event', (d) => listening.received.push(d));

      unsub();
      eventBus.emit('other.event', 1);

      expect(listening.received).toEqual([]);
      // Manual unsub is idempotent and shutdown still works cleanly
      unsub();
      listening.shutdown();
    });

    it('should clean up subscriptions made outside onInitialize', () => {
      listening.initialize();
      listening.listenPublic('late.event', (d) => listening.received.push(d));

      listening.shutdown();
      eventBus.emit('late.event', 1);

      expect(listening.received).toEqual([]);
      expect(eventBus.getListenerCount('late.event')).toBe(0);
    });

    it('listenOnce should fire once and be safe to drain at shutdown', () => {
      listening.initialize();
      listening.listenOncePublic('once.event', (d) => listening.received.push(d));

      eventBus.emit('once.event', 1);
      eventBus.emit('once.event', 2);

      expect(listening.received).toEqual([1]);
      listening.shutdown(); // already-fired once-sub must not throw
    });

    it('listenOnce should be cleaned at shutdown if never fired', () => {
      listening.initialize();
      listening.listenOncePublic('once.event', (d) => listening.received.push(d));

      listening.shutdown();
      eventBus.emit('once.event', 1);

      expect(listening.received).toEqual([]);
    });

    it('listenForEntity should route by entityId and clean up at shutdown', () => {
      listening.initialize();
      listening.listenForEntityPublic('pos.changed', 'hero', (d) => listening.received.push(d));

      eventBus.emit('pos.changed', { entityId: 'npc-1', x: 1 });
      eventBus.emit('pos.changed', { entityId: 'hero', x: 2 });
      expect(listening.received).toEqual([{ entityId: 'hero', x: 2 }]);

      listening.shutdown();
      eventBus.emit('pos.changed', { entityId: 'hero', x: 3 });
      expect(listening.received).toHaveLength(1);
    });
  });

  describe('query matching', () => {
    let entity: Entity;

    beforeEach(() => {
      entity = new Entity(eventBus);
    });

    it('should match entity without query constraints', () => {
      expect(system.matchesQuery(entity)).toBe(true);
    });

    it('should not match inactive entities', () => {
      entity.active = false;
      expect(system.matchesQuery(entity)).toBe(false);
    });

    describe('required components', () => {
      beforeEach(() => {
        system = new TestSystem(eventBus, {
          required: [TestComponent, AnotherComponent],
        });
      });

      it('should match entity with all required components', () => {
        entity.add(TestComponent);
        entity.add(AnotherComponent);
        expect(system.matchesQuery(entity)).toBe(true);
      });

      it('should not match entity missing required components', () => {
        entity.add(TestComponent);
        expect(system.matchesQuery(entity)).toBe(false);
      });
    });

    describe('excluded components', () => {
      beforeEach(() => {
        system = new TestSystem(eventBus, {
          required: [TestComponent],
          excluded: [ExcludedComponent],
        });
      });

      it('should match entity without excluded components', () => {
        entity.add(TestComponent);
        expect(system.matchesQuery(entity)).toBe(true);
      });

      it('should not match entity with excluded components', () => {
        entity.add(TestComponent);
        entity.add(ExcludedComponent);
        expect(system.matchesQuery(entity)).toBe(false);
      });
    });

    describe('anyOf components', () => {
      beforeEach(() => {
        system = new TestSystem(eventBus, {
          anyOf: [TestComponent, AnotherComponent],
        });
      });

      it('should match entity with any of the components', () => {
        entity.add(TestComponent);
        expect(system.matchesQuery(entity)).toBe(true);

        const entity2 = new Entity(eventBus);
        entity2.add(AnotherComponent);
        expect(system.matchesQuery(entity2)).toBe(true);
      });

      it('should not match entity without any of the components', () => {
        entity.add(ExcludedComponent);
        expect(system.matchesQuery(entity)).toBe(false);
      });
    });

    describe('tags', () => {
      beforeEach(() => {
        system = new TestSystem(eventBus, {
          tags: ['player', 'hero'],
        });
      });

      it('should match entity with all required tags', () => {
        entity.addTag('player');
        entity.addTag('hero');
        expect(system.matchesQuery(entity)).toBe(true);
      });

      it('should not match entity missing required tags', () => {
        entity.addTag('player');
        expect(system.matchesQuery(entity)).toBe(false);
      });
    });

    describe('excluded tags', () => {
      beforeEach(() => {
        system = new TestSystem(eventBus, {
          excludedTags: ['enemy'],
        });
      });

      it('should match entity without excluded tags', () => {
        entity.addTag('player');
        expect(system.matchesQuery(entity)).toBe(true);
      });

      it('should not match entity with excluded tags', () => {
        entity.addTag('enemy');
        expect(system.matchesQuery(entity)).toBe(false);
      });
    });

    describe('complex queries', () => {
      beforeEach(() => {
        system = new TestSystem(eventBus, {
          required: [TestComponent],
          excluded: [ExcludedComponent],
          tags: ['player'],
          excludedTags: ['enemy'],
        });
      });

      it('should match entity meeting all criteria', () => {
        entity.add(TestComponent);
        entity.addTag('player');
        expect(system.matchesQuery(entity)).toBe(true);
      });

      it('should not match if any criteria fails', () => {
        entity.add(TestComponent);
        entity.addTag('player');
        entity.add(ExcludedComponent);
        expect(system.matchesQuery(entity)).toBe(false);

        entity.remove(ExcludedComponent);
        entity.addTag('enemy');
        expect(system.matchesQuery(entity)).toBe(false);
      });
    });
  });

  describe('entity management', () => {
    let entity: Entity;

    beforeEach(() => {
      system = new TestSystem(eventBus, {
        required: [TestComponent],
      });
      entity = new Entity(eventBus);
    });

    describe('addEntity', () => {
      it('should add matching entity', () => {
        entity.add(TestComponent);
        system.addEntity(entity);

        expect(system.getEntityCount()).toBe(1);
        expect(system.addedEntities).toContain(entity);
      });

      it('should not add non-matching entity', () => {
        system.addEntity(entity);

        expect(system.getEntityCount()).toBe(0);
        expect(system.addedEntities).toHaveLength(0);
      });

      it('should not add entity twice', () => {
        entity.add(TestComponent);
        system.addEntity(entity);
        system.addEntity(entity);

        expect(system.getEntityCount()).toBe(1);
        expect(system.addedEntities).toHaveLength(1);
      });
    });

    describe('removeEntity', () => {
      it('should remove entity', () => {
        entity.add(TestComponent);
        system.addEntity(entity);
        system.removeEntity(entity);

        expect(system.getEntityCount()).toBe(0);
        expect(system.removedEntities).toContain(entity);
      });

      it('should handle removing non-existent entity', () => {
        system.removeEntity(entity);
        expect(system.removedEntities).toHaveLength(0);
      });
    });

    describe('refreshEntity', () => {
      beforeEach(() => {
        entity.add(TestComponent);
        system.addEntity(entity);
      });

      it('should remove entity if no longer matches', () => {
        entity.remove(TestComponent);
        system.refreshEntity(entity);

        expect(system.getEntityCount()).toBe(0);
        expect(system.removedEntities).toContain(entity);
      });

      it('should add entity if now matches', () => {
        const newEntity = new Entity(eventBus);
        system.refreshEntity(newEntity);
        expect(system.getEntityCount()).toBe(1);

        newEntity.add(TestComponent);
        system.refreshEntity(newEntity);
        expect(system.getEntityCount()).toBe(2);
      });

      it('should handle inactive entities', () => {
        entity.active = false;
        system.refreshEntity(entity);

        expect(system.getEntityCount()).toBe(0);
      });
    });
  });

  describe('update', () => {
    beforeEach(() => {
      system.initialize();
    });

    it('should call onUpdate when enabled and initialized', () => {
      system.update(0.016);

      expect(system.updateCalled).toBe(true);
      expect(system.lastDeltaTime).toBe(0.016);
    });

    it('should not update when disabled', () => {
      system.enabled = false;
      system.update(0.016);

      expect(system.updateCalled).toBe(false);
    });

    it('should not update when not initialized', () => {
      system.shutdown();
      system.update(0.016);

      expect(system.updateCount).toBe(0);
    });

    it('should count updates', () => {
      system.update(0.016);
      system.update(0.016);
      system.update(0.016);

      expect(system.updateCount).toBe(3);
    });
  });

  describe('getEntities', () => {
    it('should return array of entities', () => {
      const entity1 = new Entity(eventBus);
      const entity2 = new Entity(eventBus);
      entity1.add(TestComponent);
      entity2.add(TestComponent);

      system = new TestSystem(eventBus, { required: [TestComponent] });
      system.addEntity(entity1);
      system.addEntity(entity2);

      const entities = system.getEntities();
      expect(entities).toHaveLength(2);
      expect(entities).toContain(entity1);
      expect(entities).toContain(entity2);
    });

    it('should return empty array when no entities', () => {
      expect(system.getEntities()).toHaveLength(0);
    });
  });

  describe('clearEntities', () => {
    it('should remove all entities', () => {
      const entity1 = new Entity(eventBus);
      const entity2 = new Entity(eventBus);
      entity1.add(TestComponent);
      entity2.add(TestComponent);

      system = new TestSystem(eventBus, { required: [TestComponent] });
      system.addEntity(entity1);
      system.addEntity(entity2);

      system.clearEntities();

      expect(system.getEntityCount()).toBe(0);
    });
  });
});
