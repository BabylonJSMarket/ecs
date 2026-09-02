/**
 * Runs the shared RendererAdapter contract against the ThreeAdapter, driving it
 * with the real `three` package (a dev dependency) but bypassing init() — three's
 * WebGLRenderer needs a live WebGL context that jsdom doesn't provide. The
 * scene-graph code paths (geometry, transforms, cameras, raycasting, shadows)
 * all run on plain CPU-side three objects, so wiring those fields directly lets
 * the adapter behave identically to production for everything except pixel
 * output — the same trick BabylonAdapter's contract uses with NullEngine.
 *
 * Limitations baked in here (matching BabylonAdapter.contract.test.ts):
 *   - skipPhysics: Rapier is a WASM module the jsdom env isn't set up to load.
 *     Physics is covered separately by the Components/Physics tests in
 *     @babylonjsmarket/arcade and by browser/integration smoke.
 *   - skipLabels: jsdom's 2D canvas context is a stub, so the DynamicTexture-style
 *     label path can't render. Labels are exercised via the Arcade panel tests.
 *   - skipThinField: loading + merging a GLB needs the addons bundle + fetch,
 *     unavailable headless.
 */

import * as THREE from 'three';
import { describe, it, expect } from 'vitest';
import { BLOOM_LAYER, ThreeAdapter } from './ThreeAdapter';
import { runRendererAdapterContract } from './rendererAdapterContract';
import type { CameraHandle, MeshHandle, SoundHandle } from './types';

/** Minimal stand-in for three/addons OrbitControls (no GL, no real input). */
class StubOrbitControls {
  target = new THREE.Vector3();
  minDistance = 0;
  maxDistance = Infinity;
  minPolarAngle = 0;
  maxPolarAngle = Math.PI;
  enableDamping = false;
  dampingFactor = 0;
  zoomSpeed = 1;
  rotateSpeed = 1;
  enabled = true;
  update(): void {}
  dispose(): void {}
}

runRendererAdapterContract('Three (headless)', () => new ThreeAdapter(), {
  skipPhysics: true,
  skipLabels: true,
  skipThinField: true,
  skipMeshLoad: true, // needs a real GLB fetch; covered by the browser demo
  skipTextureLoad: true, // needs a real image fetch; covered by the browser demo
  skipAudio: true, // jsdom has no AudioContext; the headless-degrade path is locked below
  // Projection is NOT skipped: worldToScreen falls back to window dimensions
  // under jsdom, so the pixel-basis cases (+X lands right of centre when
  // looking −Z, left at identity) run on Three's own camera math. The pose
  // round-trip, floating-origin round-trip, AND the camera-forward convention
  // (identity → +Z — the ThreeAdapter applies a +Y look-flip so its free camera
  // matches the Mock/Babylon convention instead of Three's native −Z) all run.

  glowEnrolled(adapter, meshId) {
    // Read the per-object layer mask the adapter marks glow meshes with.
    const root = (adapter as ThreeAdapter).getMeshRootObject(meshId);
    if (!root) return { enrolled: 0, total: 0 };
    let total = 0;
    let enrolled = 0;
    root.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      total += 1;
      if (o.layers.isEnabled(BLOOM_LAYER)) enrolled += 1;
    });
    return { enrolled, total };
  },
  setup(adapter) {
    // Wire the public engine fields + the private renderer/controls scaffolding
    // that init() would normally build from a real WebGL canvas.
    const ta = adapter as unknown as {
      THREE: typeof THREE;
      scene: THREE.Scene;
      renderer: unknown;
      canvas: HTMLCanvasElement;
      OrbitControlsCtor: unknown;
    };
    const canvas = document.createElement('canvas');
    ta.THREE = THREE;
    ta.scene = new THREE.Scene();
    ta.canvas = canvas;
    ta.renderer = {
      domElement: canvas,
      shadowMap: { enabled: false, type: 0 },
      render() {},
      setSize() {},
      setPixelRatio() {},
      setClearColor() {},
      dispose() {},
    };
    ta.OrbitControlsCtor = StubOrbitControls;
  },
});

