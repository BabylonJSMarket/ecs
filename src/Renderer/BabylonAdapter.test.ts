/**
 * Unit tests for the pure pieces of BabylonAdapter that don't need a live
 * engine. The engine-bound methods are exercised by BabylonAdapter.contract
 * (NullEngine); here we lock down `hardwareScalingLevelForDpr`, which decides
 * how crisp a retina display renders — a 2× display must drive the backing
 * buffer at full physical resolution, not 1× CSS pixels.
 */

import { describe, it, expect, vi } from 'vitest';
import { MeshBuilder, NullEngine, PBRMaterial, Scene, Vector3 } from '@babylonjs/core';
import { GPUParticleSystem } from '@babylonjs/core';
import type { ParticleSystem } from '@babylonjs/core';
import type { AbstractMesh, DeepImmutable, GlowLayer } from '@babylonjs/core';
import { BabylonAdapter, hardwareScalingLevelForDpr } from './BabylonAdapter';
import type { CameraHandle, MeshHandle, SoundHandle } from './types';

describe('hardwareScalingLevelForDpr', () => {
  it('renders a 2x (retina) display at physical resolution', () => {
    // level is the inverse of DPR: 1/2 backing buffer = full 2x pixels.
    expect(hardwareScalingLevelForDpr(2)).toBe(0.5);
  });

  it('is a no-op (level 1) on a standard 1x display', () => {
    expect(hardwareScalingLevelForDpr(1)).toBe(1);
  });

  it('handles a fractional DPR (e.g. 1.5x display)', () => {
    expect(hardwareScalingLevelForDpr(1.5)).toBeCloseTo(1 / 1.5, 6);
  });

  it('never upscales past native for a sub-1 DPR (floors the ratio at 1)', () => {
    expect(hardwareScalingLevelForDpr(0.75)).toBe(1);
  });

  it('caps absurdly high DPRs at 3x so the render target stays sane', () => {
    expect(hardwareScalingLevelForDpr(8)).toBeCloseTo(1 / 3, 6);
  });

  it('collapses to level 1 for missing / zero / non-finite DPR (headless)', () => {
    expect(hardwareScalingLevelForDpr(undefined)).toBe(1);
    expect(hardwareScalingLevelForDpr(0)).toBe(1);
    expect(hardwareScalingLevelForDpr(Number.NaN)).toBe(1);
    expect(hardwareScalingLevelForDpr(Number.POSITIVE_INFINITY)).toBe(1);
    expect(hardwareScalingLevelForDpr(-2)).toBe(1);
  });
});

/**
 * The audio surface's headless guarantee: with no WebAudio in the host (jsdom
 * ships no `AudioContext`), initAudio must resolve false — never reject, never
 * let Babylon's engine factory throw — createSound must resolve null, and the
 * playback calls must accept that null (or any unknown handle) silently. This
 * is the "silent room" path every headless test and SSR pass depends on; the
 * shared contract skips the audio block for engines (skipAudio), so it is
 * pinned here.
 */
