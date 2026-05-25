/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vizStore, waterFillHeights } from './vizStore';

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
