/**
 * RaceDetector — surfaces hidden conflicts between Systems.
 *
 * Two classes of race are tracked per frame:
 *
 *   1. Event races — two different Systems emit the same `(eventType, entityId)`
 *      in one frame. Even if "it only glitches every other frame" in the UI,
 *      the emission pattern is non-deterministic and must be fixed.
 *
 *   2. Adapter races — two different Systems call the same mutator on the
 *      same opaque renderer handle in one frame (e.g., both writing
 *      setMeshPosition to the same mesh). Last-writer-wins silently would
 *      hide intermittent flicker; we warn instead.
 *
 *   3. Component races — two different Systems write the same component field
 *      on the same entity in one frame (e.g., a mover and an animation system
 *      both setting `MeshPrimitive.position`). The event/adapter ledgers miss
 *      this whenever the write is a plain field assignment, not a bus emit or
 *      an adapter call — the exact "one component silently loses to another"
 *      class. Opt-in (`detectComponentRaces`) since it snapshots + diffs each
 *      tracked entity around every System's onUpdate, which isn't free.
 *
 * The detector itself is framework-agnostic: a piece of plumbing, no DOM, no
 * 3D lib. The World owns one and wires it into the EventBus and a Proxy
 * around the RendererAdapter. Dev builds construct it; prod builds skip it.
 */

export interface RaceWarning {
  kind: 'event' | 'adapter' | 'component';
  key: string;
  sources: string[];
  message: string;
}

/**
 * Minimal shape the component-race snapshot needs — an entity whose components
 * serialize to plain data. Structural (not an `Entity` import) so the detector
 * stays decoupled and trivially testable.
 */
export interface TrackableEntity {
  id: string;
  getComponents(): Array<{ constructor: { name: string }; toJSON(): Record<string, unknown> }>;
}

/** Per-field serialized value, keyed field → stable string. */
type FieldMap = Map<string, string>;
/** entityId → componentName → field snapshot, captured before a System runs. */
export type ComponentSnapshot = Map<string, Map<string, FieldMap>>;

/** Stable per-field string for equality; never throws on a weird value. */
function stableField(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return String(value);
  }
}

/** Serialize a component to a field → stable-string map for cheap diffing. */
function fieldsOf(c: { toJSON(): Record<string, unknown> }): FieldMap {
  const out: FieldMap = new Map();
  const json = c.toJSON();
  for (const k in json) out.set(k, stableField(json[k]));
  return out;
}

export interface RaceDetectorOptions {
  /** Called on every warning. Defaults to console.warn. */
  onWarn?(message: string): void;
}

/** Tag used when an emit/write happens outside any System.update context. */
export const EXTERNAL_SOURCE = '<external>';

export class RaceDetector {
  private currentSystem: string | null = null;
  private eventSources = new Map<string, Set<string>>();
  private handleSources = new Map<string, Set<string>>();
  private componentSources = new Map<string, Set<string>>();
  private eventWarned = new Set<string>();
  private handleWarned = new Set<string>();
  private componentWarned = new Set<string>();
  private readonly onWarn: (msg: string) => void;

  /**
   * Opt-in component-field race detection. Off by default (even in dev): when
   * on, every System's onUpdate is bracketed by a snapshot + diff of its query
   * entities, which is measurable on entity-heavy systems. Flip via the World's
   * `detectComponentRaces` option while chasing a "component silently loses" bug.
   */
  componentTracking = false;

  /** Recent warnings (most recent last). Tests and the World use this for readouts. */
  readonly warnings: RaceWarning[] = [];

  constructor(options: RaceDetectorOptions = {}) {
    this.onWarn = options.onWarn ?? ((msg) => console.warn(msg));
  }

  /** Called by World at the top of each update(). Resets per-frame state. */
  beginFrame(): void {
    this.eventSources.clear();
    this.handleSources.clear();
    this.componentSources.clear();
    this.eventWarned.clear();
    this.handleWarned.clear();
    this.componentWarned.clear();
  }

  /** Called by System.update() wrapper. Pass null when the System is done. */
  setCurrentSystem(name: string | null): void {
    this.currentSystem = name;
  }

  getCurrentSystem(): string | null {
    return this.currentSystem;
  }

