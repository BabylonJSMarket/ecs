/**
 * Unit tests for the pure pieces of BabylonAdapter that don't need a live
 * engine. The engine-bound methods are exercised by BabylonAdapter.contract
 * (NullEngine); here we lock down `hardwareScalingLevelForDpr`, which decides
 * how crisp a retina display renders — a 2× display must drive the backing
 * buffer at full physical resolution, not 1× CSS pixels.
 */

import { describe, it, expect } from 'vitest';
import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
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
describe('BabylonAdapter procedural missile — the nose points where it is going', () => {
  function headless(): BabylonAdapter {
    const adapter = new BabylonAdapter();
    adapter.engine = new NullEngine();
    adapter.scene = new Scene(adapter.engine);
    adapter.scene.useRightHandedSystem = true;
    return adapter;
  }

  /** Every vertex of `mesh`, expressed in its ROOT's local frame. */
  function verticesInRootSpace(mesh: AbstractMesh): Array<[number, number, number]> {
    const raw = mesh.getVerticesData('position')!;
    const out: Array<[number, number, number]> = [];
    // The child carries the rotation under test, so bake it in: what matters is
    // where the geometry lands on the missile, not how the child is oriented.
    mesh.computeWorldMatrix(true);
    const m = mesh.getWorldMatrix();
    for (let i = 0; i < raw.length; i += 3) {
      const p = Vector3.TransformCoordinates(
        new Vector3(raw[i], raw[i + 1], raw[i + 2]), m,
      );
      out.push([p.x, p.y, p.z]);
    }
    return out;
  }

  it('the cone tapers to a POINT at the front and is open where it meets the shaft', () => {
    const adapter = headless();
    adapter.createProceduralMesh('msl', { shape: 'missile', size: [1, 1, 10] });

    const nose = adapter.scene!.meshes.find((m) => m.name === 'msl-nose');
    expect(nose).toBeDefined();

    const verts = verticesInRootSpace(nose!);
    const zs = verts.map((v) => v[2]);
    const front = Math.max(...zs);
    const back = Math.min(...zs);

    // Radius of the cross-section at each end, measured about the missile's axis.
    const radiusAt = (z: number) => {
      const ring = verts.filter((v) => Math.abs(v[2] - z) < 1e-3);
      return Math.max(...ring.map((v) => Math.hypot(v[0], v[1])));
    };

    // Front = the apex: everything there sits on the axis.
    expect(radiusAt(front)).toBeLessThan(0.01);
    // Back = the open base, seated against the shaft, at the body's full radius.
    expect(radiusAt(back)).toBeGreaterThan(0.4);
  });

  it('the cone sits ahead of the body, not inside it', () => {
    const adapter = headless();
    adapter.createProceduralMesh('msl2', { shape: 'missile', size: [1, 1, 10] });
    const zOf = (name: string) => {
      const mesh = adapter.scene!.meshes.find((m) => m.name === name)!;
      return verticesInRootSpace(mesh).map((v) => v[2]);
    };
    expect(Math.max(...zOf('msl2-nose'))).toBeGreaterThan(Math.max(...zOf('msl2-body')));
  });
});

describe('BabylonAdapter mesh bounds — where the art actually is', () => {
  it('reports the world box of a procedural hull, centred on its geometry', () => {
    const adapter = new BabylonAdapter();
    adapter.engine = new NullEngine();
    adapter.scene = new Scene(adapter.engine);
    adapter.scene.useRightHandedSystem = true;
    adapter.createProceduralMesh('hull', { shape: 'missile', size: [1, 1, 10] });

    const min: [number, number, number] = [0, 0, 0];
    const max: [number, number, number] = [0, 0, 0];
    expect(adapter.getMeshWorldBounds('hull', min, max)).toBe(true);

    // A 10-long missile: the box must span roughly that along Z and be about a
    // unit across. The point is that it reflects the GEOMETRY under the root —
    // the root node's own bounds are empty, which is the trap this guards.
    expect(max[2] - min[2]).toBeGreaterThan(5);
    expect(max[0] - min[0]).toBeGreaterThan(0.5);
    expect(max[0] - min[0]).toBeLessThan(4);
  });
})

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
});

