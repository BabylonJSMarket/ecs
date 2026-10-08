/**
 * BabylonLiteAdapter's plugin host accessors — the Lite twins of
 * BabylonAdapter's getScene / getOrbitCamera / getPhysicsBody /
 * getHavokPlugin / getMeshIdForBody, plus getEngine (Lite's texture uploads
 * take an EngineContext, which Babylon reaches through scene.getEngine()).
 *
 * Lite needs a WebGPU device for a real scene, so the scene, engine, camera and
 * Havok world are stand-ins and the aggregate factory is a spy; no device is
 * touched (see BabylonLiteAdapter.gravity.test for the same pattern).
 */
import { describe, it, expect, vi } from 'vitest';
import type { CameraHandle } from './types';

vi.hoisted(() => {
  // Lite's bundle reads these at module init (see BabylonLiteAdapter.contract.test).
  const g = globalThis as Record<string, unknown>;
  g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  g.GPUBufferUsage ??= {};
  g.GPUTextureUsage ??= {};
  g.GPUMapMode ??= {};
  g.GPUColorWrite ??= {};
});

vi.mock('@babylonjs/lite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@babylonjs/lite')>()),
  createPhysicsAggregate: vi.fn((_world: unknown, node: unknown) => ({ body: { node }, shape: {} })),
  setPhysicsBodyPreStep: vi.fn(),
  setPhysicsBodyMotionType: vi.fn(),
}));

const { BabylonLiteAdapter } = await import('./BabylonLiteAdapter');

interface Internals {
  scene: unknown;
  engine: unknown;
  havokWorld: unknown;
  havokReady: boolean;
  cameras: Map<CameraHandle, { camera: unknown }>;
  meshesByMeshId: Map<string, unknown>;
}

const internals = (a: InstanceType<typeof BabylonLiteAdapter>) => a as unknown as Internals;

describe('BabylonLiteAdapter plugin host accessors', () => {
  it('answer null before init(), so a plugin can wait instead of throwing', () => {
    const a = new BabylonLiteAdapter();
    expect(a.getScene()).toBeNull();
    expect(a.getEngine()).toBeNull();
    expect(a.getHavokWorld()).toBeNull();
    expect(a.getPhysicsBody('nope')).toBeNull();
    expect(a.getOrbitCamera({ __handle: 'x' } as unknown as CameraHandle)).toBeNull();
  });

  it('hand out the live scene and engine', () => {
    const a = new BabylonLiteAdapter();
    const scene = { fake: 'scene' };
    const engine = { fake: 'engine' };
    internals(a).scene = scene;
    internals(a).engine = engine;
    expect(a.getScene()).toBe(scene);
    expect(a.getEngine()).toBe(engine);
  });

  it('getOrbitCamera returns the ArcRotateCamera behind a handle', () => {
    const a = new BabylonLiteAdapter();
    const camera = { beta: 1 };
    const h = { __handle: 'cam' } as unknown as CameraHandle;
    internals(a).cameras.set(h, { camera });
    expect(a.getOrbitCamera(h)).toBe(camera);
  });

  it('the Havok world is withheld until it is ready', () => {
    const a = new BabylonLiteAdapter();
    const world = { fake: 'world' };
    internals(a).havokWorld = world;
    expect(a.getHavokWorld()).toBeNull();
    internals(a).havokReady = true;
    expect(a.getHavokWorld()).toBe(world);
  });

  it('a body maps to its mesh both ways, and forgets it when destroyed', () => {
    const a = new BabylonLiteAdapter();
    internals(a).havokWorld = { fake: 'world' };
    internals(a).havokReady = true;
    internals(a).meshesByMeshId.set('ball', { name: 'ball' });
    expect(a.physicsCreateBody('ball', {
      motionType: 'dynamic', mass: 1, friction: 0.5, restitution: 0.2, shapeType: 'sphere', lockRotation: false,
    })).toBe(true);
    const body = a.getPhysicsBody('ball');
    expect(body).not.toBeNull();
    expect(a.getMeshIdForBody(body!)).toBe('ball');
    a.physicsDestroyBody('ball');
    expect(a.getPhysicsBody('ball')).toBeNull();
    expect(a.getMeshIdForBody(body!)).toBeUndefined();
  });
});
