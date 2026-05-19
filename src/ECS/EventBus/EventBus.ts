/**
 * Type for event listener callback functions.
 * T is the type of data passed with the event.
 */
export type EventCallback<T = any> = (data: T) => void;

/**
 * Function returned when subscribing to events.
 * Call it to unsubscribe from the event.
 */
export type UnsubscribeFn = () => void;

/**
 * Structure of an event in the system.
 * Used internally and by wildcard listeners.
 */
export interface IEvent {
  type: string;
  data?: any;
}

/**
 * Options for configuring an EventBus instance.
 */
export interface EventBusOptions {
  /**
   * Enable duplicate event detection per frame.
   * When enabled, warns if the same event type is emitted for the same entity
   * multiple times in a single frame. Useful for catching race conditions
   * between systems.
   * @default false
   */
  trackDuplicates?: boolean;
}

/**
 * Minimal shape the EventBus needs from a RaceDetector to attribute emits to
 * the running System. Avoids a direct dependency so the bus stays a plain
 * messaging primitive.
 */
export interface IRaceDetectorEventSink {
  recordEvent(type: string, data: unknown): void;
}

/**
 * EVENT POOLING - Performance Optimization
 *
 * Creating new objects for every event would create garbage collection pressure.
 * Instead, we pre-allocate a pool of event objects and reuse them.
 *
 * The pool is circular - when we reach the end, we wrap around to the start.
 * 640 events is enough to handle bursts without overwriting events still in use.
 */
const EVENT_POOL_SIZE = 640;
const eventPool: IEvent[] = [];
let eventPoolIndex = 0;

// Pre-allocate all event objects at startup
for (let i = 0; i < EVENT_POOL_SIZE; i++) {
  eventPool.push({ type: "", data: undefined });
}

/**
 * Get an event object from the pool and set its properties.
 * Uses circular indexing to reuse objects efficiently.
 *
 * @param type - The event type/name
 * @param data - The event data payload
 * @returns A pooled event object (reused, not new)
 */
function getPooledEvent(type: string, data: any): IEvent {
  const event = eventPool[eventPoolIndex];
  eventPoolIndex = (eventPoolIndex + 1) % EVENT_POOL_SIZE;
  event.type = type;
  event.data = data;
  return event;
}

/**
 * EventBus - High-performance publish/subscribe event system.
 *
 * The EventBus is the communication backbone of the ECS framework.
 * It allows decoupled parts of your game to communicate without
 * direct references to each other.
 *
 * Key Features:
 * - Memory-efficient event pooling (no GC pressure)
 * - Queue-based processing (safe for events emitted during handling)
 * - Wildcard listeners (listen to ALL events)
 * - Deduplication (skip repeated identical events)
 * - Fast path optimization (skips overhead when not needed)
 *
 * Common Usage:
 * ```typescript
 * const bus = new EventBus();
 *
 * // Subscribe to events
 * const unsub = bus.on("player.damaged", (data) => {
 *   console.log(`Player took ${data.amount} damage!`);
 * });
 *
 * // Emit events
 * bus.emit("player.damaged", { amount: 10 });
 *
 * // Unsubscribe when done
 * unsub();
 * ```
 */
export class EventBus {
  /**
   * Map of event type -> Set of callback functions.
   * Using Set ensures each callback is only registered once per event.
   */
  private listeners: Map<string, Set<EventCallback>> = new Map();

  /**
   * Queue for events emitted while processing other events.
   * Prevents recursive event handling from causing stack overflow.
   */
  private eventQueue: IEvent[] = [];

  /**
   * Current position in the event queue.
   * Using an index instead of shift() avoids array reallocation.
   */
  private queueIndex = 0;

  /**
   * Flag to track if we're currently processing events.
   * Used to determine if new events should be queued.
   */
  private isProcessing = false;

  /**
   * Special listeners that receive ALL events (subscribed with '*').
   * Useful for debugging, logging, or event replay systems.
   */
  private wildcardListeners: Set<EventCallback> = new Set();

  /**
   * Indexed listeners keyed by (event type → entityId → callbacks).
   *
   * Powers `onForEntity`. When a subscriber says "I only care about events
   * for entity X," we file the callback in this map instead of the global
   * `listeners` set. Dispatch then does an O(1) lookup using the emit's
   * `data.entityId` and calls only the targeted callbacks.
   *
   * Why this matters: in a city with thousands of NPCs all emitting
   * `position.changed`, an unfiltered `on('position.changed')` fires the
   * callback for every single NPC. With this index, a hero-only listener
   * costs nothing when an NPC moves — the inner Map.get returns undefined
   * and dispatch moves on.
   */
  private entityListeners: Map<string, Map<string, Set<EventCallback>>> = new Map();

