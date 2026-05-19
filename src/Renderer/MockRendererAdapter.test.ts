/**
 * Unit tests for MockRendererAdapter. This adapter is the spine of every
 * Systems test in the package — it records each adapter call so tests can
 * assert "did the System call setMeshPosition with these args" without
 * needing a real 3D engine. The contract callers rely on is:
 *
 *   - factory methods (createMesh, createDirectionalLight, ...) return
 *     opaque handles and push a `{ method, args }` entry into `.calls`.
 *   - mutator methods (setMeshPosition, nudgeCameraAlpha, ...) push entries
 *     too, and update the small in-memory stubs (cameraAngles, etc.) that
 *     read-back methods like getCameraForward consult.
 *   - lifecycle (init / startLoop / stopLoop / resize / dispose) records
 *     the method name with no positional args.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockRendererAdapter } from './MockRendererAdapter';
import type {
  ArcCameraSpec,
  CameraHandle,
  DirectionalLightSpec,
  HemisphericLightSpec,
  LabelSpec,
  LightHandle,
  MaterialSpec,
  MeshHandle,
  PhysicsBodyOpts,
  PrimitiveSpec,
  Vec3,
} from './types';

describe('MockRendererAdapter', () => {
  let renderer: MockRendererAdapter;

  beforeEach(() => {
    renderer = new MockRendererAdapter();
  });

  describe('construction and init', () => {
    it('starts with an empty calls array and "babylon" kind', () => {
      expect(renderer.calls).toEqual([]);
      expect(renderer.kind).toBe('babylon');
    });

    it('init() records the call and resolves without a canvas dependency', async () => {
      // We pass a stub canvas; the adapter never touches it.
      const fakeCanvas = {} as HTMLCanvasElement;
      await renderer.init(fakeCanvas);
      expect(renderer.calls).toHaveLength(1);
      expect(renderer.calls[0]).toMatchObject({ method: 'init', args: [] });
    });
  });

  describe('mesh handles', () => {
    const prim: PrimitiveSpec = { kind: 'box', width: 1, height: 1, depth: 1 };
    const mat: MaterialSpec = { diffuse: [1, 0, 0] };

    it('createMesh records the call and returns a usable handle', () => {
      const h = renderer.createMesh('hero', prim, mat);
      expect(h).toBeDefined();
      expect(renderer.calls).toHaveLength(1);
      expect(renderer.calls[0]).toMatchObject({
        method: 'createMesh',
        args: ['hero', prim, mat],
      });
    });

    it('setMeshPosition / setMeshRotation / setMeshColor / setMeshVisible all record their mutations', () => {
      const h = renderer.createMesh('hero', prim);
      renderer.setMeshPosition(h, 1, 2, 3);
      renderer.setMeshRotation(h, 0.1, 0.2, 0.3);
      renderer.setMeshColor(h, 0.5, 0.5, 0.5);
      renderer.setMeshVisible(h, false);

      const methods = renderer.calls.map((c) => c.method);
      expect(methods).toEqual([
        'createMesh',
        'setMeshPosition',
        'setMeshRotation',
        'setMeshColor',
        'setMeshVisible',
      ]);
      // sanity-check the arg payload on a couple of them
      expect(renderer.calls[1].args).toEqual([h, 1, 2, 3]);
      expect(renderer.calls[4].args).toEqual([h, false]);
    });

    it('getMeshWorldPosition writes into out, returns it, and uses meshWorldPositions stub', () => {
      const h = renderer.createMesh('hero', prim);
      renderer.meshWorldPositions.set(h, [7, 8, 9]);
      const out: Vec3 = [0, 0, 0];
      const result = renderer.getMeshWorldPosition(h, out);
      expect(result).toBe(out);
      expect(out).toEqual([7, 8, 9]);
      expect(renderer.calls.some((c) => c.method === 'getMeshWorldPosition')).toBe(true);
    });

    it('getMeshWorldPosition defaults to origin when no stub is set', () => {
      const h = renderer.createMesh('hero', prim);
      const out: Vec3 = [99, 99, 99];
      renderer.getMeshWorldPosition(h, out);
      expect(out).toEqual([0, 0, 0]);
    });

    it('disposeMesh records the call with the handle', () => {
      const h = renderer.createMesh('hero', prim);
      renderer.disposeMesh(h);
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('disposeMesh');
      expect(last.args).toEqual([h]);
    });

    it('loadMesh records the call and resolves with the same id, a handle, and empty animationNames', async () => {
      const result = await renderer.loadMesh('robot', { url: '/models/robot.glb' });
      expect(result.meshId).toBe('robot');
      expect(result.handle).toBeDefined();
      expect(result.animationNames).toEqual([]);
      expect(renderer.calls[0]).toMatchObject({
        method: 'loadMesh',
        args: ['robot', { url: '/models/robot.glb' }],
      });
    });
  });

  describe('lights', () => {
    const dirSpec: DirectionalLightSpec = {
      direction: [-1, -2, -1],
      intensity: 1,
      diffuse: [1, 1, 1],
      specular: [1, 1, 1],
    };
    const hemSpec: HemisphericLightSpec = {
      direction: [0, 1, 0],
      intensity: 0.5,
      diffuse: [1, 1, 1],
      groundColor: [0, 0, 0],
      specular: [0, 0, 0],
    };

    it('createDirectionalLight and createHemisphericLight return handles and record calls', () => {
      const dir = renderer.createDirectionalLight('sun', dirSpec);
      const hem = renderer.createHemisphericLight('ambient', hemSpec);
      expect(dir).toBeDefined();
      expect(hem).toBeDefined();
      const methods = renderer.calls.map((c) => c.method);
      expect(methods).toEqual(['createDirectionalLight', 'createHemisphericLight']);
    });

    it('updateLightIntensity and disposeLight record the call with the handle', () => {
      const dir = renderer.createDirectionalLight('sun', dirSpec);
      renderer.updateLightIntensity(dir, 0.25);
      renderer.disposeLight(dir);
      expect(renderer.calls.map((c) => c.method)).toEqual([
        'createDirectionalLight',
        'updateLightIntensity',
        'disposeLight',
      ]);
      expect(renderer.calls[1].args).toEqual([dir, 0.25]);
    });
  });

  describe('cameras', () => {
    const camSpec: ArcCameraSpec = {
      alpha: 0,
      beta: Math.PI / 3,
      radius: 10,
      minRadius: 1,
      maxRadius: 50,
      minBeta: 0.1,
      maxBeta: Math.PI - 0.1,
      target: [0, 0, 0],
      inertia: 0.9,
      wheelPrecision: 50,
      angularSensibility: 1000,
    };

    it('createArcCamera seeds cameraAngles / cameraTargets and records the call', () => {
      const cam = renderer.createArcCamera('main', camSpec);
      expect(renderer.cameraAngles.get(cam)).toEqual({
        alpha: 0,
        beta: Math.PI / 3,
        radius: 10,
      });
      expect(renderer.cameraTargets.get(cam)).toEqual([0, 0, 0]);
      expect(renderer.calls[0].method).toBe('createArcCamera');
    });

    it('setCameraTarget mutates the stub and getCameraTarget reads it back', () => {
      const cam = renderer.createArcCamera('main', camSpec);
      renderer.setCameraTarget(cam, 5, 6, 7);
      const out: Vec3 = [0, 0, 0];
      renderer.getCameraTarget(cam, out);
      expect(out).toEqual([5, 6, 7]);
      expect(renderer.calls.some((c) => c.method === 'setCameraTarget')).toBe(true);
    });

    it('nudgeCameraAlpha / nudgeCameraRadius / nudgeCameraBeta update angles and record calls', () => {
      const cam = renderer.createArcCamera('main', camSpec);
      renderer.nudgeCameraAlpha(cam, 0.5);
      renderer.nudgeCameraRadius(cam, -2);
      renderer.nudgeCameraBeta(cam, -0.1);

      const angles = renderer.getCameraAngles(cam);
      expect(angles.alpha).toBeCloseTo(0.5);
      expect(angles.radius).toBeCloseTo(8);
      expect(angles.beta).toBeCloseTo(Math.PI / 3 - 0.1);

      const methods = renderer.calls.map((c) => c.method);
      expect(methods).toContain('nudgeCameraAlpha');
      expect(methods).toContain('nudgeCameraRadius');
      expect(methods).toContain('nudgeCameraBeta');
    });

    it('nudgeCameraRadius clamps to a small positive floor', () => {
      const cam = renderer.createArcCamera('main', camSpec);
      renderer.nudgeCameraRadius(cam, -9999);
      expect(renderer.getCameraAngles(cam).radius).toBeGreaterThan(0);
    });

    it('nudgeCameraTarget accumulates into cameraTargets', () => {
      const cam = renderer.createArcCamera('main', camSpec);
      renderer.nudgeCameraTarget(cam, 1, 0, 0);
      renderer.nudgeCameraTarget(cam, 0, 2, 0);
      expect(renderer.cameraTargets.get(cam)).toEqual([1, 2, 0]);
    });

    it('getCameraForward returns a unit vector derived from alpha', () => {
      const cam = renderer.createArcCamera('main', { ...camSpec, alpha: 0 });
      const out: Vec3 = [0, 0, 0];
      renderer.getCameraForward(cam, out);
      // alpha=0 → forward = (-1, 0, 0)
      expect(out[0]).toBeCloseTo(-1);
      expect(out[1]).toBe(0);
      expect(out[2]).toBeCloseTo(0);
    });
  });

  describe('shadows', () => {
    it('attachShadowCaster returns a handle and records caster + receive calls', () => {
      const light = renderer.createDirectionalLight('sun', {
        direction: [0, -1, 0],
        intensity: 1,
        diffuse: [1, 1, 1],
        specular: [1, 1, 1],
      });
      const mesh = renderer.createMesh('floor', { kind: 'ground', width: 10, height: 10 });
      const shadow = renderer.attachShadowCaster(light, mesh);
      renderer.setMeshReceiveShadows(mesh, true);
      renderer.detachShadowCaster(shadow);

      const methods = renderer.calls.map((c) => c.method);
      expect(methods).toEqual([
        'createDirectionalLight',
        'createMesh',
        'attachShadowCaster',
        'setMeshReceiveShadows',
        'detachShadowCaster',
      ]);
    });
  });

  describe('animation', () => {
    it('records play/stop/setWeight/setSpeed calls with their args', () => {
      renderer.playAnimation('hero', 'walk', true);
      renderer.setAnimationWeight('hero', 'walk', 0.7);
      renderer.setAnimationSpeed('hero', 'walk', 1.5);
      renderer.stopAnimation('hero', 'walk');

      expect(renderer.calls.map((c) => c.method)).toEqual([
        'playAnimation',
        'setAnimationWeight',
        'setAnimationSpeed',
        'stopAnimation',
      ]);
      expect(renderer.calls[0].args).toEqual(['hero', 'walk', true]);
      expect(renderer.calls[1].args).toEqual(['hero', 'walk', 0.7]);
    });
  });

  describe('labels', () => {
    it('records the full label lifecycle', () => {
      const spec: LabelSpec = { text: 'HP', color: [1, 1, 1], fontSize: 24 };
      const label = renderer.createLabel('hp', spec);
      renderer.setLabelText(label, 'HP 80');
      renderer.setLabelPosition(label, 0, 2, 0);
      renderer.setLabelColor(label, 1, 0, 0);
      renderer.setLabelAlpha(label, 0.8);
      renderer.setLabelScale(label, 1.5);
      renderer.setLabelVisible(label, false);
      renderer.disposeLabel(label);

      const methods = renderer.calls.map((c) => c.method);
      expect(methods).toEqual([
        'createLabel',
        'setLabelText',
        'setLabelPosition',
        'setLabelColor',
        'setLabelAlpha',
        'setLabelScale',
        'setLabelVisible',
        'disposeLabel',
      ]);
    });
  });

  describe('physics', () => {
    it('records body create / set velocity / step / destroy', () => {
      const opts: PhysicsBodyOpts = {
        shapeType: 'sphere',
        motionType: 'dynamic',
        mass: 1,
        friction: 0.3,
        restitution: 0.2,
        lockRotation: false,
      };
      renderer.physicsCreateBody('ball', opts);
      renderer.physicsSetBodyVelocity('ball', 0, -9.8, 0);
      renderer.physicsStep(1 / 60);
      renderer.physicsDestroyBody('ball');

      expect(renderer.calls.map((c) => c.method)).toEqual([
        'physicsCreateBody',
        'physicsSetBodyVelocity',
        'physicsStep',
        'physicsDestroyBody',
      ]);
      expect(renderer.calls[0].args).toEqual(['ball', opts]);
      expect(renderer.calls[2].args).toEqual([1 / 60]);
    });
  });

  describe('lifecycle', () => {
    it('startLoop / stopLoop / resize / dispose each record themselves with no args', () => {
      renderer.startLoop(() => undefined);
      renderer.resize();
      renderer.stopLoop();
      renderer.dispose();

      const entries = renderer.calls;
      expect(entries.map((c) => c.method)).toEqual([
        'startLoop',
        'resize',
        'stopLoop',
        'dispose',
      ]);
      // None of the lifecycle calls store positional args — they're bare markers.
      for (const e of entries) {
        expect(e.args).toEqual([]);
      }
    });
  });

  describe('calls log shape', () => {
    it('appends in chronological order and lets callers clear via calls.length = 0', () => {
      renderer.createMesh('a', { kind: 'box' });
      renderer.createMesh('b', { kind: 'sphere' });
      expect(renderer.calls).toHaveLength(2);

      // This pattern is used in contractTest.ts to reset between phases.
      renderer.calls.length = 0;
      expect(renderer.calls).toEqual([]);

      renderer.createMesh('c', { kind: 'cylinder' });
      expect(renderer.calls).toHaveLength(1);
      expect(renderer.calls[0].method).toBe('createMesh');
    });

    it('every entry exposes a method string and args array', () => {
      const h: MeshHandle = renderer.createMesh('x', { kind: 'box' });
      const light: LightHandle = renderer.createDirectionalLight('sun', {
        direction: [0, -1, 0],
        intensity: 1,
        diffuse: [1, 1, 1],
        specular: [1, 1, 1],
      });
      const cam: CameraHandle = renderer.createArcCamera('cam', {
        alpha: 0,
        beta: 1,
        radius: 5,
        minRadius: 1,
        maxRadius: 10,
        minBeta: 0,
        maxBeta: Math.PI,
        target: [0, 0, 0],
        inertia: 0.9,
        wheelPrecision: 50,
        angularSensibility: 1000,
      });

      // The handles themselves are opaque; we just confirm the bookkeeping
      // entries are shaped as documented.
      for (const entry of renderer.calls) {
        expect(typeof entry.method).toBe('string');
        expect(Array.isArray(entry.args)).toBe(true);
      }

      // Use the handles so the linter doesn't complain.
      expect(h).toBeDefined();
      expect(light).toBeDefined();
      expect(cam).toBeDefined();
    });
  });
});
