/**
 * Runs the shared RendererAdapter contract against the BabylonAdapter,
 * driving it with @babylonjs/core's NullEngine — a headless engine designed
 * exactly for this. No canvas, no WebGL, no resize event quirks; just the
 * real Babylon scene-graph code paths.
 *
 * Why this exists: BabylonAdapter sat at 0% coverage prior to this file
 * because integrating a real engine through jsdom looked hard. NullEngine
 * makes it trivial — the adapter behaves identically to production for
 * everything except actual pixel output.
 *
 * Limitations baked in here:
 *   - skipPhysics: Havok is a WASM module that the test environment isn't
 *     set up to load. Physics behavior is covered separately by the
 *     Components/Physics tests in @babylonjsmarket/arcade.
 *   - skipLabels: Babylon's DynamicTexture path needs a real 2D canvas
 *     context which jsdom doesn't fully provide. Labels are exercised via
 *     the Arcade panel tests instead.
 */

import { AbstractMesh, NullEngine, Scene } from '@babylonjs/core';
import type { GlowLayer } from '@babylonjs/core';
import { BabylonAdapter } from './BabylonAdapter';
import { runRendererAdapterContract } from './rendererAdapterContract';

runRendererAdapterContract(
  'Babylon (NullEngine)',
  () => new BabylonAdapter(),
  {
    skipPhysics: true,
    skipLabels: true,
    skipThinField: true,
    skipMeshLoad: true, // needs a real GLB fetch; covered by the browser demo
    skipTextureLoad: true, // needs a real image fetch; covered by the browser demo
    skipAudio: true, // jsdom has no AudioContext; the headless-degrade path is locked in BabylonAdapter.test.ts
    // Projection is NOT skipped: NullEngine reports a real render size (its
    // default 512×256), so the pixel-basis cases run on Babylon's own view /
    // projection math. That is what pins the right-handed picture and the
    // in-front/behind sign of worldToScreen to the real engine.
    glowEnrolled(adapter, meshId) {
      // Read the real GlowLayer's include list: the registered node (when it is
      // a mesh) plus every mesh under it, as Babylon's per-mesh whitelist sees them.
      const ba = adapter as BabylonAdapter;
      const root = ba.getMeshRoot(meshId);
      if (!root) return { enrolled: 0, total: 0 };
      const layer = ba.scene?.effectLayers.find((l) => l.name === 'glow') as GlowLayer | undefined;
      const meshes = [root, ...root.getChildMeshes(false)].filter((n) => n instanceof AbstractMesh);
      return {
        total: meshes.length,
        enrolled: layer ? meshes.filter((m) => layer.hasMesh(m)).length : 0,
      };
    },
    setup(adapter) {
      // Bypass init() — it builds a `new Engine(canvas, ...)` that needs
      // a real WebGL context. NullEngine is a Babylon Engine subclass
      // designed for headless test runs, so we wire it directly into the
      // adapter's public engine / scene fields.
      const ba = adapter as BabylonAdapter;
      ba.engine = new NullEngine();
      ba.scene = new Scene(ba.engine);
      ba.scene.useRightHandedSystem = true;
    },
  },
);
