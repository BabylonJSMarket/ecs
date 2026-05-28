/**
 * EventBus.viz.tsx — debug Component + System for the EventBus, ported from
 * CodeLibrary. Lives in `@babylonjsmarket/ecs/viz` so any project using the
 * ecs package (arcade or otherwise) can mount it without porting the code.
 *
 * Ships as source (.viz.tsx) — downstream Vite + the Solid plugin compile it
 * at build time. Not JSON-declarable; mount it imperatively from app code
 * (or via a higher-level helper like arcade's mountArcadeViz).
 *
 * Toggle hotkey: F4 by default.
 */

import { createSignal } from 'solid-js';
// Import the public Component/System/EventBus classes through the package
// root so the SAME identity is used whether downstream resolves them via the
// dist build (most apps) or the source tree (tests inside this package).
// Without this, the .viz.tsx (src) would extend Component-from-src while
// World/Entity (dist) reference Component-from-dist, and instanceof fails.
import { Component, System } from '@babylonjsmarket/ecs';
import type { EventBus, Entity } from '@babylonjsmarket/ecs';
import { vizStore } from '../../Viz/vizStore';
import {
  EventBusDebuggerPanel,
  type EventEntry,
  type EntityGroup,
} from './EventBus.panel';

export interface EventBusDebuggerInput {
  visible?: boolean;
  maxEvents?: number;
  excludeEvents?: string[];
  activationKey?: string;
}

export class EventBusDebuggerComponent extends Component {
  visible: boolean;
  maxEvents: number;
  excludeEvents: string[];
  activationKey: string;

  constructor(data: EventBusDebuggerInput = {}) {
    super();
    this.visible = data.visible ?? false;
    this.maxEvents = data.maxEvents ?? 100;
    // Empty = let the viz layer assign a consistent F-key. Set a value here
    // (or in scene data) only to pin a specific key.
    this.activationKey = data.activationKey ?? '';
    // Default to hiding the debug-tooling chatter (this panel, the state
    // stepper, playback transport, per-frame engine ticks) so only gameplay
    // events show. Callers can override with their own list.
    this.excludeEvents = data.excludeEvents ?? [
      'eventbusdebugger.',
      'statestepper.',
      'playback.',
      'world.update.',
    ];
  }

  serialize(): EventBusDebuggerInput {
    return {
      visible: this.visible,
      maxEvents: this.maxEvents,
      excludeEvents: [...this.excludeEvents],
      activationKey: this.activationKey,
    };
  }
}

export const EventBusDebuggerEvents = {
  SHOWN: 'eventbusdebugger.shown',
  HIDDEN: 'eventbusdebugger.hidden',
  PAUSED: 'eventbusdebugger.paused',
  RESUMED: 'eventbusdebugger.resumed',
  CLEARED: 'eventbusdebugger.cleared',
} as const;

export class EventBusDebuggerSystem extends System {
  private eventUnsubscribes: (() => void)[] = [];
  private component: EventBusDebuggerComponent | null = null;
  // We no longer subscribe to '*' — any wildcard subscriber forces every emit
  // off the bus's fast path. Instead the bus has its own opt-in ring buffer
  // (EventBus.enableRecording); we drive it on/off with panel visibility and
  // drain new entries on a low-frequency poll. The targeted listeners
  // (entity.removed) stay on always — they're cheap and routed by event name.
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastReadSeq = 0;
  /** Ring-buffer capacity at the bus while the panel is recording. */
  private readonly RECORD_CAPACITY = 1024;
  /** Drain cadence — the panel UI refreshes about 5×/s, plenty for debugging. */
  private readonly POLL_MS = 200;

  private readonly STORAGE_KEY = 'arcade-ebd-expanded';
  private readonly PANEL_ID = 'eventbus-debugger';

  private filter = createSignal('');
  private paused = createSignal(false);
  private entityGroups = createSignal(new Map<string, EntityGroup>());
  private expandedEntities = createSignal(new Set<string>());
  private expandedEvents = createSignal(new Set<string>());
  private flashingEntities = createSignal(new Set<string>());
  private flashingEvents = createSignal(new Set<string>());

  constructor(eventBus: EventBus) {
    super(eventBus);
    this.query = { required: [EventBusDebuggerComponent] };
  }