  /**
   * Cache of last event data by type for deduplication.
   * Used by emitChanged() to skip identical consecutive events.
   */
  private lastEventData: Map<string, string> = new Map();

  /**
   * Whether to track and warn about duplicate events per frame.
   */
  private _trackDuplicates: boolean = false;

  /**
   * Set of event keys (eventType:entityId) seen this frame.
   * Used for duplicate detection when trackDuplicates is enabled.
   */
  private _frameEventKeys: Set<string> = new Set();

  /**
   * Current frame number, incremented by startFrame().
   */
  private _currentFrame: number = 0;

  /**
   * Optional race detector sink. Set by World in dev builds.
   */
  private _raceDetector: IRaceDetectorEventSink | null = null;

  /**
   * Create a new EventBus instance.
   * @param options - Configuration options
   */
  constructor(options: EventBusOptions = {}) {
    this._trackDuplicates = options.trackDuplicates ?? false;
  }

  /**
   * Start a new frame. Call this at the beginning of each update loop.
   * Clears duplicate tracking and increments the frame counter.
   * Typically called by World.update().
   */
  startFrame(): void {
    this._currentFrame++;
    this._frameEventKeys.clear();
  }

  /**
   * Get the current frame number.
   * Useful for debugging and tracking event timing.
   */
  get currentFrame(): number {
    return this._currentFrame;
  }

  /**
   * Check if duplicate tracking is enabled.
   */
  get trackDuplicates(): boolean {
    return this._trackDuplicates;
  }

  /**
   * Wire a race detector sink. Pass null to disable. Must be called before
   * the first emit to attribute events deterministically.
   */
  setRaceDetector(detector: IRaceDetectorEventSink | null): void {
    this._raceDetector = detector;
  }

  /**
   * Emit an event to all listeners of that type.
   *
   * Events emitted during listener execution are queued and
   * processed after the current event completes (prevents recursion).
   *
   * @param type - The event type/name (e.g., "player.moved")
   * @param data - Optional data to pass to listeners
   */
  emit<T = any>(type: string, data?: T): void {
    // Check for duplicate events if tracking is enabled
    this.checkDuplicate(type, data);

    // Attribute this emit to the currently-running System (dev builds only).
    if (this._raceDetector !== null) {
      this._raceDetector.recordEvent(type, data);
    }

    // Fast path: no wildcard listeners and not processing - skip event wrapper entirely
    // This avoids object allocation overhead when wildcards aren't used
    if (this.wildcardListeners.size === 0 && !this.isProcessing) {
      this.processEventDirect(type, data);
      return;
    }

    // Need event wrapper for wildcard listeners or queuing
    const event = getPooledEvent(type, data);

    // If we're already processing events, queue this one for later
    if (this.isProcessing) {
      this.eventQueue.push(event);
      return;
    }

    // Process this event and any queued events it generates
    this.processEvent(event);
    this.processQueue();
  }

  /**
   * Check if this event+entity combination has already been emitted this frame.
   * Warns if duplicate tracking is enabled and a duplicate is detected.
   *
   * @param type - The event type
   * @param data - The event data (checked for entityId property)
   */
  private checkDuplicate(type: string, data: any): void {
    if (!this._trackDuplicates) return;

    // Only check events that have an entityId
    const entityId = data?.entityId;
    if (entityId === undefined) return;

    const key = `${type}:${entityId}`;

    if (this._frameEventKeys.has(key)) {
      console.warn(
        `[EventBus] Duplicate event in frame ${this._currentFrame}: "${type}" for entity "${entityId}"\n` +
        `  This may indicate a race condition between systems.`
      );
    }

    this._frameEventKeys.add(key);
  }

  /**
   * Emit an event, but skip if identical to the last emission of this type.
   *
   * Use this for state-change events where duplicate values are meaningless.
   * For example, emitting position updates only when position actually changes.
   *
   * @param type - The event type
   * @param data - Event data (compared with previous emission)
   */
  emitChanged<T = any>(type: string, data?: T): void {
    const dataKey = this.getDataKey(data);
    // If we can compute a key and it matches the last emission, skip
    if (dataKey !== null && this.lastEventData.get(type) === dataKey) {
      return; // Skip duplicate
    }
    // Store this emission's key for future comparison
    if (dataKey !== null) {
      this.lastEventData.set(type, dataKey);
    }
    this.emit(type, data);
  }