describe('BabylonAdapter audio — headless degrade (no AudioContext)', () => {
  it('initAudio resolves false without throwing, idempotently', async () => {
    const adapter = new BabylonAdapter();
    expect(await adapter.initAudio()).toBe(false);
    expect(await adapter.initAudio()).toBe(false);
  });

  it('createSound resolves null and every sound op accepts the null / an unknown handle', async () => {
    const adapter = new BabylonAdapter();
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
 * The glow layer on a LOADED model. The shared contract stands a model root up
 * from primitives (no GLB fetch headlessly); this drives the real thing —
 * Babylon direct-loads a `data:` GLB under NullEngine, no fetch — so the case
 * that actually failed in the arcade room is the one pinned: the handle maps
 * to glTF's geometry-less `__root__`, and the CRT / marquee / coin light are
 * the meshes under it. Also pins the late-child path (a mesh parented under an
 * enrolled root after the call joins on the next frame's onBeforeRender, and
 * nothing listens once no root is enrolled).
 */
describe('BabylonAdapter glow — a loaded model enrols the meshes under its root', () => {
  function headless(): BabylonAdapter {
    const adapter = new BabylonAdapter();
    adapter.engine = new NullEngine();
    adapter.scene = new Scene(adapter.engine);
    adapter.scene.useRightHandedSystem = true;
    return adapter;
  }
  const glowLayerOf = (adapter: BabylonAdapter): GlowLayer =>
    adapter.scene!.effectLayers.find((l) => l.name === 'glow') as GlowLayer;
  // Babylon hands out new-mesh notifications (and observer removals) on a
  // SetImmediate tick — a 1 ms setTimeout batch — so tests wait for it.
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
  // Babylon reads an EMPTY include list as "everything glows", so each test
  // keeps one unrelated primitive enrolled: releasing the model must then read
  // as released, not as the whole scene lighting up again.
  function selective(adapter: BabylonAdapter): MeshHandle {
    adapter.setGlowLayer({ intensity: 0.9 });
    const anchor = adapter.createMesh('anchor', { kind: 'sphere' });
    adapter.addGlowMesh(anchor);
    return anchor;
  }

  it('addGlowMesh on a GLB handle whitelists every mesh under __root__ (instances included); removeGlowMesh clears them', async () => {
    const adapter = headless();
    const { handle } = await adapter.loadMesh('cabinet', { url: cabinetGlbDataUrl() });
    const root = adapter.getMeshRoot('cabinet')!;
    const parts = root.getChildMeshes(false);
    expect(parts.map((m) => m.name).sort()).toEqual(['coinlight', 'marquee', 'screen']);
    // The loader instances the repeated glTF mesh: two of the three are
    // InstancedMeshes, which the glow pass draws through their source.
    expect(parts.filter((m) => m.isAnInstance).length).toBe(2);

    selective(adapter);
    const layer = glowLayerOf(adapter);
    expect(parts.map((m) => layer.hasMesh(m))).toEqual([false, false, false]);
    adapter.addGlowMesh(handle);
    expect(parts.map((m) => layer.hasMesh(m))).toEqual([true, true, true]);

    adapter.removeGlowMesh(handle);
    expect(parts.map((m) => layer.hasMesh(m))).toEqual([false, false, false]);
  });

  it('a mesh parented under an enrolled root afterwards joins on the next tick; strays stay out; the listener goes with the last root', async () => {
    const adapter = headless();
    const scene = adapter.scene!;
    const listeners = () => scene.onNewMeshAddedObservable.observers.length;
    const idle = listeners();

    const { handle } = await adapter.loadMesh('cabinet', { url: cabinetGlbDataUrl() });
    const root = adapter.getMeshRoot('cabinet')!;
    const anchor = selective(adapter);
    adapter.addGlowMesh(handle);
    const layer = glowLayerOf(adapter);
    expect(listeners()).toBe(idle + 1);

    // Babylon announces the mesh on its SetImmediate tick — after the
    // `.parent =` below — so the enrolment lands then, not synchronously.
    const late = MeshBuilder.CreateBox('late-neon', { size: 1 }, scene);
    late.parent = root;
    expect(layer.hasMesh(late)).toBe(false);
    await tick();
    expect(layer.hasMesh(late)).toBe(true);

    // Deeper works too (a plugin's graft under a part), and a stray does not.
    const graft = MeshBuilder.CreateBox('fist', { size: 1 }, scene);
    graft.parent = root.getChildMeshes(false)[0];
    const stray = MeshBuilder.CreateBox('stray', { size: 1 }, scene);
    await tick();
    expect(layer.hasMesh(graft)).toBe(true);
    expect(layer.hasMesh(stray)).toBe(false);

    // Removal takes the late arrivals out with the rest; the listener stays
    // only while some root (here the anchor) is still enrolled.
    adapter.removeGlowMesh(handle);
    expect([late, graft].map((m) => layer.hasMesh(m))).toEqual([false, false]);
    await tick();
    expect(listeners()).toBe(idle + 1);
    adapter.removeGlowMesh(anchor);
    await tick();
    expect(listeners()).toBe(idle);

    // With the model released, a new child under it stays out even while the
    // watch is up for something else.
    adapter.addGlowMesh(anchor);
    const orphan = MeshBuilder.CreateBox('orphan', { size: 1 }, scene);
    orphan.parent = root;
    await tick();
    expect(layer.hasMesh(orphan)).toBe(false);
  });

  it('disabling the layer drops the roots and the listener; a primitive still enrols itself alone', async () => {
    const adapter = headless();
    const scene = adapter.scene!;
    const idle = scene.onNewMeshAddedObservable.observers.length;
    const box = adapter.createMesh('lamp', { kind: 'box' });
    adapter.setGlowLayer({ intensity: 0.9 });
    adapter.addGlowMesh(box);
    expect(glowLayerOf(adapter).hasMesh(adapter.getMeshRoot('lamp') as AbstractMesh)).toBe(true);
    expect(scene.onNewMeshAddedObservable.observers.length).toBe(idle + 1);
    adapter.setGlowLayer(null);
    await tick();
    expect(scene.onNewMeshAddedObservable.observers.length).toBe(idle);
    expect(() => adapter.addGlowMesh(box)).not.toThrow(); // no layer: no-op
  });
});

/**
 * Handedness of an IMPORTED model. The scene is right-handed so the glTF loader
 * adds no compensating root flip, and nothing the adapter does afterwards
 * (instantiate, fit, rotation reset) may introduce one: a vertex the file puts
 * at local +X must land at world +X, through a world matrix with a positive
 * determinant, on every path a room reaches a model by. (The arcade room's
 * mirrored lettering was NOT this — the picture and the import were right, the
 * cabinet atlas had been packed mirrored to suit the old left-handed room — but
 * a mirror here would present the same symptom, so it is pinned.)
 */
describe('BabylonAdapter model import — a glTF is not mirrored', () => {
  function headless(): BabylonAdapter {
    const adapter = new BabylonAdapter();
    adapter.engine = new NullEngine();
    adapter.scene = new Scene(adapter.engine);
    adapter.scene.useRightHandedSystem = true;
    return adapter;
  }
  const det3 = (m: DeepImmutable<Float32Array | number[]>): number =>
    m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) -
    m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) +
    m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);
  /**
   * World-space X extent of the `marquee` triangle (its file-local +X vertex).
   * loadMesh keeps the file's node names; instantiateModel prefixes them with
   * the clone id (`c_marquee`), so the mesh is found by name in the scene.
   */
  function marqueeWorldX(adapter: BabylonAdapter, meshName: string): { minX: number; maxX: number; det: number } {
    const marquee = adapter.scene!.meshes.find((m) => m.name === meshName)!;
    expect(marquee).toBeDefined();
    marquee.computeWorldMatrix(true);
    const bb = marquee.getBoundingInfo().boundingBox;
    return { minX: bb.minimumWorld.x, maxX: bb.maximumWorld.x, det: det3(marquee.getWorldMatrix().m) };
  }

  it('loadMesh: the file-local +X vertex lands at world +X (proper, det > 0)', async () => {
    const adapter = headless();
    await adapter.loadMesh('m', { url: cabinetGlbDataUrl() });
    const { minX, maxX, det } = marqueeWorldX(adapter, 'marquee');
    expect(maxX).toBeCloseTo(1, 4);
    expect(minX).toBeCloseTo(0, 4);
    expect(det).toBeGreaterThan(0);
  });

  it('instantiateModel (+ fit, the room path): the clone keeps local +X at world +X, scaled but never mirrored', async () => {
    const adapter = headless();
    const url = cabinetGlbDataUrl();
    await adapter.loadModelTemplate(url);
    const h = adapter.instantiateModel('c', url, {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      fit: { fitHeight: 2, seatOnGround: true },
    });
    adapter.setModelVisible(h, true);
    const { minX, maxX, det } = marqueeWorldX(adapter, 'c_marquee');
    expect(maxX).toBeCloseTo(2, 4); // 1 m triangle fitted to 2 m tall → +2 m along +X
    expect(minX).toBeCloseTo(0, 4);
    expect(det).toBeGreaterThan(0);
  });

  /**
   * `getMeshRoot` is the host accessor adapter PLUGINS reach a hull through —
   * it is how ShipDamageFX finds a ship to put craters on, shed a wing from, or
   * pulse a damaged part. `loadMesh` indexed its root and `instantiateModel`
   * did not, so it answered null for every model built from a template, which
   * is how every GLB ship in the shooter is made. Nothing threw: "no root" is
   * indistinguishable from "nothing to mark", so the damage effects simply
   * never happened on the ships built to show damage.
   */
  it('instantiateModel indexes the clone root, so getMeshRoot finds it like loadMesh does', async () => {
    const adapter = headless();
    const url = cabinetGlbDataUrl();
    await adapter.loadModelTemplate(url);
    adapter.instantiateModel('ship-7', url, { position: [0, 0, 0] });

    const root = adapter.getMeshRoot('ship-7');
    expect(root).not.toBeNull();
    // And it is the real subtree, not an empty placeholder — a plugin walks
    // these children looking for the part it was asked to mark.
    expect(root!.getChildMeshes(false).length).toBeGreaterThan(0);
  });

  it('loadMesh indexes its root too — the two paths agree', async () => {
    const adapter = headless();
    await adapter.loadMesh('ship-8', { url: cabinetGlbDataUrl() });
    expect(adapter.getMeshRoot('ship-8')).not.toBeNull();
  });
});

/**
 * A minimal binary glTF: `cabinet` (no geometry) with three one-triangle
 * children — `screen`, `marquee` (which carries `coinlight`) — on one emissive
 * material. Handed to loadMesh as a `data:model/gltf-binary` URL, which
 * Babylon's glTF loader direct-loads (no fetch), so the test runs headlessly.
 */
function cabinetGlbDataUrl(): string {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const bin = new Uint8Array(44); // 36 + 6, padded to a 4-byte boundary
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), 36);
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'cabinet', children: [1, 2] },
      { name: 'screen', mesh: 0 },
      { name: 'marquee', mesh: 0, children: [3] },
      { name: 'coinlight', mesh: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [
      { name: 'crt', emissiveFactor: [1, 1, 1], pbrMetallicRoughness: { baseColorFactor: [0, 0, 0, 1] } },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: 44 }],
  });
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20);
  jsonPadded.set(jsonBytes);
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  glb.set(jsonPadded, 20);
  const binOffset = 20 + jsonPadded.length;
  view.setUint32(binOffset, bin.length, true);
  view.setUint32(binOffset + 4, 0x004e4942, true); // 'BIN\0'
  glb.set(bin, binOffset + 8);
  let ascii = '';
  for (const byte of glb) ascii += String.fromCharCode(byte);
  return `data:model/gltf-binary;base64,${btoa(ascii)}`;
}

