/**
 * Lite twin of BabylonAdapter.gravity.test: gravity set before the Havok WASM
 * lands is the gravity the world is created with, and once the world exists a
 * new gravity reaches it. Lite used to ignore physicsSetGravity outright, so a
 * pinball table on Lite never tilted.
 *
 * Lite runs LEFT-handed and the adapter negates Z at the seam, so gravity, body
 * velocities and body snapshots go in mirrored and come back canonical. The
 * "canonical frame" block below proves the round trips (they used to skip the
 * mirror: a body thrown toward +z flew toward −z on Lite).
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
  createPhysicsAggregate: vi.fn((_world: unknown, node: unknown) => ({ body: { node }, shape: {} })),
  setPhysicsBodyPreStep: vi.fn(),
  setPhysicsBodyMotionType: vi.fn(),
  setPhysicsBodyTransform: vi.fn(),
  setPhysicsBodyAngularVelocity: vi.fn(),
  // A recording body: the linear velocity set is the one read back.
  setPhysicsBodyLinearVelocity: vi.fn((_w: unknown, body: { lv?: unknown }, v: unknown) => { body.lv = v; }),
  getPhysicsBodyLinearVelocity: vi.fn((_w: unknown, body: { lv?: unknown }) => body.lv ?? { x: 0, y: 0, z: 0 }),
  getCameraPosition: vi.fn((cam: { pos: { x: number; y: number; z: number } }) => cam.pos),
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
    expect(createdWith()).toEqual({ x: 0, y: -303, z: -34.5 }); // mirrored into Lite's LH frame
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
    expect(vi.mocked(BL.setPhysicsGravity)).toHaveBeenLastCalledWith({ fake: 'world' }, { x: 1, y: -9.81, z: -2 });
  });
});

// ─── Canonical frame round trips ────────────────────────────────────────────

/** A stand-in Lite mesh: position + the rotationQuaternion the adapter writes. */
function fakeMesh() {
  const v = { x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { v.x = x; v.y = y; v.z = z; } };
  const q = { x: 0, y: 0, z: 0, w: 1, set(x: number, y: number, z: number, w: number) { q.x = x; q.y = y; q.z = z; q.w = w; } };
  return { name: 'm', position: v, rotationQuaternion: q, scaling: { set() {} } };
}

type BodyInternals = Internals & {
  havokWorld: unknown;
  havokReady: boolean;
  meshesByMeshId: Map<string, unknown>;
};

function withBody(id = 'ball') {
  const adapter = headless();
  const i = adapter as unknown as BodyInternals;
  i.havokWorld = { fake: 'world' };
  i.havokReady = true;
  const mesh = fakeMesh();
  i.meshesByMeshId.set(id, mesh);
  adapter.physicsCreateBody(id, {
    motionType: 'dynamic', mass: 1, friction: 0.5, restitution: 0.2, shapeType: 'sphere', lockRotation: false,
  });
  return { adapter, mesh, body: adapter.getPhysicsBody(id)! };
}

describe('BabylonLiteAdapter physics in the canonical (right-handed) frame', () => {
  it('a velocity toward +z reaches Lite as −z and reads back as +z', () => {
    const { adapter, body } = withBody();
    adapter.physicsSetBodyVelocity('ball', 1, 2, 3);
    expect(vi.mocked(BL.setPhysicsBodyLinearVelocity)).toHaveBeenLastCalledWith({ fake: 'world' }, body, { x: 1, y: 2, z: -3 });
    expect(adapter.physicsGetBodyState('ball')!.linearVelocity).toEqual([1, 2, 3]);
  });

  it('a snapshot round-trips: position, rotation and linear velocity come back as given', () => {
    const { adapter, mesh } = withBody();
    const state = {
      position: [1.5, 2, 7] as [number, number, number],
      rotation: [0.3, -1.1, 0.4] as [number, number, number],
      linearVelocity: [-2, 0.5, 4] as [number, number, number],
      angularVelocity: [0, 0, 0] as [number, number, number],
    };
    adapter.physicsSetBodyState('ball', state);
    // Inside Lite it is the mirror image…
    expect([mesh.position.x, mesh.position.y, mesh.position.z]).toEqual([1.5, 2, -7]);
    const [, , p, q] = vi.mocked(BL.setPhysicsBodyTransform).mock.lastCall!;
    expect(p).toEqual({ x: 1.5, y: 2, z: -7 });
    const mq = mesh.rotationQuaternion;
    expect(q).toEqual({ x: mq.x, y: mq.y, z: mq.z, w: mq.w });
    // …and the same rotation setMeshRotation would give the mesh.
    const viaMesh = fakeMesh();
    (adapter as unknown as { applyEulerQuat(m: unknown, x: number, y: number, z: number): void })
      .applyEulerQuat(viaMesh, 0.3, -1.1, 0.4);
    expect(mq.x).toBeCloseTo(viaMesh.rotationQuaternion.x, 12);
    expect(mq.w).toBeCloseTo(viaMesh.rotationQuaternion.w, 12);
    // …and back out it is canonical again.
    const back = adapter.physicsGetBodyState('ball')!;
    expect(back.position).toEqual([1.5, 2, 7]);
    back.rotation.forEach((r, k) => expect(r).toBeCloseTo(state.rotation[k]!, 10));
    expect(back.linearVelocity).toEqual([-2, 0.5, 4]);
  });

  it('angular velocity is a pseudovector: (x, y, z) reaches Lite as (−x, −y, z)', () => {
    const { adapter, body } = withBody();
    adapter.physicsSetBodyState('ball', {
      position: [0, 0, 0], rotation: [0, 0, 0], linearVelocity: [0, 0, 0], angularVelocity: [1, 2, 3],
    });
    expect(vi.mocked(BL.setPhysicsBodyAngularVelocity)).toHaveBeenLastCalledWith({ fake: 'world' }, body, { x: -1, y: -2, z: 3 });
  });
});