describe('BabylonAdapter sun — one sun, replaced rather than stacked', () => {
  function headless(): BabylonAdapter {
    const adapter = new BabylonAdapter();
    adapter.engine = new NullEngine();
    adapter.scene = new Scene(adapter.engine);
    adapter.scene.useRightHandedSystem = true;
    return adapter;
  }
  const sunSpec = {
    direction: [0.6, -0.25, -0.76] as [number, number, number],
    distance: 2400,
    intensity: 4.5,
    diffuse: [1, 0.95, 0.85] as [number, number, number],
    specular: [1, 0.95, 0.85] as [number, number, number],
    starburst: { size: 850, color: [3, 2.5, 1.5] as [number, number, number], texels: 32 },
  };
  // Babylon defers observer removal onto a timeout tick, so a test that counts
  // observers has to let that batch land first.
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
  const discs = (a: BabylonAdapter) => a.scene!.meshes.filter((m) => m.name.includes('_disc'));
  const stars = (a: BabylonAdapter) => a.scene!.meshes.filter((m) => m.name.includes('_starburst'));

  it('a second createSun replaces the first — one light, one disc, one star, one observer', async () => {
    // The round reset rebuilds the world in place and calls straight back in
    // here. Stacking would leave the old light burning (the scene gaining a
    // directional light per death), the old disc parked inside the new one, and
    // the old follow observer running for the rest of the session.
    const adapter = headless();
    adapter.createPerspectiveCamera('cam', { fov: 1, near: 0.1, far: 200000 });
    adapter.createSun('sun', sunSpec);
    const beforeObservers = adapter.scene!.onBeforeRenderObservable.observers.length;
    const firstDisc = discs(adapter)[0];

    adapter.createSun('sun', sunSpec);
    expect(discs(adapter)).toHaveLength(1);
    expect(stars(adapter)).toHaveLength(1);
    expect(adapter.scene!.lights.filter((l) => l.name.startsWith('Sun_'))).toHaveLength(1);
    await tick();
    expect(adapter.scene!.onBeforeRenderObservable.observers.length).toBe(beforeObservers);
    // And the surviving disc is the NEW one — the flare's render target binds to
    // whatever getSunDisc hands back, so handing back a disposed mesh is the
    // difference between a flare and a black square.
    expect(adapter.getSunDisc()).not.toBe(firstDisc);
    expect(firstDisc.isDisposed()).toBe(true);
  });

  it('enrols the disc and the star in the glow layer, whichever is set up first', () => {
    // GlowLayer's include list is a WHITELIST: leave the sun out and the layer
    // runs, costs its pass, and glows nothing — which is most of why the ported
    // sun read as a flat dot next to the reference.
    for (const glowFirst of [true, false]) {
      const adapter = headless();
      adapter.createPerspectiveCamera('cam', { fov: 1, near: 0.1, far: 200000 });
      if (glowFirst) adapter.setGlowLayer({ intensity: 0.9 });
      adapter.createSun('sun', sunSpec);
      if (!glowFirst) adapter.setGlowLayer({ intensity: 0.9 });
      const layer = adapter.scene!.effectLayers.find((l) => l.name === 'glow') as GlowLayer;
      expect(layer.hasMesh(adapter.getSunDisc()!)).toBe(true);
      expect(layer.hasMesh(stars(adapter)[0])).toBe(true);
    }
  });

  it('drops the replaced sun out of the glow whitelist', () => {
    // A disposed mesh left in the include list keeps being walked by the layer.
    const adapter = headless();
    adapter.createPerspectiveCamera('cam', { fov: 1, near: 0.1, far: 200000 });
    adapter.setGlowLayer({ intensity: 0.9 });
    adapter.createSun('sun', sunSpec);
    const layer = adapter.scene!.effectLayers.find((l) => l.name === 'glow') as GlowLayer;
    const staleDisc = adapter.getSunDisc()!;
    const staleStar = stars(adapter)[0];
    adapter.createSun('sun', sunSpec);
    expect(layer.hasMesh(staleDisc)).toBe(false);
    expect(layer.hasMesh(staleStar)).toBe(false);
    expect(layer.hasMesh(adapter.getSunDisc()!)).toBe(true);
  });

  it('omitting starburst leaves the bare disc', () => {
    const adapter = headless();
    adapter.createPerspectiveCamera('cam', { fov: 1, near: 0.1, far: 200000 });
    const { starburst: _drop, ...bare } = sunSpec;
    adapter.createSun('sun', bare);
    expect(discs(adapter)).toHaveLength(1);
    expect(stars(adapter)).toHaveLength(0);
  });
});