// A missile that flies blunt-end-first is not a subtle bug once you see it, but
// nothing in the suite looked at the shape of a procedural mesh — so a sign
// error on one rotation shipped, and the nose cone was mounted apex-first into
// the shaft with its flat disc presented to the direction of travel.
// The bug this guards is invisible at devicePixelRatio 1 — which is every
// headless browser and every other test in this file — so it has to set the
// hardware scaling level by hand to reproduce a retina panel.
describe('BabylonAdapter worldToScreen — CSS pixels, not backing-store pixels', () => {
  function retina(scaling: number): BabylonAdapter {
    const adapter = new BabylonAdapter();
    // NullEngine renders at a fixed 512x256 buffer.
    adapter.engine = new NullEngine();
    adapter.scene = new Scene(adapter.engine);
    adapter.scene.useRightHandedSystem = true;
    // hardwareScalingLevel = 1/dpr, so 0.5 is a 2x display: the buffer holds
    // twice as many pixels as the CSS box. NullEngine ignores
    // setHardwareScalingLevel (it always reports 1) and its buffer size is
    // fixed, so the accessor is stubbed — which is precisely the input
    // worldToScreen reads, and the thing under test is that it reads it at all.
    adapter.engine.getHardwareScalingLevel = () => scaling;
    return adapter;
  }

  /** Project a point straight down the camera's nose. */
  function centre(adapter: BabylonAdapter): { x: number; y: number } {
    const cam = adapter.createPerspectiveCamera('c', { fov: 1.05, near: 0.1, far: 1000 });
    adapter.setCameraPose(cam, [0, 0, 0], { x: 0, y: 0, z: 0, w: 1 });
    const out = { x: 0, y: 0 };
    // Identity orientation looks down +Z (the canonical convention), so a point
    // on +Z lands in the middle of the frame.
    expect(adapter.worldToScreen(0, 0, 50, out)).toBe(true);
    return out;
  }

  it('puts the centre of the view at the centre of the CSS box on a 2x display', () => {
    const adapter = retina(0.5);
    const engine = adapter.engine!;
    // The CSS box is the buffer scaled back by the hardware-scaling level.
    const cssW = engine.getRenderWidth() * 0.5;
    const cssH = engine.getRenderHeight() * 0.5;

    const p = centre(adapter);
    expect(p.x).toBeCloseTo(cssW / 2, 0);
    expect(p.y).toBeCloseTo(cssH / 2, 0);
    // And emphatically NOT the buffer's centre, which is what a HUD used to be
    // handed: half a screen right and down of the guns.
    expect(p.x).not.toBeCloseTo(engine.getRenderWidth() / 2, 0);
  });

  it('agrees with itself at 1x, where the two spaces coincide', () => {
    const adapter = retina(1);
    const engine = adapter.engine!;
    const p = centre(adapter);
    expect(p.x).toBeCloseTo(engine.getRenderWidth() / 2, 0);
    expect(p.y).toBeCloseTo(engine.getRenderHeight() / 2, 0);
  });

  // The inverse direction had the same bug the other way round: the ray was
  // built from buffer pixels and Babylon scaled them up AGAIN, so on a 2x
  // display a ray through the middle of the screen came out through its
  // bottom-right corner. A drag tool tracked the pointer at double speed.
  it('screenToWorldPoint aims the middle of the screen down the camera nose on a 2x display', () => {
    for (const scaling of [0.5, 1]) {
      const adapter = retina(scaling);
      const cam = adapter.createPerspectiveCamera('c', { fov: 1.05, near: 0.1, far: 1000 });
      adapter.setCameraPose(cam, [0, 0, 0], { x: 0, y: 0, z: 0, w: 1 });
      const out: [number, number, number] = [0, 0, 0];
      adapter.screenToWorldPoint(cam, 0.5, 0.5, 50, out);
      expect(out[0]).toBeCloseTo(0, 3);
      expect(out[1]).toBeCloseTo(0, 3);
      expect(out[2]).toBeGreaterThan(49);
    }
  });

  it('screenToWorldPoint round-trips with worldToScreen on a 2x display', () => {
    const adapter = retina(0.5);
    const engine = adapter.engine!;
    const cam = adapter.createPerspectiveCamera('c', { fov: 1.05, near: 0.1, far: 1000 });
    adapter.setCameraPose(cam, [0, 0, 0], { x: 0, y: 0, z: 0, w: 1 });
    const cssW = engine.getRenderWidth() * 0.5;
    const cssH = engine.getRenderHeight() * 0.5;
    const world: [number, number, number] = [0, 0, 0];
    adapter.screenToWorldPoint(cam, 0.25, 0.75, 40, world);
    const back = { x: 0, y: 0 };
    expect(adapter.worldToScreen(world[0], world[1], world[2], back)).toBe(true);
    expect(back.x / cssW).toBeCloseTo(0.25, 3);
    expect(back.y / cssH).toBeCloseTo(0.75, 3);
  });
});

