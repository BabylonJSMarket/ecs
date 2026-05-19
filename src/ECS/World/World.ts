import type { EntityId, ComponentType } from '../types';
import { Entity } from '../Entity/Entity';
import { System } from '../System/System';
import type { ISystemQuery } from '../System/System';
import { EventBus } from '../EventBus/EventBus';
import type { UnsubscribeFn } from '../EventBus/EventBus';
import { SceneLoader } from '../SceneLoader/SceneLoader';
import type { RendererAdapter } from '../../Renderer/types';
import { RaceDetector } from '../Race/RaceDetector';
import { withRaceTracking } from '../../Renderer/raceTrackingAdapter';

/**
 * Configuration options for creating a World.
 */
export interface IWorldOptions {
  /** Maximum number of entities allowed (default: 10000) */
  maxEntities?: number;
  /** EventBus instance to use (creates new one if not provided) */
  eventBus?: EventBus;
  /** SceneLoader instance for loading scenes into this world */
  sceneLoader?: SceneLoader;
  /** Active renderer adapter — systems read `world.renderer` to create 3D objects */
  renderer?: RendererAdapter;
  /**
   * Enable race detection (event + adapter-handle writes). When true, the
   * World wraps the renderer in a tracking Proxy and the EventBus records
   * emit source Systems. Warnings go to console.warn. Defaults to dev
   * builds (`import.meta.env.DEV` / `NODE_ENV !== 'production'`).
   */
  detectRaces?: boolean;
}

function isDev(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (env && typeof env.DEV === 'boolean') return env.DEV;
  } catch { /* no import.meta in this runtime */ }
  try {
    const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (proc && proc.env) {
      return proc.env.NODE_ENV !== 'production';
    }
  } catch { /* no process */ }
  return true;
}

/**
 * World - The main container and orchestrator for ECS.
 *
 * The World is the heart of the ECS framework. It:
 * - Manages all entities and their lifecycle
 * - Holds and updates all systems
 * - Owns the EventBus for communication
 * - Handles pause/resume functionality
 * - Automatically routes entities to matching systems
 *
 * Typical usage:
 * ```typescript
 * const world = new World();
 *
 * // Add systems (order determined by priority)
 * world.addSystem(new InputSystem(world.getEventBus()));
 * world.addSystem(new MovementSystem(world.getEventBus()));
 * world.addSystem(new RenderSystem(world.getEventBus()));
 *
 * // Create entities
 * const player = world.createEntity("player");
 * player.add(new Position(0, 0));
 * player.add(new Velocity(0, 0));
 *
 * // Game loop
 * function gameLoop(deltaTime) {
 *   world.update(deltaTime);
 *   requestAnimationFrame(gameLoop);
 * }
 * ```
 */
export class World {
  /**
   * Map of all entities in this world, keyed by ID.
   */
  private entities: Map<EntityId, Entity> = new Map();

  /**
   * All systems in this world, sorted by priority (highest first).
   */
  private systems: System[] = [];

  /**
   * The EventBus used for all communication in this world.
   */
  protected eventBus: EventBus;

  /**
   * Whether the world is currently running (update loop active).
   */
  private running: boolean = false;

  /**
   * Whether the world is paused. Paused worlds skip pauseable systems.
   */
  private _paused: boolean = false;

  /**
   * Maximum number of entities allowed in this world.
   */
  private maxEntities: number;

  /**
   * Event subscriptions to clean up on destroy.
   */
  private subscriptions: UnsubscribeFn[] = [];

  /**
   * Whether initialize() has been called.
   */
  private _initialized: boolean = false;

  /**
   * Optional SceneLoader for loading scene definitions.
   */
  private _sceneLoader?: SceneLoader;

  /**
   * Active renderer adapter. Systems read this to create meshes, lights, and
   * cameras. Remains undefined until a renderer-using Game sets it.
   */
  public renderer?: RendererAdapter;

  /**
   * Race detector. Present only when detectRaces is enabled (dev default).
   * System.update() uses it to attribute emits and adapter writes to the
   * currently-running System.
   */
  public raceDetector?: RaceDetector;

