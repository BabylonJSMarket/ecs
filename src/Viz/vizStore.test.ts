/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  vizStore,
  waterFillHeights,
  installVizKeyboard,
  uninstallVizKeyboard,
} from './vizStore';

describe('waterFillHeights', () => {
  it('gives everyone their wish when the pool has room to spare', () => {
    expect(waterFillHeights([100, 120], 400, 80)).toEqual([100, 120]);
  });

  it('lets a short panel keep its content height and hands the rest to the tall one', () => {
    // Short asks 50, tall asks 1000, pool 400 → short keeps 50, tall gets 350.
    expect(waterFillHeights([50, 1000], 400, 80)).toEqual([50, 350]);
  });

  it('splits the pool evenly between two panels that both overflow', () => {
    expect(waterFillHeights([1000, 1000], 400, 80)).toEqual([200, 200]);
  });

  it('water-fills in multiple levels (one short, two tall share the remainder)', () => {
    // 80 settles first; 320 left between the two tall ones → 160 each.
    expect(waterFillHeights([80, 600, 600], 400, 80)).toEqual([80, 160, 160]);
  });

  it('never drops a forced split below the floor', () => {
    const out = waterFillHeights([1000, 1000], 100, 80);
    expect(out.every((h) => h >= 80)).toBe(true);
  });

  it('handles an empty column', () => {
    expect(waterFillHeights([], 400, 80)).toEqual([]);
  });
});

// ---- Shared helpers + global reset ----

const reg = (id: string, extra: Record<string, unknown> = {}) =>
  vizStore.registerPanel({
    id,
    title: id,
    position: 'top-left',
    content: () => null,
    ...extra,
  });

describe('docked manual height override', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
  });
  afterEach(() => vizStore.clear());

  const dockTwo = () => {
    for (const id of ['a', 'b']) {
      vizStore.registerPanel({ id, title: id, position: 'top-left', content: () => null });
      vizStore.showPanel(id);
      vizStore.dockPanel(id, 'left');
    }
  };

  it('pins a panel to its viewport ratio and reflows the rest around it', () => {
    dockTwo();
    vizStore.setDockHeightRatio('a', 0.25);
    expect(vizStore.panels['a'].heightRatio).toBe(0.25);
    expect(vizStore.panels['a'].height).toBe(Math.round(0.25 * window.innerHeight));
    // The unpinned panel still gets a real (flex) height beside it.
    expect(vizStore.panels['b'].height).toBeGreaterThanOrEqual(80);
    expect(vizStore.panels['b'].heightRatio).toBeUndefined();
  });

  it('clears the override back to content-aware auto-fit', () => {
    dockTwo();
    // a has little content, b has lots — once unpinned, a should shrink to its
    // content and b should absorb the freed space.
    vizStore.reportNaturalHeight('a', 100);
    vizStore.reportNaturalHeight('b', 1000);
    vizStore.setDockHeightRatio('a', 0.5);
    vizStore.clearDockHeightRatio('a');
    expect(vizStore.panels['a'].heightRatio).toBeUndefined();
    expect(vizStore.panels['a'].height).toBe(100); // fit to content
    expect(vizStore.panels['b'].height).toBeGreaterThan(vizStore.panels['a'].height);
  });
});

// ---- Registration, visibility, scene name ----

