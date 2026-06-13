import type { EntityId, ComponentType } from '../types';
import { Component, componentTypeId } from '../Component/Component';
import { EventBus } from '../EventBus/EventBus';

/**
 * Entity - A game object composed of components.
 *
 * In ECS, an Entity is essentially an ID with a bag of components attached.
 * The entity itself has no behavior - it's just a container that groups
 * components together to form a game object.
 *
 * Examples of entities:
 * - A "Player" entity with Position, Health, and Input components
 * - A "Bullet" entity with Position, Velocity, and Damage components
 * - A "Tree" entity with just Position and Mesh components
 *
 * Entities can also have tags - simple string labels for categorization
 * (e.g., "enemy", "player", "destructible").
 */
export class Entity {
  /**
   * Auto-incrementing counter for generating unique entity IDs.
   * Each new entity gets the next available number.
   */
  private static nextId = 1;

  /**
   * Unique identifier for this entity.
   * Used to reference this entity in events and queries.
   */
  public readonly id: EntityId;

  /**
   * Map storing all components attached to this entity.
   * Key: Component class (constructor), Value: Component instance
   * Using a Map allows O(1) lookup by component type.
   */
  private components: Map<ComponentType, Component> = new Map();

  /**
   * Reference to the world's event bus for emitting entity events.
   */
  private eventBus: EventBus;

  /**
   * Whether this entity is active. Inactive entities can be skipped
   * by systems that check this flag.
   */
  private _active: boolean = true;

  /**
   * Optional human-readable name for debugging and identification.
   */
  private _name: string = '';

  /**
   * Set of string tags for categorization.
   * Tags are a lightweight way to mark entities without components.
   */
  private tags: Set<string> = new Set();

  /**
   * Create a new entity.
   *
   * @param eventBus - The world's event bus for communication
   * @param id - Optional custom ID. If not provided, auto-generates one.
   */
  constructor(eventBus: EventBus, id?: EntityId) {
    this.id = id || `entity-${Entity.nextId++}`;
    this.eventBus = eventBus;
  }

  /**
   * Whether this entity is active.
   * Systems can skip inactive entities to "pause" them.
   */
  get active(): boolean {
    return this._active;
  }

  /**
   * Activate or deactivate this entity.
   * Emits "entity.{id}.activated" or "entity.{id}.deactivated" events.
   */
  set active(value: boolean) {
    if (this._active !== value) {
      this._active = value;
      this.eventBus.emit(`entity.${this.id}.${value ? 'activated' : 'deactivated'}`, {
        entity: this,
      });
    }
  }

  /**
   * Get the entity's display name.
   */
  get name(): string {
    return this._name;
  }

  /**
   * Set the entity's display name for debugging.
   */
  set name(value: string) {
    this._name = value;
  }

  /**
   * Add a component to this entity.
   *
   * You can pass either:
   * - A component instance: entity.add(new Position(10, 20))
   * - A component class with args: entity.add(Position, 10, 20)
   *
   * Only one component of each type can be attached.
   * Adding a duplicate type is silently ignored.
   *
   * @param componentOrClass - Component instance or class to add
   * @param args - Constructor arguments if passing a class
   * @returns This entity for method chaining
   */
  add<T extends Component>(componentOrClass: T | ComponentType<T>, ...args: any[]): Entity {
    let component: Component;
    let ComponentClass: ComponentType;

    // Check if we received an instance or a class
    if (componentOrClass instanceof Component) {
      // It's an instance - use directly
      component = componentOrClass;
      ComponentClass = componentOrClass.constructor as ComponentType;
    } else {
      // It's a class constructor - instantiate it
      ComponentClass = componentOrClass as ComponentType;
      component = new ComponentClass(...args);
    }

    // Prevent duplicate components of the same type
    if (this.components.has(ComponentClass)) {
      return this;
    }

    // Store the component and trigger its lifecycle hook
    this.components.set(ComponentClass, component);
    component.onAttach(this.id, this.eventBus);

    // Notify listeners that a component was added
    this.eventBus.emit(`entity.${this.id}.component.added`, {
      entity: this,
      component,
      type: ComponentClass,
    });

    return this;
  }

  /**
   * Get a component of the specified type from this entity.
   *
   * @param ComponentClass - The component class to retrieve
   * @returns The component instance, or undefined if not found
   *
   * Note: Includes fallback lookup by class name to handle
   * dynamic import scenarios where class references may differ.
   */
  get<T extends Component>(ComponentClass: ComponentType<T>): T | undefined {
    // First try direct class reference lookup (fastest)
    const direct = this.components.get(ComponentClass);
    if (direct) return direct as T;

    // Fallback: match by stable component type id (handles dynamic-import class
    // mismatches where the same component is loaded as two class objects). Uses
    // componentTypeId, NOT Class.name — minified, name-colliding component types
    // would otherwise match each other and return the wrong component.
    const targetType = componentTypeId(ComponentClass);
    for (const [cls, comp] of this.components) {
      if (componentTypeId(cls) === targetType) {
        return comp as T;
      }
    }
    return undefined;
  }

