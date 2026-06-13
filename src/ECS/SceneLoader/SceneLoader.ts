/**
 * SceneLoader.ts - Load and instantiate game scenes from JSON
 *
 * The SceneLoader bridges the gap between data-driven design and runtime ECS.
 * It allows you to define scenes in JSON files and load them into a World,
 * automatically creating entities with their components.
 *
 * Benefits of data-driven scenes:
 * - Level designers can work without code changes
 * - Easy to tweak and iterate on game content
 * - Scenes can be loaded dynamically at runtime
 * - Supports save/load by serializing back to JSON
 *
 * Workflow:
 * 1. Register your components with the SceneLoader
 * 2. Load scene JSON from file or URL
 * 3. Instantiate the scene into a World
 * 4. (Optional) Serialize World back to JSON
 */

import { Component, componentTypeId } from "../Component/Component";
import { Entity } from "../Entity/Entity";
import { System } from "../System/System";
import { World } from "../World/World";
import { EventBus } from "../EventBus/EventBus";

// ============================================
// Scene Data Interfaces
// ============================================

/**
 * Complete scene definition loaded from JSON.
 *
 * Example JSON:
 * ```json
 * {
 *   "name": "Level1",
 *   "entities": {
 *     "player": {
 *       "components": {
 *         "Position": { "x": 0, "y": 0 },
 *         "Health": { "current": 100, "max": 100 }
 *       },
 *       "tags": ["player", "team-red"]
 *     }
 *   }
 * }
 * ```
 */
export interface SceneData {
  /** Unique scene identifier */
  name: string;
  /** Display title for the game */
  gameTitle?: string;
  /** Display title for this scene/level */
  sceneTitle?: string;
  /** Mechanic guide slug — renders Examples/mechanics/{slug}.mdx in the side panel */
  guide?: string;
  /** Entity ID to use as the "world" entity (for global components) */
  worldEntity?: string;
  /** List of component types used (for pre-loading) */
  components?: string[];
  /** List of system types to create */
  systems?: string[];
  /** Entity definitions keyed by entity ID */
  entities: Record<string, EntityData>;
  /** Scene-wide configuration */
  config?: SceneConfig;
}

/**
 * Entity definition within a scene.
 */
export interface EntityData {
  /** Component data keyed by component type name */
  components: Record<string, any>;
  /** Optional tags to apply to the entity */
  tags?: string[];
}

/**
 * Scene-wide configuration options.
 */
export interface SceneConfig {
  /** Enable physics simulation */
  physics?: boolean;
  /** Gravity vector [x, y, z] */
  gravity?: [number, number, number];
  /** Enable debug mode */
  debug?: boolean;
  /** Map component names to alternative class names */
  componentMap?: Record<string, string>;
}

/**
 * Registry entry mapping a component name to its class and optional system.
 *
 * The constructor types are widened to concrete (non-abstract) constructors
 * because `typeof Component` / `typeof System` name the abstract base and
 * TypeScript refuses `new AbstractCtor(...)`. Callers always register
 * concrete subclasses, so this is the correct runtime contract.
 */
export interface ComponentEntry {
  /** The concrete Component subclass constructor. */
  component: new (data?: any) => Component;
  /** Optional concrete System subclass constructor. */
  system?: new (eventBus: EventBus) => System;
}

// ============================================
// SceneLoader Events
// ============================================

/**
 * Events emitted during scene loading.
 * Listen to these to show loading progress or debug issues.
 */
export const SceneLoaderEvents = {
  /** Scene loading started */
  LOADING: "sceneloader.loading",
  /** Scene loaded successfully */
  LOADED: "sceneloader.loaded",
  /** Scene loading failed */
  ERROR: "sceneloader.error",
  /** Entity created from scene data */
  ENTITY_CREATED: "sceneloader.entity.created",
  /** Component added to entity */
  COMPONENT_LOADED: "sceneloader.component.loaded",
  /** System automatically created */
  SYSTEM_CREATED: "sceneloader.system.created",
} as const;

// ============================================
// SceneLoader - Loads scenes from JSON
// ============================================