describe('registration & visibility', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
  });
  afterEach(() => vizStore.clear());

  it('registers with default geometry and hidden state', () => {
    reg('p');
    const p = vizStore.panels['p'];
    expect(p.visible).toBe(false);
    expect(p.collapsed).toBe(false);
    expect(p.placed).toBe(false);
    expect(p.dock).toBeNull();
    expect(p.width).toBe(280);
    expect(p.height).toBe(400);
    expect(p.history).toEqual({ past: [], future: [] });
  });

  it('allocates sequential F-keys when none declared', () => {
    reg('a');
    reg('b');
    reg('c');
    expect(vizStore.panels['a'].activationKey).toBe('F1');
    expect(vizStore.panels['b'].activationKey).toBe('F2');
    expect(vizStore.panels['c'].activationKey).toBe('F3');
  });

  it('honors an explicitly-declared activation key', () => {
    reg('x', { activationKey: 'Digit5' });
    expect(vizStore.panels['x'].activationKey).toBe('Digit5');
    // The next panel skips no F-keys (Digit5 isn't an F-key) → starts at F1.
    reg('y');
    expect(vizStore.panels['y'].activationKey).toBe('F1');
  });

  it('stacks a newly registered panel on top (higher z)', () => {
    reg('a');
    reg('b');
    expect(vizStore.panels['b'].z).toBeGreaterThan(vizStore.panels['a'].z);
  });

  it('defaults position to top-right when none given/saved', () => {
    vizStore.registerPanel({ id: 'q', title: 'q', content: () => null });
    expect(vizStore.panels['q'].position).toBe('top-right');
    // top-right default anchor.
    expect(vizStore.panels['q'].x).toBe(-10);
    expect(vizStore.panels['q'].y).toBe(10);
  });

  it('isVisible / showPanel / hidePanel', () => {
    reg('p');
    expect(vizStore.isVisible('p')).toBe(false);
    vizStore.showPanel('p');
    expect(vizStore.isVisible('p')).toBe(true);
    vizStore.hidePanel('p');
    expect(vizStore.isVisible('p')).toBe(false);
  });

  it('isVisible is false for unknown panels', () => {
    expect(vizStore.isVisible('nope')).toBe(false);
  });

  it('togglePanel flips visibility', () => {
    reg('p');
    vizStore.togglePanel('p');
    expect(vizStore.isVisible('p')).toBe(true);
    vizStore.togglePanel('p');
    expect(vizStore.isVisible('p')).toBe(false);
  });

  it('guards no-op on unknown ids', () => {
    expect(() => vizStore.showPanel('zz')).not.toThrow();
    expect(() => vizStore.hidePanel('zz')).not.toThrow();
    expect(() => vizStore.togglePanel('zz')).not.toThrow();
    expect(() => vizStore.updatePosition('zz', 1, 1)).not.toThrow();
    expect(() => vizStore.updateSize('zz', 1, 1)).not.toThrow();
    expect(() => vizStore.setCollapsed('zz', true)).not.toThrow();
    expect(() => vizStore.toggleCollapsed('zz')).not.toThrow();
    expect(() => vizStore.dockPanel('zz', 'left')).not.toThrow();
    expect(() => vizStore.undockPanel('zz')).not.toThrow();
    expect(() => vizStore.setDockHeightRatio('zz', 0.5)).not.toThrow();
    expect(() => vizStore.clearDockHeightRatio('zz')).not.toThrow();
    expect(() => vizStore.reportNaturalHeight('zz', 100)).not.toThrow();
    expect(() => vizStore.setPanelData('zz', 'k', 1)).not.toThrow();
    expect(() => vizStore.seedPanelData('zz', 'k', 1)).not.toThrow();
    expect(() => vizStore.undo('zz')).not.toThrow();
    expect(() => vizStore.redo('zz')).not.toThrow();
  });

  it('unregisterPanel removes the panel', () => {
    reg('p');
    expect(vizStore.panels['p']).toBeDefined();
    vizStore.unregisterPanel('p');
    expect(vizStore.panels['p']).toBeUndefined();
  });

  it('updatePosition marks placed and stores coords', () => {
    reg('p');
    vizStore.updatePosition('p', 50, 60);
    expect(vizStore.panels['p'].x).toBe(50);
    expect(vizStore.panels['p'].y).toBe(60);
    expect(vizStore.panels['p'].placed).toBe(true);
  });

  it('updateSize stores width/height', () => {
    reg('p');
    vizStore.updateSize('p', 333, 222);
    expect(vizStore.panels['p'].width).toBe(333);
    expect(vizStore.panels['p'].height).toBe(222);
  });

  it('setSceneName changes the scene and reloads dock widths', () => {
    vizStore.setSceneName('scene-b');
    expect(vizStore.sceneName).toBe('scene-b');
    expect(vizStore.dockWidths.left).toBe(280);
    expect(vizStore.dockWidths.right).toBe(280);
  });
});

