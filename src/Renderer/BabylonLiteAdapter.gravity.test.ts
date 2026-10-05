/**
 * Lite twin of BabylonAdapter.gravity.test: gravity set before the Havok WASM
 * lands is the gravity the world is created with, and once the world exists a
 * new gravity reaches it. Lite used to ignore physicsSetGravity outright, so a
 * pinball table on Lite never tilted.
 *
 * Lite needs a WebGPU device for a real scene, so the scene is a stand-in and
 * the two Havok calls are spies; no device is touched.
 */
import { describe, it, expect, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  // Lite's bundle reads these at module init (see BabylonLiteAdapter.contract.test).
  const g = globalThis as Record<string, unknown>;
  g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  g.GPUBufferUsage ??= {};
  g.GPUTextureUsage ??= {};
  g.GPUMapMode ??= {};
  g.GPUColorWrite ??= {};
  // Lite reaches Havok through a dynamic import, so the WASM is asked for a
  // tick AFTER ensureHavok returns: the gate is opened, not a promise handed out.
  let open: (v: unknown) => void = () => {};
  let gate = new Promise((resolve) => { open = resolve; });
  return {
    loadHavok: () => gate,
    close: () => { gate = new Promise((resolve) => { open = resolve; }); },
    release: () => open({}),
  };
});

vi.mock('@babylonjs/havok', () => ({ default: () => fakes.loadHavok() }));

vi.mock('@babylonjs/lite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@babylonjs/lite')>()),
  createHavokWorld: vi.fn(() => ({ fake: 'world' })),
  setPhysicsGravity: vi.fn(),
}));

const BL = await import('@babylonjs/lite');
const { BabylonLiteAdapter } = await import('./BabylonLiteAdapter');

type Internals = { scene: unknown; ensureHavok(): Promise<void> };

function headless() {
  const adapter = new BabylonLiteAdapter();
  (adapter as unknown as Internals).scene = { fake: 'scene' };
  return adapter;
}

async function bootHavok(adapter: InstanceType<typeof BabylonLiteAdapter>, before?: () => void) {
  fakes.close();
  const booting = (adapter as unknown as Internals).ensureHavok();
  before?.();
  fakes.release();
  await booting;
}

const createdWith = () => vi.mocked(BL.createHavokWorld).mock.lastCall?.[2];

describe('BabylonLiteAdapter.physicsSetGravity', () => {
  it('creates the world with a gravity set while the WASM was loading', async () => {
    const adapter = headless();
    await bootHavok(adapter, () => adapter.physicsSetGravity(0, -303, 34.5));
    expect(createdWith()).toEqual({ x: 0, y: -303, z: 34.5 });
  });

  it('creates the world with plain downward gravity when none was set', async () => {
    const adapter = headless();
    await bootHavok(adapter);
    expect(createdWith()).toEqual({ x: 0, y: -30, z: 0 });
  });

  it('sets the live world once Havok is up', async () => {
    const adapter = headless();
    await bootHavok(adapter);
    adapter.physicsSetGravity(1, -9.81, 2);
    expect(vi.mocked(BL.setPhysicsGravity)).toHaveBeenLastCalledWith({ fake: 'world' }, { x: 1, y: -9.81, z: 2 });
  });
});
