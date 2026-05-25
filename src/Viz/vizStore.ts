import { createStore, produce } from 'solid-js/store';
import type { JSX } from 'solid-js';

export interface PanelState {
  id: string;
  title: string;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /**
   * Docked to a screen edge (left/right) or free-floating (null). Docked
   * panels are laid out into a uniform-width column for that side and
   * resized together by the side handle; dragging a docked panel's title
   * toward the center breaks it back out to free-floating. Persisted.
   */
  dock: 'left' | 'right' | null;
  /**
   * True once the panel has an intentional placement — either the user moved
   * it or it was (auto-)arranged. Persisted. Panels that have never been
   * placed auto-arrange on first appearance so they land on screen instead of
   * piling up on their default anchor.
   */
  placed: boolean;
  /**
   * Stacking order. Higher renders on top. Bumped whenever a panel is shown
   * or interacted with (see `raisePanel`) and persisted to localStorage so
   * the last-accessed ordering survives a reload. On load the global counter
   * is advanced past any restored value so fresh raises still land on top.
   */
  z: number;
  titleColor?: string;
  /**
   * KeyboardEvent.code that toggles this panel (e.g. 'Digit5', 'F4',
   * 'Backquote'). Informational — the owning debugger still handles the
   * actual keydown; the menu UI reads this to show a shortcut badge.
   */
  activationKey?: string;
  /** Collapsed to just the title bar (body hidden). Persisted. */
  collapsed: boolean;
  /**
   * Optional manual height override for the docked layout, stored as a
   * fraction of the viewport height so it returns at the same ratio across
   * reloads and viewport sizes. Set by dragging a docked panel's bottom edge;
   * cleared (back to content-aware auto-fit) by double-clicking the handle.
   * Ignored while free-floating. Persisted.
   */
  heightRatio?: number;
  content: () => JSX.Element;
  /**
   * Optional compact element rendered in the header ONLY when collapsed —
   * a small subset of info/controls for the title-bar-only state. Omit for a
   * bare title bar (the default).
   */
  headerSummary?: () => JSX.Element;
  /**
   * Arbitrary user state for this panel — slider values, expanded sections,
   * etc. Persists to localStorage alongside position/size. Use the
   * `setPanelData` / `getPanelData` accessors instead of mutating directly.
   */
  data?: Record<string, unknown>;
  /**
   * Per-panel undo/redo of `data` (the panel's settings). Session-only, never
   * persisted. `past`/`future` hold full `data` snapshots; rapid changes
   * (e.g. a slider drag) coalesce into a single step.
   */
  history: { past: Array<Record<string, unknown>>; future: Array<Record<string, unknown>> };
}

interface VizState {
  sceneName: string;
  panels: Record<string, PanelState>;
  /** Uniform width of the left/right dock columns. Persisted per scene. */
  dockWidths: { left: number; right: number };
}

const DEFAULT_POSITIONS: Record<string, { x: number; y: number }> = {
  'top-left': { x: 10, y: 10 },
  'top-right': { x: -10, y: 10 },
  'bottom-left': { x: 10, y: -10 },
  'bottom-right': { x: -10, y: -10 },
};

const DEFAULT_WIDTH = 280;
const DEFAULT_HEIGHT = 400;

const [state, setState] = createStore<VizState>({
  sceneName: 'default',
  panels: {},
  dockWidths: { left: DEFAULT_WIDTH, right: DEFAULT_WIDTH },
});

function getStorageKey(id: string): string {
  return `viz-${state.sceneName}-${id}`;
}

function dockWidthsStorageKey(): string {
  return `viz-${state.sceneName}-dockwidths`;
}

function loadDockWidths(): void {
  let widths = { left: DEFAULT_WIDTH, right: DEFAULT_WIDTH };
  try {
    const saved = localStorage.getItem(dockWidthsStorageKey());
    if (saved) {
      const p = JSON.parse(saved) as Partial<{ left: number; right: number }>;
      widths = {
        left: typeof p.left === 'number' ? p.left : DEFAULT_WIDTH,
        right: typeof p.right === 'number' ? p.right : DEFAULT_WIDTH,
      };
    }
  } catch {
    // ignore
  }
  setState('dockWidths', widths);
}