  protected onInitialize(): void {
    this.loadExpandedState();
    // onEntityAdded may already have wired things up if the debugger entity
    // existed before world.initialize() ran. Don't re-subscribe in that case
    // or we'll log every event twice.
    if (!this.component) {
      for (const entity of this.entities) {
        const comp = entity.get(EventBusDebuggerComponent);
        if (comp) {
          this.component = comp;
          this.setupEventListeners(comp);
          this.registerPanel();
          break;
        }
      }
    }
  }

  protected onEntityAdded(entity: Entity): void {
    const comp = entity.get(EventBusDebuggerComponent);
    if (comp && !this.component) {
      this.component = comp;
      this.setupEventListeners(comp);
      this.registerPanel();
    }
  }

  protected onEntityRemoved(entity: Entity): void {
    const comp = entity.get(EventBusDebuggerComponent);
    if (comp === this.component) {
      vizStore.unregisterPanel(this.PANEL_ID);
      this.stopRecording();
      this.eventUnsubscribes.forEach((u) => u());
      this.eventUnsubscribes = [];
      this.component = null;
    }
  }

  protected onUpdate(_deltaTime: number): void {
    if (!this.component) return;
    const panelVisible = vizStore.isVisible(this.PANEL_ID);
    if (panelVisible !== this.component.visible) {
      this.component.visible = panelVisible;
      this.eventBus.emit(
        panelVisible ? EventBusDebuggerEvents.SHOWN : EventBusDebuggerEvents.HIDDEN,
        {},
      );
    }
    // Gate bus-side recording on visibility (visibility IS the toggle):
    // hidden → recording off → bus stays on its fast path → zero overhead at
    // high event volumes. Showing the panel turns recording back on and the
    // poll drains new events; the buffer starts empty from that moment,
    // which is the right semantics for a debug tool you reach for on demand.
    if (panelVisible) this.startRecording();
    else this.stopRecording();
  }

  protected onShutdown(): void {
    vizStore.unregisterPanel(this.PANEL_ID);
    this.stopRecording();
    this.eventUnsubscribes.forEach((u) => u());
    this.eventUnsubscribes = [];
  }

  private setupEventListeners(_comp: EventBusDebuggerComponent): void {
    // Only the targeted listeners go here — the wildcard '*' lives behind
    // subscribeWildcard() so it's added/removed with panel visibility.
    const removedUnsub = this.eventBus.on(
      'world.entity.removed',
      (data: { entityId?: string }) => {
        const id = data?.entityId;
        if (!id) return;
        const next = new Map(this.entityGroups[0]());
        next.delete(id);
        this.entityGroups[1](next);
      },
    );
    this.eventUnsubscribes.push(removedUnsub);
  }

  private startRecording(): void {
    if (this.pollTimer !== null) return;
    this.eventBus.enableRecording(this.RECORD_CAPACITY);
    // Skip whatever's already in the buffer — fresh tail from "now."
    const recent = this.eventBus.getRecentEvents(0);
    this.lastReadSeq = recent.length > 0 ? recent[recent.length - 1].seq : 0;
    this.pollTimer = setInterval(() => this.drainRecording(), this.POLL_MS);
  }

  private stopRecording(): void {
    if (this.pollTimer === null) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.eventBus.disableRecording();
    this.lastReadSeq = 0;
  }

  private drainRecording(): void {
    if (this.paused[0]() || !this.component) return;
    const events = this.eventBus.getRecentEvents(this.lastReadSeq);
    if (events.length === 0) return;
    const excludes = this.component.excludeEvents;
    for (const ev of events) {
      let excluded = false;
      for (const ex of excludes) {
        if (ev.type.startsWith(ex)) { excluded = true; break; }
      }
      if (!excluded) this.logEvent(ev.type, ev.data);
    }
    this.lastReadSeq = events[events.length - 1].seq;
  }

  private logEvent(eventType: string, data: unknown): void {
    const now = performance.now();
    const d = data as { entityId?: string; entity?: { id?: string } | string } | null;
    const entityId =
      d?.entityId ??
      (typeof d?.entity === 'string'
        ? d?.entity
        : (d?.entity as { id?: string } | undefined)?.id) ??
      'Global';

    // Skip internal/debug entities (the convention is a `__` id prefix, e.g.
    // `__debugger`, `__state-stepper`) — the panel is for gameplay entities.
    if (entityId.startsWith('__')) return;

    this.triggerFlash(entityId, eventType);

    const next = new Map(this.entityGroups[0]());
    const existingGroup = next.get(entityId);
    const existingEntry = existingGroup?.events.get(eventType);

    const newEntry: EventEntry = existingEntry
      ? { ...existingEntry, lastTimestamp: now, data: this.sanitizeData(data) }
      : {
          timestamp: now,
          lastTimestamp: now,
          event: eventType,
          data: this.sanitizeData(data),
          entityId,
        };

    const newEvents = new Map(existingGroup?.events ?? []);
    newEvents.set(eventType, newEntry);

    next.set(entityId, { entityId, events: newEvents, lastEventTime: now });
    this.entityGroups[1](next);
  }

