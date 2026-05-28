/**
 * Pure declarative panel spec. Framework- and renderer-agnostic — the same
 * spec can be rendered by a Solid adapter (viz-pro's PanelRenderer), serialized
 * to JSON, or inspected for tooling/screenshots without ever touching the DOM.
 *
 * Lives in the FREE ecs/viz layer so any package can BUILD a spec (arcade
 * components, games) with only an ecs dependency and emit it on the EventBus;
 * the (private, dev-only) viz-pro layer subscribes and renders it. That keeps
 * arcade ↔ viz-pro decoupled — neither imports the other.
 *
 * A `PanelSpec` is *what* the panel shows; `Binding<T>` is the live read/write
 * channel to game state. Bindings are not serializable on purpose — they
 * carry closures over component instances or world queries — but everything
 * else in the spec is plain data.
 */

import type { JSX } from 'solid-js';

export type PanelAnchor =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

/**
 * Live read/write channel for a control. `set` is optional for read-only
 * controls (readout, progress, list). `persist` opts into localStorage round-
 * tripping via `vizStore.{get,set}PanelData` — the renderer seeds the value
 * on mount and writes through on every `set`.
 */
export interface Binding<T> {
  get: () => T;
  set?: (value: T) => void;
  persist?: string;
}

export interface SliderSpec {
  kind: 'slider';
  label: string;
  min: number;
  max: number;
  step?: number;
  bind: Binding<number>;
  /** Fires once on slider release. Use for expensive commits (e.g. physics rebuild). */
  onCommit?: () => void;
  /** Optional helper line shown below the slider. */
  help?: string;
  /**
   * Poll `bind.get()` on this cadence (ms) so the thumb tracks state changed
   * elsewhere (e.g. a recording playhead advancing). Omit for static bindings.
   * The poll never calls `bind.set`, so it won't fight the user's drag.
   */
  pollMs?: number;
}

export interface ToggleSpec {
  kind: 'toggle';
  label: string;
  bind: Binding<boolean>;
  help?: string;
}

export interface NumberSpec {
  kind: 'number';
  label: string;
  min?: number;
  max?: number;
  step?: number;
  bind: Binding<number>;
}

export interface TextSpec {
  kind: 'text';
  label: string;
  placeholder?: string;
  bind: Binding<string>;
}

export interface SelectOption<T extends string | number = string> {
  label: string;
  value: T;
}

export interface SelectSpec<T extends string | number = string> {
  kind: 'select';
  label: string;
  options: SelectOption<T>[];
  bind: Binding<T>;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface ColorSpec {
  kind: 'color';
  label: string;
  bind: Binding<RGB>;
}

export interface ButtonSpec {
  kind: 'button';
  label: string;
  onClick: () => void;
  variant?: 'default' | 'primary' | 'danger';
}

export interface ProgressSpec {
  kind: 'progress';
  label: string;
  min: number;
  max: number;
  bind: Binding<number>;
  /** Optional color stops [ratio, color] used to tint the bar. */
  colorStops?: [number, string][];
}

export interface ReadoutSpec {
  kind: 'readout';
  label: string;
  bind: Binding<string | number>;
}

export interface ListColumn<Row> {
  /** Column header text. Pass empty string to skip header. */
  header?: string;
  /** Cell renderer — returns the string to display for `row`. */
  cell: (row: Row) => string;
  /** Optional CSS color for the cell text (also receives the row). */
  color?: (row: Row) => string | undefined;
  /** CSS width hint, e.g. '60px' or '40%'. */
  width?: string;
}

export interface ListSpec<Row = unknown> {
  kind: 'list';
  label?: string;
  bind: Binding<Row[]>;
  columns: ListColumn<Row>[];
  /** Max body height before scrolling kicks in. Defaults to 180. */
  maxHeight?: number;
  /** Optional poll cadence (ms) to refresh the list. */
  pollMs?: number;
}

export interface GroupSpec {
  kind: 'group';
  controls: ControlSpec[];
  /** When true (default), children render in a horizontal row. */
  inline?: boolean;
}

export interface NoteSpec {
  kind: 'note';
  text: string;
}

export type ControlSpec =
  | SliderSpec
  | ToggleSpec
  | NumberSpec
  | TextSpec
  | SelectSpec
  | ColorSpec
  | ButtonSpec
  | ProgressSpec
  | ReadoutSpec
  | ListSpec
  | GroupSpec
  | NoteSpec;

export interface SectionSpec {
  /** Heading text. Omit for an untitled section (controls only). */
  title?: string;
  /** When true, the section can be expanded/collapsed via its header. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  controls: ControlSpec[];
}

export interface PanelSpec {
  id: string;
  title: string;
  /** Per-panel accent color override. The theme provides a default. */
  titleColor?: string;
  position?: PanelAnchor;
  width?: number;
  height?: number;
  /** Keyboard code (e.g. 'Digit5') that toggles visibility. */
  activationKey?: string;
  /** Initial visibility. Persisted state in vizStore wins on re-mount. */
  visibleByDefault?: boolean;
  /**
   * Optional compact element shown in the title bar ONLY when the panel is
   * collapsed. Omit for a bare title bar (the default).
   */
  headerSummary?: () => JSX.Element;
  sections: SectionSpec[];
}

/**
 * Identity helper that gives spec authors type inference and a single place
 * to evolve the contract (e.g. validation, defaults) without changing every
 * call site.
 */
export function definePanel(spec: PanelSpec): PanelSpec {
  return spec;
}