// ---- z-ordering / raisePanel ----

describe('z-ordering', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
  });
  afterEach(() => vizStore.clear());

  it('raisePanel moves a panel above the others, renormalizing to 1..N', () => {
    reg('a');
    reg('b');
    reg('c');
    vizStore.raisePanel('a');
    const { a, b, c } = vizStore.panels;
    // a is now on top; ranks are a compact 1..3.
    expect(a.z).toBe(3);
    expect([b.z, c.z].sort()).toEqual([1, 2]);
  });

  it('raisePanel is a no-op for unknown ids', () => {
    reg('a');
    const before = vizStore.panels['a'].z;
    vizStore.raisePanel('nope');
    expect(vizStore.panels['a'].z).toBe(before);
  });

  it('showPanel raises the shown panel to the top', () => {
    reg('a');
    reg('b');
    vizStore.showPanel('a');
    expect(vizStore.panels['a'].z).toBeGreaterThan(vizStore.panels['b'].z);
  });
});

// ---- collapse ----

describe('collapse', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
  });
  afterEach(() => vizStore.clear());

  it('isCollapsed defaults false; setCollapsed sets it', () => {
    reg('p');
    expect(vizStore.isCollapsed('p')).toBe(false);
    vizStore.setCollapsed('p', true);
    expect(vizStore.isCollapsed('p')).toBe(true);
    vizStore.setCollapsed('p', false);
    expect(vizStore.isCollapsed('p')).toBe(false);
  });

  it('isCollapsed is false for unknown panels', () => {
    expect(vizStore.isCollapsed('nope')).toBe(false);
  });

  it('toggleCollapsed flips it', () => {
    reg('p');
    vizStore.toggleCollapsed('p');
    expect(vizStore.isCollapsed('p')).toBe(true);
    vizStore.toggleCollapsed('p');
    expect(vizStore.isCollapsed('p')).toBe(false);
  });

  it('collapsing a docked panel reflows the column', () => {
    for (const id of ['a', 'b']) {
      reg(id);
      vizStore.showPanel(id);
      vizStore.dockPanel(id, 'left');
    }
    vizStore.setCollapsed('a', true);
    expect(vizStore.panels['a'].collapsed).toBe(true);
    // 'a' (collapsed, first by y) sits at top with the gap offset.
    expect(vizStore.panels['a'].y).toBe(10);
    // 'b' sits below the collapsed bar (44) + gap (10).
    expect(vizStore.panels['b'].y).toBe(10 + 44 + 10);
  });
});

// ---- show all / hide all ----

describe('show/hide all', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
  });
  afterEach(() => vizStore.clear());

  it('showAllPanels shows every panel; hideAllPanels hides them', () => {
    reg('a');
    reg('b');
    reg('c');
    vizStore.showAllPanels();
    expect(['a', 'b', 'c'].every((id) => vizStore.isVisible(id))).toBe(true);
    vizStore.hideAllPanels();
    expect(['a', 'b', 'c'].every((id) => !vizStore.isVisible(id))).toBe(true);
  });

  it('showAllPanels only flips hidden panels (already-visible untouched)', () => {
    reg('a');
    vizStore.showPanel('a');
    reg('b');
    vizStore.showAllPanels();
    expect(vizStore.isVisible('a')).toBe(true);
    expect(vizStore.isVisible('b')).toBe(true);
  });
});

// ---- arrange / columns ----

