import type { ComponentType } from '../types';
import { Entity } from '../Entity/Entity';
import { EventBus } from '../EventBus/EventBus';
import type { World } from '../World/World';

/**
 * Query interface for filtering which entities a system processes.
 *
 * A system only receives entities that match its query. This allows
 * you to write focused systems that only deal with relevant entities.
 *
 * Example:
 * ```typescript
 * // A movement system that needs Position AND Velocity
 * this.query = {
 *   required: [Position, Velocity],
 *   excluded: [Static],  // Skip static objects
 * };
 * ```
 */
export interface ISystemQuery {
  /** Entity must have ALL of these components */
  required?: ComponentType[];

  /** Entity must have NONE of these components */
  excluded?: ComponentType[];

  /** Entity must have AT LEAST ONE of these components */
  anyOf?: ComponentType[];

  /** Entity must have ALL of these tags */
  tags?: string[];

  /** Entity must have NONE of these tags */
  excludedTags?: string[];
}

/**
 * System - Abstract base class for all game systems.
 *
 * In ECS, Systems contain the game logic. While Components are data
 * and Entities are containers, Systems are where behavior lives.
 *
 * Each system:
 * - Defines a query to filter which entities it cares about
 * - Receives matching entities automatically from the World
 * - Processes those entities every frame in its update() method
 *
 * Example:
 * ```typescript
 * class MovementSystem extends System {
 *   constructor(eventBus: EventBus) {
 *     super(eventBus);
 *     this.query = { required: [Position, Velocity] };
 *   }
 *
 *   protected onUpdate(deltaTime: number): void {
 *     for (const entity of this.entities) {
 *       const pos = entity.get(Position)!;
 *       const vel = entity.get(Velocity)!;
 *       pos.x += vel.x * deltaTime;
 *       pos.y += vel.y * deltaTime;
 *     }
 *   }
 * }
 * ```
 */
export abstract class System {
  /**
   * Reference to the world's event bus for communication.
   * Use this to emit events or subscribe to other systems' events.
   */
  protected eventBus: EventBus;

  /**
   * Set of entities that match this system's query.
   * Automatically managed by the World.
   */
  protected entities: Set<Entity> = new Set();

  /**
   * Whether this system is enabled. Disabled systems don't update.
   */
  protected _enabled: boolean = true;

  /**
   * Execution priority. Higher priority systems run first.
   * Default is 0. Use negative values to run later.
   */
  protected _priority: number = 0;

  /**
   * If true, this system pauses when the world is paused.
   * Set to false for systems that should run during pause (e.g., UI).
   */
  protected _pauseable: boolean = true;

  /**
   * Query that defines which entities this system processes.
   * Set this in your system's constructor.
   */
  protected query: ISystemQuery = {};

  /**
   * Reference to the World this system belongs to.
   */
  protected world?: World;

  /**
   * Tracks whether initialize() has been called.
   */
  private _initialized: boolean = false;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Whether this system is enabled.
   */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Enable or disable this system.
   * Emits "system.{SystemName}.enabled" or "disabled" events.
   */
  set enabled(value: boolean) {
    if (this._enabled !== value) {
      this._enabled = value;
      this.eventBus?.emit(`system.${this.constructor.name}.${value ? 'enabled' : 'disabled'}`, {
        system: this,
      });
    }
  }

  /**
   * Get the system's execution priority.
   * Higher values run first.
   */
  get priority(): number {
    return this._priority;
  }

  /**
   * Set the system's execution priority.
   */
  set priority(value: number) {
    this._priority = value;
  }

  /**
   * Whether this system pauses when the world is paused.
   */
  get pauseable(): boolean {
    return this._pauseable;
  }

  /**
   * Set whether this system should pause with the world.
   */
  set pauseable(value: boolean) {
    this._pauseable = value;
  }

  /**
   * Whether this system has been initialized.
   */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Called by the World to provide a reference back to itself.
   * @param world - The World that owns this system
   */
  setWorld(world: World): void {
    this.world = world;
  }

  /**
   * Initialize the system. Called once when the system is added to a World.
   * Override onInitialize() for custom initialization logic.
   */
  initialize(): void {
    if (this._initialized) {
      return;
    }

    this._initialized = true;
    this.onInitialize();
  }

  /**
   * Override this method for custom initialization.
   * Called once after the system is added to the World.
   * Good place to subscribe to events or set up resources.
   */
  protected onInitialize(): void {}

  /**
   * Shutdown the system. Called when the system is removed from a World.
   * Override onShutdown() for custom cleanup logic.
   */
  shutdown(): void {
    if (!this._initialized) {
      return;
    }

    this.onShutdown();
    this.entities.clear();
    this._initialized = false;
  }