/**
 * Bursts must not accumulate. A GPU particle system never disposes itself —
 * `disposeOnStop` is a CPU-only behaviour; the GPU `stop()` flips a bool — so
 * one-per-burst left every hit spark and explosion in `scene.particleSystems`
 * paying an update pass and a draw every frame, forever. The cabinet slid from
 * the 30s into the teens over a minute of play while every mesh count sat
 * still. So the GPU bursts are POOLED: configured per burst, started, and once
 * their particles have had time to die, stopped, reset and taken out of the
 * scene until the next burst reuses them.
 *
 * NullEngine cannot drive a GPU system's frame loop, so the pool's bookkeeping
 * is exercised directly (the sweep, with the clock advanced), and the CPU
 * fallback's self-dispose wiring is pinned on the natural NullEngine path.
 */
/**
 * The frame-time split — the readout that turns "we're at 32fps and it's
 * CPU-bound" into a number with a name on it.
 *
 * Driven by a scripted clock rather than a real loop. A wall-clock test of a
 * timing feature measures the machine it runs on: it passes on an idle laptop,
 * fails in CI under load, and teaches you nothing either way. Feeding
 * `performance.now` a fixed sequence pins what is actually being claimed —
 * that the milliseconds land in the right bucket and that the buckets add up.
 */