  private triggerFlash(entityId: string, eventType: string): void {
    const ent = new Set(this.flashingEntities[0]());
    ent.add(entityId);
    this.flashingEntities[1](ent);

    const eventKey = `${entityId}:${eventType}`;
    const evt = new Set(this.flashingEvents[0]());
    evt.add(eventKey);
    this.flashingEvents[1](evt);

    setTimeout(() => {
      const e1 = new Set(this.flashingEntities[0]());
      e1.delete(entityId);
      this.flashingEntities[1](e1);
      const e2 = new Set(this.flashingEvents[0]());
      e2.delete(eventKey);
      this.flashingEvents[1](e2);
    }, 150);
  }

  private sanitizeData(data: unknown): unknown {
    if (data === undefined || data === null) return null;
    try {
      const seen = new WeakSet<object>();
      return JSON.parse(
        JSON.stringify(data, (_key, value) => {
          if (typeof value === 'function') return undefined;
          if (value && typeof value === 'object') {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
            const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
            if (ctor && ctor !== 'Object' && ctor !== 'Array') {
              return `[${ctor}]`;
            }
          }
          return value;
        }),
      );
    } catch {
      return '[Complex Object]';
    }
  }

  private registerPanel(): void {
    if (!this.component) return;
    vizStore.registerPanel({
      id: this.PANEL_ID,
      title: 'EventBus',
      width: 400,
      position: 'top-right',
      titleColor: '#4a9eff',
      activationKey: this.component.activationKey,
      // Default visibility; persisted state wins on reload.
      visible: this.component.visible,
      content: () => (
        <EventBusDebuggerPanel
          filter={this.filter[0]}
          setFilter={this.filter[1]}
          paused={this.paused[0]}
          togglePause={() => {
            const next = !this.paused[0]();
            this.paused[1](next);
            this.eventBus.emit(
              next ? EventBusDebuggerEvents.PAUSED : EventBusDebuggerEvents.RESUMED,
              {},
            );
          }}
          clear={() => {
            this.entityGroups[1](new Map());
            this.eventBus.emit(EventBusDebuggerEvents.CLEARED, {});
          }}
          entityGroups={this.entityGroups[0]}
          expandedEntities={this.expandedEntities[0]}
          toggleEntity={(entityId) => this.toggleEntityExpanded(entityId)}
          expandedEvents={this.expandedEvents[0]}
          toggleEvent={(entityId, eventType) =>
            this.toggleEventExpanded(entityId, eventType)
          }
          flashingEntities={this.flashingEntities[0]}
          flashingEvents={this.flashingEvents[0]}
        />
      ),
    });
    // Visibility comes from registerPanel (default above, persisted state
    // wins). onUpdate reconciles component.visible and emits SHOWN/HIDDEN.
  }

  private toggleEntityExpanded(entityId: string): void {
    const next = new Set(this.expandedEntities[0]());
    next.has(entityId) ? next.delete(entityId) : next.add(entityId);
    this.expandedEntities[1](next);
    this.saveExpandedState();
  }

  private toggleEventExpanded(entityId: string, eventType: string): void {
    const key = `${entityId}:${eventType}`;
    const next = new Set(this.expandedEvents[0]());
    next.has(key) ? next.delete(key) : next.add(key);
    this.expandedEvents[1](next);
    this.saveExpandedState();
  }

  private loadExpandedState(): void {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (!stored) return;
      const data = JSON.parse(stored) as { entities?: string[]; events?: string[] };
      if (data.entities) this.expandedEntities[1](new Set(data.entities));
      if (data.events) this.expandedEvents[1](new Set(data.events));
    } catch {
      // Ignore
    }
  }

  private saveExpandedState(): void {
    try {
      localStorage.setItem(
        this.STORAGE_KEY,
        JSON.stringify({
          entities: [...this.expandedEntities[0]()],
          events: [...this.expandedEvents[0]()],
        }),
      );
    } catch {
      // Ignore
    }
  }
}