/**
 * SceneLoader - Load and instantiate scenes from JSON data.
 *
 * The SceneLoader works in two phases:
 * 1. **Load**: Parse JSON and store scene data
 * 2. **Instantiate**: Create entities in a World from the data
 *
 * Usage:
 * ```typescript
 * const loader = new SceneLoader(eventBus);
 *
 * // Register components that can be instantiated
 * loader.registerComponent("Position", PositionComponent);
 * loader.registerComponent("Physics", PhysicsComponent, PhysicsSystem);
 *
 * // Load scene data
 * await loader.loadSceneFromUrl("/scenes/level1.json");
 *
 * // Instantiate into a World
 * const { entities, systems } = loader.instantiateScene("Level1", world);
 * ```
 */
export class SceneLoader {
  /**
   * EventBus for emitting loading events.
   */
  private eventBus: EventBus;

  /**
   * Registry of component names -> Component classes.
   * Components must be registered before scenes using them can be loaded.
   */
  private componentRegistry: Map<string, ComponentEntry> = new Map();

  /**
   * Cache of loaded scene data, keyed by scene name.
   */
  private loadedScenes: Map<string, SceneData> = new Map();

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Register a component class for scene loading.
   *
   * Components must be registered before loading scenes that use them.
   * This creates a mapping from the component name (as it appears in JSON)
   * to the actual TypeScript class.
   *
   * @param name - Component name as it appears in scene JSON
   * @param componentClass - The Component class constructor
   * @param systemClass - Optional System class to auto-create
   *
   * Example:
   * ```typescript
   * loader.registerComponent("Position", PositionComponent);
   * loader.registerComponent("Physics", PhysicsComponent, PhysicsSystem);
   * ```
   */
  registerComponent(
    name: string,
    componentClass: new (data?: any) => Component,
    systemClass?: new (eventBus: EventBus) => System,
  ): void {
    // Stamp the registry name as the class's stable, minification-safe type id
    // (unless the class declares its own). This is what Entity.get/has match on,
    // so identity survives bundler class-name mangling. See componentTypeId().
    stampComponentType(componentClass, name);
    this.componentRegistry.set(name, {
      component: componentClass,
      system: systemClass,
    });
  }

  /**
   * Register multiple components at once.
   *
   * @param components - Object mapping component names to entries
   *
   * Example:
   * ```typescript
   * loader.registerComponents({
   *   Position: { component: PositionComponent },
   *   Physics: { component: PhysicsComponent, system: PhysicsSystem },
   * });
   * ```
   */
  registerComponents(components: Record<string, ComponentEntry>): void {
    for (const [name, entry] of Object.entries(components)) {
      if (entry.component) stampComponentType(entry.component, name);
      this.componentRegistry.set(name, entry);
    }
  }

  /**
   * Get a registered component class by name.
   *
   * @param name - Component name
   * @returns The Component class, or undefined if not registered
   */
  getComponentClass(name: string): typeof Component | undefined {
    return this.componentRegistry.get(name)?.component;
  }

  /**
   * Get a registered system class by component name.
   *
   * @param name - Component name
   * @returns The System class, or undefined if not registered
   */
  getSystemClass(name: string): typeof System | undefined {
    return this.componentRegistry.get(name)?.system;
  }