  /**
   * Create a new World.
   *
   * @param options - Configuration options
   */
  constructor(options: IWorldOptions = {}) {
    this.maxEntities = options.maxEntities || 10000;
    this.eventBus = options.eventBus || new EventBus();
    this._sceneLoader = options.sceneLoader;

    const detect = options.detectRaces ?? isDev();
    if (detect) {
      this.raceDetector = new RaceDetector();
      this.eventBus.setRaceDetector(this.raceDetector);
      this.renderer = options.renderer
        ? withRaceTracking(options.renderer, this.raceDetector)
        : undefined;
    } else {
      this.renderer = options.renderer;
    }

    this.setupEventListeners();
  }

  /**
   * Whether this world has been initialized.
   */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Whether this world is currently paused.
   */
  get paused(): boolean {
    return this._paused;
  }

  /**
   * Get the associated SceneLoader.
   */
  get sceneLoader(): SceneLoader | undefined {
    return this._sceneLoader;
  }

  /**
   * Set the SceneLoader for this world.
   */
  set sceneLoader(loader: SceneLoader | undefined) {
    this._sceneLoader = loader;
  }

  /**
   * Pause the world. Pauseable systems will stop updating.
   * Emits "world.paused" event.
   */
  pause(): void {
    if (!this._paused) {
      this._paused = true;
      this.eventBus.emit('world.paused', { world: this });
    }
  }

  /**
   * Resume the world after pausing.
   * Emits "world.resumed" event.
   */
  resume(): void {
    if (this._paused) {
      this._paused = false;
      this.eventBus.emit('world.resumed', { world: this });
    }
  }

  /**
   * Toggle pause state.
   */
  togglePause(): void {
    if (this._paused) {
      this.resume();
    } else {
      this.pause();
    }
  }

  /**
   * Get the EventBus for this world.
   * Use this to emit events or subscribe to system communications.
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Set up internal event listeners for automatic entity routing.
   *
   * The World listens for entity changes (component added/removed,
   * tag added/removed, activated/deactivated) and automatically
   * updates which systems track which entities.
   */
  private setupEventListeners(): void {
    this.subscriptions.push(
      this.eventBus.on('*', (event: any) => {
        if (!event.type || !event.data) return;

        // Parse event type: "entity.{id}.{action}"
        const parts = event.type.split('.');
        if (parts[0] !== 'entity' || parts.length < 3) return;

        const action = parts.slice(2).join('.');

        switch (action) {
          case 'component.added':
          case 'component.removed':
          case 'tag.added':
          case 'tag.removed':
            // Entity composition changed - refresh system membership
            if (event.data.entity) {
              this.onComponentChanged(event.data.entity);
            }
            break;
          case 'activated':
            // Entity became active - add to matching systems
            if (event.data.entity) {
              this.onEntityActivated(event.data.entity);
            }
            break;
          case 'deactivated':
            // Entity became inactive - remove from all systems
            if (event.data.entity) {
              this.onEntityDeactivated(event.data.entity);
            }
            break;
        }
      })
    );
  }

  /**
   * Called when an entity's components or tags change.
   * Refreshes all systems to check if the entity still matches their queries.
   */
  private onComponentChanged(entity: Entity): void {
    this.systems.forEach(system => {
      system.refreshEntity(entity);
    });
  }

  /**
   * Called when an entity becomes active.
   * Adds the entity to all systems whose queries it matches.
   */
  private onEntityActivated(entity: Entity): void {
    this.systems.forEach(system => {
      system.addEntity(entity);
    });
  }

  /**
   * Called when an entity becomes inactive.
   * Removes the entity from all systems.
   */
  private onEntityDeactivated(entity: Entity): void {
    this.systems.forEach(system => {
      system.removeEntity(entity);
    });
  }

  /**
   * Initialize the world and all its systems.
   * Called automatically on first update() if not called manually.
   * Emits "world.initialized" event.
   */
  initialize(): void {
    if (this._initialized) {
      return;
    }

    this._initialized = true;
    this.systems.forEach(system => system.initialize());
    this.eventBus.emit('world.initialized', { world: this });
  }