  /**
   * Override this method for custom cleanup.
   * Called when the system is removed from the World.
   * Good place to unsubscribe from events and release resources.
   */
  protected onShutdown(): void {}

  /**
   * Add an entity to this system if it matches the query.
   * Called automatically by the World when entities are created/modified.
   *
   * @param entity - Entity to potentially add
   */
  addEntity(entity: Entity): void {
    if (this.matchesQuery(entity)) {
      if (!this.entities.has(entity)) {
        this.entities.add(entity);
        this.onEntityAdded(entity);
      }
    }
  }

  /**
   * Remove an entity from this system.
   * Called automatically by the World when entities are destroyed.
   *
   * @param entity - Entity to remove
   */
  removeEntity(entity: Entity): void {
    if (this.entities.delete(entity)) {
      this.onEntityRemoved(entity);
    }
  }

  /**
   * Re-evaluate whether an entity should be in this system.
   * Called when an entity's components or tags change.
   *
   * @param entity - Entity to re-evaluate
   */
  refreshEntity(entity: Entity): void {
    const matches = this.matchesQuery(entity);
    const hasEntity = this.entities.has(entity);

    if (matches && !hasEntity) {
      this.addEntity(entity);
    } else if (!matches && hasEntity) {
      this.removeEntity(entity);
    }
  }

  /**
   * Override to react when an entity is added to this system.
   * Called after the entity is added to the entities set.
   *
   * @param _entity - The entity that was added
   */
  protected onEntityAdded(_entity: Entity): void {}

  /**
   * Override to react when an entity is removed from this system.
   * Called after the entity is removed from the entities set.
   *
   * @param _entity - The entity that was removed
   */
  protected onEntityRemoved(_entity: Entity): void {}

  /**
   * Check if an entity matches this system's query.
   *
   * @param entity - Entity to check
   * @returns True if the entity matches all query criteria
   */
  matchesQuery(entity: Entity): boolean {
    // Inactive entities never match
    if (!entity.active) {
      return false;
    }

    // Check required components - must have ALL
    if (this.query.required && this.query.required.length > 0) {
      if (!entity.hasAll(...this.query.required)) {
        return false;
      }
    }

    // Check excluded components - must have NONE
    if (this.query.excluded && this.query.excluded.length > 0) {
      if (entity.hasAny(...this.query.excluded)) {
        return false;
      }
    }

    // Check anyOf components - must have AT LEAST ONE
    if (this.query.anyOf && this.query.anyOf.length > 0) {
      if (!entity.hasAny(...this.query.anyOf)) {
        return false;
      }
    }

    // Check required tags - must have ALL
    if (this.query.tags && this.query.tags.length > 0) {
      const hasAllTags = this.query.tags.every(tag => entity.hasTag(tag));
      if (!hasAllTags) {
        return false;
      }
    }

    // Check excluded tags - must have NONE
    if (this.query.excludedTags && this.query.excludedTags.length > 0) {
      const hasAnyExcludedTag = this.query.excludedTags.some(tag => entity.hasTag(tag));
      if (hasAnyExcludedTag) {
        return false;
      }
    }

    return true;
  }

  /**
   * Called every frame by the World.
   * If enabled and initialized, calls onUpdate().
   *
   * @param deltaTime - Time since last frame in seconds
   */
  update(deltaTime: number): void {
    if (!this._enabled || !this._initialized) {
      return;
    }

    // Opt-in race attribution. In dev builds World hangs a RaceDetector off
    // itself; in prod it's undefined and we take the straight path.
    const detector = (this.world as unknown as {
      raceDetector?: { setCurrentSystem(name: string | null): void };
    })?.raceDetector;
    if (detector) {
      detector.setCurrentSystem(this.constructor.name);
      try {
        this.onUpdate(deltaTime);
      } finally {
        detector.setCurrentSystem(null);
      }
      return;
    }

    this.onUpdate(deltaTime);
  }

  /**
   * REQUIRED: Override this method with your system's update logic.
   * Called every frame with the time since last frame.
   *
   * @param deltaTime - Time since last frame in seconds
   */
  protected abstract onUpdate(deltaTime: number): void;

  /**
   * Get all entities in this system as an array.
   * @returns Array of matching entities
   */
  getEntities(): Entity[] {
    return Array.from(this.entities);
  }

  /**
   * Get the count of entities in this system.
   * @returns Number of matching entities
   */
  getEntityCount(): number {
    return this.entities.size;
  }

  /**
   * Remove all entities from this system.
   * Note: Does not call onEntityRemoved for each entity.
   */
  clearEntities(): void {
    this.entities.clear();
  }
}