describe('BabylonAdapter rock field — one material, not one per rock', () => {
  function headless(): BabylonAdapter {
    const adapter = new BabylonAdapter();
    adapter.engine = new NullEngine();
    adapter.scene = new Scene(adapter.engine);
    adapter.scene.useRightHandedSystem = true;
    return adapter;
  }
  const rockMats = (a: BabylonAdapter) =>
    a.scene!.materials.filter((m) => m.name.startsWith('rock-shared-'));

  function field(adapter: BabylonAdapter, n: number): MeshHandle[] {
    const out: MeshHandle[] = [];
    for (let i = 0; i < n; i++) {
      out.push(adapter.createProceduralMesh(`rock-${i}`, {
        shape: 'asteroid', size: [40, 40, 40], seed: i, color: [0.5, 0.45, 0.4],
        subdivisions: 2,
      }));
    }
    return out;
  }

  it('a whole field shares ONE material', () => {
    // Babylon batches by material, so a material per rock is a full state change
    // and a uniform upload per rock, every frame, on meshes that deliberately
    // never frustum-cull. That is what a 120-rock field was paying.
    const adapter = headless();
    const handles = field(adapter, 40);
    expect(rockMats(adapter)).toHaveLength(1);
    const first = adapter.scene!.getMeshByName('rock-0')!.material;
    for (const name of ['rock-7', 'rock-39']) {
      expect(adapter.scene!.getMeshByName(name)!.material).toBe(first);
    }
    expect(handles).toHaveLength(40);
  });

  it('each rock still gets its own hue, carried in the vertex colours', () => {
    // The variation has to survive losing the per-rock material, or the field
    // turns into forty identical grey balls.
    const adapter = headless();
    field(adapter, 4);
    const tintOf = (name: string) => {
      const c = adapter.scene!.getMeshByName(name)!.getVerticesData('color')!;
      return [c[0], c[1], c[2]];
    };
    expect(tintOf('rock-0')).not.toEqual(tintOf('rock-1'));
    // Uniform across one rock's own vertices — it is a tint, not a gradient.
    const c = adapter.scene!.getMeshByName('rock-2')!.getVerticesData('color')!;
    expect([c[4], c[5], c[6]]).toEqual([c[0], c[1], c[2]]);
    // And the albedo is left white so the vertex colour is what shows.
    const mat = rockMats(adapter)[0] as unknown as { albedoColor: { r: number } };
    expect(mat.albedoColor.r).toBe(1);
  });

  it('disposing one rock does not strip the material off the others', () => {
    // disposeMesh disposes a mesh's material. Sharing one without guarding that
    // means the first rock destroyed takes the whole field down to Babylon's
    // default grey — and nothing errors.
    const adapter = headless();
    const handles = field(adapter, 5);
    adapter.disposeMesh(handles[0]);
    const survivor = adapter.scene!.getMeshByName('rock-3')!.material!;
    // A disposed material is pulled out of scene.materials — that is the check,
    // since Babylon materials carry no isDisposed().
    expect(adapter.scene!.materials).toContain(survivor);
    expect(rockMats(adapter)).toHaveLength(1);
  });

  it('still disposes a material that only one mesh wears', () => {
    // The guard must not leak the ordinary case.
    const adapter = headless();
    // A material spec, or the primitive gets no material to dispose.
    const solo = adapter.createMesh('solo', { kind: 'sphere' }, { diffuse: [1, 0, 0] });
    const mat = adapter.scene!.getMeshByName('solo_sphere')!.material!;
    expect(adapter.scene!.materials).toContain(mat);
    adapter.disposeMesh(solo);
    expect(adapter.scene!.materials).not.toContain(mat);
  });

  it('oil blobs and drops get their own shared material, not the asteroid one', () => {
    const adapter = headless();
    field(adapter, 3);
    adapter.createProceduralMesh('blob', {
      shape: 'oil-blob', size: [50, 50, 50], seed: 1, color: [0.3, 0.28, 0.25],
    });
    adapter.createProceduralMesh('drop', {
      shape: 'asteroid-drop', size: [2, 2, 2], color: [0.4, 0.3, 0.2],
    });
    // Three kinds, three materials — for any number of rocks.
    expect(rockMats(adapter)).toHaveLength(3);
  });
});