  /**
   * Shutdown the world and all its systems.
   * Emits "world.shutdown" event.
   */
  shutdown(): void {
    if (!this._initialized) {
      return;
    }

    this.running = false;
    this.systems.forEach(system => system.shutdown());
    this._initialized = false;
    this.eventBus.emit('world.shutdown', { world: this });
  }

  /**
   * Create a new entity in this world.
   *
   * @param id - Optional custom ID. Auto-generates if not provided.
   * @returns The newly created entity
   * @throws If max entities limit is reached or ID already exists
   */
  createEntity(id?: EntityId): Entity {
    if (this.entities.size >= this.maxEntities) {
      throw new Error(`Maximum entity limit (${this.maxEntities}) reached`);
    }

    const entity = new Entity(this.eventBus, id);

    if (this.entities.has(entity.id)) {
      throw new Error(`Entity with id '${entity.id}' already exists`);
    }

    this.entities.set(entity.id, entity);
    this.eventBus.emit('world.entity.created', { world: this, entity });

    // Add to matching systems
    this.systems.forEach(system => {
      system.addEntity(entity);
    });

    return entity;
  }

  /**
   * Get an entity by its ID.
   *
   * @param id - The entity ID to look up
   * @returns The entity, or undefined if not found
   */
  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  /**
   * Get all entities in this world.
   * @returns Array of all entities
   */
  getEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  /**
   * Get all entities that have a specific tag.
   *
   * @param tag - The tag to filter by
   * @returns Array of entities with this tag
   */
  getEntitiesByTag(tag: string): Entity[] {
    return this.getEntities().filter(entity => entity.hasTag(tag));
  }

  /**
   * Get all entities that have a specific component type.
   *
   * @param component - The component class to filter by
   * @returns Array of entities with this component
   */
  getEntitiesWithComponent(component: ComponentType): Entity[] {
    return this.getEntities().filter(entity => entity.has(component));
  }

  /**
   * Get all entities that have ALL specified component types.
   *
   * @param components - Component classes to require
   * @returns Array of entities with all these components
   */
  getEntitiesWithComponents(...components: ComponentType[]): Entity[] {
    return this.getEntities().filter(entity => entity.hasAll(...components));
  }

  /**
   * Query entities using the same query syntax as Systems.
   *
   * This is useful for one-off queries without creating a system.
   * Note: Unlike system queries, this runs fresh each call (not cached).
   *
   * @param query - Query criteria (same as ISystemQuery)
   * @returns Array of matching entities
   */
  query(query: ISystemQuery = {}): Entity[] {
    let entities = this.getEntities();

    // Filter by active entities only
    entities = entities.filter(entity => entity.active);

    // Filter by required components
    if (query.required && query.required.length > 0) {
      entities = entities.filter(entity => entity.hasAll(...(query.required || [])));
    }

    // Filter by excluded components
    if (query.excluded && query.excluded.length > 0) {
      entities = entities.filter(entity => !entity.hasAny(...(query.excluded || [])));
    }

    // Filter by anyOf components
    if (query.anyOf && query.anyOf.length > 0) {
      entities = entities.filter(entity => entity.hasAny(...(query.anyOf || [])));
    }

    // Filter by tags
    if (query.tags && query.tags.length > 0) {
      entities = entities.filter(entity => query.tags!.every(tag => entity.hasTag(tag)));
    }

    // Filter by excluded tags
    if (query.excludedTags && query.excludedTags.length > 0) {
      entities = entities.filter(entity => !query.excludedTags!.some(tag => entity.hasTag(tag)));
    }

    return entities;
  }

  /**
   * Remove an entity from this world.
   *
   * Removes the entity from all systems, calls destroy() on it,
   * and emits "world.entity.removed" event.
   *
   * @param entity - Entity or entity ID to remove
   * @returns True if entity was found and removed
   */
  removeEntity(entity: Entity | EntityId): boolean {
    const entityToRemove = typeof entity === 'string' ? this.entities.get(entity) : entity;

    if (!entityToRemove) {
      return false;
    }

    // Remove from all systems first
    this.systems.forEach(system => {
      system.removeEntity(entityToRemove);
    });

    // Destroy the entity (cleans up components)
    entityToRemove.destroy();
    this.entities.delete(entityToRemove.id);

    this.eventBus.emit('world.entity.removed', {
      world: this,
      entity: entityToRemove,
    });

    return true;
  }