describe('arrangePanels & toggleArrange', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
  });
  afterEach(() => vizStore.clear());

  it('arrangePanels tiles visible panels into two columns', () => {
    for (const id of ['a', 'b', 'c', 'd']) {
      reg(id);
      vizStore.showPanel(id);
    }
    vizStore.arrangePanels();
    const ps = ['a', 'b', 'c', 'd'].map((id) => vizStore.panels[id]);
    // Alternates columns: positive x (left, +10) and negative x (right, -10).
    expect(ps[0].x).toBe(10);
    expect(ps[1].x).toBe(-10);
    expect(ps[2].x).toBe(10);
    expect(ps[3].x).toBe(-10);
    expect(ps.every((p) => p.placed)).toBe(true);
  });

  it('arrangePanels is a no-op when nothing is visible', () => {
    reg('a');
    expect(() => vizStore.arrangePanels()).not.toThrow();
    expect(vizStore.panels['a'].placed).toBe(false);
  });

  it('toggleArrange docks free panels, then releases them when toggled again', () => {
    reg('a');
    reg('b');
    vizStore.showPanel('a');
    vizStore.showPanel('b');
    // First toggle: all free → all dock.
    vizStore.toggleArrange();
    expect(vizStore.panels['a'].dock).not.toBeNull();
    expect(vizStore.panels['b'].dock).not.toBeNull();
    // Second toggle: all docked → all released.
    vizStore.toggleArrange();
    expect(vizStore.panels['a'].dock).toBeNull();
    expect(vizStore.panels['b'].dock).toBeNull();
  });

  it('toggleArrange chooses side by panel center vs viewport center', () => {
    reg('left');
    reg('right');
    vizStore.showPanel('left');
    vizStore.showPanel('right');
    // Far left panel → left dock; far right → right dock.
    vizStore.updatePosition('left', 5, 20);
    vizStore.updatePosition('right', window.innerWidth - 50, 20);
    vizStore.toggleArrange();
    expect(vizStore.panels['left'].dock).toBe('left');
    expect(vizStore.panels['right'].dock).toBe('right');
  });

  it('toggleArrange restores pre-dock geometry on release', () => {
    reg('a');
    vizStore.showPanel('a');
    vizStore.updatePosition('a', 100, 120);
    vizStore.updateSize('a', 300, 350);
    vizStore.toggleArrange(); // dock — saves geometry
    vizStore.toggleArrange(); // release — restores it
    expect(vizStore.panels['a'].x).toBe(100);
    expect(vizStore.panels['a'].y).toBe(120);
    expect(vizStore.panels['a'].width).toBe(300);
    expect(vizStore.panels['a'].height).toBe(350);
  });

  it('toggleArrange is a no-op with no visible panels', () => {
    reg('a');
    expect(() => vizStore.toggleArrange()).not.toThrow();
    expect(vizStore.panels['a'].dock).toBeNull();
  });
});

// ---- docking ----

