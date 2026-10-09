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
  skipMeshLoad: true, // needs a real GLB fetch; covered by the browser demo
  skipTextureLoad: true, // needs a real image fetch; covered by the browser demo
  skipAudio: true, // jsdom has no AudioContext; the headless-degrade path is locked below
  // Projection is NOT skipped: worldToScreen falls back to window dimensions
  // under jsdom, so the pixel-basis cases (+X lands right of centre when
  // looking −Z, left at identity) run on Three's own camera math. The pose
  // round-trip, floating-origin round-trip, AND the camera-forward convention
  // (identity → +Z — the ThreeAdapter applies a +Y look-flip so its free camera
  // matches the Mock/Babylon convention instead of Three's native −Z) all run.

  parentMeshUnder(adapter, id, parent) {
    // The interface has no parenting call, so the subtree the glow layer has to
    // enrol is built here in Three's own terms.
    const ta = adapter as ThreeAdapter;
    const parentMesh = ta.getMeshObject(parent);
    if (!parentMesh) return;
    const child = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    child.name = id;
    parentMesh.add(child);
  },
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
    const screen = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    screen.name = 'screen';
    adapter.getMeshObject(root)!.add(screen);
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
    const screen = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    screen.name = 'screen';
    adapter.getMeshObject(root)!.add(screen);
    adapter.setGlowLayer({ intensity: 0.9 });
    adapter.addGlowMesh(root);
    const rootObj = adapter.getMeshRootObject('cabinet')!;
    expect(masked(rootObj).length).toBe(2);
    adapter.setGlowLayer(null);
    expect(masked(rootObj)).toEqual([]);
  });
});

/**
 * The plugin-host post-pass hook (class-only, not the RendererAdapter
 * interface). A plugin inserts a three/addons Pass; the composer is built on
 * demand even with the glow layer off, and the OutputPass always stays last.
 * Runs the real three/addons composer against a stub renderer that answers the
 * size queries EffectComposer makes; nothing is drawn.
 */
describe('ThreeAdapter post-pass plugin hook', () => {
  class FakePass {
    enabled = true;
    needsSwap = true;
    camera: unknown = null;
    sizes: [number, number][] = [];
    setSize(w: number, h: number): void { this.sizes.push([w, h]); }
    render(): void {}
  }

  function live(): ThreeAdapter {
    const adapter = new ThreeAdapter();
    const ta = adapter as unknown as { THREE: typeof THREE; scene: THREE.Scene; renderer: unknown; defaultCamera: THREE.PerspectiveCamera };
    ta.THREE = THREE;
    ta.scene = new THREE.Scene();
    ta.defaultCamera = new THREE.PerspectiveCamera();
    ta.renderer = {
      getSize: (v: THREE.Vector2) => v.set(640, 360),
      getPixelRatio: () => 1,
      render() {},
      setRenderTarget() {},
      dispose() {},
    };
    return adapter;
  }
  const names = (a: ThreeAdapter) => a.getComposerPasses().map((p) => (p as object).constructor.name);

  it('builds the composer for a plugin pass with glow off: scene, pass, output', async () => {
    const adapter = live();
    const pass = new FakePass();
    expect(adapter.getComposerPasses()).toEqual([]);
    expect(await adapter.addPostPass(pass)).toBe(true);
    expect(names(adapter)).toEqual(['RenderPass', 'FakePass', 'OutputPass']);
    expect(pass.sizes.at(-1)).toEqual([640, 360]); // sized by the composer
  });

  it("with bloom on, 'bloom' sits before the (selective) bloom pass and 'output' after it; OutputPass stays last", async () => {
    const adapter = live();
    adapter.setGlowLayer({ intensity: 0.5 } as never);
    const ao = new FakePass();
    const grade = new FakePass();
    await adapter.addPostPass(grade, { before: 'output' });
    await adapter.addPostPass(ao, { before: 'bloom' });
    const chain = adapter.getComposerPasses();
    expect(names(adapter)).toEqual(['RenderPass', 'FakePass', 'SelectiveBloomPass', 'FakePass', 'OutputPass']);
    expect(chain[1]).toBe(ao);
    expect(chain[3]).toBe(grade);
    expect(adapter.getPostPasses()).toEqual([ao, grade]);
  });

  it('removing the last pass with glow off drops the composer; with glow on the bloom chain stays', async () => {
    const adapter = live();
    const pass = new FakePass();
    await adapter.addPostPass(pass);
    adapter.removePostPass(pass);
    await Promise.resolve();
    expect(adapter.getComposerPasses()).toEqual([]);

    adapter.setGlowLayer({ intensity: 0.5 } as never);
    await adapter.addPostPass(pass);
    adapter.removePostPass(pass);
    await new Promise((r) => setTimeout(r, 0));
    expect(names(adapter)).toEqual(['RenderPass', 'SelectiveBloomPass', 'OutputPass']);
  });

  it('turning glow off keeps the plugin pass and takes bloom out', async () => {
    const adapter = live();
    adapter.setGlowLayer({ intensity: 0.5 } as never);
    const pass = new FakePass();
    await adapter.addPostPass(pass, { before: 'bloom' });
    adapter.setGlowLayer(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(names(adapter)).toEqual(['RenderPass', 'FakePass', 'OutputPass']);
  });

  it('re-points a camera-carrying pass at the camera the frame draws through', async () => {
    const adapter = live();
    const pass = new FakePass();
    await adapter.addPostPass(pass);
    const cam = new THREE.PerspectiveCamera();
    (adapter as unknown as { syncPostCameras(c: THREE.PerspectiveCamera): void }).syncPostCameras(cam);
    expect(pass.camera).toBe(cam);
    const scenePass = adapter.getComposerPasses()[0] as { camera: unknown };
    expect(scenePass.camera).toBe(cam);
  });

  it('the glow is include-only, as Babylon\'s GlowLayer: only meshes on BLOOM_LAYER give light to it', async () => {
    const adapter = live();
    adapter.setGlowLayer({ intensity: 0.5 } as never);
    // The composer builds behind a lazy import; wait for it, not for a tick.
    await (adapter as unknown as { ensureComposer(): Promise<boolean> }).ensureComposer();
    const scene = (adapter as unknown as { scene: THREE.Scene }).scene;
    const lit = new THREE.MeshStandardMaterial({ color: 0x00ff00, emissive: 0xff0000, emissiveIntensity: 2 });
    const glowing = new THREE.Mesh(new THREE.BoxGeometry(), lit);
    glowing.layers.enable(BLOOM_LAYER);
    const wallMat = new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: 0x00ff00 });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(), wallMat);
    const haze = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 }));
    const stars = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial());
    scene.add(glowing, wall, haze, stars);
    const bloom = adapter.getComposerPasses()[1] as unknown as { prepareScene(): void; restoreScene(): void };
    bloom.prepareScene();
    // Enrolled: drawn as its EMISSIVE only, at its intensity.
    const g = glowing.material as unknown as THREE.MeshBasicMaterial;
    expect(g.isMeshBasicMaterial).toBe(true);
    expect(g.color.r).toBeCloseTo(2);
    expect(g.color.g).toBeCloseTo(0);
    // Not enrolled: black where opaque (it still hides what is behind it), gone otherwise.
    expect((wall.material as unknown as THREE.MeshBasicMaterial).color.getHex()).toBe(0x000000);
    expect(haze.visible).toBe(false);
    expect(stars.visible).toBe(false);
    bloom.restoreScene();
    expect(glowing.material).toBe(lit);
    expect(wall.material).toBe(wallMat);
    expect(haze.visible && stars.visible).toBe(true);
  });

  it('headless (no real WebGLRenderer) resolves false but keeps the pass for when one exists', async () => {
    const adapter = new ThreeAdapter();
    const pass = new FakePass();
    expect(await adapter.addPostPass(pass)).toBe(false);
    expect(adapter.getPostPasses()).toEqual([pass]);
  });
});

