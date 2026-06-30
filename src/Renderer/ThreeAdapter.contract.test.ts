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
import { ThreeAdapter } from './ThreeAdapter';
import { runRendererAdapterContract } from './rendererAdapterContract';

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
  // jsdom has no real canvas/size, and Three's identity-camera forward is −Z
  // (vs the Mock/Babylon +Z convention), so the numeric worldToScreen
  // in-front/behind assertions aren't engine-agnostic here. The pose round-trip
  // and floating-origin round-trip still run; worldToScreen runs as a no-throw
  // smoke check. Numeric projection is covered by the browser comparison demo.
  skipProjection: true,
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
