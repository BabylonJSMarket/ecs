/**
 * @babylonjsmarket/ecs/viz — generic Solid-based debug-panel infrastructure.
 *
 * Lives in the ecs package so the EventBus debugger (which depends on it)
 * can also live here without arcade ↔ ecs circular imports. Renderer-agnostic
 * — works under any RendererAdapter, including the Mock one used by tests.
 *
 * The default toggle hotkeys are scoped per component; mount what you need
 * from your app's bootstrap (or via a higher-level helper like arcade's
 * mountArcadeViz).
 */
export { vizStore, installVizKeyboard, uninstallVizKeyboard } from './vizStore';
export type { PanelState, PanelConfig } from './vizStore';
export { VizPanel } from './VizPanel';
export type { VizPanelProps } from './VizPanel';
export { VizRoot, mountVizRoot, unmountVizRoot } from './VizRoot';

// Declarative panel-spec contract (the free "what to show"). viz-pro provides
// the renderer (the paid "how to show it").
export { definePanel } from './spec';
export type {
  PanelSpec,
  SectionSpec,
  ControlSpec,
  SliderSpec,
  ToggleSpec,
  NumberSpec,
  TextSpec,
  SelectSpec,
  SelectOption,
  ColorSpec,
  ButtonSpec,
  ProgressSpec,
  ReadoutSpec,
  ListSpec,
  ListColumn,
  GroupSpec,
  NoteSpec,
  Binding,
  PanelAnchor,
  RGB,
} from './spec';

// EventBus-decoupled panel registration: hosts emit specs, the dev-only viz
// layer renders them.
export { VizEvents } from './VizEvents';
export type { VizEventName } from './VizEvents';
export {
  PanelHostComponent,
  PanelHostSystem,
  type PanelHostInput,
} from './PanelHost';
export {
  EventBusDebuggerComponent,
  EventBusDebuggerSystem,
  EventBusDebuggerEvents,
  type EventBusDebuggerInput,
} from '../ECS/EventBus/EventBus.viz';
export {
  EventBusDebuggerPanel,
  type EventBusDebuggerPanelProps,
  type EventEntry,
  type EntityGroup,
} from '../ECS/EventBus/EventBus.panel';
