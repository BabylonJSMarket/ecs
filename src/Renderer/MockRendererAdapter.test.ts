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
  ParticleEmitterSpec,
  PerspectiveCameraSpec,
  PhysicsBodyOpts,
  PrimitiveSpec,
  ProceduralMeshSpec,
  Quaternion,
  ScreenPoint,
  SkyboxSpec,
  SunSpec,
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

    it('init() surfaces the passed canvas through getRenderingCanvas', async () => {
      const fakeCanvas = {} as HTMLCanvasElement;
      await renderer.init(fakeCanvas);
      expect(renderer.getRenderingCanvas()).toBe(fakeCanvas);
    });

    it('init(null) leaves getRenderingCanvas null (no canvas in headless tests)', async () => {
      await renderer.init(null as any);
      expect(renderer.getRenderingCanvas()).toBeNull();
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

    it('records the full `tube` primitive spec so silo-wall Systems can be asserted', () => {
      // The silo wall is an open-ended cylinder shell; render Systems emit it
      // via createMesh({kind:'tube',...}) and tests assert on the recorded spec.
      const tubePrim: PrimitiveSpec = {
        kind: 'tube',
        diameter: 2,
        height: 3,
        thickness: 0.15,
        tessellation: 32,
      };
      const h = renderer.createMesh('building.silo', tubePrim, mat);
      expect(h).toBeDefined();
      expect(renderer.calls[0]).toMatchObject({
        method: 'createMesh',
        args: ['building.silo', tubePrim, mat],
      });
      // The exact spec object is preserved (kind + every param), not a copy.
      expect(renderer.calls[0].args[1]).toBe(tubePrim);
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

  describe('skeleton stub', () => {
    it('setMockBones seeds a rig that listBones/getBoneWorldPose answer from', () => {
      renderer.setMockBones('hero', [
        { name: 'Hips' },
        { name: 'LeftHand', position: [0.4, 1.2, 0.1], orientation: { x: 0, y: 1, z: 0, w: 0 } },
      ]);

      expect(renderer.listBones('hero')).toEqual(['Hips', 'LeftHand']);

      const outPos: Vec3 = [0, 0, 0];
      const outQ = { x: 0, y: 0, z: 0, w: 1 };
      expect(renderer.getBoneWorldPose('hero', 'LeftHand', outPos, outQ)).toBe(true);
      expect(outPos).toEqual([0.4, 1.2, 0.1]);
      expect(outQ).toEqual({ x: 0, y: 1, z: 0, w: 0 });

      // Unseeded bone on a seeded mesh still misses cleanly.
      expect(renderer.getBoneWorldPose('hero', 'Tail', outPos, outQ)).toBe(false);
    });

    it('setMeshOrientation stores the last quaternion per handle for assertions', () => {
      const h = renderer.createMesh('spinner', { kind: 'box' });
      renderer.setMeshOrientation(h, { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 });
      expect(renderer.meshOrientations.get(h)).toEqual({
        x: 0,
        y: Math.SQRT1_2,
        z: 0,
        w: Math.SQRT1_2,
      });
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

    it('records the optional background / borderColor sign-plate fields', () => {
      // Building signs carry a filled plate + border behind the text; render
      // Systems set them on the LabelSpec and tests assert the recorded call.
      const signSpec: LabelSpec = {
        text: 'Saloon',
        fontSize: 26,
        background: 'rgba(15, 23, 42, 0.88)',
        borderColor: 'rgba(148, 163, 184, 0.95)',
      };
      renderer.createLabel('sign.bar', signSpec);
      expect(renderer.calls[0]).toMatchObject({
        method: 'createLabel',
        args: ['sign.bar', signSpec],
      });
      const recorded = renderer.calls[0].args[1] as LabelSpec;
      expect(recorded.background).toBe('rgba(15, 23, 42, 0.88)');
      expect(recorded.borderColor).toBe('rgba(148, 163, 184, 0.95)');
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

  describe('mesh extended operations', () => {
    const prim: PrimitiveSpec = { kind: 'box', width: 1, height: 1, depth: 1 };

    it('setMeshScale records the call with the handle and scale args', () => {
      const h = renderer.createMesh('block', prim);
      renderer.setMeshScale(h, 2, 3, 4);
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('setMeshScale');
      expect(last.args).toEqual([h, 2, 3, 4]);
    });

    it('replaceMeshGeometry records the call with the geometry', () => {
      const h = renderer.createMesh('block', prim);
      const geom = { positions: [0, 1, 2], indices: [0, 1, 2], normals: [0, 1, 0] };
      renderer.replaceMeshGeometry(h, geom as any);
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('replaceMeshGeometry');
      expect(last.args[1]).toBe(geom);
    });

    it('setMeshBillboardMode records the call with the mode', () => {
      const h = renderer.createMesh('sprite', prim);
      renderer.setMeshBillboardMode(h, 'all');
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('setMeshBillboardMode');
      expect(last.args).toEqual([h, 'all']);
    });

    it('setMeshBoundingBoxExtents stores extents and records the call', () => {
      const h = renderer.createMesh('block', prim);
      const min: Vec3 = [-1, -1, -1];
      const max: Vec3 = [1, 1, 1];
      renderer.setMeshBoundingBoxExtents(h, min, max);
      const stored = renderer.meshBoundingExtents.get(h);
      expect(stored).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] });
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('setMeshBoundingBoxExtents');
    });

    it('getMeshBoundingBoxExtents returns stored extents after set', () => {
      const h = renderer.createMesh('block', prim);
      renderer.setMeshBoundingBoxExtents(h, [-2, -2, -2], [2, 2, 2]);
      const result = renderer.getMeshBoundingBoxExtents(h);
      expect(result).toEqual({ min: [-2, -2, -2], max: [2, 2, 2] });
      expect(renderer.calls.some((c) => c.method === 'getMeshBoundingBoxExtents')).toBe(true);
    });

    it('getMeshBoundingBoxExtents returns null when no extents set', () => {
      const h = renderer.createMesh('block', prim);
      const result = renderer.getMeshBoundingBoxExtents(h);
      expect(result).toBeNull();
    });

    it('setMeshPosition round-trips through getMeshWorldPosition', () => {
      const h = renderer.createMesh('hero', prim);
      renderer.setMeshPosition(h, 5, 10, 15);
      const out: Vec3 = [0, 0, 0];
      renderer.getMeshWorldPosition(h, out);
      expect(out).toEqual([5, 10, 15]);
    });
  });

  describe('line system', () => {
    it('createLineSystem returns a handle, stores the lines, and records the call', () => {
      const lines: Vec3[][] = [[[0, 0, 0], [1, 1, 1]]];
      const h = renderer.createLineSystem('path', lines, [1, 0, 0]);
      expect(h).toBeDefined();
      const stored = renderer.lineSystems.get(h);
      expect(stored).toBeDefined();
      expect(stored!.lines).toEqual(lines);
      expect(stored!.color).toEqual([1, 0, 0]);
      expect(stored!.visible).toBe(true);
      expect(renderer.calls[0].method).toBe('createLineSystem');
    });

    it('updateLineSystem mutates stored lines and color', () => {
      const h = renderer.createLineSystem('path', [[[0, 0, 0], [1, 0, 0]]]);
      const newLines: Vec3[][] = [[[2, 2, 2], [3, 3, 3]]];
      renderer.updateLineSystem(h, newLines, [0, 1, 0]);
      const stored = renderer.lineSystems.get(h);
      expect(stored!.lines).toEqual(newLines);
      expect(stored!.color).toEqual([0, 1, 0]);
      expect(renderer.calls.some((c) => c.method === 'updateLineSystem')).toBe(true);
    });

    it('updateLineSystem on unknown handle records the call without throwing', () => {
      const fakeHandle = { __mockHandle: 'lineSystem:ghost' } as any;
      const lines: Vec3[][] = [[[0, 0, 0], [1, 0, 0]]];
      renderer.updateLineSystem(fakeHandle, lines);
      expect(renderer.calls[0].method).toBe('updateLineSystem');
    });

    it('updateLineSystem without color does not overwrite existing color', () => {
      const h = renderer.createLineSystem('path', [[[0, 0, 0], [1, 0, 0]]], [1, 0, 0]);
      renderer.updateLineSystem(h, [[[5, 5, 5], [6, 6, 6]]]);
      const stored = renderer.lineSystems.get(h);
      expect(stored!.color).toEqual([1, 0, 0]); // unchanged
    });

    it('setLineSystemVisible mutates the visible flag', () => {
      const h = renderer.createLineSystem('path', []);
      renderer.setLineSystemVisible(h, false);
      expect(renderer.lineSystems.get(h)!.visible).toBe(false);
      expect(renderer.calls.some((c) => c.method === 'setLineSystemVisible')).toBe(true);
    });

    it('setLineSystemVisible on unknown handle records the call without throwing', () => {
      const fakeHandle = { __mockHandle: 'lineSystem:ghost' } as any;
      renderer.setLineSystemVisible(fakeHandle, true);
      expect(renderer.calls[0].method).toBe('setLineSystemVisible');
    });

    it('disposeLineSystem removes the entry from lineSystems', () => {
      const h = renderer.createLineSystem('path', []);
      renderer.disposeLineSystem(h);
      expect(renderer.lineSystems.has(h)).toBe(false);
      expect(renderer.calls.some((c) => c.method === 'disposeLineSystem')).toBe(true);
    });
  });

  describe('cameras extended', () => {
    const camSpec: ArcCameraSpec = {
      alpha: Math.PI / 4,
      beta: Math.PI / 3,
      radius: 10,
      minRadius: 1,
      maxRadius: 50,
      minBeta: 0.1,
      maxBeta: Math.PI - 0.1,
      target: [1, 2, 3],
      inertia: 0.9,
      wheelPrecision: 50,
      angularSensibility: 1000,
    };

    it('setCameraRadius sets the radius directly', () => {
      const cam = renderer.createArcCamera('main', camSpec);
      renderer.setCameraRadius(cam, 25);
      expect(renderer.getCameraAngles(cam).radius).toBe(25);
      expect(renderer.calls.some((c) => c.method === 'setCameraRadius')).toBe(true);
    });

    it('setCameraRadius on unknown handle records the call without throwing', () => {
      const fakeHandle = { __mockHandle: 'arcCamera:ghost' } as any;
      renderer.setCameraRadius(fakeHandle, 10);
      expect(renderer.calls[0].method).toBe('setCameraRadius');
    });

    it('setCameraRadiusLimits records the call with min and max', () => {
      const cam = renderer.createArcCamera('main', camSpec);
      renderer.setCameraRadiusLimits(cam, 2, 30);
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('setCameraRadiusLimits');
      expect(last.args).toEqual([cam, 2, 30]);
    });

    it('setCameraFov records the call with the fov value', () => {
      const cam = renderer.createArcCamera('main', camSpec);
      renderer.setCameraFov(cam, 0.8);
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('setCameraFov');
      expect(last.args).toEqual([cam, 0.8]);
    });

    it('setCameraControlsEnabled records the call with the enabled flag', () => {
      const cam = renderer.createArcCamera('main', camSpec);
      renderer.setCameraControlsEnabled(cam, false);
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('setCameraControlsEnabled');
      expect(last.args).toEqual([cam, false]);
    });

    it('getCameraTarget returns origin when no camera registered', () => {
      const fakeHandle = { __mockHandle: 'arcCamera:ghost' } as any;
      const out: Vec3 = [99, 99, 99];
      renderer.getCameraTarget(fakeHandle, out);
      expect(out).toEqual([0, 0, 0]);
    });

    it('getCameraAngles returns zeros when no camera registered', () => {
      const fakeHandle = { __mockHandle: 'arcCamera:ghost' } as any;
      const angles = renderer.getCameraAngles(fakeHandle);
      expect(angles).toEqual({ alpha: 0, beta: 0, radius: 0 });
    });

    it('getCameraForward falls back to alpha=0 for unknown camera', () => {
      const fakeHandle = { __mockHandle: 'arcCamera:ghost' } as any;
      const out: Vec3 = [0, 0, 0];
      renderer.getCameraForward(fakeHandle, out);
      // alpha=0 → forward = (-cos0, 0, -sin0) = (-1, 0, 0)
      expect(out[0]).toBeCloseTo(-1);
      expect(out[2]).toBeCloseTo(0);
    });

    it('getCameraRight returns a vector perpendicular to forward', () => {
      const cam = renderer.createArcCamera('main', { ...camSpec, alpha: 0 });
      const out: Vec3 = [0, 0, 0];
      renderer.getCameraRight(cam, out);
      // alpha=0 → right = (sin0, 0, -cos0) = (0, 0, -1)
      expect(out[0]).toBeCloseTo(0);
      expect(out[1]).toBe(0);
      expect(out[2]).toBeCloseTo(-1);
    });

    it('getCameraRight falls back to alpha=0 for an unknown camera', () => {
      const fakeHandle = { __mockHandle: 'arcCamera:ghost' } as any;
      const out: Vec3 = [0, 0, 0];
      renderer.getCameraRight(fakeHandle, out);
      // No stored angles → alpha=0 → right = (sin0, 0, -cos0) = (0, 0, -1)
      expect(out[0]).toBeCloseTo(0);
      expect(out[1]).toBe(0);
      expect(out[2]).toBeCloseTo(-1);
    });

    it('screenToWorldPoint falls back to a zero target for an unknown camera', () => {
      const fakeHandle = { __mockHandle: 'arcCamera:ghost' } as any;
      const out: Vec3 = [9, 9, 9];
      const result = renderer.screenToWorldPoint(fakeHandle, 0.5, 0.5, 10, out);
      // No stored target → origin [0,0,0]; alpha=0 forward = (-1,0,0) * 10
      expect(result).toBe(out);
      expect(out[0]).toBeCloseTo(-10);
      expect(out[1]).toBeCloseTo(0);
      expect(out[2]).toBeCloseTo(0);
    });

    it('nudgeCameraAlpha / nudgeCameraRadius / nudgeCameraBeta on unknown handle record without throwing', () => {
      const fakeHandle = { __mockHandle: 'arcCamera:ghost' } as any;
      renderer.nudgeCameraAlpha(fakeHandle, 0.1);
      renderer.nudgeCameraRadius(fakeHandle, 1);
      renderer.nudgeCameraBeta(fakeHandle, 0.1);
      const methods = renderer.calls.map((c) => c.method);
      expect(methods).toContain('nudgeCameraAlpha');
      expect(methods).toContain('nudgeCameraRadius');
      expect(methods).toContain('nudgeCameraBeta');
    });

    it('nudgeCameraBeta clamps to (0.01, π − 0.01)', () => {
      const cam = renderer.createArcCamera('main', { ...camSpec, beta: Math.PI / 2 });
      renderer.nudgeCameraBeta(cam, 9999);
      expect(renderer.getCameraAngles(cam).beta).toBeLessThan(Math.PI);
      renderer.nudgeCameraBeta(cam, -9999);
      expect(renderer.getCameraAngles(cam).beta).toBeGreaterThan(0);
    });

    it('nudgeCameraTarget on unknown handle creates and records a new entry', () => {
      const fakeHandle = { __mockHandle: 'arcCamera:ghost' } as any;
      renderer.nudgeCameraTarget(fakeHandle, 1, 2, 3);
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('nudgeCameraTarget');
    });
  });

  describe('picking', () => {
    it('pickAtScreenPoint returns null and records the call', () => {
      const result = renderer.pickAtScreenPoint(320, 240);
      expect(result).toBeNull();
      expect(renderer.calls[0]).toMatchObject({ method: 'pickAtScreenPoint', args: [320, 240, undefined] });
    });

    it('pickAtScreenPoint passes opts through to the call record', () => {
      renderer.pickAtScreenPoint(100, 200, { meshFilter: () => true } as any);
      expect(renderer.calls[0].args[2]).toBeDefined();
    });
  });

  describe('instanced models', () => {
    it('loadModelTemplate resolves with animationNames from the stub', async () => {
      renderer.modelTemplateAnimationNames = ['idle', 'walk', 'run'];
      const result = await renderer.loadModelTemplate('/models/hero.glb');
      expect(result.animationNames).toEqual(['idle', 'walk', 'run']);
      expect(renderer.calls[0]).toMatchObject({ method: 'loadModelTemplate', args: ['/models/hero.glb', undefined] });
    });

    it('loadModelTemplate passes opts through to the call record', async () => {
      await renderer.loadModelTemplate('/models/hero.glb', { lockRootMotion: true } as any);
      expect(renderer.calls[0].args[1]).toMatchObject({ lockRootMotion: true });
    });

    it('instantiateModel returns a handle and records the call', () => {
      const h = renderer.instantiateModel('hero1', '/models/hero.glb', { position: [1, 0, 0] } as any);
      expect(h).toBeDefined();
      const last = renderer.calls[0];
      expect(last.method).toBe('instantiateModel');
      expect(last.args[0]).toBe('hero1');
    });

    it('setModelVisible / setModelAlpha / disposeModel record their calls', () => {
      const h = renderer.instantiateModel('hero1', '/models/hero.glb');
      renderer.setModelVisible(h, false);
      renderer.setModelAlpha('hero1', 0.5);
      renderer.disposeModel('hero1', h);
      const methods = renderer.calls.map((c) => c.method);
      expect(methods).toContain('setModelVisible');
      expect(methods).toContain('setModelAlpha');
      expect(methods).toContain('disposeModel');
    });

    it('playAnimationOnce returns animationOnceDuration and records the call', () => {
      renderer.animationOnceDuration = 1.5;
      const dur = renderer.playAnimationOnce('hero1', 'attack');
      expect(dur).toBe(1.5);
      expect(renderer.calls[0]).toMatchObject({ method: 'playAnimationOnce', args: ['hero1', 'attack'] });
    });
  });

  describe('skybox', () => {
    const skySpec: SkyboxSpec = {
      zenithColor: [0.4, 0.7, 1.0],
      horizonColor: [1, 1, 1],
      groundColor: [0.2, 0.2, 0.2],
      sunColor: [1, 1, 0.9],
      sunDirection: [0, 1, 0],
    };

    it('createSkybox returns a handle and records the call', () => {
      const h = renderer.createSkybox('sky1', skySpec);
      expect(h).toBeDefined();
      expect(renderer.calls[0]).toMatchObject({ method: 'createSkybox', args: ['sky1', skySpec] });
    });

    it('updateSkyboxSun records the call with direction and color', () => {
      const h = renderer.createSkybox('sky1', skySpec);
      renderer.updateSkyboxSun(h, [0, -1, 0], [1, 1, 0.8]);
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('updateSkyboxSun');
      expect(last.args[1]).toEqual([0, -1, 0]);
    });

    it('disposeSkybox records the call', () => {
      const h = renderer.createSkybox('sky1', skySpec);
      renderer.disposeSkybox(h);
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('disposeSkybox');
      expect(last.args).toEqual([h]);
    });
  });

  describe('environment and materials', () => {
    it('setEnvironmentTexture records the call with url and opts', () => {
      renderer.setEnvironmentTexture('/env/studio.hdr', { rotationY: 0.5 } as any);
      expect(renderer.calls[0]).toMatchObject({ method: 'setEnvironmentTexture', args: ['/env/studio.hdr', { rotationY: 0.5 }] });
    });

    it('clearEnvironmentTexture records the call with no args', () => {
      renderer.clearEnvironmentTexture();
      expect(renderer.calls[0]).toMatchObject({ method: 'clearEnvironmentTexture', args: [] });
    });

    it('point lights record their spec and round-trip their position', () => {
      const h = renderer.createPointLight('neon', {
        position: [1, 2, 3],
        intensity: 4,
        diffuse: [1, 0.2, 0.6],
        range: 7,
      });
      expect(renderer.getLightPosition(h)).toEqual([1, 2, 3]);
      renderer.setLightPosition(h, -5, 1.5, 0);
      expect(renderer.getLightPosition(h)).toEqual([-5, 1.5, 0]);
      const methods = renderer.calls.map((c) => c.method);
      expect(methods).toContain('createPointLight');
      expect(methods).toContain('setLightPosition');
    });

    it('getLightPosition is undefined for a light it never placed', () => {
      const h = renderer.createHemisphericLight('ambient', {
        direction: [0, 1, 0],
        intensity: 1,
        diffuse: [1, 1, 1],
        groundColor: [0, 0, 0],
        specular: [0, 0, 0],
      });
      expect(renderer.getLightPosition(h)).toBeUndefined();
    });

    it('applyPbrMaterial records the call with handle and spec', () => {
      const h = renderer.createMesh('sphere', { kind: 'sphere', diameter: 1 });
      const spec = { albedoColor: [1, 0, 0], metallic: 0.8, roughness: 0.2 };
      renderer.applyPbrMaterial(h, spec as any);
      const last = renderer.calls[renderer.calls.length - 1];
      expect(last.method).toBe('applyPbrMaterial');
      expect(last.args[0]).toBe(h);
      expect(last.args[1]).toBe(spec);
    });
  });

  describe('physics extended', () => {
    const opts: PhysicsBodyOpts = {
      shapeType: 'box',
      motionType: 'dynamic',
      mass: 1,
      friction: 0.5,
      restitution: 0.3,
      lockRotation: true,
    };

    it('physicsCreateBody does not overwrite an existing body snapshot', () => {
      renderer.physicsCreateBody('cube', opts);
      renderer.physicsBodies.set('cube' as any, {
        position: [5, 5, 5],
        rotation: [0, 0, 0],
        linearVelocity: [1, 0, 0],
        angularVelocity: [0, 0, 0],
      });
      // calling again should not reset the preloaded values
      renderer.physicsCreateBody('cube', opts);
      expect(renderer.physicsBodies.get('cube' as any)!.position).toEqual([5, 5, 5]);
    });

    it('physicsSetPaused sets the physicsPaused flag and records the call', () => {
      renderer.physicsSetPaused(true);
      expect(renderer.physicsPaused).toBe(true);
      renderer.physicsSetPaused(false);
      expect(renderer.physicsPaused).toBe(false);
      const methods = renderer.calls.map((c) => c.method);
      expect(methods).toEqual(['physicsSetPaused', 'physicsSetPaused']);
    });

    it('physicsGetBodyState returns null for an unregistered mesh', () => {
      const result = renderer.physicsGetBodyState('ghost');
      expect(result).toBeNull();
      expect(renderer.calls[0].method).toBe('physicsGetBodyState');
    });

    it('physicsGetBodyState returns a snapshot copy for a registered body', () => {
      renderer.physicsCreateBody('ball', { ...opts, shapeType: 'sphere' });
      renderer.physicsBodies.set('ball' as any, {
        position: [1, 2, 3],
        rotation: [0.1, 0.2, 0.3],
        linearVelocity: [4, 5, 6],
        angularVelocity: [0, 0.1, 0],
      });
      const snap = renderer.physicsGetBodyState('ball');
      expect(snap).not.toBeNull();
      expect(snap!.position).toEqual([1, 2, 3]);
      expect(snap!.linearVelocity).toEqual([4, 5, 6]);
    });

    it('physicsSetBodyState persists the snapshot and records the call', () => {
      renderer.physicsCreateBody('ball', { ...opts, shapeType: 'sphere' });
      const state = {
        position: [10, 20, 30] as Vec3,
        rotation: [0, 0, 0] as Vec3,
        linearVelocity: [1, 2, 3] as Vec3,
        angularVelocity: [0, 0, 0] as Vec3,
      };
      renderer.physicsSetBodyState('ball', state);
      const snap = renderer.physicsGetBodyState('ball');
      expect(snap!.position).toEqual([10, 20, 30]);
      expect(renderer.calls.some((c) => c.method === 'physicsSetBodyState')).toBe(true);
    });

    it('physicsSetBodyAngularVelocity records the call with the velocity args', () => {
      renderer.physicsSetBodyAngularVelocity('cube', 0.1, 0.2, 0.3);
      const last = renderer.calls[0];
      expect(last.method).toBe('physicsSetBodyAngularVelocity');
      expect(last.args).toEqual(['cube', 0.1, 0.2, 0.3]);
    });

    it('physicsSetBodyDrivenByMesh records the call with the flag', () => {
      renderer.physicsSetBodyDrivenByMesh('cube', true);
      expect(renderer.calls[0]).toMatchObject({ method: 'physicsSetBodyDrivenByMesh', args: ['cube', true] });
    });

    it('physicsSetGravity records the call with x y z', () => {
      renderer.physicsSetGravity(0, -9.8, 0);
      expect(renderer.calls[0]).toMatchObject({ method: 'physicsSetGravity', args: [0, -9.8, 0] });
    });

    it('physicsResizeBoxBody records the call with meshId and halfExtents', () => {
      renderer.physicsResizeBoxBody('cube', [0.5, 0.5, 0.5]);
      expect(renderer.calls[0]).toMatchObject({ method: 'physicsResizeBoxBody', args: ['cube', [0.5, 0.5, 0.5]] });
    });

    it('physicsSetTimeStep records the call with the hz value', () => {
      renderer.physicsSetTimeStep(120);
      expect(renderer.calls[0]).toMatchObject({ method: 'physicsSetTimeStep', args: [120] });
    });

    it('physicsSetRestitution records the call with meshId and restitution', () => {
      renderer.physicsSetRestitution('ball', 0.9);
      expect(renderer.calls[0]).toMatchObject({ method: 'physicsSetRestitution', args: ['ball', 0.9] });
    });

    it('setCollidersVisible records the call with the visible flag', () => {
      renderer.setCollidersVisible(true);
      expect(renderer.calls[0]).toMatchObject({ method: 'setCollidersVisible', args: [true] });
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

  // Mock-specific branches the shared contract can't reach because its `persp`
  // spec has no position/orientation, it always creates a camera before
  // projecting, and it never samples a rock with a seed omitted or a zero-length
  // direction. These pin the default/guard paths in the Mock's own bookkeeping.
  describe('perspective camera + projection edge branches', () => {
    it('createPerspectiveCamera copies an explicit position + orientation into the record', () => {
      const spec: PerspectiveCameraSpec = {
        fov: Math.PI / 3,
        near: 0.1,
        far: 100000,
        position: [3, -4, 5],
        orientation: { x: 0, y: 0.7071068, z: 0, w: 0.7071068 },
      };
      const h = renderer.createPerspectiveCamera('posed', spec);
      const outPos: Vec3 = [0, 0, 0];
      const outQ: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
      renderer.getCameraPose(h, outPos, outQ);
      expect(outPos).toEqual([3, -4, 5]);
      expect(outQ.y).toBeCloseTo(0.7071068, 6);
      expect(outQ.w).toBeCloseTo(0.7071068, 6);
    });

    it('getCameraPose no-ops on an unknown handle, leaving out params untouched', () => {
      const outPos: Vec3 = [1, 2, 3];
      const outQ: Quaternion = { x: 9, y: 9, z: 9, w: 9 };
      // A handle the adapter never minted → early return, out params unchanged.
      renderer.getCameraPose({} as unknown as CameraHandle, outPos, outQ);
      expect(outPos).toEqual([1, 2, 3]);
      expect(outQ).toEqual({ x: 9, y: 9, z: 9, w: 9 });
    });

    it('worldToScreen returns false and leaves out untouched when no perspective camera exists', () => {
      const fresh = new MockRendererAdapter();
      const out: ScreenPoint = { x: 42, y: 42 };
      expect(fresh.worldToScreen(1, 2, 3, out)).toBe(false);
      expect(out).toEqual({ x: 42, y: 42 }); // no active camera → untouched
    });
  });

  describe('procedural surface guard branches', () => {
    it('sampleProceduralSurface defaults a missing seed and tolerates a zero-length direction', () => {
      // No `seed` → the `?? 1` default; a [0,0,0] dir → the `hypot || 1` guard.
      const spec: ProceduralMeshSpec = { shape: 'asteroid', size: [10, 0, 0] };
      const out: Vec3 = [0, 0, 0];
      const ret = renderer.sampleProceduralSurface(spec, 0, 0, 0, out);
      expect(ret).toBe(out);
      expect(out.every(Number.isFinite)).toBe(true);
      // Deterministic for the defaulted seed.
      const again: Vec3 = [0, 0, 0];
      renderer.sampleProceduralSurface(spec, 0, 0, 0, again);
      expect(again).toEqual(out);
    });
  });

  describe('particle + sun guard branches', () => {
    it('createParticleEmitter copies an explicit spec.position into the record', () => {
      const spec: ParticleEmitterSpec = {
        texture: renderer.createDynamicTexture('dot', { width: 2, height: 2, pixels: new Uint8ClampedArray(2 * 2 * 4).fill(255), hasAlpha: true }),
        capacity: 100,
        emitRate: 100,
        emitRadius: 1,
        minSize: 0.1,
        maxSize: 0.2,
        minLifeTime: 1,
        maxLifeTime: 2,
        minEmitPower: 0,
        maxEmitPower: 0,
        color1: [1, 1, 1, 1],
        color2: [1, 1, 1, 1],
        colorDead: [0, 0, 0, 0],
        blend: 'add',
        position: [7, 8, 9],
      };
      const h = renderer.createParticleEmitter('seeded', spec);
      expect(renderer.particleEmitters.get(h)?.position).toEqual([7, 8, 9]);
    });

    it('createSun tolerates a zero-length direction via the hypot guard', () => {
      const spec: SunSpec = {
        direction: [0, 0, 0], // degenerate → hypot || 1 keeps the readback finite
        distance: 1000,
        intensity: 1,
        diffuse: [1, 1, 1],
        specular: [1, 1, 1],
        discDiameter: 10,
        discColor: [1, 1, 1],
      };
      renderer.createSun('degenerate-sun', spec);
      const out: Vec3 = [7, 7, 7];
      const ret = renderer.getSunWorldPosition(out);
      expect(ret).toBe(out);
      // -(0/1)*distance on every axis → a finite (signed) zero, not NaN.
      expect(out.every(v => Number.isFinite(v) && v === 0)).toBe(true);
    });
  });
});

describe('MockRendererAdapter.getMeshWorldBounds', () => {
  it('hands back bounds a test seeded, so code that reads real art is exercisable', () => {
    // A mock holds no geometry, so this map is how a test stands in for a loaded
    // hull — which is what lets a HUD's "bracket the art, not the transform"
    // path be tested at all without an engine.
    const adapter = new MockRendererAdapter();
    adapter.meshWorldBounds.set('ship', { min: [-1, -2, -3], max: [4, 5, 6] });

    const min: Vec3 = [0, 0, 0];
    const max: Vec3 = [0, 0, 0];
    expect(adapter.getMeshWorldBounds('ship', min, max)).toBe(true);
    expect(min).toEqual([-1, -2, -3]);
    expect(max).toEqual([4, 5, 6]);
  });
});
