/**
 * Gravity set before Havok is up must not be lost.
 *
 * Havok is a WASM module that loads in the background, so a game's first tick
 * can run before there is a physics engine. The pinball Plunger sets the
 * table's tilt on that first tick; the adapter used to forward it to a missing
 * engine and drop it, Havok then booted with plain downward gravity, and the
 * ball rolled up the table. Havok is faked here: the WASM is a promise this
 * test resolves, and the plugin only records the gravity it is given.
 */
import { describe, it, expect, vi } from 'vitest';
import { NullEngine, Scene, Vector3 } from '@babylonjs/core';

const havok = vi.hoisted(() => {
  let release: (v: unknown) => void = () => {};
  return {
    load: () => new Promise((resolve) => { release = resolve; }),
    release: () => release({}),
  };
});

vi.mock('@babylonjs/havok', () => ({ default: () => havok.load() }));

vi.mock('@babylonjs/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@babylonjs/core')>();
  class FakeHavokPlugin {
    name = 'HavokPlugin';
    gravity = new core.Vector3();
    getPluginVersion() { return 2; }
    setGravity(g: InstanceType<typeof core.Vector3>) { this.gravity = g.clone(); }
    setTimeStep() {}
    getTimeStep() { return 1 / 60; }
    executeStep() {}
    setVelocityLimits() {}
    dispose() {}
  }
  return { ...core, HavokPlugin: FakeHavokPlugin };
});

const { BabylonAdapter } = await import('./BabylonAdapter');

function headless() {
  const adapter = new BabylonAdapter();
  adapter.engine = new NullEngine();
  adapter.scene = new Scene(adapter.engine);
  return adapter;
}

/** Start Havok the way a scene's first physics body does, and let it land. */
async function bootHavok(adapter: InstanceType<typeof BabylonAdapter>, before?: () => void) {
  const booting = (adapter as unknown as { ensureHavok(): Promise<void> }).ensureHavok();
  before?.();
  havok.release();
  await booting;
}

const gravityOf = (adapter: InstanceType<typeof BabylonAdapter>) =>
  (adapter.getHavokPlugin() as unknown as { gravity: Vector3 }).gravity.asArray();

describe('BabylonAdapter.physicsSetGravity', () => {
  it('keeps a gravity set while the Havok WASM is still loading', async () => {
    const adapter = headless();
    await bootHavok(adapter, () => adapter.physicsSetGravity(0, -303, 34.5));
    expect(gravityOf(adapter)).toEqual([0, -303, 34.5]);
  });

  it('keeps a gravity set before anything started Havok', async () => {
    const adapter = headless();
    adapter.physicsSetGravity(0, -12, 14);
    await bootHavok(adapter);
    expect(gravityOf(adapter)).toEqual([0, -12, 14]);
  });

  it('boots with plain downward gravity when none was set', async () => {
    const adapter = headless();
    await bootHavok(adapter);
    expect(gravityOf(adapter)).toEqual([0, -30, 0]);
  });

  it('applies straight away once Havok is up', async () => {
    const adapter = headless();
    await bootHavok(adapter);
    adapter.physicsSetGravity(1, -9.81, 2);
    expect(gravityOf(adapter)).toEqual([1, -9.81, 2]);
  });
});