/**
 * The audio surface's headless guarantee (the shared contract skips its audio
 * block for engines — see skipAudio): with no WebAudio in the host, initAudio
 * resolves false instead of letting `new THREE.AudioListener()` throw on a
 * missing AudioContext, createSound resolves null, and every playback call
 * accepts that null / an unknown handle silently.
 */
describe('ThreeAdapter audio — headless degrade (no AudioContext)', () => {
  function headless(): ThreeAdapter {
    const adapter = new ThreeAdapter();
    const ta = adapter as unknown as { THREE: typeof THREE; scene: THREE.Scene };
    ta.THREE = THREE;
    ta.scene = new THREE.Scene();
    return adapter;
  }

  it('initAudio resolves false without throwing, idempotently', async () => {
    const adapter = headless();
    expect(await adapter.initAudio()).toBe(false);
    expect(await adapter.initAudio()).toBe(false);
  });

  it('createSound resolves null and every sound op accepts the null / an unknown handle', async () => {
    const adapter = headless();
    const h = await adapter.createSound('attract', { url: 'https://example.invalid/attract.ogg', spatial: {} });
    expect(h).toBeNull();
    const target = h as unknown as SoundHandle;
    const bogusMesh = {} as unknown as MeshHandle;
    expect(() => {
      adapter.attachAudioListener({} as unknown as CameraHandle);
      adapter.playSound(target);
      adapter.stopSound(target);
      adapter.setSoundVolume(target, 0.5);
      adapter.attachSoundToMesh(target, bogusMesh);
      adapter.disposeSound(target);
      adapter.dispose();
    }).not.toThrow();
  });
});

/**
 * The glow mask on a model subtree (the shared contract proves the initial
 * subtree + release; this pins the late-child path, which is synchronous on
 * Three): a mesh parented under an enrolled root AFTER addGlowMesh — even a
 * grandchild through a group that itself arrived late — joins the mask, and
 * removeGlowMesh takes the whole subtree out and stops listening.
 */
describe('ThreeAdapter glow — an enrolled subtree picks up late children', () => {
  function headless(): ThreeAdapter {
    const adapter = new ThreeAdapter();
    const ta = adapter as unknown as { THREE: typeof THREE; scene: THREE.Scene };
    ta.THREE = THREE;
    ta.scene = new THREE.Scene();
    return adapter;
  }
  const masked = (root: THREE.Object3D): string[] => {
    const out: string[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.layers.isEnabled(BLOOM_LAYER)) out.push(o.name);
    });
    return out;
  };

  it('a child (and a grandchild via a late group) added after enrolment is masked; removal clears and stops listening', () => {
    const adapter = headless();
    const root = adapter.createMesh('cabinet', { kind: 'box' });
    adapter.createDebugBox('screen', root, [1, 1, 1]);
    adapter.setGlowLayer({ intensity: 0.9 });
    adapter.addGlowMesh(root);
    const rootObj = adapter.getMeshRootObject('cabinet')!;
    expect(masked(rootObj).sort()).toEqual(['cabinet', 'screen']);

    const arm = new THREE.Group();
    arm.name = 'arm';
    rootObj.add(arm);
    const late = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    late.name = 'coin-light';
    arm.add(late);
    expect(masked(rootObj).sort()).toEqual(['cabinet', 'coin-light', 'screen']);

    adapter.removeGlowMesh(root);
    expect(masked(rootObj)).toEqual([]);
    const after = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    after.name = 'after';
    arm.add(after);
    expect(masked(rootObj)).toEqual([]);
  });

  it('disabling the layer releases every enrolled subtree', () => {
    const adapter = headless();
    const root = adapter.createMesh('cabinet', { kind: 'box' });
    adapter.createDebugBox('screen', root, [1, 1, 1]);
    adapter.setGlowLayer({ intensity: 0.9 });
    adapter.addGlowMesh(root);
    const rootObj = adapter.getMeshRootObject('cabinet')!;
    expect(masked(rootObj).length).toBe(2);
    adapter.setGlowLayer(null);
    expect(masked(rootObj)).toEqual([]);
  });
});
