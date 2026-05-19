import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Component, EventBus } from '..';

class TestComponent extends Component {
  value: number = 0;
  onAttachCalled = false;
  onDetachCalled = false;

  protected onAttachOverride(): void {
    this.onAttachCalled = true;
  }

  protected onDetachOverride(): void {
    this.onDetachCalled = true;
  }

  testEmit(event: string, data?: any): void {
    this.emit(event, data);
  }
}

class AnotherTestComponent extends Component {
  name: string = 'test';
}

describe('Component', () => {
  let component: TestComponent;
  let eventBus: EventBus;

  beforeEach(() => {
    component = new TestComponent();
    eventBus = new EventBus();
  });

  describe('lifecycle', () => {
    it('should call onAttachOverride when attached', () => {
      component.onAttach('entity-1', eventBus);

      expect(component.onAttachCalled).toBe(true);
      expect((component as any).entityId).toBe('entity-1');
      expect((component as any).eventBus).toBe(eventBus);
    });

    it('should call onDetachOverride when detached', () => {
      component.onAttach('entity-1', eventBus);
      component.onDetach();

      expect(component.onDetachCalled).toBe(true);
      expect((component as any).entityId).toBeUndefined();
      expect((component as any).eventBus).toBeUndefined();
    });
  });

  describe('enabled property', () => {
    it('should be enabled by default', () => {
      expect(component.enabled).toBe(true);
    });

    it('should emit event when enabled state changes', () => {
      const callback = vi.fn();
      eventBus.on('component.TestComponent.disabled', callback);

      component.onAttach('entity-1', eventBus);
      component.enabled = false;

      expect(callback).toHaveBeenCalledWith({
        entityId: 'entity-1',
        component,
      });
    });

    it('should emit enabled event when re-enabled', () => {
      const callback = vi.fn();
      eventBus.on('component.TestComponent.enabled', callback);

      component.onAttach('entity-1', eventBus);
      component.enabled = false;
      component.enabled = true;

      expect(callback).toHaveBeenCalledWith({
        entityId: 'entity-1',
        component,
      });
    });

    it('should not emit event if enabled state does not change', () => {
      const callback = vi.fn();
      eventBus.on('component.TestComponent.enabled', callback);

      component.onAttach('entity-1', eventBus);
      component.enabled = true; // Already true

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('emit', () => {
    it('should emit namespaced events', () => {
      const callback = vi.fn();
      eventBus.on('entity.entity-1.test-event', callback);

      component.onAttach('entity-1', eventBus);
      component.testEmit('test-event', { value: 42 });

      expect(callback).toHaveBeenCalledWith({ value: 42 });
    });

    it('should not emit if not attached to entity', () => {
      const callback = vi.fn();
      eventBus.on('entity.entity-1.test-event', callback);

      component.testEmit('test-event', { value: 42 });

      expect(callback).not.toHaveBeenCalled();
    });

    it('should not emit if eventBus is not set', () => {
      const callback = vi.fn();
      (component as any).entityId = 'entity-1';

      expect(() => component.testEmit('test-event')).not.toThrow();
    });
  });

  describe('clone', () => {
    it('should create a deep copy of the component', () => {
      component.value = 100;
      component.onAttach('entity-1', eventBus);

      const cloned = component.clone() as TestComponent;

      expect(cloned).not.toBe(component);
      expect(cloned.value).toBe(100);
      expect((cloned as any).entityId).toBeUndefined();
      expect((cloned as any).eventBus).toBeUndefined();
    });

    it('should preserve the component type', () => {
      const cloned = component.clone();
      expect(cloned).toBeInstanceOf(TestComponent);
    });

    it('should work with different component types', () => {
      const anotherComponent = new AnotherTestComponent();
      anotherComponent.name = 'modified';

      const cloned = anotherComponent.clone() as AnotherTestComponent;

      expect(cloned).toBeInstanceOf(AnotherTestComponent);
      expect(cloned.name).toBe('modified');
    });
  });

  describe('toJSON', () => {
    it('should serialize component data without entityId and eventBus', () => {
      component.value = 42;
      component.onAttach('entity-1', eventBus);

      const json = component.toJSON();

      expect(json.value).toBe(42);
      expect(json.entityId).toBeUndefined();
      expect(json.eventBus).toBeUndefined();
      expect(json._enabled).toBe(true);
    });

    it('should include all public properties', () => {
      component.value = 100;
      component.enabled = false;

      const json = component.toJSON();

      expect(json.value).toBe(100);
      expect(json._enabled).toBe(false);
      expect(json.onAttachCalled).toBe(false);
      expect(json.onDetachCalled).toBe(false);
    });
  });
});