describe('BabylonAdapter frame timings', () => {
  /**
   * Drive N loop iterations with a fixed cost per phase.
   *
   * The loop body is captured off `runRenderLoop` rather than let run: calling
   * it by hand is what makes the clock scriptable. No camera is registered, so
   * `scene.render()` is skipped and Babylon never reads the clock behind us.
   */
  function runFrames(opts: { frames: number; tickMs: number; renderMs: number; gapMs: number }) {
    const adapter = new BabylonAdapter();
    const engine = new NullEngine();
    const scene = new Scene(engine);
    (adapter as unknown as { engine: NullEngine }).engine = engine;
    (adapter as unknown as { scene: Scene }).scene = scene;
    // The adapter skips the draw when no camera is registered, so the split
    // needs one — but a real render would read the clock behind us and spend
    // an unknown amount of it. A stub camera plus a stub render buys both: the
    // branch is taken, and the draw costs exactly what the script says.
    scene.activeCamera = {} as unknown as Scene['activeCamera'];

    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.spyOn(scene, 'render').mockImplementation(() => {
      clock += opts.renderMs;
    });

    let body: (() => void) | undefined;
    vi.spyOn(engine, 'runRenderLoop').mockImplementation((fn) => {
      body = fn as () => void;
    });

    const dts: number[] = [];
    adapter.startLoop((dt) => {
      dts.push(dt);
      clock += opts.tickMs;
    });

    for (let i = 0; i < opts.frames; i++) {
      // Everything between the end of one loop body and the start of the next:
      // vsync wait, compositing, the browser's own work.
      clock += opts.gapMs;
      body!();
    }

    const timings = adapter.getFrameTimings();
    now.mockRestore();
    vi.restoreAllMocks();
    return { timings, dts, adapter, engine };
  }

  it('splits one frame into tick, render and the gap between loop bodies', () => {
    // 2ms of simulation, 3ms of draw submission, 15ms of nothing — a frame that
    // is mostly waiting, which is the shape a vsync-capped or GPU-bound game
    // makes and the shape that gets misdiagnosed as "the renderer is slow".
    const { timings } = runFrames({ frames: 200, tickMs: 2, renderMs: 3, gapMs: 15 });
    expect(timings.tick).toBeCloseTo(2, 3);
    expect(timings.render).toBeCloseTo(3, 3);
    expect(timings.frame).toBeCloseTo(20, 3);
    // The whole point of the row: 15ms nobody in the loop spent.
    expect(timings.outside).toBeCloseTo(15, 3);
  });

  it('discards the first interval, which measures scene construction and not a frame', () => {
    // startLoop stamps the clock, and the first callback lands however long
    // later the browser felt like — after asset upload, shader compilation, a
    // scene build. Fed into a smoothed average that one sample reads as a
    // half-second frame for the next several seconds, so the panel's first
    // impression would be a lie every time.
    const adapter = new BabylonAdapter();
    const engine = new NullEngine();
    (adapter as unknown as { engine: NullEngine }).engine = engine;
    (adapter as unknown as { scene: Scene }).scene = new Scene(engine);

    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    let body: (() => void) | undefined;
    vi.spyOn(engine, 'runRenderLoop').mockImplementation((fn) => { body = fn as () => void; });

    adapter.startLoop(() => {});
    clock += 4000; // four seconds of loading before the first frame
    body!();
    expect(adapter.getFrameTimings().frame).toBe(0);

    clock += 20;
    body!();
    // Only the honest 20ms interval reaches the average.
    expect(adapter.getFrameTimings().frame).toBeCloseTo(2, 6);
    vi.restoreAllMocks();
  });

  it('hands the same interval to the simulation as seconds of dt', () => {
    const { dts } = runFrames({ frames: 3, tickMs: 2, renderMs: 3, gapMs: 15 });
    // frame 1 is the startLoop→first-body gap; 2 and 3 are steady state.
    expect(dts[1]).toBeCloseTo(0.02, 6);
    expect(dts[2]).toBeCloseTo(0.02, 6);
  });

  it('reports zeros and no false confidence before the loop has run', () => {
    const adapter = new BabylonAdapter();
    const t = adapter.getFrameTimings();
    expect(t.frame).toBe(0);
    expect(t.outside).toBe(0);
    // renderMeasured is a statement about the ADAPTER, not about this frame:
    // this one owns its draw call whether or not it has made one yet.
    expect(t.renderMeasured).toBe(true);
    expect(t.gpuMeasured).toBe(false);
    expect(t.breakdownMeasured).toBe(false);
  });

  it('attaches and fully releases the engine instrumentation', () => {
    const adapter = new BabylonAdapter();
    const engine = new NullEngine();
    (adapter as unknown as { engine: NullEngine }).engine = engine;
    (adapter as unknown as { scene: Scene }).scene = new Scene(engine);

    expect(adapter.getFrameTimings().breakdownMeasured).toBe(false);
    adapter.profileFrame(true);
    adapter.profileFrame(true); // idempotent — no second instrumentation
    expect(adapter.getFrameTimings().breakdownMeasured).toBe(true);
    // NullEngine has no timer-query extension, so the GPU counter never
    // receives a sample. The flag says so instead of the row reading 0.00ms.
    expect(adapter.getFrameTimings().gpuMeasured).toBe(false);

    adapter.profileFrame(false);
    expect(adapter.getFrameTimings().breakdownMeasured).toBe(false);
    // The trap this pins: the GPU timer's two observers live on the ENGINE,
    // registered by captureGPUFrameTime, and EngineInstrumentation.dispose()
    // does not remove them. Dispose without clearing the flag first and the
    // engine keeps starting a timer query every frame for the rest of the
    // session with nothing alive to read it.
    expect((engine as unknown as { _captureGPUFrameTime?: boolean })._captureGPUFrameTime).toBe(false);
    expect(engine.onBeginFrameObservable.hasObservers()).toBe(false);
    expect(engine.onEndFrameObservable.hasObservers()).toBe(false);
  });
});