describe('BabylonLiteAdapter arc camera + bounds in the canonical frame', () => {
  type CamInternals = { cameras: Map<unknown, { camera: unknown }>; meshes: Map<unknown, unknown> };
  function withArc(liteAlpha = -0.5) {
    const adapter = headless();
    const camera = { target: { x: 0, y: 0, z: 0 }, alpha: liteAlpha, beta: 1, radius: 10, pos: { x: 0, y: 0, z: 0 } };
    const h = { __handle: 'cam' } as never;
    (adapter as unknown as CamInternals).cameras.set(h, { camera });
    return { adapter, camera, h };
  }

  it('setCameraTarget / getCameraTarget mirror z and round-trip', () => {
    const { adapter, camera, h } = withArc();
    adapter.setCameraTarget(h, 1, 2, 3);
    expect(camera.target).toEqual({ x: 1, y: 2, z: -3 });
    expect(adapter.getCameraTarget(h, [0, 0, 0])).toEqual([1, 2, 3]);
  });

  it('alpha reads back as the canonical alpha createArcCamera was given, and nudges the same way', () => {
    const { adapter, camera, h } = withArc(-0.5); // createArcCamera({ alpha: 0.5 }) stores −0.5
    expect(adapter.getCameraAngles(h).alpha).toBeCloseTo(0.5);
    adapter.nudgeCameraAlpha(h, 0.25);
    expect(adapter.getCameraAngles(h).alpha).toBeCloseTo(0.75);
    expect(camera.alpha).toBeCloseTo(-0.75);
  });

  it('forward and right come back canonical: looking down +z, right is −x (forward × up)', () => {
    const { adapter, camera, h } = withArc();
    // Canonical eye (0,0,−10) looking at the origin is Lite eye (0,0,+10).
    camera.pos = { x: 0, y: 0, z: 10 };
    expect(adapter.getCameraForward(h, [0, 0, 0])).toEqual([0, 0, 1]);
    const right = adapter.getCameraRight(h, [0, 0, 0]);
    expect(right[0]).toBeCloseTo(-1);
    expect(right[2]).toBeCloseTo(0);
  });

  it('bounding-box extents mirror z (min/max swap) and round-trip', () => {
    const adapter = headless();
    const mesh = { boundMin: [0, 0, 0], boundMax: [0, 0, 0] } as { boundMin: number[]; boundMax: number[] };
    const h = { __handle: 'box' } as never;
    (adapter as unknown as CamInternals).meshes.set(h, mesh);
    adapter.setMeshBoundingBoxExtents(h, [-1, 0, 0.5], [1, 2, 3]);
    expect(mesh.boundMin).toEqual([-1, 0, -3]);
    expect(mesh.boundMax).toEqual([1, 2, -0.5]);
    (adapter as unknown as { boxExtents: Map<unknown, unknown> }).boxExtents.clear(); // read Lite's own bounds
    expect(adapter.getMeshBoundingBoxExtents(h)).toEqual({ min: [-1, 0, 0.5], max: [1, 2, 3] });
  });
});
