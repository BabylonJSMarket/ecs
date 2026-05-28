/**
 * Base Component + System pair for a spec-driven debug panel, decoupled from
 * any renderer. Subclass `PanelHostComponent` so the system's query isolates
 * one entity per panel, then subclass `PanelHostSystem` and override
 * `buildSpec()` to return the declarative `PanelSpec`. The base handles the
 * register lifecycle (retry until the world + config component are ready,
 * re-emit on a late viz layer, unregister on shutdown).
 *
 * Registration is published on the EventBus (`VizEvents.PANEL_REGISTERED`),
 * NOT rendered here — so this base, and everything that subclasses it
 * (arcade component debuggers, game-local panels), depends only on ecs. The
 * dev-only viz-pro layer subscribes and renders via its PanelRenderer. viz-pro
 * overrides `publishSpec`/`unpublishSpec` to register into `vizStore` directly
 * (its own debuggers live next to the renderer, so they skip the bus).
 */
import { Component, System } from '@babylonjsmarket/ecs';
import type { ComponentType, Entity, EventBus, World } from '@babylonjsmarket/ecs';
import type { PanelAnchor, PanelSpec } from './spec';
import { VizEvents } from './VizEvents';

export interface PanelHostInput {
  panelId?: string;
  visible?: boolean;
  activationKey?: string;
  position?: PanelAnchor;
}

export class PanelHostComponent extends Component {
  panelId: string;
  visible: boolean;
  activationKey: string;
  position: PanelAnchor;

  constructor(data: PanelHostInput & { panelId: string }) {
    super();
    this.panelId = data.panelId;
    this.visible = data.visible ?? false;
    this.activationKey = data.activationKey ?? '';
    this.position = data.position ?? 'top-right';
  }

  serialize(): PanelHostInput {
    return {
      panelId: this.panelId,
      visible: this.visible,
      activationKey: this.activationKey,
      position: this.position,
    };
  }
}

export abstract class PanelHostSystem<
  C extends PanelHostComponent = PanelHostComponent,
> extends System {
  protected component: C | null = null;
  private registered = false;
  /** The last spec we built, kept so we can re-emit when the viz layer mounts late. */
  private builtSpec: PanelSpec | null = null;
  private hostUnsubs: Array<() => void> = [];

  constructor(eventBus: EventBus, componentClass: ComponentType<C>) {
    super(eventBus);
    this.query = { required: [componentClass] };
    this._pauseable = false;
  }

  /** REQUIRED: build the declarative spec for this panel. */
  protected abstract buildSpec(world: World, component: C): PanelSpec;

  /** Override to defer spec construction until a required entity exists. */
  protected canBuild(_world: World, _component: C): boolean {
    return true;
  }

  /** Override to layer a `title`, `position`, or `titleColor` onto the spec. */
  protected decorateSpec(spec: PanelSpec): PanelSpec {
    return spec;
  }

  /**
   * Publish a built spec. The free base emits it on the bus for the viz layer
   * to render; viz-pro overrides this to register into vizStore directly.
   */
  protected publishSpec(spec: PanelSpec): void {
    this.eventBus.emit(VizEvents.PANEL_REGISTERED, { spec });
  }

  /** Counterpart to publishSpec, called on shutdown. */
  protected unpublishSpec(id: string): void {
    this.eventBus.emit(VizEvents.PANEL_UNREGISTERED, { id });
  }

  protected onInitialize(): void {
    for (const entity of this.entities) {
      const c = entity.get((this.query.required as ComponentType<C>[])[0]);
      if (c) {
        this.component = c;
        break;
      }
    }
    // If the viz layer mounts after us, it announces HOST_READY; re-emit so the
    // panel appears without a manual toggle (registration is order-independent).
    this.hostUnsubs.push(
      this.eventBus.on(VizEvents.HOST_READY, () => {
        if (this.builtSpec) this.publishSpec(this.builtSpec);
      })
    );
    this.tryRegister();
  }

  protected onUpdate(_dt: number): void {
    if (!this.registered) this.tryRegister();
  }

  protected onEntityAdded(entity: Entity): void {
    if (this.component) return;
    const c = entity.get((this.query.required as ComponentType<C>[])[0]);
    if (c) {
      this.component = c;
      this.tryRegister();
    }
  }

  protected onShutdown(): void {
    if (this.component) this.unpublishSpec(this.component.panelId);
    this.hostUnsubs.forEach((u) => u());
    this.hostUnsubs = [];
    this.registered = false;
    this.builtSpec = null;
  }

  private tryRegister(): void {
    if (this.registered || !this.component || !this.world) return;
    if (!this.canBuild(this.world, this.component)) return;

    const built = this.buildSpec(this.world, this.component);
    const spec = this.decorateSpec({
      ...built,
      id: built.id || this.component.panelId,
      position: built.position ?? this.component.position,
      activationKey: built.activationKey ?? this.component.activationKey,
      visibleByDefault: built.visibleByDefault ?? this.component.visible,
    });

    this.builtSpec = spec;
    this.publishSpec(spec);
    this.registered = true;
  }
}