describe('docking', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
  });
  afterEach(() => vizStore.clear());

  it('isDocked reflects dock state', () => {
    reg('p');
    vizStore.showPanel('p');
    expect(vizStore.isDocked('p')).toBe(false);
    vizStore.dockPanel('p', 'right');
    expect(vizStore.isDocked('p')).toBe(true);
    expect(vizStore.panels['p'].dock).toBe('right');
    expect(vizStore.panels['p'].placed).toBe(true);
  });

  it('isDocked is false for unknown panels', () => {
    expect(vizStore.isDocked('nope')).toBe(false);
  });

  it('getDockWidth / setDockWidth round-trips and clamps', () => {
    expect(vizStore.getDockWidth('left')).toBe(280);
    vizStore.setDockWidth('left', 400);
    expect(vizStore.getDockWidth('left')).toBe(400);
    // Clamp: min 160, max 900.
    vizStore.setDockWidth('left', 10);
    expect(vizStore.getDockWidth('left')).toBe(160);
    vizStore.setDockWidth('left', 5000);
    expect(vizStore.getDockWidth('left')).toBe(900);
  });

  it('setDockWidth persists to localStorage and survives a scene reload', () => {
    vizStore.setDockWidth('right', 320);
    // setSceneName reloads dock widths from storage.
    vizStore.setSceneName('other');
    expect(vizStore.getDockWidth('right')).toBe(280); // other scene's default
    vizStore.setSceneName('test');
    expect(vizStore.getDockWidth('right')).toBe(320); // restored
  });

  it('dockPanel positions panel at the docked column x', () => {
    reg('p');
    vizStore.showPanel('p');
    vizStore.dockPanel('p', 'left');
    expect(vizStore.panels['p'].x).toBe(10); // DOCK_GAP
    vizStore.dockPanel('p', 'right');
    expect(vizStore.panels['p'].x).toBe(-10); // -DOCK_GAP
  });

  it('undockPanel restores pre-dock geometry', () => {
    reg('p');
    vizStore.showPanel('p');
    vizStore.updatePosition('p', 77, 88);
    vizStore.updateSize('p', 250, 300);
    vizStore.dockPanel('p', 'left');
    vizStore.undockPanel('p');
    expect(vizStore.panels['p'].dock).toBeNull();
    expect(vizStore.panels['p'].width).toBe(250);
    expect(vizStore.panels['p'].height).toBe(300);
    expect(vizStore.panels['p'].x).toBe(77);
    expect(vizStore.panels['p'].y).toBe(88);
  });

  it('undockPanel places at an explicit drop point when given', () => {
    reg('p');
    vizStore.showPanel('p');
    vizStore.dockPanel('p', 'left');
    vizStore.undockPanel('p', 200, 250);
    expect(vizStore.panels['p'].x).toBe(200);
    expect(vizStore.panels['p'].y).toBe(250);
  });

  it('undockPanel without saved geometry keeps current coords', () => {
    reg('p');
    vizStore.showPanel('p');
    // No dock first → preDockGeom never saved.
    vizStore.undockPanel('p');
    expect(vizStore.panels['p'].dock).toBeNull();
  });

  it('hiding a docked panel reflows the column', () => {
    for (const id of ['a', 'b']) {
      reg(id);
      vizStore.showPanel(id);
      vizStore.dockPanel(id, 'left');
    }
    const bYbefore = vizStore.panels['b'].y;
    vizStore.hidePanel('a');
    // b should now move up to the top of the column.
    expect(vizStore.panels['b'].y).toBeLessThanOrEqual(bYbefore);
    expect(vizStore.panels['b'].y).toBe(10);
  });

  it('togglePanel hide branch reflows a docked column', () => {
    reg('a');
    vizStore.showPanel('a');
    vizStore.dockPanel('a', 'left');
    expect(() => vizStore.togglePanel('a')).not.toThrow();
    expect(vizStore.isVisible('a')).toBe(false);
  });

  it('showPanel re-docks a previously docked panel into its column', () => {
    reg('a');
    vizStore.showPanel('a');
    vizStore.dockPanel('a', 'left');
    vizStore.hidePanel('a');
    vizStore.showPanel('a');
    expect(vizStore.panels['a'].x).toBe(10);
    expect(vizStore.panels['a'].y).toBe(10);
  });

  it('setDockHeightRatio clamps to [0.05, 0.95]', () => {
    reg('a');
    vizStore.showPanel('a');
    vizStore.dockPanel('a', 'left');
    vizStore.setDockHeightRatio('a', 0.001);
    expect(vizStore.panels['a'].heightRatio).toBe(0.05);
    vizStore.setDockHeightRatio('a', 5);
    expect(vizStore.panels['a'].heightRatio).toBe(0.95);
  });

  it('clearDockHeightRatio is a no-op when no ratio is set', () => {
    reg('a');
    vizStore.showPanel('a');
    vizStore.dockPanel('a', 'left');
    expect(() => vizStore.clearDockHeightRatio('a')).not.toThrow();
    expect(vizStore.panels['a'].heightRatio).toBeUndefined();
  });

  it('reportNaturalHeight filters sub-6px noise', () => {
    reg('a');
    vizStore.showPanel('a');
    vizStore.dockPanel('a', 'left');
    vizStore.reportNaturalHeight('a', 200);
    // A <6px delta is ignored; the dock layout stays put.
    const h1 = vizStore.panels['a'].height;
    vizStore.reportNaturalHeight('a', 203);
    // No relayout scheduled from the noise report; height unchanged.
    expect(vizStore.panels['a'].height).toBe(h1);
  });

  it('reportNaturalHeight on a visible docked panel coalesces into one relayout', () => {
    vi.useFakeTimers();
    for (const id of ['a', 'b']) {
      reg(id);
      vizStore.showPanel(id);
      vizStore.dockPanel(id, 'left');
    }
    // Two measurements: 'a' short, 'b' tall. A burst schedules one relayout.
    vizStore.reportNaturalHeight('a', 100);
    vizStore.reportNaturalHeight('b', 2000);
    vi.advanceTimersByTime(200); // fire the coalesced dock relayout
    // Content-aware split: short 'a' shrinks to its content, 'b' absorbs rest.
    expect(vizStore.panels['a'].height).toBe(100);
    expect(vizStore.panels['b'].height).toBeGreaterThan(vizStore.panels['a'].height);
    vi.useRealTimers();
  });
});