  /**
   * Convert event data to a string key for deduplication comparison.
   * Handles circular references and filters out non-serializable values.
   *
   * @param data - The event data to convert
   * @returns A string key, or null if data can't be stringified
   */
  private getDataKey(data: any): string | null {
    if (data === undefined || data === null) {
      return "null";
    }
    try {
      // Track seen objects to handle circular references
      const seen = new WeakSet();
      return JSON.stringify(data, (key, value) => {
        // Detect circular references
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) {
            return undefined; // Skip circular reference
          }
          seen.add(value);
        }
        // Skip functions - they can't be compared
        if (typeof value === "function") return undefined;
        // Skip class instances (keep only plain objects and arrays)
        if (value?.constructor?.name && !["Object", "Array"].includes(value.constructor.name)) {
          return undefined;
        }
        return value;
      });
    } catch {
      return null; // Return null if stringification fails
    }
  }

  /**
   * Emit an event immediately, bypassing the queue.
   *
   * Use with caution - this processes the event synchronously even
   * if we're already processing events. Useful for time-critical events.
   *
   * @param type - The event type
   * @param data - Optional event data
   */
  emitImmediate<T = any>(type: string, data?: T): void {
    // Fast path when no wildcard listeners
    if (this.wildcardListeners.size === 0) {
      this.processEventDirect(type, data);
      return;
    }
    const event = getPooledEvent(type, data);
    this.processEvent(event);
  }

  /**
   * Subscribe to events of a specific type.
   *
   * @param type - Event type to listen for, or '*' for all events
   * @param callback - Function to call when event is emitted
   * @returns Unsubscribe function - call it to stop listening
   *
   * Example:
   * ```typescript
   * const unsub = bus.on("player.died", (data) => {
   *   showGameOver();
   * });
   *
   * // Later, when you want to stop listening:
   * unsub();
   * ```
   */
  on<T = any>(type: string, callback: EventCallback<T>): UnsubscribeFn {
    // Handle wildcard subscription
    if (type === '*') {
      this.wildcardListeners.add(callback);
      return () => this.wildcardListeners.delete(callback);
    }

    // Create listener set for this event type if it doesn't exist
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }

    const callbacks = this.listeners.get(type)!;
    callbacks.add(callback);

    // Return unsubscribe function
    return () => {
      callbacks.delete(callback);
      // Clean up empty listener sets to prevent memory leaks
      if (callbacks.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  /**
   * Subscribe to events of a specific type, restricted to a single entity.
   *
   * Dispatch is indexed by `(type, entityId)`, so emits whose `data.entityId`
   * doesn't match this `entityId` do **zero** work for this subscriber —
   * no callback invocation, no comparison. Use this for hero-perspective UI
   * code in a world full of similarly-shaped NPC events.
   *
   * Required emit shape: `bus.emit(type, { entityId: '...', ... })`. Emits
   * without `entityId` in their data won't reach entity-routed listeners
   * (use `on()` for those).
   *
   * @param type - Event type to listen for
   * @param entityId - Only events whose `data.entityId` matches dispatch here
   * @param callback - Function to call when a matching event is emitted
   * @returns Unsubscribe function — call it to stop listening
   *
   * Example:
   * ```typescript
   * // 3000 NPCs walking → bus.emit('position.changed', { entityId: 'npc-42', ... })
   * // The hero-only listener costs nothing per NPC emit:
   * bus.onForEntity('position.changed', 'hero', () => updateHeroHud());
   * ```
   */
  onForEntity<T extends { entityId: string } = { entityId: string }>(
    type: string,
    entityId: string,
    callback: EventCallback<T>,
  ): UnsubscribeFn {
    if (!entityId) return () => { /* no-op */ };

    let byEntity = this.entityListeners.get(type);
    if (!byEntity) {
      byEntity = new Map();
      this.entityListeners.set(type, byEntity);
    }
    let callbacks = byEntity.get(entityId);
    if (!callbacks) {
      callbacks = new Set();
      byEntity.set(entityId, callbacks);
    }
    callbacks.add(callback as EventCallback);

    return () => {
      const callbacksRef = byEntity!.get(entityId);
      if (!callbacksRef) return;
      callbacksRef.delete(callback as EventCallback);
      // Prune empty inner sets/maps so the index doesn't grow forever as
      // entities get destroyed and recreated under fresh ids.
      if (callbacksRef.size === 0) {
        byEntity!.delete(entityId);
        if (byEntity!.size === 0) this.entityListeners.delete(type);
      }
    };
  }

  /**
   * Subscribe to an event type, but only fire once.
   * Automatically unsubscribes after the first event.
   *
   * @param type - Event type to listen for
   * @param callback - Function to call once
   * @returns Unsubscribe function (can cancel before event fires)
   */
  once<T = any>(type: string, callback: EventCallback<T>): UnsubscribeFn {
    const unsubscribe = this.on(type, (data: T) => {
      unsubscribe(); // Remove listener before calling callback
      callback(data);
    });
    return unsubscribe;
  }

  /**
   * Manually unsubscribe from events.
   *
   * Alternative to using the function returned by on().
   * If callback is omitted, removes ALL listeners for that type.
   *
   * @param type - Event type, or '*' for wildcard listeners
   * @param callback - Specific callback to remove (optional)
   */
  off(type: string, callback?: EventCallback): void {
    if (type === '*') {
      if (callback) {
        this.wildcardListeners.delete(callback);
      } else {
        this.wildcardListeners.clear();
      }
      return;
    }

    // If no callback specified, remove all listeners for this type
    if (!callback) {
      this.listeners.delete(type);
      return;
    }

    // Remove specific callback
    const callbacks = this.listeners.get(type);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.listeners.delete(type);
      }
    }
  }

  /**
   * Remove all listeners and reset the EventBus state.
   * Useful when shutting down or resetting the game.
   */
  clear(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
    this.entityListeners.clear();
    this.eventQueue.length = 0;
    this.queueIndex = 0;
    this.isProcessing = false;
    this.lastEventData.clear();
    this._frameEventKeys.clear();
  }

  /**
   * Check if any listeners are registered for an event type.
   *
   * @param type - The event type to check
   * @returns True if there are listeners (including wildcards)
   */
  hasListeners(type: string): boolean {
    return this.listeners.has(type) || this.wildcardListeners.size > 0;
  }

  /**
   * Get the number of listeners registered.
   *
   * @param type - Optional event type. If omitted, counts all listeners.
   * @returns Number of listeners
   */
  getListenerCount(type?: string): number {
    if (!type) {
      // Count all listeners across all types
      let total = this.wildcardListeners.size;
      this.listeners.forEach(callbacks => {
        total += callbacks.size;
      });
      return total;
    }

    // Count listeners for specific type (plus wildcards)
    const callbacks = this.listeners.get(type);
    return (callbacks?.size || 0) + this.wildcardListeners.size;
  }

  /**
   * Fast path: process event without creating wrapper object.
   * Used when there are no wildcard listeners to avoid allocation.
   *
   * @param type - Event type
   * @param data - Event data
   */
  private processEventDirect(type: string, data: any): void {
    const callbacks = this.listeners.get(type);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event listener for '${type}':`, error);
        }
      });
    }
    this.dispatchEntityRouted(type, data);
  }

  /**
   * Process an event, notifying type-specific and wildcard listeners.
   *
   * @param event - The event object to process
   */
  private processEvent(event: IEvent): void {
    // Notify type-specific listeners
    const callbacks = this.listeners.get(event.type);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(event.data);
        } catch (error) {
          console.error(`Error in event listener for '${event.type}':`, error);
        }
      });
    }

    this.dispatchEntityRouted(event.type, event.data);

    // Notify wildcard listeners (they receive the full event object)
    this.wildcardListeners.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        console.error(`Error in wildcard event listener for '${event.type}':`, error);
      }
    });
  }

  /**
   * Notify entity-routed listeners registered via `onForEntity`. Two map
   * lookups; nothing fires unless someone subscribed to this exact
   * `(type, entityId)` pair.
   */
  private dispatchEntityRouted(type: string, data: any): void {
    const byEntity = this.entityListeners.get(type);
    if (!byEntity) return;
    const entityId = data?.entityId;
    if (entityId === undefined || entityId === null) return;
    const targeted = byEntity.get(entityId);
    if (!targeted) return;
    targeted.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in entity event listener for '${type}':`, error);
      }
    });
  }

  /**
   * Process all queued events.
   *
   * Called after processing an event to handle any events
   * that were emitted during that processing.
   */
  private processQueue(): void {
    if (this.isProcessing || this.eventQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    // Process queue without shift() to avoid array reallocation
    // This is more efficient than shifting elements
    while (this.queueIndex < this.eventQueue.length) {
      const event = this.eventQueue[this.queueIndex++];
      this.processEvent(event);
    }

    // Reset queue for reuse
    this.eventQueue.length = 0;
    this.queueIndex = 0;
    this.isProcessing = false;
  }
}
