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
  DirectionalLightSpec,
  HemisphericLightSpec,
  LabelSpec,
  MaterialSpec,
  PrimitiveSpec,
  RendererAdapter,
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
      try {
        adapter.dispose();
      } catch {
        /* swallow */
      }
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

      it('disposeMesh does not throw, and adapter remains usable afterward', () => {
        const h = adapter.createMesh('hero', prim, mat);
        expect(() => adapter.disposeMesh(h)).not.toThrow();
        // Creating a fresh mesh after a dispose must still work.
        expect(() => adapter.createMesh('other', prim, mat)).not.toThrow();
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
    });

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

      it('dispose is idempotent — calling twice does not throw', () => {
        expect(() => {
          adapter.dispose();
          adapter.dispose();
        }).not.toThrow();
      });
    });
  });
}