  /**
   * Check if this entity has a component of the specified type.
   *
   * @param ComponentClass - The component class to check for
   * @returns True if the entity has this component type
   */
  has(ComponentClass: ComponentType): boolean {
    if (this.components.has(ComponentClass)) return true;
    // Fallback: match by stable component type id (see get()) — never Class.name.
    const targetType = componentTypeId(ComponentClass);
    for (const cls of this.components.keys()) {
      if (componentTypeId(cls) === targetType) return true;
    }
    return false;
  }

  /**
   * Check if this entity has ALL of the specified component types.
   * Useful for system queries that require multiple components.
   *
   * @param ComponentClasses - Component classes to check
   * @returns True only if entity has every specified component
   */
  hasAll(...ComponentClasses: ComponentType[]): boolean {
    return ComponentClasses.every(cls => this.has(cls));
  }

  /**
   * Check if this entity has ANY of the specified component types.
   * Useful for queries with optional components.
   *
   * @param ComponentClasses - Component classes to check
   * @returns True if entity has at least one specified component
   */
  hasAny(...ComponentClasses: ComponentType[]): boolean {
    return ComponentClasses.some(cls => this.has(cls));
  }

  /**
   * Remove a component from this entity.
   *
   * Calls the component's onDetach() lifecycle hook and emits
   * an "entity.{id}.component.removed" event.
   *
   * @param ComponentClass - The component class to remove
   * @returns This entity for method chaining
   */
  remove(ComponentClass: ComponentType): Entity {
    const component = this.components.get(ComponentClass);
    if (!component) {
      return this;
    }

    // Trigger cleanup lifecycle hook
    component.onDetach();
    this.components.delete(ComponentClass);

    // Notify listeners
    this.eventBus.emit(`entity.${this.id}.component.removed`, {
      entity: this,
      component,
      type: ComponentClass,
    });

    return this;
  }

  /**
   * Remove all components from this entity.
   * Each removal triggers onDetach() and emits removal events.
   */
  removeAll(): void {
    // Convert to array first to avoid mutation during iteration
    const componentsToRemove = Array.from(this.components.keys());
    componentsToRemove.forEach(ComponentClass => this.remove(ComponentClass));
  }

  /**
   * Get all component instances attached to this entity.
   * @returns Array of all components
   */
  getComponents(): Component[] {
    return Array.from(this.components.values());
  }

  /**
   * Get all component classes (types) attached to this entity.
   * @returns Array of component constructors
   */
  getComponentTypes(): ComponentType[] {
    return Array.from(this.components.keys());
  }

  /**
   * Add a tag to this entity.
   * Tags are lightweight string labels for categorization.
   *
   * @param tag - The tag string to add
   * @returns This entity for method chaining
   */
  addTag(tag: string): Entity {
    if (!this.tags.has(tag)) {
      this.tags.add(tag);
      this.eventBus.emit(`entity.${this.id}.tag.added`, { entity: this, tag });
    }
    return this;
  }

  /**
   * Remove a tag from this entity.
   *
   * @param tag - The tag string to remove
   * @returns This entity for method chaining
   */
  removeTag(tag: string): Entity {
    if (this.tags.delete(tag)) {
      this.eventBus.emit(`entity.${this.id}.tag.removed`, { entity: this, tag });
    }
    return this;
  }

  /**
   * Check if this entity has a specific tag.
   *
   * @param tag - The tag to check for
   * @returns True if the entity has this tag
   */
  hasTag(tag: string): boolean {
    return this.tags.has(tag);
  }

  /**
   * Get all tags on this entity.
   * @returns Array of tag strings
   */
  getTags(): string[] {
    return Array.from(this.tags);
  }

  /**
   * Remove all tags from this entity.
   */
  clearTags(): void {
    this.tags.clear();
  }

  /**
   * Create a deep copy of this entity.
   *
   * The clone has:
   * - A new unique ID
   * - Copies of all components (via component.clone())
   * - Copies of all tags
   * - Same name and active state
   *
   * Useful for prefabs/templates where you define an entity
   * once and spawn multiple copies.
   */
  clone(): Entity {
    const cloned = new Entity(this.eventBus);
    cloned._name = this._name;
    cloned._active = this._active;

    // Copy all tags
    this.tags.forEach(tag => cloned.tags.add(tag));

    // Clone each component and attach to the new entity
    this.components.forEach((component, ComponentClass) => {
      const clonedComponent = component.clone();
      cloned.components.set(ComponentClass, clonedComponent);
      clonedComponent.onAttach(cloned.id, this.eventBus);
    });

    return cloned;
  }

  /**
   * Destroy this entity.
   *
   * Removes all components (triggering their onDetach hooks),
   * clears all tags, and emits a "destroyed" event.
   *
   * After destruction, this entity should not be used.
   */
  destroy(): void {
    this.removeAll();
    this.clearTags();
    this.eventBus.emit(`entity.${this.id}.destroyed`, { entity: this });
  }

  /**
   * Convert this entity to a JSON-serializable object.
   *
   * Includes: id, name, active state, tags, and all component data.
   * Used for saving game state or exporting scenes.
   */
  toJSON(): any {
    const components: any = {};
    this.components.forEach((component, ComponentClass) => {
      components[ComponentClass.name] = component.toJSON();
    });

    return {
      id: this.id,
      name: this._name,
      active: this._active,
      tags: Array.from(this.tags),
      components,
    };
  }
}