// ---- panel data persistence ----

describe('panel data', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
  });
  afterEach(() => vizStore.clear());

  it('getPanelData returns fallback when unset', () => {
    reg('p');
    expect(vizStore.getPanelData('p', 'speed', 5)).toBe(5);
  });

  it('getPanelData returns fallback for unknown panel', () => {
    expect(vizStore.getPanelData('nope', 'k', 'def')).toBe('def');
  });

  it('setPanelData / getPanelData round-trips', () => {
    reg('p');
    vizStore.setPanelData('p', 'speed', 12);
    expect(vizStore.getPanelData('p', 'speed', 0)).toBe(12);
  });

  it('setPanelData persists across a reload (re-register reads back)', () => {
    reg('p');
    vizStore.setPanelData('p', 'color', 'red');
    // Simulate reload: drop the panel from the store but keep localStorage.
    vizStore.unregisterPanel('p');
    expect(vizStore.panels['p']).toBeUndefined();
    reg('p');
    expect(vizStore.getPanelData('p', 'color', 'none')).toBe('red');
  });

  it('persisted data is the same viz-{scene}-{id} key', () => {
    reg('p');
    vizStore.setPanelData('p', 'k', 99);
    const raw = localStorage.getItem('viz-test-p');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.data.k).toBe(99);
    // content/headerSummary/history are stripped before persisting.
    expect(parsed.content).toBeUndefined();
    expect(parsed.history).toBeUndefined();
  });

  it('seedPanelData sets a baseline only when unset', () => {
    reg('p');
    vizStore.seedPanelData('p', 'vol', 0.5);
    expect(vizStore.getPanelData('p', 'vol', 0)).toBe(0.5);
    // Seeding again does NOT overwrite an existing value.
    vizStore.seedPanelData('p', 'vol', 0.9);
    expect(vizStore.getPanelData('p', 'vol', 0)).toBe(0.5);
    // Seeding does not record undo history.
    expect(vizStore.canUndo('p')).toBe(false);
  });

  it('getPanelData falls back when the stored value is null', () => {
    reg('p');
    vizStore.setPanelData('p', 'k', null);
    expect(vizStore.getPanelData('p', 'k', 'fallback')).toBe('fallback');
  });
});

// ---- undo / redo ----