function saveDockWidths(): void {
  try {
    localStorage.setItem(dockWidthsStorageKey(), JSON.stringify(state.dockWidths));
  } catch {
    // ignore
  }
}

function loadFromStorage(id: string): Partial<PanelState> | null {
  try {
    const saved = localStorage.getItem(getStorageKey(id));
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

function saveToStorage(id: string, panel: PanelState): void {
  try {
    const { content, headerSummary, history, ...serializable } = panel;
    void content;
    void headerSummary;
    void history;
    localStorage.setItem(getStorageKey(id), JSON.stringify(serializable));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Move `id` above every other panel, then renormalize all stacking ranks to
 * a compact 1..N sequence (preserving relative order) and persist them. This
 * keeps the saved z values small and stable across reloads instead of an
 * ever-increasing counter.
 */
function bringToFront(id: string): void {
  if (!state.panels[id]) return;
  const ordered = Object.values(state.panels)
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((p) => p.id)
    .filter((pid) => pid !== id);
  ordered.push(id); // target on top
  ordered.forEach((pid, i) => {
    const rank = i + 1;
    if (state.panels[pid].z !== rank) setState('panels', pid, 'z', rank);
    saveToStorage(pid, state.panels[pid]);
  });
}

// Default toggle keys, handed out in registration order to any panel that
// doesn't declare its own. Keeps the shortcut scheme consistent (F1..F9)
// instead of a grab-bag of digits/backquote/F-keys per component.
const F_KEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9'];

function allocActivationKey(excludeId: string): string {
  const used = new Set<string>();
  for (const id in state.panels) {
    if (id === excludeId) continue;
    const k = state.panels[id].activationKey;
    if (k) used.add(k);
  }
  for (const k of F_KEYS) {
    if (!used.has(k)) return k;
  }
  return '';
}

function isEditingText(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// Single global key handler for all panel toggles. Plain key (no modifiers)
// matching a panel's activationKey toggles it. Modifier combos are left for
// layout actions (e.g. the menu's Alt+Shift+A / Alt+Shift+H).
function handleVizKeydown(e: KeyboardEvent): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (isEditingText(e.target)) return;
  for (const id in state.panels) {
    const key = state.panels[id].activationKey;
    if (key && key === e.code) {
      e.preventDefault();
      vizStore.togglePanel(id);
      return;
    }
  }
}

let keyboardInstalled = false;

/** Install the single global toggle-key listener (called by mountVizRoot). */
export function installVizKeyboard(): void {
  if (keyboardInstalled || typeof window === 'undefined') return;
  window.addEventListener('keydown', handleVizKeydown);
  keyboardInstalled = true;
}

/** Remove the global toggle-key listener (called by unmountVizRoot). */
export function uninstallVizKeyboard(): void {
  if (!keyboardInstalled || typeof window === 'undefined') return;
  window.removeEventListener('keydown', handleVizKeydown);
  keyboardInstalled = false;
}

export type PanelConfig = Omit<PanelState, 'visible' | 'x' | 'y' | 'width' | 'height' | 'z' | 'collapsed' | 'history' | 'placed' | 'dock'> & Partial<PanelState>;

// ---- Docking ----
//
// Pre-dock geometry (per panel, session-only) so releasing a panel restores
// the free-floating size/position it had before it was docked.
const preDockGeom = new Map<string, { x: number; y: number; width: number; height: number }>();
const DOCK_GAP = 10;
const COLLAPSED_DOCK_H = 44;
const DOCK_MIN_EXPANDED_H = 80;

/**
 * Measured "natural" pixel height (header + unclipped content) per panel,
 * reported by VizPanel via `reportNaturalHeight`. Session-only; drives the
 * content-aware dock distribution so a short panel shrinks to its content and
 * the freed space flows to the panels that actually have more to show.
 */
const measuredNatural = new Map<string, number>();

/**
 * Max-min "water-fill" split of `pool` px across items each wanting
 * `desired[i]`: anyone asking for no more than the fair share gets exactly
 * their wish; whoever wants more splits the remainder equally (never below
 * `floor`). Short panels keep their content height; tall ones share the rest.
 * Exported for unit tests.
 */
export function waterFillHeights(desired: number[], pool: number, floor: number): number[] {
  const n = desired.length;
  const out = new Array<number>(n).fill(0);
  const settled = new Array<boolean>(n).fill(false);
  let remaining = pool;
  let open = n;
  let changed = true;
  while (changed && open > 0) {
    changed = false;
    const fair = remaining / open;
    for (let i = 0; i < n; i += 1) {
      if (settled[i] || desired[i] > fair) continue;
      out[i] = desired[i];
      settled[i] = true;
      remaining -= desired[i];
      open -= 1;
      changed = true;
    }
  }
  if (open > 0) {
    const share = Math.max(floor, remaining / open);
    for (let i = 0; i < n; i += 1) if (!settled[i]) out[i] = share;
  }
  return out;
}

/**
 * Lay every visible docked panel into its side's column: uniform width (the
 * side's dock width), stacked top→down. Heights are content-aware — each
 * expanded panel asks for its measured natural height (capped at the column),
 * short ones get exactly that, and the leftover is shared among the panels
 * that overflow (which then scroll behind an edge fade in VizPanel).
 */
function relayoutDocks(): void {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  for (const side of ['left', 'right'] as const) {
    // Order by current vertical position, NOT z — interacting with a docked
    // panel (e.g. clicking its collapse button) raises its z, and ordering by
    // z would then yank it to the bottom of the column. y is stable.
    const docked = Object.values(state.panels)
      .filter((p) => p.dock === side && p.visible)
      .sort((a, b) => a.y - b.y);
    if (docked.length === 0) continue;
    const width = state.dockWidths[side];
    const x = side === 'left' ? DOCK_GAP : -DOCK_GAP;
    const expandable = docked.filter((p) => !p.collapsed);
    const reserved = (docked.length - expandable.length) * COLLAPSED_DOCK_H;
    const pool = Math.max(0, vh - DOCK_GAP * (docked.length + 1) - reserved);
    const heights = new Map<string, number>();
    // Panels with a manual height ratio are pinned to that fraction of the
    // viewport; the rest water-fill whatever space is left around them.
    const fixed = expandable.filter((p) => typeof p.heightRatio === 'number');
    const flex = expandable.filter((p) => typeof p.heightRatio !== 'number');
    let fixedTotal = 0;
    for (const p of fixed) {
      const h = Math.round(
        Math.max(DOCK_MIN_EXPANDED_H, Math.min(pool, (p.heightRatio as number) * vh))
      );
      heights.set(p.id, h);
      fixedTotal += h;
    }
    const flexPool = Math.max(0, pool - fixedTotal);
    // Each flex panel wants its measured content height (fallback to its current
    // height before the first measurement lands), capped at the column.
    const desired = flex.map((p) =>
      Math.min(flexPool, Math.max(DOCK_MIN_EXPANDED_H, measuredNatural.get(p.id) ?? p.height))
    );
    const split = waterFillHeights(desired, flexPool, DOCK_MIN_EXPANDED_H);
    flex.forEach((p, i) => heights.set(p.id, Math.round(split[i])));
    let y = DOCK_GAP;
    for (const p of docked) {
      if (p.collapsed) {
        setState('panels', p.id, { x, y, width });
        y += COLLAPSED_DOCK_H + DOCK_GAP;
      } else {
        const h = heights.get(p.id) ?? DOCK_MIN_EXPANDED_H;
        setState('panels', p.id, { x, y, width, height: h });
        y += h + DOCK_GAP;
      }
      saveToStorage(p.id, state.panels[p.id]);
    }
  }
}

// A measurement-driven relayout, coalesced so a burst of content changes (e.g.
// streaming EventBus rows) triggers at most one relayout per window.
let dockRelayoutTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleDockRelayout(): void {
  if (typeof setTimeout === 'undefined') {
    relayoutDocks();
    return;
  }
  if (dockRelayoutTimer) return;
  dockRelayoutTimer = setTimeout(() => {
    dockRelayoutTimer = undefined;
    relayoutDocks();
  }, 120);
}

// ---- Per-panel settings undo/redo ----
//
// History snapshots live in the reactive panel state (so the header buttons
// can reactively enable/disable). Rapid `setPanelData` bursts (a slider drag)
// coalesce into ONE undo step via a short debounce: the first write in a burst
// snapshots the pre-change `data`; the window stays open until writes stop.
const HISTORY_LIMIT = 50;
const TXN_MS = 400;
const txnOpen = new Set<string>();
const txnTimers = new Map<string, ReturnType<typeof setTimeout>>();

function openHistoryTxn(id: string): void {
  if (!state.panels[id]) return;
  if (!txnOpen.has(id)) {
    const snapshot = { ...(state.panels[id].data ?? {}) };
    setState('panels', id, 'history', (h) => ({
      past: [...h.past, snapshot].slice(-HISTORY_LIMIT),
      future: [],
    }));
    txnOpen.add(id);
  }
  const prev = txnTimers.get(id);
  if (prev) clearTimeout(prev);
  if (typeof setTimeout !== 'undefined') {
    txnTimers.set(
      id,
      setTimeout(() => {
        txnOpen.delete(id);
        txnTimers.delete(id);
      }, TXN_MS)
    );
  }
}

function closeHistoryTxn(id: string): void {
  const prev = txnTimers.get(id);
  if (prev) clearTimeout(prev);
  txnTimers.delete(id);
  txnOpen.delete(id);
}

// ---- Layout: tile panels into two screen-fitting columns ----
function layoutIntoColumns(panels: PanelState[]): void {
  if (panels.length === 0) return;
  const gap = 10;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const columns: PanelState[][] = [[], []];
  panels.forEach((p, i) => columns[i % 2].push(p));
  columns.forEach((col, c) => {
    if (col.length === 0) return;
    // Negative x docks from the right edge (see VizPanel.getAbsolutePosition).
    const x = c === 0 ? gap : -gap;
    const slot = Math.max(80, Math.floor((vh - gap * (col.length + 1)) / col.length));
    let y = gap;
    for (const p of col) {
      const h = Math.min(p.height, slot);
      setState('panels', p.id, { x, y, height: h, placed: true });
      saveToStorage(p.id, state.panels[p.id]);
      y += h + gap;
    }
  });
}

// Auto-arrange any visible panel that has never been placed, so new/first-run
// panels land on screen instead of stacking on their default anchor. Debounced
// so a burst of registrations lays out together.
let autoArrangeTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleAutoArrange(): void {
  if (typeof setTimeout === 'undefined') return;
  if (autoArrangeTimer) clearTimeout(autoArrangeTimer);
  autoArrangeTimer = setTimeout(() => {
    autoArrangeTimer = undefined;
    // Auto-place only unplaced, free-floating panels; docked ones are laid
    // out by relayoutDocks.
    const targets = Object.values(state.panels)
      .filter((p) => p.visible && !p.placed && p.dock === null)
      .sort((a, b) => a.z - b.z);
    layoutIntoColumns(targets);
    relayoutDocks();
  }, 50);
}

export const vizStore = {
  get panels() {
    return state.panels;
  },

  get sceneName() {
    return state.sceneName;
  },

  setSceneName(name: string): void {
    setState('sceneName', name);
    loadDockWidths();
  },

  registerPanel(config: PanelConfig): void {
    const saved = loadFromStorage(config.id);
    const pos = DEFAULT_POSITIONS[config.position || 'top-right'];

    // Restore a persisted stacking rank so the last-accessed ordering
    // survives reloads; otherwise stack the newest panel on top. Ranks stay
    // compact (1..N) — `bringToFront` renormalizes them on every raise.
    const savedZ = typeof saved?.z === 'number' ? saved.z : undefined;
    const maxRank = Object.values(state.panels).reduce((m, p) => Math.max(m, p.z), 0);
    const z = savedZ ?? maxRank + 1;

    // Honor an explicitly-declared key (from viz data); otherwise hand out the
    // next free F-key so shortcuts stay consistent.
    const explicitKey = config.activationKey;
    const activationKey =
      explicitKey && explicitKey.length > 0 ? explicitKey : allocActivationKey(config.id);

    const panel: PanelState = {
      visible: false,
      collapsed: false,
      placed: false,
      dock: null,
      x: pos.x,
      y: pos.y,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      ...config,
      ...saved,
      // Fall back only if neither config nor saved specified a position.
      position: saved?.position ?? config.position ?? 'top-right',
      // Always use the new content / header functions (never persisted).
      content: config.content,
      headerSummary: config.headerSummary,
      // activationKey is code-defined, never user state — ignore any value
      // that leaked into localStorage and trust the current registration.
      activationKey,
      z,
      // History is session-only; always start empty (never restore from save).
      history: { past: [], future: [] },
    };

    setState('panels', config.id, panel);

    // Never placed → auto-arrange onto the screen once the registration burst
    // settles. A restored docked panel also needs a (debounced) relayout into
    // its column. scheduleAutoArrange does both.
    if (!panel.placed || panel.dock) scheduleAutoArrange();
  },

  unregisterPanel(id: string): void {
    measuredNatural.delete(id);
    setState(
      'panels',
      produce((panels) => {
        delete panels[id];
      })
    );
  },

  isVisible(id: string): boolean {
    return state.panels[id]?.visible ?? false;
  },

  showPanel(id: string): void {
    if (!state.panels[id]) return;
    setState('panels', id, 'visible', true);
    bringToFront(id);
    // A docked panel must reflow back into its column on show (it was filtered
    // out of the layout while hidden); otherwise it reappears at stale coords
    // and looks free-floating. Mirrors togglePanel's show branch.
    if (state.panels[id].dock) relayoutDocks();
    else if (!state.panels[id].placed) scheduleAutoArrange();
  },

  hidePanel(id: string): void {
    if (!state.panels[id]) return;
    const wasDocked = state.panels[id].dock !== null;
    setState('panels', id, 'visible', false);
    saveToStorage(id, state.panels[id]);
    if (wasDocked) relayoutDocks(); // reflow the column to fill the gap
  },

  togglePanel(id: string): void {
    if (!state.panels[id]) return;
    const newVisible = !state.panels[id].visible;
    setState('panels', id, 'visible', newVisible);
    if (newVisible) {
      bringToFront(id);
      if (state.panels[id].dock) relayoutDocks();
      else if (!state.panels[id].placed) scheduleAutoArrange();
    } else {
      saveToStorage(id, state.panels[id]);
      if (state.panels[id].dock) relayoutDocks();
    }
  },

  /**
   * Raise a panel above all others (newest interaction wins). Called when a
   * panel is shown and on mousedown anywhere inside it. Renormalizes ranks.
   */
  raisePanel(id: string): void {
    bringToFront(id);
  },

  isCollapsed(id: string): boolean {
    return state.panels[id]?.collapsed ?? false;
  },

  setCollapsed(id: string, collapsed: boolean): void {
    if (!state.panels[id]) return;
    setState('panels', id, 'collapsed', collapsed);
    saveToStorage(id, state.panels[id]);
    if (state.panels[id].dock) relayoutDocks(); // freed space → other panels
  },

  toggleCollapsed(id: string): void {
    if (!state.panels[id]) return;
    setState('panels', id, 'collapsed', !state.panels[id].collapsed);
    saveToStorage(id, state.panels[id]);
    if (state.panels[id].dock) relayoutDocks(); // freed space → other panels
  },

  /** Hide every registered panel. */
  hideAllPanels(): void {
    for (const id of Object.keys(state.panels)) {
      if (state.panels[id].visible) {
        setState('panels', id, 'visible', false);
        saveToStorage(id, state.panels[id]);
      }
    }
  },

  /** Show every registered panel. */
  showAllPanels(): void {
    for (const id of Object.keys(state.panels)) {
      if (!state.panels[id].visible) {
        setState('panels', id, 'visible', true);
        saveToStorage(id, state.panels[id]);
      }
    }
    scheduleAutoArrange();
  },

  /**
   * Dock all visible panels alternating down the left and right edges so they
   * stop overlapping AND all stay on screen. Each column divides the viewport
   * height among its panels — a panel keeps its natural height when there's
   * room and shrinks to fit when the column is crowded, so none get pushed off
   * the bottom. Order follows current stacking (z), top-most last.
   */
  arrangePanels(): void {
    const visible = Object.values(state.panels)
      .filter((p) => p.visible)
      .sort((a, b) => a.z - b.z);
    layoutIntoColumns(visible);
  },

  // ---- Docking ----

  isDocked(id: string): boolean {
    return (state.panels[id]?.dock ?? null) !== null;
  },

  getDockWidth(side: 'left' | 'right'): number {
    return state.dockWidths[side];
  },

  /** Dock a panel to a side (saving its free geometry to restore later). */
  dockPanel(id: string, side: 'left' | 'right'): void {
    const p = state.panels[id];
    if (!p) return;
    if (p.dock === null) {
      preDockGeom.set(id, { x: p.x, y: p.y, width: p.width, height: p.height });
    }
    setState('panels', id, { dock: side, placed: true });
    relayoutDocks();
  },

  /**
   * Release a panel back to free-floating. Restores its pre-dock size; places
   * it at (x, y) when given (e.g. where it was dragged), else its prior spot.
   */
  undockPanel(id: string, x?: number, y?: number): void {
    if (!state.panels[id]) return;
    const prev = preDockGeom.get(id);
    preDockGeom.delete(id);
    const patch: Partial<PanelState> = { dock: null, placed: true };
    if (prev) {
      patch.width = prev.width;
      patch.height = prev.height;
    }
    patch.x = x ?? prev?.x ?? state.panels[id].x;
    patch.y = y ?? prev?.y ?? state.panels[id].y;
    setState('panels', id, patch);
    saveToStorage(id, state.panels[id]);
    relayoutDocks(); // reflow the column the panel left
  },

  /** Resize a dock column (uniform width for every panel docked to that side). */
  setDockWidth(side: 'left' | 'right', width: number): void {
    setState('dockWidths', side, Math.max(160, Math.min(900, Math.round(width))));
    saveDockWidths();
    relayoutDocks();
  },

  /**
   * Toggle "snap to docks". If any visible panel is free-floating, dock all of
   * them to whichever side they're nearest (uniform column width). If they're
   * all already docked, release them back to free-floating.
   */
  toggleArrange(): void {
    const visible = Object.values(state.panels).filter((p) => p.visible);
    if (visible.length === 0) return;
    const anyFree = visible.some((p) => p.dock === null);
    if (anyFree) {
      const iw = typeof window !== 'undefined' ? window.innerWidth : 1200;
      for (const p of visible) {
        if (p.dock !== null) continue;
        preDockGeom.set(p.id, { x: p.x, y: p.y, width: p.width, height: p.height });
        const left = p.x < 0 ? iw - p.width + p.x : p.x;
        const side = left + p.width / 2 < iw / 2 ? 'left' : 'right';
        setState('panels', p.id, { dock: side, placed: true });
      }
      relayoutDocks();
    } else {
      for (const p of visible) {
        const prev = preDockGeom.get(p.id);
        preDockGeom.delete(p.id);
        const patch: Partial<PanelState> = { dock: null };
        if (prev) {
          patch.x = prev.x;
          patch.y = prev.y;
          patch.width = prev.width;
          patch.height = prev.height;
        }
        setState('panels', p.id, patch);
        saveToStorage(p.id, state.panels[p.id]);
      }
    }
  },

  updatePosition(id: string, x: number, y: number): void {
    if (!state.panels[id]) return;
    // A manual move counts as an intentional placement.
    setState('panels', id, { x, y, placed: true });
    saveToStorage(id, state.panels[id]);
  },

  updateSize(id: string, width: number, height: number): void {
    if (!state.panels[id]) return;
    setState('panels', id, { width, height });
    saveToStorage(id, state.panels[id]);
  },

  /**
   * Report a panel's natural (unclipped) content-inclusive pixel height —
   * VizPanel measures it and calls this when content changes. Drives the
   * content-aware dock distribution; ignored for free-floating panels. Noisy
   * sub-pixel reports are filtered and relayouts are coalesced.
   */
  reportNaturalHeight(id: string, height: number): void {
    if (!state.panels[id]) return;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const h = Math.min(Math.round(height), vh);
    const prev = measuredNatural.get(id);
    if (prev !== undefined && Math.abs(prev - h) < 6) return;
    measuredNatural.set(id, h);
    if (state.panels[id].dock && state.panels[id].visible) scheduleDockRelayout();
  },

  /**
   * Pin a docked panel's height to a fraction of the viewport (manual override
   * of the auto-fit), reflowing the rest of the column around it. Persisted via
   * the relayout, so it returns at the same ratio on reload / resize.
   */
  setDockHeightRatio(id: string, ratio: number): void {
    if (!state.panels[id]) return;
    const clamped = Math.max(0.05, Math.min(0.95, ratio));
    setState('panels', id, 'heightRatio', clamped);
    relayoutDocks();
  },

  /** Drop a docked panel's manual height, returning it to content-aware auto-fit. */
  clearDockHeightRatio(id: string): void {
    if (!state.panels[id]?.heightRatio) return;
    setState('panels', id, 'heightRatio', undefined);
    saveToStorage(id, state.panels[id]);
    relayoutDocks();
  },

  /**
   * Read a persisted slider / dropdown / expanded-section value, with a
   * default if the panel has never written one. Returns the same type as
   * the default for callers that lean on inference.
   */
  getPanelData<T>(id: string, key: string, fallback: T): T {
    const panel = state.panels[id];
    if (!panel?.data) return fallback;
    const v = panel.data[key];
    return (v as T) ?? fallback;
  },

  /**
   * Persist an arbitrary panel value (slider, toggle, etc.) to localStorage
   * under the same `viz-{sceneName}-{id}` key as position/size. Reading
   * back via `getPanelData` is automatic on the next `registerPanel`.
   *
   * Records an (coalesced) undo step.
   */
  setPanelData(id: string, key: string, value: unknown): void {
    if (!state.panels[id]) return;
    openHistoryTxn(id);
    const data: Record<string, unknown> = { ...(state.panels[id].data ?? {}), [key]: value };
    setState('panels', id, 'data', data);
    saveToStorage(id, state.panels[id]);
  },

  /**
   * Set a panel value WITHOUT recording history — used to seed the baseline
   * (a control's initial value) so the first real change is undoable back to
   * it. No-op if the key already has a value.
   */
  seedPanelData(id: string, key: string, value: unknown): void {
    if (!state.panels[id]) return;
    const existing = state.panels[id].data;
    if (existing && existing[key] !== undefined) return;
    const data: Record<string, unknown> = { ...(existing ?? {}), [key]: value };
    setState('panels', id, 'data', data);
    saveToStorage(id, state.panels[id]);
  },

  canUndo(id: string): boolean {
    return (state.panels[id]?.history.past.length ?? 0) > 0;
  },

  canRedo(id: string): boolean {
    return (state.panels[id]?.history.future.length ?? 0) > 0;
  },

  /** Restore the panel's settings to the previous snapshot. */
  undo(id: string): void {
    if (!state.panels[id]) return;
    closeHistoryTxn(id); // make any in-progress burst a single undoable step
    const h = state.panels[id].history;
    if (h.past.length === 0) return;
    const current = { ...(state.panels[id].data ?? {}) };
    const prev = h.past[h.past.length - 1];
    setState('panels', id, 'history', (hh) => ({
      past: hh.past.slice(0, -1),
      future: [...hh.future, current].slice(-HISTORY_LIMIT),
    }));
    setState('panels', id, 'data', { ...prev });
    saveToStorage(id, state.panels[id]);
  },

  /** Re-apply the settings change that was just undone. */
  redo(id: string): void {
    if (!state.panels[id]) return;
    closeHistoryTxn(id);
    const h = state.panels[id].history;
    if (h.future.length === 0) return;
    const current = { ...(state.panels[id].data ?? {}) };
    const next = h.future[h.future.length - 1];
    setState('panels', id, 'history', (hh) => ({
      past: [...hh.past, current].slice(-HISTORY_LIMIT),
      future: hh.future.slice(0, -1),
    }));
    setState('panels', id, 'data', { ...next });
    saveToStorage(id, state.panels[id]);
  },

  clear(): void {
    // Cancel any pending debounced work so it can't fire against a fresh set.
    if (autoArrangeTimer) {
      clearTimeout(autoArrangeTimer);
      autoArrangeTimer = undefined;
    }
    if (dockRelayoutTimer) {
      clearTimeout(dockRelayoutTimer);
      dockRelayoutTimer = undefined;
    }
    for (const t of txnTimers.values()) clearTimeout(t);
    txnTimers.clear();
    txnOpen.clear();
    preDockGeom.clear();
    measuredNatural.clear();
    // setState('panels', {}) would *merge* (a no-op) under Solid's store
    // semantics — delete each key so the registry is truly emptied.
    setState(
      'panels',
      produce((panels) => {
        for (const id of Object.keys(panels)) delete panels[id];
      })
    );
  },

  get dockWidths() {
    return state.dockWidths;
  },
};