/**
 * The shadow map covers a square 2·extent wide around the light's axis, so the
 * extent decides how sharp a shadow is. Absent, the old ±25 box stays, so no
 * existing scene changes.
 */
describe('BabylonAdapter directional shadow extent', () => {
  function headless(): BabylonAdapter {
    const adapter = new BabylonAdapter();
    adapter.engine = new NullEngine();
    adapter.scene = new Scene(adapter.engine);
    return adapter;
  }
  const light = (adapter: BabylonAdapter, id: string) =>
    adapter.scene!.lights.find((l) => l.name === `DirectionalLight_${id}`) as unknown as {
      orthoLeft: number;
      orthoRight: number;
      orthoTop: number;
      orthoBottom: number;
    };
  const spec = (extent?: number) => ({
    direction: [0, -1, 0] as [number, number, number],
    intensity: 1,
    diffuse: [1, 1, 1] as [number, number, number],
    specular: [1, 1, 1] as [number, number, number],
    shadow: { enabled: true, mapSize: 512, minZ: 0, maxZ: 10, ...(extent === undefined ? {} : { extent }) },
  });

  it('defaults to the old ±25 box', () => {
    const adapter = headless();
    adapter.createDirectionalLight('sun', spec());
    const l = light(adapter, 'sun');
    expect([l.orthoLeft, l.orthoRight, l.orthoTop, l.orthoBottom]).toEqual([-25, 25, 25, -25]);
  });

  it('honours the extent', () => {
    const adapter = headless();
    adapter.createDirectionalLight('lamp', spec(1.8));
    const l = light(adapter, 'lamp');
    expect([l.orthoLeft, l.orthoRight, l.orthoTop, l.orthoBottom]).toEqual([-1.8, 1.8, 1.8, -1.8]);
  });
});

