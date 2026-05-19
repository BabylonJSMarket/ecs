import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Entity, Component, EventBus } from '..';

class TestComponent extends Component {
  value: number;

  constructor(value: number = 0) {
    super();
    this.value = value;
  }
}

class AnotherComponent extends Component {
  name: string = 'test';
}

class ThirdComponent extends Component {
  flag: boolean = false;
}

describe('Entity', () => {
  let entity: Entity;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    entity = new Entity(eventBus);
  });

  describe('constructor', () => {
    it('should generate unique ids', () => {
      const entity1 = new Entity(eventBus);
      const entity2 = new Entity(eventBus);

      expect(entity1.id).not.toBe(entity2.id);
      expect(entity1.id).toMatch(/^entity-\d+$/);
      expect(entity2.id).toMatch(/^entity-\d+$/);
    });

    it('should accept custom id', () => {
      const customEntity = new Entity(eventBus, 'custom-id');
      expect(customEntity.id).toBe('custom-id');
    });

    it('should be active by default', () => {
      expect(entity.active).toBe(true);
    });

    it('should have empty name by default', () => {
      expect(entity.name).toBe('');
    });
  });

  describe('active property', () => {
    it('should emit event when activated', () => {
      const callback = vi.fn();
      eventBus.on(`entity.${entity.id}.activated`, callback);

      entity.active = false;
      entity.active = true;

      expect(callback).toHaveBeenCalledWith({ entity });
    });

    it('should emit event when deactivated', () => {
      const callback = vi.fn();
      eventBus.on(`entity.${entity.id}.deactivated`, callback);

      entity.active = false;

      expect(callback).toHaveBeenCalledWith({ entity });
    });

    it('should not emit event if value does not change', () => {
      const callback = vi.fn();
      eventBus.on(`entity.${entity.id}.activated`, callback);

      entity.active = true; // Already true

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('name property', () => {
    it('should set and get name', () => {
      entity.name = 'Player';
      expect(entity.name).toBe('Player');
    });
  });

  describe('add', () => {
    it('should add component to entity', () => {
      const result = entity.add(TestComponent, 42);
      const component = entity.get(TestComponent);

      expect(result).toBe(entity); // Should return entity for chaining
      expect(component).toBeInstanceOf(TestComponent);
      expect(component?.value).toBe(42);
      expect(entity.has(TestComponent)).toBe(true);
    });

    it('should emit component.added event', () => {
      const callback = vi.fn();
      eventBus.on(`entity.${entity.id}.component.added`, callback);

      entity.add(TestComponent);
      const component = entity.get(TestComponent);

      expect(callback).toHaveBeenCalledWith({
        entity,
        component,
        type: TestComponent,
      });
    });

    it('should call component onAttach', () => {
      entity.add(TestComponent);
      const component = entity.get(TestComponent)!;
      expect((component as any).entityId).toBe(entity.id);
      expect((component as any).eventBus).toBe(eventBus);
    });

    it('should return entity without replacing existing component', () => {
      entity.add(TestComponent, 10);
      const component1 = entity.get(TestComponent)!;

      const result = entity.add(TestComponent, 20);
      const component2 = entity.get(TestComponent)!;

      expect(result).toBe(entity); // Returns entity for chaining
      expect(component1).toBe(component2); // Same component
      expect(component1.value).toBe(10); // Value not changed
    });

    it('should add component instance directly', () => {
      // Test the branch where a component instance is passed directly (lines 129-130)
      const instance = new TestComponent(99);
      const result = entity.add(instance);

      expect(result).toBe(entity); // Should return entity for chaining
      expect(entity.has(TestComponent)).toBe(true);
      const retrieved = entity.get(TestComponent);
      expect(retrieved).toBe(instance); // Should be the same instance
      expect(retrieved?.value).toBe(99);
    });
  });

  describe('get', () => {
    it('should get component by type', () => {
      entity.add(TestComponent, 42);
      const retrieved = entity.get(TestComponent);

      expect(retrieved).toBeInstanceOf(TestComponent);
      expect(retrieved?.value).toBe(42);
    });

    it('should return undefined if component not found', () => {
      expect(entity.get(TestComponent)).toBeUndefined();
    });

    it('should fallback to class name lookup when direct reference fails', () => {
      // This tests the dynamic import compatibility fallback (lines 174-177)
      // where a component can be found by class name if the direct reference lookup fails
      entity.add(TestComponent, 42);

      // Create a different class with the same name to simulate dynamic import mismatch
      const DifferentTestComponent = class TestComponent extends Component {
        value: number = 0;
      };

      // The direct lookup will fail, but the name-based fallback should find it
      const retrieved = entity.get(DifferentTestComponent);

      expect(retrieved).toBeDefined();
      expect((retrieved as any).value).toBe(42);
    });
  });

  describe('has', () => {
    it('should return true if entity has component', () => {
      entity.add(TestComponent);
      expect(entity.has(TestComponent)).toBe(true);
    });

    it('should return false if entity does not have component', () => {
      expect(entity.has(TestComponent)).toBe(false);
    });

    it('should fallback to class name lookup when direct reference fails', () => {
      // This tests the dynamic import compatibility fallback (line 192)
      entity.add(TestComponent);

      // Create a different class with the same name to simulate dynamic import mismatch
      const DifferentTestComponent = class TestComponent extends Component {
        value: number = 0;
      };

      // The direct lookup will fail, but the name-based fallback should find it
      expect(entity.has(DifferentTestComponent)).toBe(true);
    });
  });

  describe('hasAll', () => {
    it('should return true if entity has all components', () => {
      entity.add(TestComponent);
      entity.add(AnotherComponent);

      expect(entity.hasAll(TestComponent, AnotherComponent)).toBe(true);
    });

    it('should return false if entity missing any component', () => {
      entity.add(TestComponent);

      expect(entity.hasAll(TestComponent, AnotherComponent)).toBe(false);
    });

    it('should return true for empty array', () => {
      expect(entity.hasAll()).toBe(true);
    });
  });

  describe('hasAny', () => {
    it('should return true if entity has any component', () => {
      entity.add(TestComponent);

      expect(entity.hasAny(TestComponent, AnotherComponent)).toBe(true);
    });

    it('should return false if entity has none of the components', () => {
      expect(entity.hasAny(TestComponent, AnotherComponent)).toBe(false);
    });

    it('should return false for empty array', () => {
      expect(entity.hasAny()).toBe(false);
    });
  });

  describe('remove', () => {
    it('should remove component from entity', () => {
      entity.add(TestComponent);
      const result = entity.remove(TestComponent);

      expect(result).toBe(entity); // Returns entity for chaining
      expect(entity.has(TestComponent)).toBe(false);
    });

    it('should emit component.removed event', () => {
      const callback = vi.fn();
      entity.add(TestComponent);
      const component = entity.get(TestComponent);
      eventBus.on(`entity.${entity.id}.component.removed`, callback);

      entity.remove(TestComponent);

      expect(callback).toHaveBeenCalledWith({
        entity,
        component,
        type: TestComponent,
      });
    });

    it('should call component onDetach', () => {
      entity.add(TestComponent);
      const component = entity.get(TestComponent)!;
      const detachSpy = vi.spyOn(component, 'onDetach');

      entity.remove(TestComponent);

      expect(detachSpy).toHaveBeenCalled();
    });

    it('should return entity even if component not found', () => {
      expect(entity.remove(TestComponent)).toBe(entity);
    });
  });

  describe('removeAll', () => {
    it('should remove all components', () => {
      entity.add(TestComponent);
      entity.add(AnotherComponent);
      entity.add(ThirdComponent);

      entity.removeAll();

      expect(entity.getComponents()).toHaveLength(0);
    });

    it('should call onDetach for all components', () => {
      entity.add(TestComponent);
      entity.add(AnotherComponent);
      const comp1 = entity.get(TestComponent)!;
      const comp2 = entity.get(AnotherComponent)!;
      const spy1 = vi.spyOn(comp1, 'onDetach');
      const spy2 = vi.spyOn(comp2, 'onDetach');

      entity.removeAll();

      expect(spy1).toHaveBeenCalled();
      expect(spy2).toHaveBeenCalled();
    });
  });

  describe('getComponents', () => {
    it('should return array of all components', () => {
      entity.add(TestComponent);
      entity.add(AnotherComponent);
      const comp1 = entity.get(TestComponent)!;
      const comp2 = entity.get(AnotherComponent)!;

      const components = entity.getComponents();

      expect(components).toHaveLength(2);
      expect(components).toContain(comp1);
      expect(components).toContain(comp2);
    });

    it('should return empty array if no components', () => {
      expect(entity.getComponents()).toHaveLength(0);
    });
  });

  describe('getComponentTypes', () => {
    it('should return array of component types', () => {
      entity.add(TestComponent);
      entity.add(AnotherComponent);

      const types = entity.getComponentTypes();

      expect(types).toHaveLength(2);
      expect(types).toContain(TestComponent);
      expect(types).toContain(AnotherComponent);
    });
  });

  describe('tags', () => {
    describe('addTag', () => {
      it('should add tag to entity', () => {
        entity.addTag('player');
        expect(entity.hasTag('player')).toBe(true);
      });

      it('should emit tag.added event', () => {
        const callback = vi.fn();
        eventBus.on(`entity.${entity.id}.tag.added`, callback);

        entity.addTag('player');

        expect(callback).toHaveBeenCalledWith({ entity, tag: 'player' });
      });

      it('should not add duplicate tags', () => {
        const callback = vi.fn();
        eventBus.on(`entity.${entity.id}.tag.added`, callback);

        entity.addTag('player');
        entity.addTag('player');

        expect(callback).toHaveBeenCalledTimes(1);
        expect(entity.getTags()).toHaveLength(1);
      });
    });

    describe('removeTag', () => {
      it('should remove tag from entity', () => {
        entity.addTag('player');
        const result = entity.removeTag('player');

        expect(result).toBe(entity); // Returns entity for chaining
        expect(entity.hasTag('player')).toBe(false);
      });

      it('should emit tag.removed event', () => {
        const callback = vi.fn();
        entity.addTag('player');
        eventBus.on(`entity.${entity.id}.tag.removed`, callback);

        entity.removeTag('player');

        expect(callback).toHaveBeenCalledWith({ entity, tag: 'player' });
      });

      it('should return entity even if tag not found', () => {
        expect(entity.removeTag('nonexistent')).toBe(entity);
      });
    });

    describe('hasTag', () => {
      it('should return true if entity has tag', () => {
        entity.addTag('player');
        expect(entity.hasTag('player')).toBe(true);
      });

      it('should return false if entity does not have tag', () => {
        expect(entity.hasTag('player')).toBe(false);
      });
    });

    describe('getTags', () => {
      it('should return array of tags', () => {
        entity.addTag('player');
        entity.addTag('hero');

        const tags = entity.getTags();

        expect(tags).toHaveLength(2);
        expect(tags).toContain('player');
        expect(tags).toContain('hero');
      });

      it('should return empty array if no tags', () => {
        expect(entity.getTags()).toHaveLength(0);
      });
    });

    describe('clearTags', () => {
      it('should remove all tags', () => {
        entity.addTag('player');
        entity.addTag('hero');

        entity.clearTags();

        expect(entity.getTags()).toHaveLength(0);
      });
    });
  });

  describe('clone', () => {
    it('should create a deep copy of the entity', () => {
      entity.name = 'Original';
      entity.active = false;
      entity.addTag('player');
      entity.add(TestComponent, 42);

      const cloned = entity.clone();

      expect(cloned).not.toBe(entity);
      expect(cloned.id).not.toBe(entity.id);
      expect(cloned.name).toBe('Original');
      expect(cloned.active).toBe(false);
      expect(cloned.hasTag('player')).toBe(true);
      expect(cloned.has(TestComponent)).toBe(true);
      expect(cloned.get(TestComponent)?.value).toBe(42);
    });

    it('should attach cloned components to new entity', () => {
      entity.add(TestComponent);
      const cloned = entity.clone();
      const clonedComponent = cloned.get(TestComponent);

      expect((clonedComponent as any).entityId).toBe(cloned.id);
    });

    it('should create independent copy', () => {
      entity.addTag('original');
      const cloned = entity.clone();

      cloned.addTag('cloned');
      entity.addTag('modified');

      expect(entity.hasTag('cloned')).toBe(false);
      expect(cloned.hasTag('modified')).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should remove all components', () => {
      entity.add(TestComponent);
      entity.add(AnotherComponent);

      entity.destroy();

      expect(entity.getComponents()).toHaveLength(0);
    });

    it('should clear all tags', () => {
      entity.addTag('player');
      entity.addTag('hero');

      entity.destroy();

      expect(entity.getTags()).toHaveLength(0);
    });

    it('should emit destroyed event', () => {
      const callback = vi.fn();
      eventBus.on(`entity.${entity.id}.destroyed`, callback);

      entity.destroy();

      expect(callback).toHaveBeenCalledWith({ entity });
    });
  });

  describe('toJSON', () => {
    it('should serialize entity to JSON', () => {
      entity.name = 'Player';
      entity.active = false;
      entity.addTag('hero');
      entity.addTag('player');
      entity.add(TestComponent, 100);
      entity.add(AnotherComponent);

      const json = entity.toJSON();

      expect(json.id).toBe(entity.id);
      expect(json.name).toBe('Player');
      expect(json.active).toBe(false);
      expect(json.tags).toEqual(['hero', 'player']);
      expect(json.components.TestComponent.value).toBe(100);
      expect(json.components.AnotherComponent.name).toBe('test');
    });

    it('should handle empty entity', () => {
      const json = entity.toJSON();

      expect(json.id).toBe(entity.id);
      expect(json.name).toBe('');
      expect(json.active).toBe(true);
      expect(json.tags).toEqual([]);
      expect(json.components).toEqual({});
    });
  });
});
