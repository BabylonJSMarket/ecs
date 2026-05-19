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
 * The detector itself is framework-agnostic: a piece of plumbing, no DOM, no
 * 3D lib. The World owns one and wires it into the EventBus and a Proxy
 * around the RendererAdapter. Dev builds construct it; prod builds skip it.
 */

export interface RaceWarning {
  kind: 'event' | 'adapter';
  key: string;
  sources: string[];
  message: string;
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
  private eventWarned = new Set<string>();
  private handleWarned = new Set<string>();
  private readonly onWarn: (msg: string) => void;

  /** Recent warnings (most recent last). Tests and the World use this for readouts. */
  readonly warnings: RaceWarning[] = [];

  constructor(options: RaceDetectorOptions = {}) {
    this.onWarn = options.onWarn ?? ((msg) => console.warn(msg));
  }

  /** Called by World at the top of each update(). Resets per-frame state. */
  beginFrame(): void {
    this.eventSources.clear();
    this.handleSources.clear();
    this.eventWarned.clear();
    this.handleWarned.clear();
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
