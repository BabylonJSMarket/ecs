/**
 * runRendererAdapterContract — shared Vitest battery proving a RendererAdapter
 * implementation honors the framework's behavior contract.
 *
 * Each adapter — Mock, Babylon (via NullEngine), Three, or any future binding
 * — lives or dies by the same set of round-trip and lifecycle invariants. If
 * Mock and Babylon silently drift apart, downstream Systems pass tests
 * locally then break in the browser. This suite is the one place that
 * catches that.
 *
 * Usage from a `*.contract.test.ts`:
 *
 *   runRendererAdapterContract('Babylon', () => new BabylonAdapter(new NullEngine()));
 *
 * The contract is intentionally CONSERVATIVE — only invariants every adapter
 * MUST satisfy. Adapter-specific quirks (Babylon's beta clamping, Three's
 * scene-graph order, …) belong in that adapter's own unit-test file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  ArcCameraSpec,
  CardMeshSpec,
  DirectionalLightSpec,
  HemisphericLightSpec,
  LabelSpec,
  MaterialSpec,
  PerspectiveCameraSpec,
  PickResult,
  PrimitiveSpec,
  Quaternion,
  RendererAdapter,
  ScreenPoint,
  ThinFieldSpec,
  Vec3,
} from './types';

export interface RendererAdapterContractOptions {
  /**
   * Adapters that don't ship a Canvas implementation in the test environment
   * (Three under jsdom with a stubbed WebGL) can opt out of label readbacks
   * that require a real 2D drawing context. Default false — Mock and Babylon
   * NullEngine both satisfy the label contract.
   */
  skipLabels?: boolean;
  /**
   * Adapters whose physics layer requires an external engine that the test
   * environment can't provide (e.g., Havok WASM under node) can skip the
   * physics smoke tests. Default false.
   */
  skipPhysics?: boolean;
  /**
   * Engine adapters (Babylon/Three) can't fetch a real GLB in the headless test
   * environment, so `loadThinField` can't be exercised against them here — set
   * this to skip the thin-field load/update/dispose test. The Mock adapter runs
   * the full sequence. Default false. (`screenToWorldPoint` is NOT gated — every
   * adapter is exercised for it.)
   */
  skipThinField?: boolean;
  /**
   * Engine adapters can't fetch a real GLB headlessly, so they skip the
   * `loadMesh` contract. The Mock adapter (no I/O — it synthesizes a handle)
   * runs it. Default false. Engine-backed loadMesh is covered by the browser
   * comparison demo instead.
   */
  skipMeshLoad?: boolean;
  /**
   * Engine adapters can't fetch a real image headlessly, so the `loadTexture`
   * round-trip + dedupe assertion is gated behind this flag. The card
   * create/set-face/dispose smoke sequence still runs on EVERY adapter (no real
   * fetch needed — front/back default to undefined). The Mock adapter (no I/O —
   * it key-dedupes a synthesized handle) runs the load assertion. Default false.
   */
  skipTextureLoad?: boolean;
  /**
   * Engine adapters can't run a meaningful screen projection in the headless
   * test env (Babylon's NullEngine reports a zero-size viewport; Three under
   * jsdom has no real canvas) — and Babylon/BabylonLite vs Three disagree on the
   * identity-camera forward axis (+Z vs −Z), so a fixed in-front/behind point
   * isn't engine-agnostic. Set this to skip the NUMERIC `worldToScreen`
   * assertions (in-front projection + behind→false). The Mock adapter (a
   * deterministic Babylon-convention pinhole) runs the full battery as the
   * reference; engines still run a no-throw smoke check. The pose round-trip and
   * floating-origin round-trip are NOT gated — every adapter runs those. Default
   * false.
   */
  skipProjection?: boolean;
  /**
   * Optional async setup hook called once per test (after the factory). Use
   * it to drive `adapter.init(canvas)` if the adapter is engine-coupled.
   */
  setup?: (adapter: RendererAdapter) => Promise<void> | void;
}

/**
 * Install the renderer-adapter contract suite inside a `describe(name, ...)`
 * block. Call once per adapter under test.
 *
 * @param name    Display name (e.g. "Babylon", "Mock"). Becomes the describe label.
 * @param factory Producer that returns a FRESH adapter on every call. The
 *                suite calls it once per test inside `beforeEach`.
 * @param options Optional per-adapter skip flags (see interface).
 */