describe('undo / redo', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vizStore.clear();
  });

  it('canUndo/canRedo start false', () => {
    reg('p');
    expect(vizStore.canUndo('p')).toBe(false);
    expect(vizStore.canRedo('p')).toBe(false);
  });

  it('canUndo/canRedo false for unknown panels', () => {
    expect(vizStore.canUndo('nope')).toBe(false);
    expect(vizStore.canRedo('nope')).toBe(false);
  });

  it('records an undoable step and restores prior data', () => {
    reg('p');
    vizStore.seedPanelData('p', 'v', 1); // baseline, no history
    vizStore.setPanelData('p', 'v', 2);
    expect(vizStore.canUndo('p')).toBe(true);
    vizStore.undo('p');
    expect(vizStore.getPanelData('p', 'v', 0)).toBe(1);
    expect(vizStore.canRedo('p')).toBe(true);
  });

  it('redo re-applies the undone change', () => {
    reg('p');
    vizStore.seedPanelData('p', 'v', 1);
    vizStore.setPanelData('p', 'v', 2);
    vizStore.undo('p');
    vizStore.redo('p');
    expect(vizStore.getPanelData('p', 'v', 0)).toBe(2);
    expect(vizStore.canRedo('p')).toBe(false);
  });

  it('undo with empty history is a no-op', () => {
    reg('p');
    expect(() => vizStore.undo('p')).not.toThrow();
    expect(vizStore.canRedo('p')).toBe(false);
  });

  it('redo with empty future is a no-op', () => {
    reg('p');
    vizStore.setPanelData('p', 'v', 1);
    expect(() => vizStore.redo('p')).not.toThrow();
  });

  it('coalesces a rapid burst into a single undo step', () => {
    reg('p');
    vizStore.seedPanelData('p', 'v', 0);
    // Three writes within the txn window → one undo step.
    vizStore.setPanelData('p', 'v', 1);
    vizStore.setPanelData('p', 'v', 2);
    vizStore.setPanelData('p', 'v', 3);
    expect(vizStore.panels['p'].history.past.length).toBe(1);
    vizStore.undo('p');
    expect(vizStore.getPanelData('p', 'v', -1)).toBe(0);
  });

  it('opens a fresh txn after the debounce window closes', () => {
    reg('p');
    vizStore.seedPanelData('p', 'v', 0);
    vizStore.setPanelData('p', 'v', 1);
    vi.advanceTimersByTime(500); // close the txn window
    vizStore.setPanelData('p', 'v', 2);
    expect(vizStore.panels['p'].history.past.length).toBe(2);
    // Undo steps back one change at a time.
    vizStore.undo('p');
    expect(vizStore.getPanelData('p', 'v', -1)).toBe(1);
    vizStore.undo('p');
    expect(vizStore.getPanelData('p', 'v', -1)).toBe(0);
  });

  it('a new edit after undo clears the redo stack', () => {
    reg('p');
    vizStore.seedPanelData('p', 'v', 0);
    vizStore.setPanelData('p', 'v', 1);
    vizStore.undo('p');
    expect(vizStore.canRedo('p')).toBe(true);
    vi.advanceTimersByTime(500);
    vizStore.setPanelData('p', 'v', 9);
    expect(vizStore.canRedo('p')).toBe(false);
  });
});

// ---- clear ----

describe('clear', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
  });
  afterEach(() => vizStore.clear());

  it('empties all panels', () => {
    reg('a');
    reg('b');
    vizStore.clear();
    expect(Object.keys(vizStore.panels).length).toBe(0);
  });

  it('cancels pending debounced relayout/arrange work', () => {
    vi.useFakeTimers();
    reg('a');
    vizStore.showPanel('a'); // schedules auto-arrange (unplaced)
    vizStore.clear();
    // Advancing timers must not re-touch a fresh (empty) store.
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(Object.keys(vizStore.panels).length).toBe(0);
    vi.useRealTimers();
  });
});

// ---- keyboard ----

