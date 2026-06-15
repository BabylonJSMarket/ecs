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

import { NullEngine, Scene } from '@babylonjs/core';
import { BabylonAdapter } from './BabylonAdapter';
import { runRendererAdapterContract } from './rendererAdapterContract';

runRendererAdapterContract(
  'Babylon (NullEngine)',
  () => new BabylonAdapter(),
  {
    skipPhysics: true,
    skipLabels: true,
    skipThinField: true,
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
