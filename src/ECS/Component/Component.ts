import type { EntityId } from '../types';
import { EventBus } from '../EventBus/EventBus';

/**
 * Component - The base class for all ECS components.
 *
 * In Entity-Component-System architecture, Components are pure data containers.
 * They hold the state and properties that define what an entity "has" or "is".
 * For example: a Position component holds x, y, z coordinates.
 *
 * Components don't contain game logic - that belongs in Systems.
 * This separation makes your code modular and reusable.
 *
 * All custom components extend this abstract class to inherit:
 * - Lifecycle hooks (onAttach, onDetach)
 * - Event emission capabilities
 * - Enable/disable functionality
 * - Cloning and serialization
 */
export abstract class Component {
  /**
   * Stable, minification-safe type id for this component class.
   *
   * Component identity in queries and serialization must NOT rely on
   * `Class.name`: production bundlers mangle class names to short, COLLIDING
   * identifiers, so two different component types can share a `.name` and a
   * query (`Entity.get`/`has`) resolves to the wrong one. Set this explicitly
   * (`static componentType = "Health"`), or let `SceneLoader.registerComponent`
   * stamp it with the registry name. Read it via {@link componentTypeId}.
   */
  static componentType?: string;

  /**
   * The ID of the entity this component is attached to.
   * Set automatically when the component is added to an entity.
   */
  protected entityId?: EntityId;

  /**
   * Reference to the world's event bus for emitting events.
   * Set automatically when the component is attached.
   */
  protected eventBus?: EventBus;

  /**
   * Internal enabled state. Use the `enabled` getter/setter to access.
   */
  private _enabled: boolean = true;

  /**
   * Whether this component is enabled.
   * Disabled components can be skipped by systems that check this flag.
   */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Enable or disable this component.
   * When changed, emits an event: `component.{ComponentName}.enabled` or `disabled`
   * Systems can listen to these events to react to component state changes.
   */
  set enabled(value: boolean) {
    if (this._enabled !== value) {
      this._enabled = value;
      // Emit an event so systems know this component's state changed
      this.eventBus?.emit(`component.${this.constructor.name}.${value ? 'enabled' : 'disabled'}`, {
        entityId: this.entityId,
        component: this,
      });
    }
  }

  /**
   * Called when this component is added to an entity.
   * This is where the component receives its entity ID and event bus reference.
   *
   * @param entityId - The ID of the entity this component now belongs to
   * @param eventBus - The world's event bus for communication
   */
  onAttach(entityId: EntityId, eventBus: EventBus): void {
    this.entityId = entityId;
    this.eventBus = eventBus;
    // Call the override hook for subclass initialization
    this.onAttachOverride();
  }

  /**
   * Called when this component is removed from an entity.
   * Cleans up references and calls the detach override hook.
   */
  onDetach(): void {
    // Call the override hook first so subclasses can clean up
    this.onDetachOverride();
    // Clear references to prevent memory leaks
    this.entityId = undefined;
    this.eventBus = undefined;
  }

  /**
   * Override this method in subclasses to run initialization logic
   * when the component is attached to an entity.
   *
   * Example: A Physics component might create a physics body here.
   */
  protected onAttachOverride(): void {}

  /**
   * Override this method in subclasses to run cleanup logic
   * when the component is removed from an entity.
   *
   * Example: A Physics component might destroy its physics body here.
   */
  protected onDetachOverride(): void {}

  /**
   * Emit an event scoped to this component's entity.
   * The event name is automatically prefixed with `entity.{entityId}.`
   *
   * @param event - The event name (e.g., "moved", "damaged")
   * @param data - Optional data to send with the event
   *
   * Example: this.emit("healthChanged", { health: 50 })
   * Results in event: "entity.player1.healthChanged"
   */
  protected emit(event: string, data?: any): void {
    if (this.eventBus && this.entityId) {
      this.eventBus.emit(`entity.${this.entityId}.${event}`, data);
    }
  }

  /**
   * Create a copy of this component.
   * The clone is detached (no entityId or eventBus) so it can be
   * attached to a different entity.
   *
   * Useful for entity prefabs/templates.
   */
  clone(): Component {
    const ComponentClass = this.constructor as any;
    const cloned = new ComponentClass();
    // Copy all properties to the clone
    Object.assign(cloned, this);
    // Clear entity-specific references so clone can be attached elsewhere
    cloned.entityId = undefined;
    cloned.eventBus = undefined;
    return cloned;
  }

  /**
   * Convert this component to a JSON-serializable object.
   * Excludes internal references (entityId, eventBus) that can't be serialized.
   *
   * Used when saving game state or exporting scenes.
   */
  toJSON(): any {
    // Destructure to exclude non-serializable properties
    const { entityId: _entityId, eventBus: _eventBus, ...data } = this as any;
    return data;
  }
}

/**
 * Resolve a component class's stable, minification-safe type id.
 *
 * Prefers an explicit/stamped {@link Component.componentType} (set directly or by
 * `SceneLoader.registerComponent` from the registry name) and only falls back to
 * the minifiable `Class.name` for component classes that were never registered.
 * Use this anywhere component identity is compared across class references —
 * never compare `Class.name` directly, or minified, name-colliding component
 * types will match each other.
 */
export function componentTypeId(
  ctor: { componentType?: string; readonly name: string } | undefined | null,
): string {
  if (!ctor) return '';
  // A stamped/explicit id is authoritative. Otherwise fall back to the class
  // name minus a trailing "Component" (the registry-name convention, e.g.
  // HemisphericLightComponent -> "HemisphericLight"). Both sides of an identity
  // comparison run through here, so the fallback stays symmetric.
  return ctor.componentType ?? ctor.name.replace(/Component$/, '');
}