/**
 * A repainted pinball floor makes a new textured ground and disposes the old
 * one. Material.dispose() leaves the material's textures alive, so every
 * repaint leaked a whole floor texture (15 MB of GPU memory at 768 × 3744).
 */
describe('BabylonAdapter disposeMesh — a textured material takes its own textures with it', () => {
  function headless(): BabylonAdapter {
    const adapter = new BabylonAdapter();
    adapter.engine = new NullEngine();
    adapter.scene = new Scene(adapter.engine);
    return adapter;
  }
  const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  it('leaves no texture behind after a create/dispose cycle', () => {
    const adapter = headless()
    // The first PBR material makes the scene's shared BRDF lookup texture; count after it.
    adapter.disposeMesh(adapter.createMesh('warm', { kind: 'ground', width: 2, depth: 2 }, { albedoTexture: PIXEL }))
    const before = adapter.scene!.textures.length
    for (let i = 0; i < 3; i++) {
      const h = adapter.createMesh(`floor${i}`, { kind: 'ground', width: 2, depth: 2 }, { albedoTexture: PIXEL })
      adapter.disposeMesh(h)
    }
    expect(adapter.scene!.textures.length).toBe(before)
  })

  it('keeps a texture the adapter hands out as a shared handle', () => {
    const adapter = headless()
    const t = adapter.loadTexture('shared', PIXEL)
    const h = adapter.createMesh('wearer', { kind: 'box' })
    const own = adapter.getTextureObject(t)!
    const mesh = (adapter as unknown as { meshes: Map<unknown, { material: { albedoTexture?: unknown } | null }> }).meshes.get(h)!
    mesh.material = new PBRMaterial('m', adapter.scene!) as never
    ;(mesh.material as unknown as PBRMaterial).albedoTexture = own
    adapter.disposeMesh(h)
    expect(adapter.scene!.textures).toContain(own)
  })
})