describe('viz keyboard', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
    installVizKeyboard();
  });
  afterEach(() => {
    uninstallVizKeyboard();
    vizStore.clear();
  });

  const press = (code: string, opts: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code, ...opts }));

  it('a plain activation key toggles the matching panel', () => {
    reg('a'); // gets F1
    expect(vizStore.isVisible('a')).toBe(false);
    press('F1');
    expect(vizStore.isVisible('a')).toBe(true);
    press('F1');
    expect(vizStore.isVisible('a')).toBe(false);
  });

  it('ignores modifier combos', () => {
    reg('a'); // F1
    press('F1', { altKey: true });
    expect(vizStore.isVisible('a')).toBe(false);
    press('F1', { ctrlKey: true });
    expect(vizStore.isVisible('a')).toBe(false);
    press('F1', { metaKey: true });
    expect(vizStore.isVisible('a')).toBe(false);
  });

  it('ignores keystrokes while editing in an input', () => {
    reg('a'); // F1
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'F1', bubbles: true }));
    expect(vizStore.isVisible('a')).toBe(false);
    input.remove();
  });

  it('does nothing for an unmatched key', () => {
    reg('a'); // F1
    press('F9');
    expect(vizStore.isVisible('a')).toBe(false);
  });

  it('installVizKeyboard is idempotent and uninstall stops handling', () => {
    installVizKeyboard(); // second call → no-op (already installed)
    reg('a'); // F1
    uninstallVizKeyboard();
    press('F1');
    expect(vizStore.isVisible('a')).toBe(false);
  });

  it('uninstall when not installed is safe', () => {
    uninstallVizKeyboard(); // installed in beforeEach
    expect(() => uninstallVizKeyboard()).not.toThrow();
  });
});

// ---- persistence round-trips on register ----

describe('persistence on register', () => {
  beforeEach(() => {
    localStorage.clear();
    vizStore.clear();
    vizStore.setSceneName('test');
  });
  afterEach(() => vizStore.clear());

  it('restores position, size, collapsed and dock from storage', () => {
    reg('p');
    vizStore.updatePosition('p', 123, 234);
    vizStore.updateSize('p', 290, 310);
    vizStore.setCollapsed('p', true);
    vizStore.unregisterPanel('p'); // reload, keep storage
    reg('p');
    const p = vizStore.panels['p'];
    expect(p.x).toBe(123);
    expect(p.y).toBe(234);
    expect(p.width).toBe(290);
    expect(p.height).toBe(310);
    expect(p.collapsed).toBe(true);
    expect(p.placed).toBe(true);
  });

  it('restores a persisted z rank instead of stacking newest on top', () => {
    reg('a');
    reg('b');
    vizStore.raisePanel('a'); // a→3 over b, ranks normalized
    const savedZ = vizStore.panels['a'].z;
    vizStore.unregisterPanel('a');
    reg('a');
    expect(vizStore.panels['a'].z).toBe(savedZ);
  });

  it('ignores an activationKey that leaked into storage (trusts registration)', () => {
    reg('a'); // F1
    vizStore.updatePosition('a', 1, 1); // force a save so storage exists
    // Manually corrupt storage with a bogus activationKey.
    const raw = JSON.parse(localStorage.getItem('viz-test-a') as string);
    raw.activationKey = 'KeyZ';
    localStorage.setItem('viz-test-a', JSON.stringify(raw));
    vizStore.unregisterPanel('a');
    reg('a');
    expect(vizStore.panels['a'].activationKey).toBe('F1');
  });

  it('tolerates corrupt JSON in storage', () => {
    localStorage.setItem('viz-test-p', '{not json');
    expect(() => reg('p')).not.toThrow();
    expect(vizStore.panels['p']).toBeDefined();
  });

  it('tolerates corrupt dock-widths JSON on scene load', () => {
    localStorage.setItem('viz-broken-dockwidths', '{not json');
    expect(() => vizStore.setSceneName('broken')).not.toThrow();
    expect(vizStore.getDockWidth('left')).toBe(280);
  });

  it('restores a docked panel and reflows it into its column on register', () => {
    reg('p');
    vizStore.showPanel('p');
    vizStore.dockPanel('p', 'right');
    vizStore.unregisterPanel('p');
    reg('p'); // restored with dock:'right' → scheduleAutoArrange
    expect(vizStore.panels['p'].dock).toBe('right');
  });
});