/** Geometry, orientation and colour conventions Three must share with Babylon. */
describe('ThreeAdapter matches Babylon conventions', () => {
  function bare(): ThreeAdapter {
    const adapter = new ThreeAdapter();
    const ta = adapter as unknown as { THREE: typeof THREE; scene: THREE.Scene };
    ta.THREE = THREE;
    ta.scene = new THREE.Scene();
    return adapter;
  }
  const obj = (a: ThreeAdapter, h: MeshHandle) => a.getMeshObject(h) as unknown as THREE.Mesh;

  it("a torus lies flat in XZ round +Y, like Babylon's (three's stands in XY)", () => {
    const a = bare();
    const h = a.createMesh('ring', { kind: 'torus', diameter: 4, thickness: 0.5 });
    const geo = obj(a, h).geometry;
    geo.computeBoundingBox();
    const size = geo.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(4.5, 1);
    expect(size.z).toBeCloseTo(4.5, 1);
    expect(size.y).toBeCloseTo(0.5, 1);
  });

  it("applies a scene Euler in Babylon's order (yaw, pitch, roll), not three's XYZ", () => {
    const a = bare();
    const h = a.createMesh('box', { kind: 'box', width: 1, height: 1, depth: 1 });
    a.setMeshRotation(h, 0.8, 0.6, 0.3);
    const m = obj(a, h);
    expect(m.rotation.order).toBe('YXZ');
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.8, 0.6, 0.3, 'YXZ'));
    expect(m.quaternion.angleTo(expected)).toBeCloseTo(0, 6);
  });

  it("a PBR material's colours are linear, as Babylon's PBRMaterial reads them; a Phong one's are sRGB", () => {
    const a = bare();
    const pbr = obj(a, a.createMesh('felt', { kind: 'box', width: 1, height: 1, depth: 1 }, { pbr: true, diffuse: [0.01, 7, 0.75] }));
    expect((pbr.material as THREE.MeshStandardMaterial).color.g).toBeCloseTo(7);
    const phong = obj(a, a.createMesh('wall', { kind: 'box', width: 1, height: 1, depth: 1 }, { diffuse: [0.5, 0.5, 0.5] }));
    expect((phong.material as THREE.MeshPhongMaterial).color.r).toBeCloseTo(new THREE.Color().setRGB(0.5, 0.5, 0.5, THREE.SRGBColorSpace).r);
  });
});