export function runRendererAdapterContract(
  name: string,
  factory: () => RendererAdapter,
  options: RendererAdapterContractOptions = {},
): void {
  describe(`RendererAdapter contract: ${name}`, () => {
    let adapter: RendererAdapter;

    beforeEach(async () => {
      adapter = factory();
      if (options.setup) {
        await options.setup(adapter);
      }
    });

    afterEach(() => {
      // Adapters MUST tolerate dispose even if the suite didn't init().
      // We swallow throws here so a broken `dispose()` shows up as the
      // explicit lifecycle test below rather than every test failing.
      // Defensive teardown — the throwing-dispose path is covered there, not here.
      /* v8 ignore start */
      try {
        adapter.dispose();
      } catch {
        /* swallow */
      }
      /* v8 ignore stop */
    });

    // ---------------------------------------------------------------------
    // Identity
    // ---------------------------------------------------------------------
    describe('identity', () => {
      it('exposes a non-empty `kind` string', () => {
        expect(typeof adapter.kind).toBe('string');
        expect(adapter.kind.length).toBeGreaterThan(0);
      });
    });

    // ---------------------------------------------------------------------
    // Mesh
    // ---------------------------------------------------------------------
    describe('mesh', () => {
      const prim: PrimitiveSpec = { kind: 'box', width: 1, height: 1, depth: 1 };
      const mat: MaterialSpec = { diffuse: [0.5, 0.5, 0.5] };

      it('createMesh returns distinct handles for distinct ids', () => {
        const a = adapter.createMesh('a', prim, mat);
        const b = adapter.createMesh('b', prim, mat);
        expect(a).not.toBe(b);
      });

      it('setMeshPosition + getMeshWorldPosition round-trips', () => {
        const h = adapter.createMesh('hero', prim, mat);
        adapter.setMeshPosition(h, 1.5, -2.25, 7);
        const out: Vec3 = [0, 0, 0];
        const result = adapter.getMeshWorldPosition(h, out);
        expect(result[0]).toBeCloseTo(1.5, 5);
        expect(result[1]).toBeCloseTo(-2.25, 5);
        expect(result[2]).toBeCloseTo(7, 5);
      });

      it('getMeshWorldPosition writes into the provided `out` and returns it', () => {
        const h = adapter.createMesh('hero', prim, mat);
        adapter.setMeshPosition(h, 3, 4, 5);
        const out: Vec3 = [0, 0, 0];
        const returned = adapter.getMeshWorldPosition(h, out);
        expect(returned).toBe(out);
      });

      it('setMeshRotation / setMeshColor / setMeshVisible are smoke-safe', () => {
        const h = adapter.createMesh('hero', prim, mat);
        expect(() => {
          adapter.setMeshRotation(h, 0.1, 0.2, 0.3);
          adapter.setMeshColor(h, 0.8, 0.1, 0.1);
          adapter.setMeshVisible(h, false);
          adapter.setMeshVisible(h, true);
        }).not.toThrow();
      });

      it('createDebugBox parents a unit wire box to a mesh; layout + dispose are smoke-safe', () => {
        const parent = adapter.createMesh('parent', prim, mat);
        const box = adapter.createDebugBox('dbg', parent, [1, 0.2, 0.9]);
        expect(box).not.toBeNull();
        expect(() => {
          adapter.setMeshScale(box!, 2, 1, 3);
          adapter.setMeshPosition(box!, 0.5, 0, -0.5);
          adapter.setMeshVisible(box!, false);
          adapter.disposeMesh(box!);
        }).not.toThrow();
      });

      it('disposeMesh does not throw, and adapter remains usable afterward', () => {
        const h = adapter.createMesh('hero', prim, mat);
        expect(() => adapter.disposeMesh(h)).not.toThrow();
        // Creating a fresh mesh after a dispose must still work.
        expect(() => adapter.createMesh('other', prim, mat)).not.toThrow();
      });

      it('ground honors `height` as its Z size when `depth` is absent, and `depth` wins when both are given', () => {
        // Regression: a `ground` is a horizontal XZ plane — width→X, depth→Z.
        // Authors naturally reach for `height` for the second dimension, so the
        // adapters fall back `depth ?? height ?? 10`. Before that, a square
        // floor written as { width: 60, height: 60 } silently collapsed to a
        // 60×1 strip (`height` ignored) — the bug that bit the poker scene.
        const span = (
          h: ReturnType<RendererAdapter['createMesh']>,
        ): { x: number; z: number } | null => {
          const ext = adapter.getMeshBoundingBoxExtents(h);
          if (!ext) return null; // Mock has no real geometry — nothing to assert.
          return { x: ext.max[0] - ext.min[0], z: ext.max[2] - ext.min[2] };
        };

        // height-only → honored as the Z dimension (not collapsed to a strip).
        const square = adapter.createMesh('floor', { kind: 'ground', width: 60, height: 60 }, mat);
        const sq = span(square);
        if (sq) {
          expect(sq.x).toBeCloseTo(60, 3);
          expect(sq.z).toBeCloseTo(60, 3); // would be ~1 (the default) if `height` were ignored
        }

        // both given → depth wins over height (and over width on Z).
        const both = adapter.createMesh('floor2', { kind: 'ground', width: 8, depth: 4, height: 99 }, mat);
        const bo = span(both);
        if (bo) {
          expect(bo.x).toBeCloseTo(8, 3);
          expect(bo.z).toBeCloseTo(4, 3); // depth, not the 99 from height
        }

        // neither given → default 10×10 (keeps the existing fallback).
        const bare = adapter.createMesh('floor3', { kind: 'ground' }, mat);
        const ba = span(bare);
        if (ba) {
          expect(ba.x).toBeCloseTo(10, 3);
          expect(ba.z).toBeCloseTo(10, 3);
        }
      });

      it('createMesh accepts a `tube` primitive (open-ended cylinder shell)', () => {
        // Silo walls: an uncapped vertical cylinder shell, base-pivoted. Both
        // the thin-shell (no thickness) and walled (thickness) forms must
        // build without throwing and yield a usable, round-trippable handle.
        const thin: PrimitiveSpec = { kind: 'tube', diameter: 2, height: 3, tessellation: 32 };
        const walled: PrimitiveSpec = { kind: 'tube', diameter: 2, height: 3, thickness: 0.15 };
        let a: ReturnType<RendererAdapter['createMesh']> | undefined;
        let b: ReturnType<RendererAdapter['createMesh']> | undefined;
        expect(() => {
          a = adapter.createMesh('silo_thin', thin, mat);
          b = adapter.createMesh('silo_walled', walled, mat);
        }).not.toThrow();
        expect(a).not.toBe(b);
        // A tube mesh round-trips position like any other primitive.
        adapter.setMeshPosition(a!, 4, 0, -2);
        const out: Vec3 = [0, 0, 0];
        adapter.getMeshWorldPosition(a!, out);
        expect(out[0]).toBeCloseTo(4, 5);
        expect(out[2]).toBeCloseTo(-2, 5);
        // Scaling + visibility + dispose are all smoke-safe on a tube.
        expect(() => {
          adapter.setMeshScale(a!, 2, 1, 2);
          adapter.setMeshVisible(a!, false);
          adapter.disposeMesh(a!);
        }).not.toThrow();
      });

      it('createMesh accepts a textured (PBR) MaterialSpec', () => {
        // A textured material (albedo + normal + roughness + AO, tiled) must
        // build the PBR path without throwing and yield a usable handle — this
        // is what the arcade-room carpet floor relies on. Adapters without a
        // PBR pipeline (mocks) record the spec and no-op the load.
        const ground: PrimitiveSpec = { kind: 'ground', width: 24, depth: 12 };
        const textured: MaterialSpec = {
          albedoTexture: 'https://example.invalid/carpet_color.jpg',
          normalTexture: 'https://example.invalid/carpet_normal.jpg',
          roughnessTexture: 'https://example.invalid/carpet_rough.jpg',
          ambientTexture: 'https://example.invalid/carpet_ao.jpg',
          roughness: 0.9,
          uScale: 45,
          vScale: 45,
        };
        let h: ReturnType<RendererAdapter['createMesh']> | undefined;
        expect(() => {
          h = adapter.createMesh('floor', ground, textured);
        }).not.toThrow();
        adapter.setMeshPosition(h!, 0, 0, 0);
        const out: Vec3 = [0, 0, 0];
        adapter.getMeshWorldPosition(h!, out);
        expect(out[1]).toBeCloseTo(0, 5);
        expect(() => adapter.disposeMesh(h!)).not.toThrow();
      });
    });

    // ---------------------------------------------------------------------
    // Geometry mutation, billboard, bounding box
    // ---------------------------------------------------------------------
    describe('geometry, billboard & bounds', () => {
      const prim: PrimitiveSpec = { kind: 'box', width: 1, height: 1, depth: 1 };
      const mat: MaterialSpec = { diffuse: [0.5, 0.5, 0.5] };

      it('replaceMeshGeometry swaps vertex data without throwing', () => {
        const h = adapter.createMesh('m', prim, mat);
        expect(() =>
          adapter.replaceMeshGeometry(h, {
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
            normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
          }),
        ).not.toThrow();
        // Without supplied normals it must recompute them, also without throwing.
        expect(() =>
          adapter.replaceMeshGeometry(h, { positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2] }),
        ).not.toThrow();
      });

      it('setMeshBillboardMode accepts every mode without throwing', () => {
        const h = adapter.createMesh('m', prim, mat);
        expect(() => {
          adapter.setMeshBillboardMode(h, 'all');
          adapter.setMeshBillboardMode(h, 'y');
          adapter.setMeshBillboardMode(h, 'none');
        }).not.toThrow();
      });

      it('setMeshBoundingBoxExtents + getMeshBoundingBoxExtents round-trips', () => {
        const h = adapter.createMesh('m', prim, mat);
        adapter.setMeshBoundingBoxExtents(h, [-2, -1, -3], [2, 1, 3]);
        const got = adapter.getMeshBoundingBoxExtents(h);
        expect(got).not.toBeNull();
        expect(got!.min[0]).toBeCloseTo(-2, 4);
        expect(got!.min[1]).toBeCloseTo(-1, 4);
        expect(got!.max[2]).toBeCloseTo(3, 4);
      });
    });

    // ---------------------------------------------------------------------
    // Picking
    // ---------------------------------------------------------------------
    describe('picking', () => {
      it('pickAtScreenPoint returns a PickResult or null without throwing', () => {
        adapter.createMesh('floor', { kind: 'ground', width: 10, depth: 10 }, { diffuse: [0.5, 0.5, 0.5] });
        let res: PickResult | null = null;
        expect(() => {
          res = adapter.pickAtScreenPoint(10, 10);
        }).not.toThrow();
        // A miss returns null, a hit returns a PickResult — both are `typeof
        // 'object'` (typeof null === 'object'), so this asserts the return shape
        // without a branch that headless adapters (always a miss) can't cover.
        expect(typeof res).toBe('object');
      });
    });

    // ---------------------------------------------------------------------
    // Mesh load (GLB) — Mock only; engines fetch a real file (see browser demo)
    // ---------------------------------------------------------------------
    if (!options.skipMeshLoad) {
      describe('mesh load', () => {
        it('loadMesh resolves to a result addressing the mesh by id', async () => {
          const res = await adapter.loadMesh('model', {
            url: 'https://example.invalid/model.glb',
            position: [1, 2, 3],
            scale: 2,
          });
          expect(res.meshId).toBe('model');
          expect(res.handle).toBeTruthy();
          expect(Array.isArray(res.animationNames)).toBe(true);
        });
      });
    }

    // ---------------------------------------------------------------------
    // Lights
    // ---------------------------------------------------------------------
    describe('lights', () => {
      const dirSpec: DirectionalLightSpec = {
        direction: [0, -1, 0],
        intensity: 1,
        diffuse: [1, 1, 1],
        specular: [1, 1, 1],
      };
      const hemSpec: HemisphericLightSpec = {
        direction: [0, 1, 0],
        intensity: 1,
        diffuse: [1, 1, 1],
        groundColor: [0.2, 0.2, 0.2],
        specular: [1, 1, 1],
      };

      it('createDirectionalLight returns a handle and updateLightIntensity is smoke-safe', () => {
        const h = adapter.createDirectionalLight('sun', dirSpec);
        expect(h).toBeDefined();
        expect(() => adapter.updateLightIntensity(h, 0.5)).not.toThrow();
        expect(() => adapter.disposeLight(h)).not.toThrow();
      });

      it('createHemisphericLight returns a handle and dispose is safe', () => {
        const h = adapter.createHemisphericLight('ambient', hemSpec);
        expect(h).toBeDefined();
        expect(() => adapter.disposeLight(h)).not.toThrow();
      });

      it('directional and hemispheric lights produce distinct handles', () => {
        const a = adapter.createDirectionalLight('sun', dirSpec);
        const b = adapter.createHemisphericLight('ambient', hemSpec);
        expect(a).not.toBe(b);
      });
    });

    // ---------------------------------------------------------------------
    // Camera
    // ---------------------------------------------------------------------
    describe('camera', () => {
      const camSpec: ArcCameraSpec = {
        alpha: Math.PI / 4,
        beta: Math.PI / 3,
        radius: 10,
        minRadius: 1,
        maxRadius: 100,
        minBeta: 0.01,
        maxBeta: Math.PI - 0.01,
        target: [1, 2, 3],
        inertia: 0.9,
        wheelPrecision: 50,
        angularSensibility: 1000,
      };

      it('createArcCamera + getCameraTarget round-trips spec.target', () => {
        const h = adapter.createArcCamera('main', camSpec);
        const out: Vec3 = [0, 0, 0];
        adapter.getCameraTarget(h, out);
        expect(out[0]).toBeCloseTo(1, 5);
        expect(out[1]).toBeCloseTo(2, 5);
        expect(out[2]).toBeCloseTo(3, 5);
      });

      it('getCameraAngles returns spec.alpha / beta / radius (within clamp range)', () => {
        const h = adapter.createArcCamera('main', camSpec);
        const a = adapter.getCameraAngles(h);
        expect(a.alpha).toBeCloseTo(camSpec.alpha, 5);
        expect(a.beta).toBeCloseTo(camSpec.beta, 5);
        expect(a.radius).toBeCloseTo(camSpec.radius, 5);
      });

      it('setCameraTarget round-trips through getCameraTarget', () => {
        const h = adapter.createArcCamera('main', camSpec);
        adapter.setCameraTarget(h, 7, 8, 9);
        const out: Vec3 = [0, 0, 0];
        adapter.getCameraTarget(h, out);
        expect(out[0]).toBeCloseTo(7, 5);
        expect(out[1]).toBeCloseTo(8, 5);
        expect(out[2]).toBeCloseTo(9, 5);
      });

      it('nudgeCameraAlpha increases alpha by the delta', () => {
        const h = adapter.createArcCamera('main', camSpec);
        const before = adapter.getCameraAngles(h).alpha;
        adapter.nudgeCameraAlpha(h, 0.5);
        const after = adapter.getCameraAngles(h).alpha;
        expect(after - before).toBeCloseTo(0.5, 5);
      });

      it('nudgeCameraBeta keeps beta within (0, π) regardless of nudge size', () => {
        const h = adapter.createArcCamera('main', camSpec);
        adapter.nudgeCameraBeta(h, 100);
        expect(adapter.getCameraAngles(h).beta).toBeLessThan(Math.PI);
        adapter.nudgeCameraBeta(h, -100);
        expect(adapter.getCameraAngles(h).beta).toBeGreaterThan(0);
      });

      it('nudgeCameraRadius keeps radius strictly positive', () => {
        const h = adapter.createArcCamera('main', camSpec);
        adapter.nudgeCameraRadius(h, -10000);
        expect(adapter.getCameraAngles(h).radius).toBeGreaterThan(0);
      });

      it('getCameraForward returns a unit vector', () => {
        const h = adapter.createArcCamera('main', camSpec);
        const out: Vec3 = [0, 0, 0];
        adapter.getCameraForward(h, out);
        const len = Math.hypot(out[0], out[1], out[2]);
        expect(len).toBeCloseTo(1, 4);
      });

      it('getCameraRight returns a unit vector', () => {
        const h = adapter.createArcCamera('main', camSpec);
        const out: Vec3 = [0, 0, 0];
        adapter.getCameraRight(h, out);
        const len = Math.hypot(out[0], out[1], out[2]);
        expect(len).toBeCloseTo(1, 4);
      });

      it('screenToWorldPoint writes a finite Vec3 into `out` and returns it', () => {
        const h = adapter.createArcCamera('main', camSpec);
        const out: Vec3 = [0, 0, 0];
        const returned = adapter.screenToWorldPoint(h, 0.5, 0.5, 14, out);
        expect(returned).toBe(out);
        expect(Number.isFinite(out[0])).toBe(true);
        expect(Number.isFinite(out[1])).toBe(true);
        expect(Number.isFinite(out[2])).toBe(true);
      });
    });

    // ---------------------------------------------------------------------
    // Free 6-DOF perspective camera (chase / flight)
    // ---------------------------------------------------------------------
    describe('perspective camera', () => {
      const persp: PerspectiveCameraSpec = { fov: Math.PI / 3, near: 0.1, far: 200000 };

      it('createPerspectiveCamera returns a defined handle, distinct per id', () => {
        const a = adapter.createPerspectiveCamera('cam-a', persp);
        const b = adapter.createPerspectiveCamera('cam-b', persp);
        expect(a).toBeDefined();
        expect(a).not.toBe(b);
      });

      it('setCameraPose + getCameraPose round-trips position and a unit quaternion', () => {
        const h = adapter.createPerspectiveCamera('chase', persp);
        // ~120° yaw about +Y — well past the gimbal-safe Euler band a
        // quat→Euler round-trip would mangle.
        const q: Quaternion = { x: 0, y: 0.8660254, z: 0, w: 0.5 };
        adapter.setCameraPose(h, [10, -4, 25], q);
        const outPos: Vec3 = [0, 0, 0];
        const outQ: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
        adapter.getCameraPose(h, outPos, outQ);
        expect(outPos[0]).toBeCloseTo(10, 4);
        expect(outPos[1]).toBeCloseTo(-4, 4);
        expect(outPos[2]).toBeCloseTo(25, 4);
        // q and −q are the same rotation, so compare up to sign: |q·out| ≈ 1.
        const dot = q.x * outQ.x + q.y * outQ.y + q.z * outQ.z + q.w * outQ.w;
        expect(Math.abs(dot)).toBeCloseTo(1, 4);
      });

      if (!options.skipProjection) {
        it('worldToScreen projects an in-front point to finite pixels and returns true', () => {
          const h = adapter.createPerspectiveCamera('hud', persp);
          // Camera at origin, identity orientation → looks down +Z (Mock's
          // Babylon-convention basis). A point ahead must project on-screen.
          adapter.setCameraPose(h, [0, 0, 0], { x: 0, y: 0, z: 0, w: 1 });
          const out: ScreenPoint = { x: NaN, y: NaN };
          const visible = adapter.worldToScreen(0, 0, 10, out);
          expect(visible).toBe(true);
          expect(Number.isFinite(out.x)).toBe(true);
          expect(Number.isFinite(out.y)).toBe(true);
        });

        it('worldToScreen returns false for a point behind the camera and leaves `out` untouched', () => {
          const h = adapter.createPerspectiveCamera('hud', persp);
          adapter.setCameraPose(h, [0, 0, 0], { x: 0, y: 0, z: 0, w: 1 });
          const out: ScreenPoint = { x: 123, y: 456 };
          const visible = adapter.worldToScreen(0, 0, -10, out);
          expect(visible).toBe(false);
          expect(out.x).toBe(123); // untouched on a behind-camera miss
          expect(out.y).toBe(456);
        });
      } else {
        it('worldToScreen returns a boolean without throwing (engine smoke)', () => {
          const h = adapter.createPerspectiveCamera('hud', persp);
          adapter.setCameraPose(h, [0, 0, 0], { x: 0, y: 0, z: 0, w: 1 });
          const out: ScreenPoint = { x: 0, y: 0 };
          let r: boolean | undefined;
          expect(() => {
            r = adapter.worldToScreen(0, 0, 10, out);
          }).not.toThrow();
          expect(typeof r).toBe('boolean');
        });
      }
    });

    // ---------------------------------------------------------------------
    // Floating origin (Phase-1: contract-only, dormant — pure bookkeeping,
    // so the round-trip runs on EVERY adapter)
    // ---------------------------------------------------------------------
    describe('floating origin', () => {
      it('getOriginOffset writes into and returns the provided `out`', () => {
        const out: Vec3 = [0, 0, 0];
        const returned = adapter.getOriginOffset(out);
        expect(returned).toBe(out);
        expect(Number.isFinite(out[0])).toBe(true);
        expect(Number.isFinite(out[1])).toBe(true);
        expect(Number.isFinite(out[2])).toBe(true);
      });

      it('setOriginOffset → getOriginOffset round-trips the recorded offset', () => {
        adapter.setOriginOffset(1000, -2000, 3000);
        const out: Vec3 = [0, 0, 0];
        adapter.getOriginOffset(out);
        expect(out[0]).toBeCloseTo(1000, 4);
        expect(out[1]).toBeCloseTo(-2000, 4);
        expect(out[2]).toBeCloseTo(3000, 4);
      });

      it('configureLargeWorld records config without throwing (no active rebase in Phase 1)', () => {
        expect(() => {
          adapter.configureLargeWorld({ enabled: true, farPlane: 200000 });
          adapter.configureLargeWorld({ enabled: false });
        }).not.toThrow();
      });
    });

    // ---------------------------------------------------------------------
    // Shadows
    // ---------------------------------------------------------------------
    describe('shadows', () => {
      it('attachShadowCaster / detachShadowCaster round-trip without throwing', () => {
        const light = adapter.createDirectionalLight('sun', {
          direction: [0, -1, 0],
          intensity: 1,
          diffuse: [1, 1, 1],
          specular: [1, 1, 1],
          shadow: { enabled: true, mapSize: 512, minZ: 0.1, maxZ: 100 },
        });
        const mesh = adapter.createMesh('caster', { kind: 'box' });
        const caster = adapter.attachShadowCaster(light, mesh);
        expect(caster).toBeDefined();
        expect(() => adapter.detachShadowCaster(caster)).not.toThrow();
        expect(() => adapter.setMeshReceiveShadows(mesh, true)).not.toThrow();
      });
    });

    // ---------------------------------------------------------------------
    // Labels (opt-out for adapters with no canvas)
    // ---------------------------------------------------------------------
    if (!options.skipLabels) {
      describe('labels', () => {
        const spec: LabelSpec = { text: 'hi', color: [1, 1, 1], fontSize: 24, scale: 1 };

        it('createLabel returns a handle and setters / dispose are smoke-safe', () => {
          const h = adapter.createLabel('hud', spec);
          expect(h).toBeDefined();
          expect(() => {
            adapter.setLabelText(h, 'updated');
            adapter.setLabelPosition(h, 1, 2, 3);
            adapter.setLabelColor(h, 0.2, 0.4, 0.6);
            adapter.setLabelAlpha(h, 0.5);
            adapter.setLabelScale(h, 2);
            adapter.setLabelVisible(h, false);
            adapter.setLabelVisible(h, true);
          }).not.toThrow();
          expect(() => adapter.disposeLabel(h)).not.toThrow();
        });

        it('createLabel honors optional background / borderColor (sign plate)', () => {
          // Building signs draw a filled plate + border behind the text. The
          // extra fields are optional and must not break the create/update/
          // dispose surface — and the plate must survive a setLabelText repaint.
          const signSpec: LabelSpec = {
            text: 'Saloon',
            fontSize: 26,
            background: 'rgba(15, 23, 42, 0.88)',
            borderColor: 'rgba(148, 163, 184, 0.95)',
          };
          let h: ReturnType<RendererAdapter['createLabel']> | undefined;
          expect(() => {
            h = adapter.createLabel('sign', signSpec);
          }).not.toThrow();
          expect(h).toBeDefined();
          expect(() => {
            adapter.setLabelText(h!, 'Assay Office');
            adapter.setLabelAlpha(h!, 0.5);
            adapter.disposeLabel(h!);
          }).not.toThrow();
        });
      });
    }

    // ---------------------------------------------------------------------
    // Animation (smoke only — needs loaded meshes for full assertions)
    // ---------------------------------------------------------------------
    describe('animation', () => {
      it('play / stop / setWeight / setSpeed are smoke-safe on an unknown mesh id', () => {
        // Adapters that don't recognize the meshId MUST no-op rather than
        // throw — Systems call these speculatively before clips are loaded.
        expect(() => {
          adapter.playAnimation('ghost', 'walk', true);
          adapter.setAnimationWeight('ghost', 'walk', 0.5);
          adapter.setAnimationSpeed('ghost', 'walk', 1.25);
          adapter.stopAnimation('ghost', 'walk');
        }).not.toThrow();
      });

      it('playAnimationOnce returns a number and no-ops on an unknown mesh id', () => {
        // One-shot driver for hit/death reactions. Unknown id → 0, no throw.
        let dur: number | undefined;
        expect(() => {
          dur = adapter.playAnimationOnce('ghost', 'hit');
        }).not.toThrow();
        expect(typeof dur).toBe('number');
      });
    });

    // ---------------------------------------------------------------------
    // Instanced models (smoke only — instantiating needs a real loaded asset,
    // which the headless test environment can't fetch). We only assert the
    // park/dispose surface is safe on ids/handles the adapter doesn't know.
    // ---------------------------------------------------------------------
    describe('instanced models', () => {
      it('setModelVisible / setModelAlpha / disposeModel are smoke-safe on unknown handles/ids', () => {
        const bogus = adapter.createMesh('decoy', { kind: 'box' });
        expect(() => {
          adapter.setModelVisible(bogus, false);
          adapter.setModelVisible(bogus, true);
          adapter.setModelAlpha('never-instantiated', 0.5);
          adapter.disposeModel('never-instantiated', bogus);
        }).not.toThrow();
      });
    });

    // ---------------------------------------------------------------------
    // Thin-instance fields (opt-out for engine adapters that can't fetch a GLB
    // in the headless test env). The Mock adapter runs the full sequence.
    // ---------------------------------------------------------------------
    if (!options.skipThinField) {
      describe('thin field', () => {
        const spec: ThinFieldSpec = {
          src: '/test/coins.glb',
          nodeName: 'GoldCoin',
          desiredSize: 0.5,
          capacity: 8,
        };

        it('loadThinField resolves a handle; instances + dispose are safe', async () => {
          const handle = await adapter.loadThinField(spec);
          expect(handle).not.toBeNull();
          // stride 5 per instance: [x, y, z, yaw, scale]
          const packed = new Float32Array([
            1, 0.3, 2, 0, 1,
            -3, 0.3, 4, Math.PI / 2, 0.5,
          ]);
          expect(() => {
            adapter.setThinFieldInstances(handle!, packed, 2);
            adapter.disposeThinField(handle!);
          }).not.toThrow();
        });

        it('setThinFieldInstances / disposeThinField are smoke-safe with zero count', async () => {
          const handle = await adapter.loadThinField(spec);
          expect(handle).not.toBeNull();
          expect(() => {
            adapter.setThinFieldInstances(handle!, new Float32Array(0), 0);
            adapter.disposeThinField(handle!);
          }).not.toThrow();
        });
      });
    }

    // ---------------------------------------------------------------------
    // Textures & cards — the renderer-agnostic poker-card surface.
    //
    // `setMeshAlbedoColor` / `getAspectRatio` / `disposeTexture` need neither a
    // real 2D drawing context nor a fetch, so they run on EVERY adapter. The
    // card-mesh sequence (createCardMesh generates a rounded-rect alpha mask via
    // DynamicTexture/CanvasTexture) and `preloadTexture` (a real image fetch) DO
    // — those are gated behind `skipLabels`, the existing "no real canvas/IO"
    // flag (engine adapters under jsdom set it; Mock + Lite-stub run the full
    // sequence). The loadTexture round-trip + dedupe is gated behind
    // skipTextureLoad (engine adapters can't fetch; Mock runs it).
    // ---------------------------------------------------------------------
    describe('textures & cards', () => {
      const cardSpec: CardMeshSpec = {
        width: 1.4,
        height: 2.0,
        subdivisions: 16,
        cornerRadius: 0.08,
        bow: 0.06,
      };

      it('setMeshAlbedoColor tints a mesh without throwing', () => {
        const floor = adapter.createMesh('felt', { kind: 'ground', width: 10, depth: 10 });
        expect(() => adapter.setMeshAlbedoColor(floor, 0.02, 0.5, 0.06)).not.toThrow();
        // An unknown handle is a safe no-op too.
        const ghost = adapter.createMesh('ghost', { kind: 'box' });
        adapter.disposeMesh(ghost);
        expect(() => adapter.setMeshAlbedoColor(ghost, 1, 1, 1)).not.toThrow();
      });

      it('disposeTexture is idempotent on an unknown handle', () => {
        // Releasing a handle that was never minted (or already released) must not
        // throw — exercised here without a real load so every adapter runs it.
        const bogus = adapter.createMesh('decoy_tex', { kind: 'box' }) as unknown as Parameters<RendererAdapter['disposeTexture']>[0];
        expect(() => {
          adapter.disposeTexture(bogus);
          adapter.disposeTexture(bogus);
        }).not.toThrow();
      });

      it('getAspectRatio returns a positive finite number', () => {
        const a = adapter.getAspectRatio();
        expect(Number.isFinite(a)).toBe(true);
        expect(a).toBeGreaterThan(0);
      });

      // Card-mesh creation generates an alpha mask on a real 2D canvas, and
      // preloadTexture fetches an image — both unavailable in the headless
      // engine envs, so they share the skipLabels gate.
      if (!options.skipLabels) {
        it('createCardMesh returns a handle that the standard mesh ops accept', () => {
          const h = adapter.createCardMesh('card0', cardSpec);
          expect(h).toBeDefined();
          // Registered like any mesh: transform / visibility ops and dispose
          // must all be smoke-safe on the returned handle.
          expect(() => {
            adapter.setMeshPosition(h, 0, 0.02, -8);
            adapter.setMeshRotation(h, 0, 0.3, Math.PI);
            adapter.setMeshScale(h, 1, 1, 1);
            adapter.setMeshVisible(h, false);
            adapter.setMeshVisible(h, true);
            adapter.disposeMesh(h);
          }).not.toThrow();
        });

        it('createCardMesh round-trips its world position like any mesh', () => {
          const h = adapter.createCardMesh('card1', cardSpec);
          adapter.setMeshPosition(h, 2, 0.02, -3);
          const out: Vec3 = [0, 0, 0];
          adapter.getMeshWorldPosition(h, out);
          expect(out[0]).toBeCloseTo(2, 4);
          expect(out[2]).toBeCloseTo(-3, 4);
        });

        it('createCardMesh accepts a flat (no-bow) minimal spec', () => {
          // bow / cornerRadius / subdivisions are all optional; a minimal spec
          // must build a usable card (defaults applied inside the adapter).
          let h: ReturnType<RendererAdapter['createCardMesh']> | undefined;
          expect(() => {
            h = adapter.createCardMesh('card_flat', { width: 1, height: 1.4 });
          }).not.toThrow();
          expect(h).toBeDefined();
          expect(() => adapter.disposeMesh(h!)).not.toThrow();
        });

        it('setMeshFaceTexture swaps a face albedo; both sides + a flip are safe', () => {
          const front = adapter.loadTexture('cardFront', '/test/AS.webp', { flipU: true, srgb: true });
          const back = adapter.loadTexture('cardBack', '/test/back-1.webp', { rotate: Math.PI });
          const h = adapter.createCardMesh('card2', { ...cardSpec, front, back });
          expect(() => {
            adapter.setMeshFaceTexture(h, 'front', front);
            adapter.setMeshFaceTexture(h, 'back', back);
            adapter.setMeshFaceTexture(h, 'front', back); // re-swap (the flip)
          }).not.toThrow();
        });

        it('setMeshFaceTexture no-ops on a non-card mesh handle', () => {
          const tex = adapter.loadTexture('lone', '/test/x.webp');
          const decoy = adapter.createMesh('decoy', { kind: 'box' });
          // A plain mesh handle (no card record) must be tolerated, not throw.
          expect(() => adapter.setMeshFaceTexture(decoy, 'front', tex)).not.toThrow();
        });

        it('disposeTexture releases a loaded texture idempotently', () => {
          const tex = adapter.loadTexture('disposable', '/test/y.webp');
          expect(() => {
            adapter.disposeTexture(tex);
            adapter.disposeTexture(tex);
          }).not.toThrow();
        });

        it('preloadTexture resolves', async () => {
          await expect(adapter.preloadTexture('/test/back-1.webp')).resolves.toBeUndefined();
        });
      }

      if (!options.skipTextureLoad) {
        it('loadTexture dedupes by key: same key → same handle, new key → new handle', () => {
          const a = adapter.loadTexture('AS', '/test/AS.webp', { flipU: true });
          const again = adapter.loadTexture('AS', '/test/AS.webp');
          const other = adapter.loadTexture('KH', '/test/KH.webp');
          expect(again).toBe(a); // dedupe hit (opts on the repeat call ignored)
          expect(other).not.toBe(a); // distinct key → distinct handle
        });
      }
    });

    // ---------------------------------------------------------------------
    // Physics (opt-out for adapters with no physics integrator)
    // ---------------------------------------------------------------------
    if (!options.skipPhysics) {
      describe('physics', () => {
        it('create / setVelocity / step / destroy form a safe sequence', () => {
          adapter.createMesh('body', { kind: 'sphere', diameter: 1 });
          expect(() => {
            adapter.physicsCreateBody('body', {
              shapeType: 'sphere',
              motionType: 'dynamic',
              mass: 1,
              friction: 0.5,
              restitution: 0.2,
              lockRotation: false,
            });
            adapter.physicsSetBodyVelocity('body', 0, -9.81, 0);
            adapter.physicsStep(1 / 60);
            adapter.physicsDestroyBody('body');
          }).not.toThrow();
        });

        it('physicsStep is safe to call with no bodies registered', () => {
          expect(() => adapter.physicsStep(1 / 60)).not.toThrow();
        });
      });
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------
    describe('lifecycle', () => {
      it('startLoop / stopLoop / resize are smoke-safe', () => {
        expect(() => {
          adapter.startLoop(() => {});
          adapter.stopLoop();
          adapter.resize();
        }).not.toThrow();
      });

      it('getRenderingCanvas returns an HTMLCanvasElement or null without throwing', () => {
        let c: HTMLCanvasElement | null | undefined;
        expect(() => {
          c = adapter.getRenderingCanvas();
        }).not.toThrow();
        expect(c === null || typeof c === 'object').toBe(true);
      });

      it('dispose is idempotent — calling twice does not throw', () => {
        expect(() => {
          adapter.dispose();
          adapter.dispose();
        }).not.toThrow();
      });
    });
  });
}