  /**
   * Load a scene from a URL (async).
   *
   * Fetches JSON from the URL, parses it, and stores it in the cache.
   * Emits LOADING, LOADED, or ERROR events.
   *
   * @param url - URL to fetch scene JSON from
   * @returns The loaded scene data
   * @throws If fetch fails or JSON is invalid
   */
  async loadSceneFromUrl(url: string): Promise<SceneData> {
    this.eventBus.emit(SceneLoaderEvents.LOADING, { url });

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Failed to load scene: ${url} (${response.status})`);
      }

      const sceneData: SceneData = await response.json();
      this.loadedScenes.set(sceneData.name, sceneData);

      this.eventBus.emit(SceneLoaderEvents.LOADED, {
        name: sceneData.name,
        entityCount: Object.keys(sceneData.entities).length,
      });

      return sceneData;
    } catch (error) {
      this.eventBus.emit(SceneLoaderEvents.ERROR, {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Load a scene from inline JSON data (synchronous).
   *
   * Use this when you have the scene data embedded in your code
   * or loaded through another mechanism.
   *
   * @param sceneData - The scene data object
   * @returns The same scene data (for chaining)
   */
  loadSceneFromData(sceneData: SceneData): SceneData {
    this.loadedScenes.set(sceneData.name, sceneData);

    this.eventBus.emit(SceneLoaderEvents.LOADED, {
      name: sceneData.name,
      entityCount: Object.keys(sceneData.entities).length,
    });

    return sceneData;
  }

  /**
   * Instantiate a loaded scene into a World.
   *
   * This is the main method - it creates all entities from the scene
   * definition and adds them to the World with their components.
   *
   * @param sceneName - Name of the loaded scene to instantiate
   * @param world - World to create entities in
   * @param options - Instantiation options
   * @returns Created entities, systems, and optional world entity
   *
   * Example:
   * ```typescript
   * const { entities, systems, worldEntity } = loader.instantiateScene(
   *   "Level1",
   *   world,
   *   { createSystems: true }
   * );
   *
   * // Add created systems to the world
   * for (const system of systems) {
   *   world.addSystem(system);
   * }
   * ```
   */
  instantiateScene(
    sceneName: string,
    world: World,
    options: {
      /** Whether to auto-create systems for components (default: true) */
      createSystems?: boolean;
      /** Override the world entity name from scene data */
      worldEntityName?: string;
    } = {}
  ): {
    /** Map of entity name -> Entity */
    entities: Map<string, Entity>;
    /** Array of auto-created systems */
    systems: System[];
    /** The designated "world" entity if one was specified */
    worldEntity?: Entity;
  } {
    const sceneData = this.loadedScenes.get(sceneName);
    if (!sceneData) {
      throw new Error(`Scene not loaded: ${sceneName}`);
    }

    const entities = new Map<string, Entity>();
    const systems: System[] = [];
    const usedComponents = new Set<string>();
    let worldEntity: Entity | undefined;

    // Determine world entity name from options or scene data
    const worldEntityName = options.worldEntityName ?? sceneData.worldEntity;

    // Create entities from scene data
    for (const [entityName, entityData] of Object.entries(sceneData.entities)) {
      // Create entity in the World
      const entity = world.createEntity(entityName);
      entities.set(entityName, entity);

      // Track if this is the designated world entity
      if (entityName === worldEntityName) {
        worldEntity = entity;
      }

      // Add tags from scene data
      if (entityData.tags) {
        for (const tag of entityData.tags) {
          entity.addTag(tag);
        }
      }

      // Add components from scene data
      for (const [componentType, componentData] of Object.entries(entityData.components)) {
        const entry = this.componentRegistry.get(componentType);

        if (!entry) {
          console.warn(`Component not registered: ${componentType}`);
          continue;
        }

        // Process component data (handle any necessary conversions)
        const processedData = this.processComponentData(componentData);

        // Create component instance with scene data
        const component = new entry.component(processedData);
        entity.add(component);
        usedComponents.add(componentType);

        this.eventBus.emit(SceneLoaderEvents.COMPONENT_LOADED, {
          entityId: entity.id,
          entityName,
          componentType,
        });
      }

      this.eventBus.emit(SceneLoaderEvents.ENTITY_CREATED, {
        entityId: entity.id,
        entityName,
        componentCount: Object.keys(entityData.components).length,
      });
    }

    // Auto-create systems for components that have them registered
    if (options.createSystems !== false) {
      const systemsCreated = new Set<string>();

      for (const componentType of usedComponents) {
        const entry = this.componentRegistry.get(componentType);

        // Create system if registered and not already created
        if (entry?.system && !systemsCreated.has(componentType)) {
          const system = new entry.system(this.eventBus);
          systems.push(system);
          systemsCreated.add(componentType);

          this.eventBus.emit(SceneLoaderEvents.SYSTEM_CREATED, {
            systemName: entry.system.name,
            componentType,
          });
        }
      }
    }

    return { entities, systems, worldEntity };
  }

  /**
   * Process component data to handle common conversions.
   *
   * Override this method in a subclass to add custom data processing
   * (e.g., converting string vectors to Vector3 objects).
   *
   * @param data - Raw component data from JSON
   * @returns Processed data ready for component constructor
   */
  protected processComponentData(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }

    if (Array.isArray(data)) {
      return data;
    }

    if (typeof data !== "object") {
      return data;
    }

    const processed: any = {};

    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        // Keep arrays as-is - components handle conversion
        processed[key] = value;
      } else if (typeof value === "object" && value !== null) {
        // Recursively process nested objects
        processed[key] = this.processComponentData(value);
      } else {
        processed[key] = value;
      }
    }

    return processed;
  }

  /**
   * Get a loaded scene's data by name.
   *
   * @param sceneName - Scene name to look up
   * @returns Scene data, or undefined if not loaded
   */
  getSceneData(sceneName: string): SceneData | undefined {
    return this.loadedScenes.get(sceneName);
  }

  /**
   * Get original entity data from loaded scenes.
   *
   * Searches all loaded scenes for an entity with the given ID.
   * Useful for getting default/original values after modifications.
   *
   * @param entityId - Entity ID to search for
   * @returns Entity data, or undefined if not found
   */
  getEntityData(entityId: string): EntityData | undefined {
    for (const scene of this.loadedScenes.values()) {
      if (scene.entities[entityId]) {
        return scene.entities[entityId];
      }
    }
    return undefined;
  }

  /**
   * Check if a scene is currently loaded in memory.
   *
   * @param sceneName - Scene name to check
   * @returns True if scene is loaded
   */
  isSceneLoaded(sceneName: string): boolean {
    return this.loadedScenes.has(sceneName);
  }

  /**
   * Unload a scene from memory.
   *
   * Note: This doesn't affect entities already created in a World.
   *
   * @param sceneName - Scene name to unload
   * @returns True if scene was found and unloaded
   */
  unloadScene(sceneName: string): boolean {
    return this.loadedScenes.delete(sceneName);
  }

  /**
   * Get names of all currently loaded scenes.
   * @returns Array of scene names
   */
  getLoadedSceneNames(): string[] {
    return Array.from(this.loadedScenes.keys());
  }

  /**
   * Serialize a World's entities to scene data format.
   *
   * This enables save/load functionality - serialize the current
   * game state and reload it later.
   *
   * @param world - World to serialize
   * @param sceneName - Name for the serialized scene
   * @returns Scene data that can be saved as JSON
   *
   * Example:
   * ```typescript
   * // Save game
   * const saveData = loader.serializeWorld(world, "SaveGame1");
   * localStorage.setItem("save", JSON.stringify(saveData));
   *
   * // Load game
   * const saved = JSON.parse(localStorage.getItem("save")!);
   * loader.loadSceneFromData(saved);
   * loader.instantiateScene("SaveGame1", newWorld);
   * ```
   */
  serializeWorld(world: World, sceneName: string): SceneData {
    const entities: Record<string, EntityData> = {};

    for (const entity of world.getEntities()) {
      const components: Record<string, any> = {};
      const componentTypes = entity.getComponentTypes();
      const componentInstances = entity.getComponents();

      for (let i = 0; i < componentTypes.length; i++) {
        const ComponentClass = componentTypes[i];
        const component = componentInstances[i];

        // Stable, minification-safe type id (the registry name once registered).
        const typeName = componentTypeId(ComponentClass);

        // Use component's toJSON if available
        if ("toJSON" in component && typeof component.toJSON === "function") {
          components[typeName] = component.toJSON();
        } else {
          // Default serialization - copy enumerable properties
          const data: any = {};
          for (const [key, value] of Object.entries(component)) {
            // Skip non-serializable properties
            if (typeof value === "function") continue;
            if (key.startsWith("_")) continue;
            data[key] = value;
          }
          components[typeName] = data;
        }
      }

      entities[entity.id] = {
        components,
        tags: entity.getTags(),
      };
    }

    return {
      name: sceneName,
      entities,
    };
  }
}

/**
 * Stamp `name` as a component class's stable type id, unless the class already
 * declares its OWN `componentType` (explicit `static componentType`, or a prior
 * registration). Uses an own-property check so a concrete class never silently
 * inherits a parent's stamped id. See {@link componentTypeId}.
 */
function stampComponentType(componentClass: object, name: string): void {
  if (!Object.prototype.hasOwnProperty.call(componentClass, "componentType")) {
    (componentClass as { componentType?: string }).componentType = name;
  }
}