  /**
   * Remove all entities from this world.
   */
  removeAllEntities(): void {
    // Convert to array to avoid mutation during iteration
    const entitiesToRemove = Array.from(this.entities.values());
    entitiesToRemove.forEach(entity => this.removeEntity(entity));
  }

  /**
   * Add a system to this world.
   *
   * The system will be:
   * - Given a reference to this world
   * - Sorted by priority (higher = runs first)
   * - Initialized if the world is already initialized
   * - Given all existing entities that match its query
   *
   * @param system - The system to add
   */
  addSystem(system: System): void {
    if (this.systems.includes(system)) {
      return;
    }

    // Set the world reference on the system
    (system as any).setWorld(this);

    this.systems.push(system);
    // Sort by priority descending (higher priority runs first)
    this.systems.sort((a, b) => b.priority - a.priority);

    // Initialize immediately if world is already initialized
    if (this._initialized) {
      system.initialize();
    }

    // Add existing entities to the new system
    this.entities.forEach(entity => {
      system.addEntity(entity);
    });

    this.eventBus.emit('world.system.added', { world: this, system });
  }

  /**
   * Remove a system from this world.
   *
   * Shuts down the system and clears its world reference.
   *
   * @param system - The system to remove
   * @returns True if system was found and removed
   */
  removeSystem(system: System): boolean {
    const index = this.systems.indexOf(system);
    if (index === -1) {
      return false;
    }

    system.shutdown();
    this.systems.splice(index, 1);

    // Clear the world reference
    (system as any).setWorld(undefined);

    this.eventBus.emit('world.system.removed', { world: this, system });
    return true;
  }

  /**
   * Get a system by its class.
   *
   * @param SystemClass - The system class to find
   * @returns The system instance, or undefined if not found
   */
  getSystem<T extends System>(SystemClass: new (...args: any[]) => T): T | undefined {
    return this.systems.find(system => system instanceof SystemClass) as T | undefined;
  }

  /**
   * Get all systems in this world.
   * @returns Array of all systems (copy, sorted by priority)
   */
  getSystems(): System[] {
    return [...this.systems];
  }

  /**
   * Update all systems for one frame.
   *
   * This is your main game loop call. It:
   * - Auto-initializes if needed
   * - Emits "world.update.start" event
   * - Updates each enabled system (respecting pause state)
   * - Emits "world.update.end" event
   *
   * @param deltaTime - Time since last frame in seconds
   */
  update(deltaTime: number): void {
    // Auto-initialize on first update
    if (!this._initialized) {
      this.initialize();
    }

    this.running = true;

    // Start a new frame for duplicate event detection
    this.eventBus.startFrame();
    this.raceDetector?.beginFrame();

    this.eventBus.emit('world.update.start', { world: this, deltaTime });

    this.systems.forEach(system => {
      if (system.enabled) {
        // Skip pauseable systems when world is paused
        if (this._paused && system.pauseable) {
          return;
        }
        system.update(deltaTime);
      }
    });

    this.eventBus.emit('world.update.end', { world: this, deltaTime });
  }

  /**
   * Check if the world is currently running.
   * @returns True if update() has been called at least once
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the current number of entities.
   */
  getEntityCount(): number {
    return this.entities.size;
  }

  /**
   * Get the maximum allowed entities.
   */
  getMaxEntities(): number {
    return this.maxEntities;
  }

  /**
   * Completely destroy this world.
   *
   * Shuts down all systems, removes all entities, clears all
   * event subscriptions, and resets the EventBus.
   */
  destroy(): void {
    this.shutdown();
    this.removeAllEntities();
    this.systems = [];
    this.subscriptions.forEach(unsubscribe => unsubscribe());
    this.subscriptions = [];
    this.eventBus.clear();
  }

  /**
   * Convert the world state to JSON for debugging/serialization.
   */
  toJSON(): any {
    return {
      entityCount: this.entities.size,
      maxEntities: this.maxEntities,
      systems: this.systems.map(s => s.constructor.name),
      entities: Array.from(this.entities.values()).map(e => e.toJSON()),
      running: this.running,
      initialized: this._initialized,
    };
  }
}
