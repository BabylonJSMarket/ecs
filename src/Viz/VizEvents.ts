/**
 * Canonical EventBus names for the decoupled debug-viz protocol.
 *
 * A spec author (an arcade component's debugger, a game-local panel) builds a
 * declarative `PanelSpec` and emits `PANEL_REGISTERED` on the world's bus; the
 * dev-only viz-pro layer (`mountVizPro`) subscribes and renders it. Neither
 * side imports the other — the bus is the only contract. In a production build
 * nothing mounts viz-pro, so these emits land on no listener (a cheap no-op)
 * and the panels simply don't render.
 *
 * Import this const everywhere — never hardcode the string literals (a synonym
 * silently breaks the bus). Names are past-tense state changes per house style.
 */
export const VizEvents = {
  /** A panel host built/rebuilt its spec. Payload: `{ spec: PanelSpec }`. Use `emit`, never `emitChanged` (the spec carries closures). */
  PANEL_REGISTERED: 'viz.panel.registered',
  /** A panel host detached. Payload: `{ id: string }`. */
  PANEL_UNREGISTERED: 'viz.panel.unregistered',
  /** The viz layer finished subscribing. Hosts that already built re-emit their spec so registration is order-independent. Payload: `{}`. */
  HOST_READY: 'viz.host.ready',
} as const;

export type VizEventName = (typeof VizEvents)[keyof typeof VizEvents];
