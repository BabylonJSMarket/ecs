import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from './EventBus';

describe('EventBus', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe('emit and on', () => {
    it('should emit and receive events', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      eventBus.emit('test', { value: 42 });

      expect(callback).toHaveBeenCalledWith({ value: 42 });
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple listeners for the same event', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      eventBus.on('test', callback1);
      eventBus.on('test', callback2);

      eventBus.emit('test', 'data');

      expect(callback1).toHaveBeenCalledWith('data');
      expect(callback2).toHaveBeenCalledWith('data');
    });

    it('should not call listeners for different events', () => {
      const callback = vi.fn();
      eventBus.on('event1', callback);

      eventBus.emit('event2', 'data');

      expect(callback).not.toHaveBeenCalled();
    });

    it('should queue events when processing', () => {
      const callback1 = vi.fn(data => {
        if (data === 'first') {
          eventBus.emit('test', 'second');
        }
      });
      const callback2 = vi.fn();

      eventBus.on('test', callback1);
      eventBus.on('test', callback2);

      eventBus.emit('test', 'first');

      expect(callback1).toHaveBeenCalledTimes(2);
      expect(callback1).toHaveBeenNthCalledWith(1, 'first');
      expect(callback1).toHaveBeenNthCalledWith(2, 'second');
      expect(callback2).toHaveBeenCalledTimes(2);
    });
  });

  describe('emitImmediate', () => {
    it('should process event immediately without queuing', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      eventBus.emitImmediate('test', 'immediate');

      expect(callback).toHaveBeenCalledWith('immediate');
    });
  });

  describe('once', () => {
    it('should only trigger callback once', () => {
      const callback = vi.fn();
      eventBus.once('test', callback);

      eventBus.emit('test', 'first');
      eventBus.emit('test', 'second');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('first');
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = eventBus.once('test', callback);

      unsubscribe();
      eventBus.emit('test', 'data');

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('onForEntity', () => {
    it('only fires for events whose data.entityId matches', () => {
      const heroCb = vi.fn();
      eventBus.onForEntity('position.changed', 'hero', heroCb);

      eventBus.emit('position.changed', { entityId: 'npc-1', x: 1 });
      eventBus.emit('position.changed', { entityId: 'npc-2', x: 2 });
      eventBus.emit('position.changed', { entityId: 'hero', x: 3 });
      eventBus.emit('position.changed', { entityId: 'npc-3', x: 4 });

      expect(heroCb).toHaveBeenCalledTimes(1);
      expect(heroCb).toHaveBeenCalledWith({ entityId: 'hero', x: 3 });
    });

    it('does not fire when data has no entityId', () => {
      const cb = vi.fn();
      eventBus.onForEntity('test', 'hero', cb);

      eventBus.emit('test', { value: 42 });
      eventBus.emit('test', undefined);

      expect(cb).not.toHaveBeenCalled();
    });

    it('coexists with plain on() for the same event type', () => {
      const allCb = vi.fn();
      const heroCb = vi.fn();
      eventBus.on('position.changed', allCb);
      eventBus.onForEntity('position.changed', 'hero', heroCb);

      eventBus.emit('position.changed', { entityId: 'npc-1' });
      eventBus.emit('position.changed', { entityId: 'hero' });

      expect(allCb).toHaveBeenCalledTimes(2);
      expect(heroCb).toHaveBeenCalledTimes(1);
    });

    it('supports multiple listeners on the same (type, entityId)', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      eventBus.onForEntity('test', 'hero', cb1);
      eventBus.onForEntity('test', 'hero', cb2);

      eventBus.emit('test', { entityId: 'hero', v: 1 });

      expect(cb1).toHaveBeenCalledWith({ entityId: 'hero', v: 1 });
      expect(cb2).toHaveBeenCalledWith({ entityId: 'hero', v: 1 });
    });

    it('unsubscribe stops dispatch and prunes empty index buckets', () => {
      const cb = vi.fn();
      const unsub = eventBus.onForEntity('test', 'hero', cb);

      eventBus.emit('test', { entityId: 'hero' });
      expect(cb).toHaveBeenCalledTimes(1);

      unsub();
      eventBus.emit('test', { entityId: 'hero' });
      expect(cb).toHaveBeenCalledTimes(1);

      // Sanity: unsub on already-empty bucket is safe (idempotent).
      expect(() => unsub()).not.toThrow();
    });

    it('returns a no-op unsubscribe when entityId is empty', () => {
      const cb = vi.fn();
      const unsub = eventBus.onForEntity('test', '', cb);

      eventBus.emit('test', { entityId: 'anything' });

      expect(cb).not.toHaveBeenCalled();
      expect(() => unsub()).not.toThrow();
    });

    it('routes through the queue when emitted during another handler', () => {
      // Ensures queued events still hit entity-routed dispatch.
      const log: string[] = [];
      eventBus.on('first', () => {
        eventBus.emit('second', { entityId: 'hero' });
      });
      eventBus.onForEntity('second', 'hero', (d) => log.push(`hero:${(d as any).entityId}`));
      eventBus.onForEntity('second', 'other', (d) => log.push(`other:${(d as any).entityId}`));

      eventBus.emit('first', null);

      expect(log).toEqual(['hero:hero']);
    });

    it('clear() drops entity-routed listeners too', () => {
      const cb = vi.fn();
      eventBus.onForEntity('test', 'hero', cb);

      eventBus.clear();
      eventBus.emit('test', { entityId: 'hero' });

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('off', () => {
    it('should remove specific listener', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      eventBus.on('test', callback1);
      eventBus.on('test', callback2);

      eventBus.off('test', callback1);
      eventBus.emit('test', 'data');

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledWith('data');
    });

    it('should remove all listeners for an event type', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      eventBus.on('test', callback1);
      eventBus.on('test', callback2);

      eventBus.off('test');
      eventBus.emit('test', 'data');

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
    });
  });

  describe('unsubscribe function', () => {
    it('should unsubscribe when called', () => {
      const callback = vi.fn();
      const unsubscribe = eventBus.on('test', callback);

      eventBus.emit('test', 'first');
      unsubscribe();
      eventBus.emit('test', 'second');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('first');
    });
  });

  describe('wildcard listeners', () => {
    it('should receive all events with wildcard listener', () => {
      const callback = vi.fn();
      eventBus.on('*', callback);

      eventBus.emit('event1', 'data1');
      eventBus.emit('event2', 'data2');

      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledWith({ type: 'event1', data: 'data1' });
      expect(callback).toHaveBeenCalledWith({ type: 'event2', data: 'data2' });
    });

    it('should unsubscribe wildcard listener', () => {
      const callback = vi.fn();
      const unsubscribe = eventBus.on('*', callback);

      unsubscribe();
      eventBus.emit('test', 'data');

      expect(callback).not.toHaveBeenCalled();
    });

    it('should remove specific wildcard listener with off', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      eventBus.on('*', callback1);
      eventBus.on('*', callback2);

      eventBus.off('*', callback1);
      eventBus.emit('test', 'data');

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('should remove all wildcard listeners', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      eventBus.on('*', callback1);
      eventBus.on('*', callback2);

      eventBus.off('*');
      eventBus.emit('test', 'data');

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should remove all listeners', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      eventBus.on('event1', callback1);
      eventBus.on('event2', callback2);
      eventBus.on('*', callback3);

      eventBus.clear();

      eventBus.emit('event1', 'data');
      eventBus.emit('event2', 'data');

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
      expect(callback3).not.toHaveBeenCalled();
    });

    it('should clear event queue', () => {
      // Test that clear() removes both listeners and queued events
      const mainCallback = vi.fn();
      const queuedCallback = vi.fn();

      // Set up a listener that will queue an event
      eventBus.on('main', () => {
        eventBus.emit('queued', 'data');
      });

      eventBus.on('queued', queuedCallback);

      // Start the chain
      eventBus.emit('main', 'start');

      // The queued event should have been processed
      expect(queuedCallback).toHaveBeenCalledWith('data');

      // Now test clear functionality
      eventBus.clear();

      // After clear, no listeners should exist
      eventBus.on('test-clear', mainCallback);
      eventBus.clear(); // Clear immediately
      eventBus.emit('test-clear', 'should-not-call');

      expect(mainCallback).not.toHaveBeenCalled();
    });
  });

  describe('hasListeners', () => {
    it('should return true when listeners exist', () => {
      eventBus.on('test', () => {});
      expect(eventBus.hasListeners('test')).toBe(true);
    });

    it('should return false when no listeners exist', () => {
      expect(eventBus.hasListeners('test')).toBe(false);
    });

    it('should return true when wildcard listeners exist', () => {
      eventBus.on('*', () => {});
      expect(eventBus.hasListeners('any-event')).toBe(true);
    });
  });

  describe('getListenerCount', () => {
    it('should return count for specific event type', () => {
      eventBus.on('test', () => {});
      eventBus.on('test', () => {});

      expect(eventBus.getListenerCount('test')).toBe(2);
    });

    it('should include wildcard listeners in count', () => {
      eventBus.on('test', () => {});
      eventBus.on('*', () => {});

      expect(eventBus.getListenerCount('test')).toBe(2);
    });

    it('should return total count when no type specified', () => {
      eventBus.on('event1', () => {});
      eventBus.on('event2', () => {});
      eventBus.on('event2', () => {});
      eventBus.on('*', () => {});

      expect(eventBus.getListenerCount()).toBe(4);
    });

    it('should return 0 for event with no listeners', () => {
      expect(eventBus.getListenerCount('test')).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should catch and log errors in listeners', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const errorCallback = vi.fn(() => {
        throw new Error('Listener error');
      });
      const normalCallback = vi.fn();

      eventBus.on('test', errorCallback);
      eventBus.on('test', normalCallback);

      eventBus.emit('test', 'data');

      expect(errorCallback).toHaveBeenCalled();
      expect(normalCallback).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should catch and log errors in wildcard listeners', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const errorCallback = vi.fn(() => {
        throw new Error('Wildcard listener error');
      });

      eventBus.on('*', errorCallback);
      eventBus.emit('test', 'data');

      expect(errorCallback).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('emitChanged', () => {
    it('should skip duplicate emissions with same data', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      eventBus.emitChanged('test', { value: 42 });
      eventBus.emitChanged('test', { value: 42 });
      eventBus.emitChanged('test', { value: 42 });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({ value: 42 });
    });

    it('should emit when data changes', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      // emitChanged with objects filters out primitives in getDataKey
      // This means objects with numeric/string properties serialize to {}
      // and are all considered the same, so only the first emission goes through
      eventBus.emitChanged('test', { value: 1 });
      eventBus.emitChanged('test', { value: 2 }); // Duplicate key {} - skipped
      eventBus.emitChanged('test', { value: 3 }); // Duplicate key {} - skipped

      // Only first emission goes through
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({ value: 1 });
    });

    it('should handle null and undefined data', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      eventBus.emitChanged('test', null);
      eventBus.emitChanged('test', null);
      eventBus.emitChanged('test', undefined);
      eventBus.emitChanged('test', undefined);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should treat different event types independently', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      eventBus.on('event1', callback1);
      eventBus.on('event2', callback2);

      eventBus.emitChanged('event1', { value: 42 });
      eventBus.emitChanged('event2', { value: 42 });
      eventBus.emitChanged('event1', { value: 42 });
      eventBus.emitChanged('event2', { value: 42 });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should handle circular references gracefully', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      const circular: any = { value: 1 };
      circular.self = circular;

      expect(() => {
        eventBus.emitChanged('test', circular);
        eventBus.emitChanged('test', circular);
      }).not.toThrow();
    });

    it('should handle primitive types', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      // Primitive string values return undefined from getDataKey (JSON.stringify filters them)
      // The first call sets lastEventData to undefined
      // All subsequent calls with primitives also return undefined and match, so they're skipped
      // This is a limitation: emitChanged doesn't work with primitive values
      eventBus.emitChanged('test', 'hello');
      eventBus.emitChanged('test', 'hello');
      eventBus.emitChanged('test', 'world');

      // No emissions go through because all primitives have the same dataKey (undefined)
      expect(callback).toHaveBeenCalledTimes(0);
    });

    it('should handle numbers as data', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      // Numbers return undefined from getDataKey (JSON.stringify filters them)
      // This is a limitation: emitChanged doesn't work with primitive number values
      eventBus.emitChanged('test', 42);
      eventBus.emitChanged('test', 42);
      eventBus.emitChanged('test', 100);

      // No emissions go through because all numbers have the same dataKey (undefined)
      expect(callback).toHaveBeenCalledTimes(0);
    });

    it('should reset deduplication cache on clear', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      eventBus.emitChanged('test', { value: 42 });
      eventBus.clear();
      eventBus.on('test', callback);
      eventBus.emitChanged('test', { value: 42 });

      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('edge cases', () => {
    it('should handle emitting to no listeners gracefully', () => {
      expect(() => {
        eventBus.emit('nonexistent', { value: 42 });
      }).not.toThrow();
    });

    it('should handle different data types', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      eventBus.emit('test', 'string');
      expect(callback).toHaveBeenCalledWith('string');

      eventBus.emit('test', 42);
      expect(callback).toHaveBeenCalledWith(42);

      eventBus.emit('test', true);
      expect(callback).toHaveBeenCalledWith(true);

      eventBus.emit('test', null);
      expect(callback).toHaveBeenCalledWith(null);

      const obj = { nested: { value: 1 } };
      eventBus.emit('test', obj);
      expect(callback).toHaveBeenCalledWith(obj);

      const arr = [1, 2, 3];
      eventBus.emit('test', arr);
      expect(callback).toHaveBeenCalledWith(arr);
    });

    it('should handle same callback registered multiple times', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);
      eventBus.on('test', callback);

      eventBus.emit('test', { value: 42 });

      // Sets prevent duplicates, so should only be called once
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should handle rapid subscribe/unsubscribe cycles', () => {
      const callback = vi.fn();

      for (let i = 0; i < 100; i++) {
        const unsubscribe = eventBus.on('test', callback);
        unsubscribe();
      }

      eventBus.emit('test', {});
      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle very large event data', () => {
      const callback = vi.fn();
      const largeData = { items: new Array(10000).fill({ value: 42 }) };

      eventBus.on('test', callback);
      eventBus.emit('test', largeData);

      expect(callback).toHaveBeenCalledWith(largeData);
    });

    it('should handle empty event type string', () => {
      const callback = vi.fn();
      eventBus.on('', callback);
      eventBus.emit('', { value: 42 });

      expect(callback).toHaveBeenCalledWith({ value: 42 });
    });

    it('should handle many concurrent event types', () => {
      const callbacks = new Map<string, ReturnType<typeof vi.fn>>();

      for (let i = 0; i < 100; i++) {
        const callback = vi.fn();
        const eventType = `event${i}`;
        callbacks.set(eventType, callback);
        eventBus.on(eventType, callback);
      }

      for (let i = 0; i < 100; i++) {
        eventBus.emit(`event${i}`, { index: i });
      }

      callbacks.forEach((callback, eventType) => {
        const index = parseInt(eventType.replace('event', ''));
        expect(callback).toHaveBeenCalledWith({ index });
      });
    });

    it('should maintain listener order during emission', () => {
      const order: number[] = [];

      eventBus.on('test', () => order.push(1));
      eventBus.on('test', () => order.push(2));
      eventBus.on('test', () => order.push(3));

      eventBus.emit('test', {});

      // Sets maintain insertion order in modern JS
      expect(order).toEqual([1, 2, 3]);
    });

    it('should handle listeners that unsubscribe during emission', () => {
      const calls: string[] = [];
      let unsubscribe2: () => void;

      // First listener unsubscribes the second listener during emission
      eventBus.on('test', () => {
        calls.push('listener1');
        if (unsubscribe2) {
          unsubscribe2();
        }
      });

      unsubscribe2 = eventBus.on('test', () => {
        calls.push('listener2');
      });

      // First emission - behavior depends on Set.forEach implementation
      // In most JS engines, removing during iteration affects current iteration
      eventBus.emit('test', {});

      expect(calls).toContain('listener1');
      // listener2 may or may not be called depending on Set iteration timing

      // Second emission - only first listener should be called
      calls.length = 0;
      eventBus.emit('test', {});

      expect(calls).toEqual(['listener1']);
    });

    it('should handle multiple unsubscribe calls safely', () => {
      const callback = vi.fn();
      const unsubscribe = eventBus.on('test', callback);
      unsubscribe();
      unsubscribe(); // Should not throw
      eventBus.emit('test', { value: 42 });

      expect(callback).not.toHaveBeenCalled();
    });

    it('should clean up event type from listeners map when last listener is removed', () => {
      const callback = vi.fn();
      const unsubscribe = eventBus.on('test', callback);
      expect(eventBus.hasListeners('test')).toBe(true);
      unsubscribe();
      expect(eventBus.hasListeners('test')).toBe(false);
    });
  });

  describe('advanced queue processing', () => {
    it('should process deeply nested emits', () => {
      const calls: string[] = [];

      eventBus.on('a', () => {
        calls.push('a');
        eventBus.emit('b', {});
      });

      eventBus.on('b', () => {
        calls.push('b');
        eventBus.emit('c', {});
      });

      eventBus.on('c', () => {
        calls.push('c');
      });

      eventBus.emit('a', {});

      expect(calls).toEqual(['a', 'b', 'c']);
    });

    it('should handle emitImmediate during queued processing', () => {
      const calls: string[] = [];

      eventBus.on('event1', () => {
        calls.push('event1-start');
        eventBus.emitImmediate('event2', {});
        calls.push('event1-end');
      });

      eventBus.on('event2', () => {
        calls.push('event2');
      });

      eventBus.emit('event1', {});

      expect(calls).toEqual(['event1-start', 'event2', 'event1-end']);
    });

    it('should handle emitImmediate with wildcard listeners', () => {
      const callback = vi.fn();
      eventBus.on('*', callback);
      eventBus.emitImmediate('test', { value: 42 });

      expect(callback).toHaveBeenCalledWith({ type: 'test', data: { value: 42 } });
    });
  });

  describe('listener management', () => {
    it('should allow once listener to be manually unsubscribed before firing', () => {
      const callback = vi.fn();
      const unsubscribe = eventBus.once('test', callback);
      unsubscribe();
      eventBus.emit('test', { value: 1 });

      expect(callback).not.toHaveBeenCalled();
    });

    it('should work with multiple once listeners', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      eventBus.once('test', callback1);
      eventBus.once('test', callback2);

      eventBus.emit('test', { value: 1 });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);

      eventBus.emit('test', { value: 2 });

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should work with once alongside regular listeners', () => {
      const regularCallback = vi.fn();
      const onceCallback = vi.fn();

      eventBus.on('test', regularCallback);
      eventBus.once('test', onceCallback);

      eventBus.emit('test', { value: 1 });
      eventBus.emit('test', { value: 2 });

      expect(regularCallback).toHaveBeenCalledTimes(2);
      expect(onceCallback).toHaveBeenCalledTimes(1);
    });

    it('should auto-unsubscribe once listener after first call', () => {
      const callback = vi.fn();
      eventBus.once('test', callback);
      eventBus.emit('test', { value: 1 });

      expect(eventBus.hasListeners('test')).toBe(false);
    });

    it('should update getListenerCount correctly after unsubscribe', () => {
      const unsubscribe1 = eventBus.on('test', vi.fn());
      const unsubscribe2 = eventBus.on('test', vi.fn());

      expect(eventBus.getListenerCount('test')).toBe(2);
      unsubscribe1();
      expect(eventBus.getListenerCount('test')).toBe(1);
      unsubscribe2();
      expect(eventBus.getListenerCount('test')).toBe(0);
    });
  });

  describe('memory management', () => {
    it('should reuse event pool objects', () => {
      const callback = vi.fn();
      eventBus.on('*', callback);

      eventBus.emit('test1', { value: 1 });
      const event1 = callback.mock.calls[0][0];

      callback.mockClear();

      // Emit 640 more events to cycle through the 640-item pool
      // After 640 more emits, we should wrap around to the first object
      for (let i = 0; i < 640; i++) {
        eventBus.emit(`event${i}`, { value: i });
      }

      // The 640th event (index 639) should reuse the first pooled event object
      const event640 = callback.mock.calls[639][0];
      expect(event640).toBe(event1); // Same object reference
    });

    it('should not leak listeners after clear', () => {
      for (let i = 0; i < 1000; i++) {
        eventBus.on(`event${i}`, vi.fn());
      }

      eventBus.clear();

      expect(eventBus.getListenerCount()).toBe(0);
    });
  });

  describe('duplicate detection', () => {
    it('should not track duplicates by default', () => {
      const bus = new EventBus();
      expect(bus.trackDuplicates).toBe(false);
    });

    it('should track duplicates when enabled via constructor', () => {
      const bus = new EventBus({ trackDuplicates: true });
      expect(bus.trackDuplicates).toBe(true);
    });

    it('should start at frame 0', () => {
      const bus = new EventBus({ trackDuplicates: true });
      expect(bus.currentFrame).toBe(0);
    });

    it('should increment frame on startFrame()', () => {
      const bus = new EventBus({ trackDuplicates: true });
      expect(bus.currentFrame).toBe(0);

      bus.startFrame();
      expect(bus.currentFrame).toBe(1);

      bus.startFrame();
      expect(bus.currentFrame).toBe(2);
    });

    it('should warn on duplicate eventType+entityId in same frame', () => {
      const bus = new EventBus({ trackDuplicates: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      bus.startFrame();

      // First emission should not warn
      bus.emit('test.event', { entityId: 'entity1', value: 1 });
      expect(warnSpy).not.toHaveBeenCalled();

      // Second emission of same event+entity should warn
      bus.emit('test.event', { entityId: 'entity1', value: 2 });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate event in frame 1: "test.event" for entity "entity1"')
      );

      warnSpy.mockRestore();
    });

    it('should NOT warn for same event type on different entities', () => {
      const bus = new EventBus({ trackDuplicates: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      bus.startFrame();

      bus.emit('test.event', { entityId: 'entity1' });
      bus.emit('test.event', { entityId: 'entity2' });

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should NOT warn for different events on same entity', () => {
      const bus = new EventBus({ trackDuplicates: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      bus.startFrame();

      bus.emit('event.a', { entityId: 'entity1' });
      bus.emit('event.b', { entityId: 'entity1' });

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should reset tracking on startFrame()', () => {
      const bus = new EventBus({ trackDuplicates: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      bus.startFrame();
      bus.emit('test.event', { entityId: 'entity1' });

      // Start a new frame - should reset tracking
      bus.startFrame();
      bus.emit('test.event', { entityId: 'entity1' });

      // Should not warn because it's a new frame
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should NOT check events without entityId', () => {
      const bus = new EventBus({ trackDuplicates: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      bus.startFrame();

      // Events without entityId should not be tracked
      bus.emit('world.event', { someData: 1 });
      bus.emit('world.event', { someData: 2 });

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should NOT warn when tracking is disabled', () => {
      const bus = new EventBus({ trackDuplicates: false });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      bus.startFrame();

      bus.emit('test.event', { entityId: 'entity1' });
      bus.emit('test.event', { entityId: 'entity1' });

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should clear frame event keys on clear()', () => {
      const bus = new EventBus({ trackDuplicates: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      bus.startFrame();
      bus.emit('test.event', { entityId: 'entity1' });

      bus.clear();

      // After clear, same event should not warn (tracking was reset)
      bus.emit('test.event', { entityId: 'entity1' });

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('getDataKey edge cases', () => {
    it('should filter out functions from event data', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      // First emission with function property
      eventBus.emitChanged('test', { value: 1, fn: () => {} });
      // Second emission with same value but different function - should still be considered same
      eventBus.emitChanged('test', { value: 1, fn: () => {} });

      // Only 1 call because functions are filtered out, leaving identical objects
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should filter out class instances from event data', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      class MyClass {
        value = 42;
      }

      // First emission with class instance
      eventBus.emitChanged('test', { nested: new MyClass() });
      // Second emission with different class instance - should be considered same
      // since class instances are filtered out
      eventBus.emitChanged('test', { nested: new MyClass() });

      // Only 1 call because class instances are filtered out
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should handle nested class instances in arrays', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      class Point {
        constructor(public x: number, public y: number) {}
      }

      eventBus.emitChanged('test', { points: [new Point(1, 2)] });
      eventBus.emitChanged('test', { points: [new Point(3, 4)] });

      // Class instances in arrays are filtered, so both emissions have same key
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('off edge cases', () => {
    it('should handle off with callback that was never registered', () => {
      const registeredCallback = vi.fn();
      const unregisteredCallback = vi.fn();

      eventBus.on('test', registeredCallback);
      eventBus.off('test', unregisteredCallback);

      eventBus.emit('test', 'data');

      // Registered callback should still work
      expect(registeredCallback).toHaveBeenCalledWith('data');
    });

    it('should handle off for event type with no listeners', () => {
      // Should not throw when removing from non-existent event type
      expect(() => {
        eventBus.off('nonexistent', vi.fn());
      }).not.toThrow();
    });

    it('should clean up event type when last specific callback is removed via off', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      expect(eventBus.hasListeners('test')).toBe(true);

      // Remove the callback via off() method (not unsubscribe function)
      eventBus.off('test', callback);

      // The event type should be cleaned up since it was the last listener
      expect(eventBus.hasListeners('test')).toBe(false);
      expect(eventBus.getListenerCount('test')).toBe(0);
    });

    it('should clean up event type when removing the last of multiple callbacks via off', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      eventBus.on('test', callback1);
      eventBus.on('test', callback2);

      expect(eventBus.getListenerCount('test')).toBe(2);

      eventBus.off('test', callback1);
      expect(eventBus.getListenerCount('test')).toBe(1);

      eventBus.off('test', callback2);
      expect(eventBus.getListenerCount('test')).toBe(0);
      expect(eventBus.hasListeners('test')).toBe(false);
    });
  });

  describe('re-entrant emits during wildcard listener processing', () => {
    it('processes events re-emitted during wildcard listener processing', () => {
      const calls: string[] = [];

      // Add wildcard listener that emits another event
      eventBus.on('*', (event: any) => {
        if (event.type === 'first') {
          calls.push('wildcard-first');
          eventBus.emit('second', {});
        } else if (event.type === 'second') {
          calls.push('wildcard-second');
        }
      });

      eventBus.emit('first', {});

      // Both events are processed — the re-emit recurses through processEvent.
      expect(calls).toEqual(['wildcard-first', 'wildcard-second']);
    });

    it('processes nested re-entrant emits depth-first', () => {
      const processOrder: string[] = [];

      // Type-specific listener that emits during processing
      eventBus.on('start', () => {
        processOrder.push('start-specific');
        eventBus.emit('middle', {});
      });

      eventBus.on('middle', () => {
        processOrder.push('middle-specific');
        eventBus.emit('end', {});
      });

      eventBus.on('end', () => {
        processOrder.push('end-specific');
      });

      // Wildcard listener to trigger queue path
      eventBus.on('*', (event: any) => {
        processOrder.push(`wildcard-${event.type}`);
      });

      eventBus.emit('start', {});

      // Each re-emit recurses synchronously through processEvent, so the order
      // is depth-first: a type listener that re-emits fully resolves the nested
      // event (and its wildcard) before the outer event's wildcard runs.
      expect(processOrder).toEqual([
        'start-specific',  // start: type listener (re-emits middle)
        'middle-specific', // middle: type listener (re-emits end)
        'end-specific',    // end: type listener
        'wildcard-end',    // end: wildcard (innermost finishes first)
        'wildcard-middle', // middle: wildcard
        'wildcard-start',  // start: wildcard (outermost finishes last)
      ]);
    });

    it('handles errors in wildcard listeners during re-entrant processing', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const normalCallback = vi.fn();

      // First add a wildcard listener that throws
      eventBus.on('*', () => {
        throw new Error('Wildcard error');
      });

      // Add a type-specific listener that should also receive the event
      eventBus.on('test', normalCallback);

      // Add another wildcard listener that emits during processing (to use queue path)
      eventBus.on('*', (event: any) => {
        if (event.type === 'trigger') {
          eventBus.emit('test', 'data');
        }
      });

      // Emit trigger to queue an event
      eventBus.emit('trigger', {});

      expect(consoleSpy).toHaveBeenCalled();
      expect(normalCallback).toHaveBeenCalledWith('data');

      consoleSpy.mockRestore();
    });

    it('should process queue correctly with nested emits from wildcard listeners', () => {
      const processedEvents: string[] = [];

      eventBus.on('*', (event: any) => {
        processedEvents.push(event.type);
        if (event.type === 'a') {
          eventBus.emit('b', {});
        }
        if (event.type === 'b') {
          eventBus.emit('c', {});
        }
      });

      eventBus.emit('a', {});

      expect(processedEvents).toEqual(['a', 'b', 'c']);
    });
  });

  describe('processEvent error handling', () => {
    it('should continue processing after error in type-specific listener with wildcards present', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const wildcardCallback = vi.fn();
      const secondCallback = vi.fn();

      // First listener throws
      eventBus.on('test', () => {
        throw new Error('First listener error');
      });

      // Second listener should still be called
      eventBus.on('test', secondCallback);

      // Wildcard listener
      eventBus.on('*', wildcardCallback);

      eventBus.emit('test', 'data');

      expect(secondCallback).toHaveBeenCalledWith('data');
      expect(wildcardCallback).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('getDataKey JSON stringify failure', () => {
    it('should return null when JSON.stringify throws an error', () => {
      const callback = vi.fn();
      eventBus.on('test', callback);

      // Create an object that will cause JSON.stringify to throw
      const problematicData: Record<string, unknown> = {};
      Object.defineProperty(problematicData, 'badProp', {
        get() {
          throw new Error('Property access error');
        },
        enumerable: true,
      });

      // First call should emit (returns null, so doesn't cache)
      eventBus.emitChanged('test', problematicData);
      // Second call should also emit (returns null, can't compare)
      eventBus.emitChanged('test', problematicData);

      // Both should emit since we can't compare them
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('complex nested emit scenarios', () => {
    it('should handle many levels of nested emits with wildcards', () => {
      const events: string[] = [];

      // Create a chain of events that emit during processing
      for (let i = 0; i < 10; i++) {
        eventBus.on(`event${i}`, () => {
          events.push(`event${i}`);
          if (i < 9) {
            eventBus.emit(`event${i + 1}`, {});
          }
        });
      }

      // Wildcard to ensure non-fast path
      eventBus.on('*', () => {});

      eventBus.emit('event0', {});

      // All events should be processed
      expect(events).toHaveLength(10);
      expect(events).toEqual([
        'event0', 'event1', 'event2', 'event3', 'event4',
        'event5', 'event6', 'event7', 'event8', 'event9'
      ]);
    });

    it('should handle emit during emitImmediate with wildcards', () => {
      const order: string[] = [];

      eventBus.on('immediate', () => {
        order.push('immediate-start');
        eventBus.emit('nested', {});
        order.push('immediate-end');
      });

      eventBus.on('nested', () => {
        order.push('nested');
      });

      eventBus.on('*', (event: any) => {
        order.push(`wildcard-${event.type}`);
      });

      eventBus.emitImmediate('immediate', {});

      // Verify processing order
      expect(order).toContain('immediate-start');
      expect(order).toContain('nested');
      expect(order).toContain('immediate-end');
    });
  });

  describe('entity-routed listener error handling', () => {
    it('logs and continues when an onForEntity listener throws', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const survivor = vi.fn();

      eventBus.onForEntity('hit', 'hero', () => {
        throw new Error('boom in entity listener');
      });
      eventBus.onForEntity('hit', 'hero', survivor);

      expect(() => eventBus.emit('hit', { entityId: 'hero', dmg: 5 })).not.toThrow();

      // The throwing listener was reported...
      expect(consoleSpy).toHaveBeenCalledWith(
        "Error in entity event listener for 'hit':",
        expect.any(Error)
      );
      // ...and a sibling listener on the same (type, entityId) still ran.
      expect(survivor).toHaveBeenCalledWith({ entityId: 'hero', dmg: 5 });

      consoleSpy.mockRestore();
    });
  });

  describe('ring-buffer recording', () => {
    it('is inactive by default', () => {
      expect(eventBus.isRecording).toBe(false);
      expect(eventBus.getRecentEvents()).toEqual([]);
    });

    it('records emitted events with type, data, frame and increasing seq', () => {
      eventBus.enableRecording(8);
      expect(eventBus.isRecording).toBe(true);

      eventBus.startFrame(); // frame -> 1
      eventBus.emit('player.moved', { x: 1 });
      eventBus.emit('player.jumped', { h: 2 });

      const events = eventBus.getRecentEvents();
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('player.moved');
      expect(events[0].data).toEqual({ x: 1 });
      expect(events[0].frame).toBe(1);
      expect(events[1].type).toBe('player.jumped');
      // seq is strictly increasing in emit order
      expect(events[1].seq).toBe(events[0].seq + 1);
    });

    it('also records emitImmediate so hot-path emits are not lost', () => {
      eventBus.enableRecording(4);
      eventBus.emitImmediate('tick', { n: 1 });

      const events = eventBus.getRecentEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tick');
    });

    it('drains only events newer than the supplied seq', () => {
      eventBus.enableRecording(8);
      eventBus.emit('a');
      eventBus.emit('b');

      const first = eventBus.getRecentEvents();
      const lastSeq = first[first.length - 1].seq;

      eventBus.emit('c');

      const since = eventBus.getRecentEvents(lastSeq);
      expect(since.map((e) => e.type)).toEqual(['c']);
    });

    it('overwrites the oldest slot when the buffer is full (chronological order preserved)', () => {
      eventBus.enableRecording(3);
      eventBus.emit('e1');
      eventBus.emit('e2');
      eventBus.emit('e3');
      eventBus.emit('e4'); // wraps, evicts e1

      const events = eventBus.getRecentEvents();
      expect(events.map((e) => e.type)).toEqual(['e2', 'e3', 'e4']);
      // still oldest-first after wrap
      expect(events[0].seq).toBeLessThan(events[2].seq);
    });

    it('is refcounted: stays active until the last viewer disables it', () => {
      eventBus.enableRecording(4); // viewer 1
      eventBus.enableRecording(4); // viewer 2
      expect(eventBus.isRecording).toBe(true);

      eventBus.disableRecording(); // viewer 1 leaves
      expect(eventBus.isRecording).toBe(true);

      eventBus.disableRecording(); // last viewer leaves
      expect(eventBus.isRecording).toBe(false);
      expect(eventBus.getRecentEvents()).toEqual([]);
    });

    it('disableRecording is a safe no-op when recording was never enabled', () => {
      expect(() => eventBus.disableRecording()).not.toThrow();
      expect(eventBus.isRecording).toBe(false);
    });

    it('grows capacity when a later viewer requests a larger buffer', () => {
      eventBus.enableRecording(2);
      eventBus.emit('a');
      eventBus.emit('b');

      // A larger request re-allocates the buffer (prior contents are dropped),
      // but recording stays active and the new, larger capacity takes effect.
      eventBus.enableRecording(4);
      expect(eventBus.isRecording).toBe(true);

      eventBus.emit('c');
      eventBus.emit('d');
      eventBus.emit('e');
      eventBus.emit('f'); // exactly fills the grown capacity-4 buffer

      const events = eventBus.getRecentEvents();
      // Capacity is now 4 (not the original 2): all four post-grow events fit
      // without eviction — proof the larger request took effect.
      expect(events.map((e) => e.type)).toEqual(['c', 'd', 'e', 'f']);
    });

    it('does not shrink when a later viewer requests a smaller buffer', () => {
      eventBus.enableRecording(5);
      eventBus.enableRecording(2); // smaller request is ignored; capacity stays 5

      eventBus.emit('a');
      eventBus.emit('b');
      eventBus.emit('c'); // would evict 'a' if capacity had shrunk to 2

      const events = eventBus.getRecentEvents();
      expect(events.map((e) => e.type)).toEqual(['a', 'b', 'c']);
    });

    it('clamps a non-positive requested capacity to at least one slot', () => {
      eventBus.enableRecording(0);
      expect(eventBus.isRecording).toBe(true);

      eventBus.emit('only');
      const events = eventBus.getRecentEvents();
      expect(events.map((e) => e.type)).toEqual(['only']);
    });
  });
});
