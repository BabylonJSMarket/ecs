import { describe, it, expect, vi } from 'vitest';
import { withRaceTracking } from './raceTrackingAdapter';
import { MockRendererAdapter } from './MockRendererAdapter';
import { RaceDetector } from '../ECS/Race/RaceDetector';
import type {
  ArcCameraSpec,
  DirectionalLightSpec,
  MeshHandle,
  PrimitiveSpec,
} from './types';

const boxSpec: PrimitiveSpec = { kind: 'box', width: 1, height: 1, depth: 1 };

const dirLightSpec: DirectionalLightSpec = {
  direction: [0, -1, 0],
  intensity: 1,
  diffuse: [1, 1, 1],
  specular: [1, 1, 1],
};

const arcCamSpec: ArcCameraSpec = {
  alpha: 0,
  beta: 1,
  radius: 5,
  minRadius: 1,
  maxRadius: 10,
  minBeta: 0.1,
  maxBeta: Math.PI - 0.1,
  target: [0, 0, 0],
  inertia: 0.9,
  wheelPrecision: 50,
  angularSensibility: 1000,
};

describe('withRaceTracking', () => {
  const setup = () => {
    const adapter = new MockRendererAdapter();
    const onWarn = vi.fn();
    const detector = new RaceDetector({ onWarn });
    const wrapped = withRaceTracking(adapter, detector);
    return { adapter, detector, wrapped, onWarn };
  };

  it('returns a Proxy that forwards createMesh through to the underlying adapter', () => {
    const { adapter, wrapped } = setup();
    const handle = wrapped.createMesh('m1', boxSpec);
    expect(handle).toBeDefined();
    const createCall = adapter.calls.find((c) => c.method === 'createMesh');
    expect(createCall).toBeDefined();
    expect(createCall?.args[0]).toBe('m1');
  });

  it('forwards setMeshPosition through to the underlying adapter (preserving args)', () => {
    const { adapter, wrapped } = setup();
    const h = wrapped.createMesh('m', boxSpec);
    wrapped.setMeshPosition(h, 1, 2, 3);
    const call = adapter.calls.find((c) => c.method === 'setMeshPosition');
    expect(call).toBeDefined();
    expect(call?.args).toEqual([h, 1, 2, 3]);
  });

  it('records a handle write on the detector when a mutating method is called', () => {
    const { detector, wrapped } = setup();
    const spy = vi.spyOn(detector, 'recordHandleWrite');
    const h = wrapped.createMesh('m', boxSpec);
    wrapped.setMeshPosition(h, 0, 0, 0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(String), 'setMeshPosition');
  });

  it('uses the handle.__mockHandle tag as the stable id passed to the detector', () => {
    const { detector, wrapped } = setup();
    const spy = vi.spyOn(detector, 'recordHandleWrite');
    const h = wrapped.createMesh('alpha', boxSpec);
    wrapped.setMeshRotation(h, 0, 1, 0);
    const tag = (h as unknown as { __mockHandle: string }).__mockHandle;
    expect(tag).toBe('mesh:alpha');
    expect(spy).toHaveBeenCalledWith('mesh:alpha', 'setMeshRotation');
  });

  it('records writes for each tracked mutator prefix (set, update, nudge, attach, detach, dispose)', () => {
    const { detector, wrapped } = setup();
    const spy = vi.spyOn(detector, 'recordHandleWrite');
    const mesh = wrapped.createMesh('m', boxSpec);
    const light = wrapped.createDirectionalLight('l', dirLightSpec);

    wrapped.setMeshPosition(mesh, 0, 0, 0);     // set*
    wrapped.updateLightIntensity(light, 0.5);   // update*
    const cam = wrapped.createArcCamera('c', arcCamSpec);
    wrapped.nudgeCameraAlpha(cam, 0.1);         // nudge*
    const shadow = wrapped.attachShadowCaster(light, mesh); // attach*
    wrapped.detachShadowCaster(shadow);         // detach*
    wrapped.disposeMesh(mesh);                  // dispose*

    const methods = spy.mock.calls.map((c) => c[1]);
    expect(methods).toEqual([
      'setMeshPosition',
      'updateLightIntensity',
      'nudgeCameraAlpha',
      'attachShadowCaster',
      'detachShadowCaster',
      'disposeMesh',
    ]);
  });

  it('does NOT record writes for non-mutating methods (createMesh, resize, getMeshWorldPosition)', () => {
    const { detector, wrapped } = setup();
    const spy = vi.spyOn(detector, 'recordHandleWrite');
    const h = wrapped.createMesh('m', boxSpec);
    wrapped.resize();
    const out: [number, number, number] = [0, 0, 0];
    wrapped.getMeshWorldPosition(h, out);
    expect(spy).not.toHaveBeenCalled();
  });

  it('warns when two systems call setMeshPosition on the same handle in the same frame', () => {
    const { detector, wrapped, onWarn } = setup();
    detector.beginFrame();
    const h = wrapped.createMesh('m', boxSpec);

    detector.setCurrentSystem('SystemA');
    wrapped.setMeshPosition(h, 1, 0, 0);

    detector.setCurrentSystem('SystemB');
    wrapped.setMeshPosition(h, 2, 0, 0);

    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(detector.warnings).toHaveLength(1);
    const w = detector.warnings[0];
    expect(w.kind).toBe('adapter');
    expect(w.sources).toEqual(['SystemA', 'SystemB']);
    expect(w.message).toContain('setMeshPosition');
    expect(w.message).toContain('mesh:m');
  });

  it('does NOT warn when the same system writes the same handle twice in one frame', () => {
    const { detector, wrapped, onWarn } = setup();
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    const h = wrapped.createMesh('m', boxSpec);
    wrapped.setMeshPosition(h, 1, 0, 0);
    wrapped.setMeshPosition(h, 2, 0, 0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('does NOT warn when two systems write DIFFERENT handles via setMeshPosition', () => {
    const { detector, wrapped, onWarn } = setup();
    detector.beginFrame();
    const a = wrapped.createMesh('a', boxSpec);
    const b = wrapped.createMesh('b', boxSpec);
    detector.setCurrentSystem('SystemA');
    wrapped.setMeshPosition(a, 1, 0, 0);
    detector.setCurrentSystem('SystemB');
    wrapped.setMeshPosition(b, 2, 0, 0);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('does NOT warn when createMesh is called by two systems on the same id (creators never race)', () => {
    const { detector, wrapped, onWarn } = setup();
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    wrapped.createMesh('m', boxSpec);
    detector.setCurrentSystem('SystemB');
    wrapped.createMesh('m', boxSpec);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('resets per-frame state on beginFrame() so same-handle writes across frames do not warn', () => {
    const { detector, wrapped, onWarn } = setup();
    const h = wrapped.createMesh('m', boxSpec);

    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    wrapped.setMeshPosition(h, 1, 0, 0);

    detector.beginFrame();
    detector.setCurrentSystem('SystemB');
    wrapped.setMeshPosition(h, 2, 0, 0);

    expect(onWarn).not.toHaveBeenCalled();
    expect(detector.warnings).toHaveLength(0);
  });

  it('warns again on a fresh clash after beginFrame() (per-frame counter reset)', () => {
    const { detector, wrapped, onWarn } = setup();
    const h = wrapped.createMesh('m', boxSpec);

    // Frame 1: clash that warns.
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    wrapped.setMeshPosition(h, 1, 0, 0);
    detector.setCurrentSystem('SystemB');
    wrapped.setMeshPosition(h, 2, 0, 0);
    expect(onWarn).toHaveBeenCalledTimes(1);

    // Frame 2: same clash should warn again because frame-warned set was cleared.
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    wrapped.setMeshPosition(h, 3, 0, 0);
    detector.setCurrentSystem('SystemB');
    wrapped.setMeshPosition(h, 4, 0, 0);
    expect(onWarn).toHaveBeenCalledTimes(2);
  });

  it('falls back to an anon: id for untagged object handles', () => {
    const { detector, adapter } = setup();
    const spy = vi.spyOn(detector, 'recordHandleWrite');
    const wrapped = withRaceTracking(adapter, detector);
    const untaggedHandle = {} as MeshHandle;
    wrapped.setMeshPosition(untaggedHandle, 0, 0, 0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/^anon:\d+$/);
  });

  it('reuses the same anon: id for repeated writes to the same untagged handle', () => {
    const { detector, adapter } = setup();
    const spy = vi.spyOn(detector, 'recordHandleWrite');
    const wrapped = withRaceTracking(adapter, detector);
    const untaggedHandle = {} as MeshHandle;

    wrapped.setMeshPosition(untaggedHandle, 0, 0, 0);
    wrapped.setMeshRotation(untaggedHandle, 0, 0, 0); // second write hits the WeakMap cache

    expect(spy).toHaveBeenCalledTimes(2);
    const firstId = spy.mock.calls[0][0];
    const secondId = spy.mock.calls[1][0];
    expect(secondId).toBe(firstId); // stable id, not a fresh anon:N
  });

  it('stringifies a primitive first arg as a prim: id (setAnimationWeight takes a string meshId)', () => {
    const { detector, wrapped } = setup();
    const spy = vi.spyOn(detector, 'recordHandleWrite');
    // setAnimationWeight is a `set*` mutator whose first arg is the mesh id
    // (a string), not an opaque handle object.
    wrapped.setAnimationWeight('hero', 'walk', 0.5);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('prim:hero', 'setAnimationWeight');
  });

  it('returns non-function properties of the underlying adapter untouched', () => {
    const { adapter, wrapped } = setup();
    // MockRendererAdapter exposes a `calls` array (a data property, not a
    // method). The Proxy must pass it through without wrapping/binding.
    const wrappedCalls = (wrapped as unknown as { calls: typeof adapter.calls }).calls;
    expect(wrappedCalls).toBe(adapter.calls);
    wrapped.resize();
    expect(wrappedCalls.some((c) => c.method === 'resize')).toBe(true);
  });

  it('preserves `this` correctly on non-mutating forwarded calls (resize)', () => {
    // resize() is a non-mutator; the Proxy binds it to the underlying adapter.
    // If `this` were wrong, MockRendererAdapter.record would throw.
    const { adapter, wrapped } = setup();
    expect(() => wrapped.resize()).not.toThrow();
    expect(adapter.calls.some((c) => c.method === 'resize')).toBe(true);
  });
});