  /** Called by the EventBus on every emit. Ignores events without an entityId. */
  recordEvent(type: string, data: unknown): void {
    const entityId = (data as { entityId?: unknown } | null | undefined)?.entityId;
    if (entityId === undefined || entityId === null) return;

    const key = `${type}:${String(entityId)}`;
    const src = this.currentSystem ?? EXTERNAL_SOURCE;
    const set = this.eventSources.get(key) ?? new Set<string>();

    if (set.size >= 1 && !set.has(src) && !this.eventWarned.has(key)) {
      const sources = [...set, src];
      this.emitWarning({
        kind: 'event',
        key,
        sources,
        message:
          `[ArcadeECS race] Event race in frame: "${type}" for entity "${String(entityId)}" ` +
          `was emitted by multiple systems [${sources.join(', ')}]. ` +
          `Two systems writing the same data last-wins non-deterministically. ` +
          `Restructure so only one system owns this event.`,
      });
      this.eventWarned.add(key);
    }

    set.add(src);
    this.eventSources.set(key, set);
  }

  /**
   * Called by the race-tracking Proxy around the RendererAdapter.
   * @param handleId - stable id extracted from the handle object
   * @param method   - adapter method name (e.g., "setMeshPosition")
   */
  recordHandleWrite(handleId: string, method: string): void {
    const key = `${handleId}:${method}`;
    const src = this.currentSystem ?? EXTERNAL_SOURCE;
    const set = this.handleSources.get(key) ?? new Set<string>();

    if (set.size >= 1 && !set.has(src) && !this.handleWarned.has(key)) {
      const sources = [...set, src];
      this.emitWarning({
        kind: 'adapter',
        key,
        sources,
        message:
          `[ArcadeECS race] Adapter race in frame: "${method}" on handle "${handleId}" ` +
          `was called by multiple systems [${sources.join(', ')}]. ` +
          `The last call wins silently — visible as intermittent flicker. ` +
          `Route the mutation through a single owning system.`,
      });
      this.handleWarned.add(key);
    }

    set.add(src);
    this.handleSources.set(key, set);
  }

  /**
   * Capture the serialized fields of every component on `entities`, for the
   * component-race diff. Cheap no-op (empty map) unless `componentTracking` is
   * on, so System.update can call it unconditionally. Called just before a
   * System's onUpdate.
   */
  snapshotComponents(entities: Iterable<TrackableEntity>): ComponentSnapshot {
    const snap: ComponentSnapshot = new Map();
    if (!this.componentTracking) return snap;
    for (const e of entities) {
      const comps = new Map<string, FieldMap>();
      for (const c of e.getComponents()) comps.set(c.constructor.name, fieldsOf(c));
      snap.set(e.id, comps);
    }
    return snap;
  }

  /**
   * Diff `entities` against a `snapshotComponents` result taken before the
   * System ran; every field whose serialized value changed is credited to
   * `systemName`. A second distinct system writing the same field this frame
   * warns. Called in System.update's finally, before clearing the current system.
   */
  diffComponents(
    entities: Iterable<TrackableEntity>,
    snapshot: ComponentSnapshot,
    systemName: string,
  ): void {
    if (!this.componentTracking) return;
    for (const e of entities) {
      const before = snapshot.get(e.id);
      for (const c of e.getComponents()) {
        const name = c.constructor.name;
        const prev = before?.get(name);
        const now = fieldsOf(c);
        for (const [field, value] of now) {
          // A field the snapshot didn't have (component added mid-update) isn't
          // a race — only a value that existed and changed counts.
          if (prev && prev.has(field) && prev.get(field) !== value) {
            this.recordComponentWrite(e.id, name, field, systemName);
          }
        }
      }
    }
  }

  /** Credit one component-field write to a system; warn on the 2nd distinct writer this frame. */
  recordComponentWrite(entityId: string, component: string, field: string, source: string): void {
    const key = `${entityId}:${component}.${field}`;
    const src = source || EXTERNAL_SOURCE;
    const set = this.componentSources.get(key) ?? new Set<string>();

    if (set.size >= 1 && !set.has(src) && !this.componentWarned.has(key)) {
      const sources = [...set, src];
      this.emitWarning({
        kind: 'component',
        key,
        sources,
        message:
          `[ArcadeECS race] Component race in frame: "${component}.${field}" on entity "${entityId}" ` +
          `was written by multiple systems [${sources.join(', ')}]. ` +
          `The last write wins silently — one system's change is lost every frame. ` +
          `Give a single system ownership of this field.`,
      });
      this.componentWarned.add(key);
    }

    set.add(src);
    this.componentSources.set(key, set);
  }

  /** Reset everything (frame state + warning log). Used by tests. */
  reset(): void {
    this.beginFrame();
    this.currentSystem = null;
    this.warnings.length = 0;
  }

  private emitWarning(warning: RaceWarning): void {
    this.warnings.push(warning);
    this.onWarn(warning.message);
  }
}
