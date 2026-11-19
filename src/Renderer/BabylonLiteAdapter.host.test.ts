/**
 * BabylonLiteAdapter's plugin host accessors — the Lite twins of
 * BabylonAdapter's getScene / getOrbitCamera / getPhysicsBody /
 * getHavokPlugin / getMeshIdForBody, plus getEngine (Lite's texture uploads
 * take an EngineContext, which Babylon reaches through scene.getEngine()).
 *
 * Lite needs a WebGPU device for a real scene, so the scene, engine, camera and
 * Havok world are stand-ins and the aggregate factory is a spy; no device is
 * touched (see BabylonLiteAdapter.gravity.test for the same pattern).
 */
import { describe, it, expect, vi } from 'vitest';
import type { CameraHandle, LightHandle, MeshHandle, ParticleEmitterSpec, TextureHandle } from './types';

vi.hoisted(() => {
  // Lite's bundle reads these at module init (see BabylonLiteAdapter.contract.test).
  const g = globalThis as Record<string, unknown>;
  g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  g.GPUBufferUsage ??= {};
  g.GPUTextureUsage ??= {};
  g.GPUMapMode ??= {};
  g.GPUColorWrite ??= {};
});

vi.mock('@babylonjs/lite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@babylonjs/lite')>()),
  createPhysicsAggregate: vi.fn((_world: unknown, node: unknown) => ({ body: { node }, shape: {} })),
  setPhysicsBodyPreStep: vi.fn(),
  setPhysicsBodyMotionType: vi.fn(),
  // Billboard sprites need a device; record them instead.
  createTexture2DFromPixels: vi.fn(() => ({ width: 32, height: 32 })),
  createGridSpriteAtlas: vi.fn(() => ({ atlas: true })),
  createFacingBillboardSystem: vi.fn(() => ({ visible: true, count: 0, sprites: [] as unknown[] })),
  addFacingBillboardSystem: vi.fn(),
  clearBillboardSprites: vi.fn((sys: { count: number; sprites: unknown[] }) => { sys.count = 0; sys.sprites.length = 0; }),
  addBillboardSpriteIndex: vi.fn((sys: { count: number; sprites: unknown[] }, props: { position: number[]; color: number[] }) => {
    sys.sprites.push({ position: [...props.position], color: [...props.color] });
    return sys.count++;
  }),
  updateBillboardSpriteIndex: vi.fn((sys: { sprites: Record<string, unknown>[] }, i: number, patch: Record<string, unknown>) => {
    Object.assign(sys.sprites[i]!, patch);
  }),
  updateTexture2DFromPixels: vi.fn(),
  setShadowTaskCasterMeshes: vi.fn(),
  // The thin-instance primer: record it instead of making GPU buffers.
  createBox: vi.fn(() => ({ name: '', material: null as unknown, pickable: true })),
  setThinInstances: vi.fn(),
  addToScene: vi.fn(),
  // Texture maps: resolve at once, no device.
  loadTexture2D: vi.fn(async (_engine: unknown, url: string) => ({ url })),
}));

const { BabylonLiteAdapter } = await import('./BabylonLiteAdapter');

interface Internals {
  scene: unknown;
  engine: unknown;
  havokWorld: unknown;
  havokReady: boolean;
  cameras: Map<CameraHandle, { camera: unknown }>;
  meshesByMeshId: Map<string, unknown>;
  meshes: Map<MeshHandle, unknown>;
}

const internals = (a: InstanceType<typeof BabylonLiteAdapter>) => a as unknown as Internals;

describe('BabylonLiteAdapter plugin host accessors', () => {
  it('answer null before init(), so a plugin can wait instead of throwing', () => {
    const a = new BabylonLiteAdapter();
    expect(a.getScene()).toBeNull();
    expect(a.getEngine()).toBeNull();
    expect(a.getHavokWorld()).toBeNull();
    expect(a.getPhysicsBody('nope')).toBeNull();
    expect(a.getOrbitCamera({ __handle: 'x' } as unknown as CameraHandle)).toBeNull();
  });

  it('hand out the live scene and engine', () => {
    const a = new BabylonLiteAdapter();
    const scene = { fake: 'scene' };
    const engine = { fake: 'engine' };
    internals(a).scene = scene;
    internals(a).engine = engine;
    expect(a.getScene()).toBe(scene);
    expect(a.getEngine()).toBe(engine);
  });

  it('getOrbitCamera returns the ArcRotateCamera behind a handle', () => {
    const a = new BabylonLiteAdapter();
    const camera = { beta: 1 };
    const h = { __handle: 'cam' } as unknown as CameraHandle;
    internals(a).cameras.set(h, { camera });
    expect(a.getOrbitCamera(h)).toBe(camera);
  });

  it('the Havok world is withheld until it is ready', () => {
    const a = new BabylonLiteAdapter();
    const world = { fake: 'world' };
    internals(a).havokWorld = world;
    expect(a.getHavokWorld()).toBeNull();
    internals(a).havokReady = true;
    expect(a.getHavokWorld()).toBe(world);
  });

  it('a body maps to its mesh both ways, and forgets it when destroyed', () => {
    const a = new BabylonLiteAdapter();
    internals(a).havokWorld = { fake: 'world' };
    internals(a).havokReady = true;
    internals(a).meshesByMeshId.set('ball', { name: 'ball' });
    expect(a.physicsCreateBody('ball', {
      motionType: 'dynamic', mass: 1, friction: 0.5, restitution: 0.2, shapeType: 'sphere', lockRotation: false,
    })).toBe(true);
    const body = a.getPhysicsBody('ball');
    expect(body).not.toBeNull();
    expect(a.getMeshIdForBody(body!)).toBe('ball');
    a.physicsDestroyBody('ball');
    expect(a.getPhysicsBody('ball')).toBeNull();
    expect(a.getMeshIdForBody(body!)).toBeUndefined();
  });

  it('getMeshObject / getMeshRoot hand out the Lite mesh by handle and by id, null when unknown or disposed', () => {
    const a = new BabylonLiteAdapter();
    const mesh = { name: 'flame', children: [], visible: true, pickable: true };
    const h = { __handle: 'mesh:flame' } as unknown as MeshHandle;
    expect(a.getMeshObject(h)).toBeNull();
    expect(a.getMeshRoot('flame')).toBeNull();
    internals(a).meshes.set(h, mesh);
    internals(a).meshesByMeshId.set('flame', mesh);
    expect(a.getMeshObject(h)).toBe(mesh);
    expect(a.getMeshRoot('flame')).toBe(mesh);
    a.disposeMesh(h);
    expect(a.getMeshObject(h)).toBeNull();
    expect(a.getMeshRoot('flame')).toBeNull();
  });

  it('runs the material-group builders queued after registerScene, once, and re-records the frame graph', async () => {
    const a = new BabylonLiteAdapter();
    let calls = 0;
    let rebuilt = 0;
    const scene = {
      _built: true,
      _deferredBuilders: [] as (() => Promise<void>)[],
      _renderables: [{ order: 5 }] as { order: number }[],
      _renderableVersion: 0,
      _frameGraph: { build: () => { rebuilt++; } },
    };
    // What Lite queues for a NEW material family: build it and add its renderables.
    scene._deferredBuilders.push(async () => { calls++; scene._renderables.push({ order: 2 }); });
    internals(a).scene = scene;
    const build = (a as unknown as { buildLateMaterialGroups(s: unknown): void }).buildLateMaterialGroups.bind(a);
    build(scene);
    build(scene); // a second frame while the first build is in flight starts nothing
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(scene._deferredBuilders).toHaveLength(0);
    expect(scene._renderables.map((r) => r.order)).toEqual([2, 5]);
    expect(scene._renderableVersion).toBe(1);
    expect(rebuilt).toBe(1);
    build(scene);
    await new Promise((r) => setTimeout(r, 0));
    expect(rebuilt).toBe(1);
  });

  it('drops a queued mesh\'s old renderable before Lite rebuilds it (Lite\'s swap drain keeps it, on destroyed buffers)', () => {
    const a = new BabylonLiteAdapter();
    const builtGroup = Object.assign(async () => ({ renderables: [] }), { _rebuildSingle: () => ({}) });
    const swapped = { material: { _buildGroup: builtGroup } };
    const other = { material: { _buildGroup: builtGroup } };
    const scene = {
      _materialSwapQueue: [swapped] as unknown[],
      _renderables: [{ mesh: swapped, order: 100 }, { mesh: other, order: 100 }],
      _renderableVersion: 0,
      _deferredBuilders: [],
      _groups: new Map(),
      _builtGroups: new Set([builtGroup]),
    };
    (a as unknown as { dropSwappedRenderables(s: unknown): void }).dropSwappedRenderables(scene);
    expect(scene._renderables.map((r) => r.mesh)).toEqual([other]);
    expect(scene._materialSwapQueue).toEqual([swapped]); // Lite still rebuilds it
  });

  it('a swap to a material family the scene never built joins that family\'s late build instead of vanishing', async () => {
    const a = new BabylonLiteAdapter();
    const destroyed: string[] = [];
    const pbrGroup = Object.assign(
      async (_s: unknown, meshes: unknown[]) => ({ renderables: meshes.map((m) => ({ mesh: m, order: 100 })) }),
      { _rebuildSingle: undefined },
    );
    const ball = { material: { _buildGroup: pbrGroup } };
    const scene = {
      _built: true,
      _materialSwapQueue: [ball] as unknown[],
      _renderables: [{ mesh: ball, order: 100 }] as { mesh: unknown; order: number }[],
      _renderableVersion: 0,
      _deferredBuilders: [] as (() => Promise<void>)[],
      _groups: new Map<unknown, unknown[]>(),
      _builtGroups: new Set<unknown>(),
      _uniformUpdaters: [] as unknown[],
      _meshDisposables: new Map([[ball, [() => destroyed.push('old ubo')]]]),
      _frameGraph: { build: () => {} },
    };
    internals(a).scene = scene;
    (a as unknown as { dropSwappedRenderables(s: unknown): void }).dropSwappedRenderables(scene);
    expect(scene._materialSwapQueue).toEqual([]);
    expect(scene._renderables).toEqual([]);
    expect(scene._groups.get(pbrGroup)).toEqual([ball]);
    expect(scene._deferredBuilders).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(destroyed).toEqual(['old ubo']); // once the GPU is done with it
    (a as unknown as { buildLateMaterialGroups(s: unknown): void }).buildLateMaterialGroups(scene);
    await new Promise((r) => setTimeout(r, 0));
    expect(scene._renderables.map((r) => r.mesh)).toEqual([ball]);
    expect(scene._builtGroups.has(pbrGroup)).toBe(true);
  });

  it('detaching one shadow caster keeps the others, and a caster about to swap material gets a fresh list', async () => {
    const BL = await import('@babylonjs/lite');
    const set = BL.setShadowTaskCasterMeshes as unknown as ReturnType<typeof vi.fn>;
    const a = new BabylonLiteAdapter();
    const ia = a as unknown as {
      shadowGenerators: Map<unknown, unknown>; shadowCasterMeshes: Map<unknown, unknown[]>; meshes: Map<unknown, unknown>;
      rekeyShadowCasters(q: unknown[]): void;
    };
    const gen = { gen: 1 };
    const light = 'light' as unknown as LightHandle;
    const ball = { name: 'ball' }, rail = { name: 'rail' };
    ia.shadowGenerators.set(light, gen);
    ia.meshes.set('h-ball', ball);
    ia.meshes.set('h-rail', rail);
    const hb = a.attachShadowCaster(light, 'h-ball' as unknown as MeshHandle);
    a.attachShadowCaster(light, 'h-rail' as unknown as MeshHandle);
    a.detachShadowCaster(hb);
    expect(set.mock.calls.at(-1)).toEqual([gen, [rail]]);
    const before = ia.shadowCasterMeshes.get(light);
    ia.rekeyShadowCasters([rail]);
    const after = ia.shadowCasterMeshes.get(light);
    expect(after).not.toBe(before);
    expect(after).toEqual([rail]);
    expect(set.mock.calls.at(-1)![1]).toBe(after);
  });

  it('a texture swap waits for the first scene build, so Lite never builds a group emptied under it', async () => {
    const BL = await import('@babylonjs/lite');
    const a = new BabylonLiteAdapter();
    const base = BL.createPbrMaterial({ baseColorFactor: [1, 1, 1, 1] });
    const mesh = { material: base as unknown };
    const group = [mesh];
    internals(a).engine = { fake: 'engine' };
    internals(a).scene = { _groups: new Map([[(base as { _buildGroup?: unknown })._buildGroup, group]]), _renderables: [] };
    let finish!: () => void;
    (a as unknown as { firstBuild: Promise<unknown> | null }).firstBuild = new Promise<void>((r) => { finish = r; });
    (a as unknown as { loadTextureMaps(m: unknown, b: unknown, s: unknown): void }).loadTextureMaps(mesh, base, { albedoTexture: 'floor.png' });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Mid-build: the mesh stays in its group, on its first material.
    expect(mesh.material).toBe(base);
    expect(group).toEqual([mesh]);
    finish();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(mesh.material).not.toBe(base);
  });

  it('stopLoop from inside a frame leaves Lite a callable frame callback (a round reset stops mid-frame)', () => {
    const a = new BabylonLiteAdapter();
    const engine = { _renderFn: (() => {}) as unknown, _animFrameId: 0 };
    internals(a).engine = engine;
    (a as unknown as { inFrame: boolean }).inFrame = true;
    a.stopLoop();
    expect(typeof engine._renderFn).toBe('function');
    (a as unknown as { inFrame: boolean }).inFrame = false;
    a.stopLoop();
    expect(engine._renderFn).toBeNull();
  });

  it('leaves a scene that is not yet registered, or has nothing queued, alone', () => {
    const a = new BabylonLiteAdapter();
    const build = (a as unknown as { buildLateMaterialGroups(s: unknown): void }).buildLateMaterialGroups.bind(a);
    const builder = () => { throw new Error('must not run'); };
    expect(() => build({ _built: false, _deferredBuilders: [builder] })).not.toThrow();
    expect(() => build({ _built: true, _deferredBuilders: [] })).not.toThrow();
    expect(() => build({})).not.toThrow();
  });

  it('setMeshVisible on a drawing mesh hides it alone, like Babylon, so a GLB under a hidden proxy still draws', () => {
    const a = new BabylonLiteAdapter();
    const glb = { name: 'car', children: [], visible: true, _gpu: {} };
    const proxy = { name: 'proxy', children: [glb], visible: true, _gpu: {} };
    const h = a.adoptMesh('proxy', proxy as never);
    a.setMeshVisible(h, false);
    expect(proxy.visible).toBe(false);
    expect(glb.visible).toBe(true);
  });

  it('setMeshVisible on an empty root (glTF root, plugin-built car) hides and shows the whole subtree', () => {
    const a = new BabylonLiteAdapter();
    const child = { name: 'wheel', children: [], visible: true };
    const root = { name: 'car', children: [child], visible: true };
    const h = a.adoptMesh('car', root as never);
    a.setMeshVisible(h, false);
    expect(root.visible).toBe(false);
    expect(child.visible).toBe(false);
    a.setMeshVisible(h, true);
    expect(child.visible).not.toBe(false);
  });

  it('adoptMesh registers a plugin-built node by handle and by id', () => {
    const a = new BabylonLiteAdapter();
    const node = { name: 'hull', children: [], visible: true, position: { set: vi.fn() }, scaling: { set: vi.fn() } };
    const h = a.adoptMesh('hull', node as never);
    expect(a.getMeshObject(h)).toBe(node);
    expect(a.getMeshRoot('hull')).toBe(node);
    a.setMeshScale(h, 2, 2, 2);
    expect(node.scaling.set).toHaveBeenCalledWith(2, 2, 2);
  });

  const emitterSpec = (over: Partial<ParticleEmitterSpec> = {}): ParticleEmitterSpec => ({
    texture: { __handle: 'smoke' } as unknown as TextureHandle,
    capacity: 50, emitRate: 100, emitRadius: 0, minSize: 1, maxSize: 1, minLifeTime: 1, maxLifeTime: 1,
    minEmitPower: 0, maxEmitPower: 0, color1: [1, 0, 0, 1], color2: [1, 0, 0, 1], colorDead: [0, 0, 0, 0],
    ...over,
  });

  it('a continuous emitter spawns at its rate, at its canonical seat, drawn mirrored into Lite', () => {
    const a = new BabylonLiteAdapter();
    const scene = { camera: null };
    internals(a).scene = scene;
    internals(a).engine = {};
    const h = a.createParticleEmitter('smoke', emitterSpec({ position: [1, 2, 3] }));
    const step = (dt: number) => (a as unknown as { stepParticles(dt: number): void }).stepParticles(dt);
    step(0.1);
    const layer = [...(a as unknown as { particleLayers: Map<string, { sprites: { position: number[]; color: number[] }[] }> }).particleLayers.values()][0]!;
    expect(layer.sprites).toHaveLength(10);
    expect(layer.sprites[0]!.position).toEqual([1, 2, -3]);
    // A plugin re-seats it through the seat; new particles start there.
    const seat = a.getParticleEmitterSeat(h)!;
    expect(seat.followsCamera).toBe(false);
    seat.position[0] = 5;
    seat.position[2] = -1;
    step(0.1);
    expect(layer.sprites.some((p) => p.position[0] === 5 && p.position[2] === 1)).toBe(true);
    // Colour runs to colorDead over life.
    expect(layer.sprites.every((p) => p.color[0] <= 1)).toBe(true);
    a.disposeParticleEmitter(h);
    expect(a.getParticleEmitterSeat(h)).toBeUndefined();
    step(0.1);
    expect(layer.sprites).toHaveLength(0);
  });

  it('a camera-following emitter re-seats at the camera every frame', () => {
    const a = new BabylonLiteAdapter();
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1];
    internals(a).scene = { camera: { worldMatrix: m } };
    internals(a).engine = {};
    const h = a.createParticleEmitter('dust', emitterSpec({ followCamera: true }));
    (a as unknown as { stepParticles(dt: number): void }).stepParticles(0.05);
    expect(a.getParticleEmitterSeat(h)!.position).toEqual([7, 8, -9]);
  });

  it('a label is real on Lite: text drawn to pixels, one billboard sprite, mirrored, tinted, scaled, and its slot reused', () => {
    const ctx = {
      clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), strokeText: vi.fn(), fillText: vi.fn(),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    } as Record<string, unknown>;
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
    try {
      const a = new BabylonLiteAdapter();
      internals(a).scene = {};
      internals(a).engine = {};
      const h = a.createLabel('dmg', { text: '42', color: [1, 0, 0], scale: 2 });
      expect(ctx.fillText).toHaveBeenCalledWith('42', 256, 128);
      a.setLabelPosition(h, 1, 2, 3);
      a.setLabelAlpha(h, 0.5);
      expect(a.setLabelScale(h, 1.5)).toBe(true);
      const rec = (a as unknown as { labelRecords: Map<unknown, { slot: { system: { sprites: Record<string, unknown>[]; visible: boolean } } }> }).labelRecords.get(h)!;
      const sprite = rec.slot.system.sprites[0]!;
      expect(sprite.position).toEqual([1, 2, -3]);
      expect(sprite.sizeWorld).toEqual([2 * 2 * 1.5, 2 * 1.5]);
      expect(sprite.color).toEqual([1, 0, 0, 0.5]);
      a.setLabelVisible(h, false);
      expect(rec.slot.system.visible).toBe(false);
      const system = rec.slot.system;
      a.disposeLabel(h);
      expect(a.setLabelScale(h, 1)).toBe(false);
      const h2 = a.createLabel('dmg2', { text: '7' });
      const rec2 = (a as unknown as { labelRecords: Map<unknown, { slot: { system: unknown } }> }).labelRecords.get(h2)!;
      expect(rec2.slot.system).toBe(system);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('getAnimationGroup hands out one clip scoped to its mesh', () => {
    const a = new BabylonLiteAdapter();
    const clip = { name: 'hit' };
    (a as unknown as { animationGroups: Map<string, unknown> }).animationGroups.set('ship/hit', clip);
    expect(a.getAnimationGroup('ship', 'hit')).toBe(clip);
    expect(a.getAnimationGroup('other', 'hit')).toBeNull();
  });

  it("a glTF root takes the adapter's Z mirror, not the loader's X mirror, and keeps it under setMeshScale", () => {
    const a = new BabylonLiteAdapter();
    const scaling = { v: [-1, 1, 1], set(x: number, y: number, z: number) { this.v = [x, y, z]; } };
    const root = { name: '__root__', children: [], scaling };
    (a as unknown as { seatGltfRoot(r: unknown, s: number): void }).seatGltfRoot(root, 2);
    expect(scaling.v).toEqual([2, 2, -2]);
    const h = a.adoptMesh('ship', root as never);
    a.setMeshScale(h, 3, 3, 3);
    expect(scaling.v).toEqual([3, 3, -3]);
    // An ordinary mesh is scaled as asked.
    const plain = { name: 'box', children: [], scaling: { v: [1, 1, 1], set(x: number, y: number, z: number) { this.v = [x, y, z]; } } };
    a.setMeshScale(a.adoptMesh('box', plain as never), 3, 3, 3);
    expect(plain.scaling.v).toEqual([3, 3, 3]);
  });

  it('a straight-down camera keeps a defined roll: its target leans toward the asked-for up', () => {
    const a = new BabylonLiteAdapter();
    const target = { v: [0, 0, 0], set(x: number, y: number, z: number) { this.v = [x, y, z]; } };
    const camera = { position: { set: vi.fn() }, target };
    const h = { __handle: 'cam' } as unknown as CameraHandle;
    (a as unknown as { perspectiveCameras: Map<unknown, unknown> }).perspectiveCameras.set(h, { camera, orientation: { x: 0, y: 0, z: 0, w: 1 } });
    // Rotation taking +Z to −Y (look down) and +Y to +Z: about +X by +90°.
    const s = Math.SQRT1_2;
    a.setCameraPose(h, [0, 10, 0], { x: s, y: 0, z: 0, w: s } as never);
    const [x, y, z] = target.v;
    expect(y).toBeCloseTo(9, 3);
    expect(x).toBeCloseTo(0, 6);
    // Canonical up +Z is Lite −Z: the lean is a hair toward −z, never zero.
    expect(z).toBeLessThan(0);
    expect(z).toBeGreaterThan(-0.01);
  });

  it('applies ModelInstantiateSpec.fit: longest horizontal extent to fitLength, mirror kept, position mirrored', () => {
    const a = new BabylonLiteAdapter();
    const v3 = () => ({ v: [0, 0, 0], x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { this.v = [x, y, z]; this.x = x; this.y = y; this.z = z; } });
    const child = { name: 'hull', children: [], _gpu: {}, boundMin: [-1, 0, -0.5], boundMax: [1, 0.5, 0.5], worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
    const root = { name: '__root__', children: [child], position: v3(), scaling: v3(), rotationQuaternion: { set: vi.fn() } };
    (a as unknown as { applyModelFit(r: unknown, f: unknown, s: unknown): void }).applyModelFit(root, { fitLength: 4 }, { position: [1, 2, 3] });
    expect(root.scaling.v).toEqual([2, 2, -2]);
    expect(root.position.v).toEqual([1, 2, -3]);
  });
});


describe('BabylonLiteAdapter glow layer host', () => {
  const ready = () => {
    const a = new BabylonLiteAdapter();
    internals(a).scene = { meshes: [], surface: { canvas: { width: 4, height: 4 }, scRT: {} } };
    internals(a).engine = { fake: 'engine' };
    const layer = () => (a as unknown as { glowLayer: { isIncluded(n: unknown): boolean } | null }).glowLayer;
    return { a, layer };
  };

  it('addGlowNode answers false until a glow layer is up, then enrols the node', () => {
    const { a, layer } = ready();
    const node = { plugin: 'quad' };
    expect(a.addGlowNode(node)).toBe(false);
    a.setGlowLayer({ intensity: 0.5 });
    expect(a.addGlowNode(node, true)).toBe(true);
    expect(layer()!.isIncluded(node)).toBe(true);
    a.removeGlowNode(node);
    expect(layer()!.isIncluded(node)).toBe(false);
  });

  it('addGlowMesh enrols the node behind a handle, also when it came before the layer', () => {
    const { a, layer } = ready();
    const node = { mesh: 1 };
    const h = { __handle: 'm' } as unknown as MeshHandle;
    internals(a).meshes.set(h, node);
    a.setGlowLayer({ intensity: 0.5 });
    a.addGlowMesh(h);
    expect(layer()!.isIncluded(node)).toBe(true);
    a.removeGlowMesh(h);
    expect(layer()!.isIncluded(node)).toBe(false);
    a.addGlowMesh(h);
    // A settings change keeps the enrolment; off clears it.
    a.setGlowLayer({ intensity: 0.8, textureRatio: 0.25 });
    expect(layer()!.isIncluded(node)).toBe(true);
    a.setGlowLayer(null);
    expect(layer()!.isIncluded(node)).toBe(false);
  });

  it('with no scene yet, the glow calls only record their settings', () => {
    const a = new BabylonLiteAdapter();
    expect(() => a.setGlowLayer({ intensity: 1 })).not.toThrow();
    expect(a.addGlowNode({})).toBe(false);
    expect(() => a.removeGlowNode({})).not.toThrow();
  });
});

describe('BabylonLiteAdapter plugin shadow casters', () => {
  it('addShadowCasterNode adds to every light list (a new array), keeps the Shadow casters, and reaches a later light', async () => {
    const BL = await import('@babylonjs/lite');
    const set = BL.setShadowTaskCasterMeshes as unknown as ReturnType<typeof vi.fn>;
    const a = new BabylonLiteAdapter();
    const ia = a as unknown as { shadowGenerators: Map<unknown, unknown>; shadowCasterMeshes: Map<unknown, unknown[]>; meshes: Map<unknown, unknown> };
    const gen = { gen: 1 };
    const light = 'light' as unknown as LightHandle;
    const ball = { name: 'ball' };
    const tree = { name: 'tree' };
    ia.shadowGenerators.set(light, gen);
    ia.meshes.set('h-ball', ball);
    a.attachShadowCaster(light, 'h-ball' as unknown as MeshHandle);
    const before = ia.shadowCasterMeshes.get(light);
    a.addShadowCasterNode(tree);
    a.addShadowCasterNode(tree); // once
    const after = ia.shadowCasterMeshes.get(light)!;
    expect(after).toEqual([ball, tree]);
    expect(after).not.toBe(before);
    expect(set.mock.calls.at(-1)).toEqual([gen, [ball, tree]]);
    // A light made later casts it too (its list starts with the plugin nodes).
    const setCasters = (a as unknown as { setCasters(l: unknown, list: unknown[]): void }).setCasters.bind(a);
    const late = 'late' as unknown as LightHandle;
    ia.shadowGenerators.set(late, { gen: 2 });
    setCasters(late, [...(a as unknown as { pluginShadowCasters: Set<unknown> }).pluginShadowCasters]);
    expect(ia.shadowCasterMeshes.get(late)).toEqual([tree]);
    a.removeShadowCasterNode(tree);
    a.removeShadowCasterNode(tree); // once
    expect(ia.shadowCasterMeshes.get(light)).toEqual([ball]);
    expect(ia.shadowCasterMeshes.get(late)).toEqual([]);
  });
});

describe('BabylonLiteAdapter plugin shadow casters, PBR preload', () => {
  it('waits for the generator preload before handing Lite the list, and drops a list overtaken meanwhile', async () => {
    const BL = await import('@babylonjs/lite');
    const set = BL.setShadowTaskCasterMeshes as unknown as ReturnType<typeof vi.fn>;
    const a = new BabylonLiteAdapter();
    const ia = a as unknown as { shadowGenerators: Map<unknown, unknown> };
    let release!: () => void;
    const gen = { _preloadShadowTask: vi.fn(() => new Promise<void>((r) => { release = r; })) };
    const light = 'light' as unknown as LightHandle;
    ia.shadowGenerators.set(light, gen);
    const tree = { name: 'tree' };
    set.mockClear();
    a.addShadowCasterNode(tree);
    expect(gen._preloadShadowTask).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(set).toHaveBeenCalledWith(gen, [tree]);
    // A second change before the first preload lands: only the newest list goes.
    set.mockClear();
    const releases: (() => void)[] = [];
    gen._preloadShadowTask = vi.fn(() => new Promise<void>((r) => releases.push(r)));
    a.addShadowCasterNode({ name: 'lamp' });
    a.removeShadowCasterNode(tree);
    for (const r of releases) r();
    await new Promise((r) => setTimeout(r, 0));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]![1]).toEqual([{ name: 'lamp' }]);
    // A failed preload is logged.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    gen._preloadShadowTask = vi.fn(() => Promise.reject(new Error('no module')));
    a.addShadowCasterNode({ name: 'post' });
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe('BabylonLiteAdapter caster hand-over waits for the material family', () => {
  it('holds a list until every caster family has its single-mesh builder, then hands it over once', async () => {
    const BL = await import('@babylonjs/lite');
    const set = BL.setShadowTaskCasterMeshes as unknown as ReturnType<typeof vi.fn>;
    const a = new BabylonLiteAdapter();
    const ia = a as unknown as { shadowGenerators: Map<unknown, unknown>; flushCasters(): void; pendingCasters: Map<unknown, unknown> };
    const gen = { _preloadShadowTask: vi.fn(() => Promise.resolve()) };
    const light = 'light' as unknown as LightHandle;
    ia.shadowGenerators.set(light, gen);
    const group: { _rebuildSingle?: unknown } = {};
    const chunk = { name: 'chunk', material: { _buildGroup: group } };
    set.mockClear();
    a.addShadowCasterNode(chunk);
    await new Promise((r) => setTimeout(r, 0));
    expect(set).not.toHaveBeenCalled();
    expect(ia.pendingCasters.size).toBe(1);
    group._rebuildSingle = () => ({});
    ia.flushCasters();
    expect(set).toHaveBeenCalledTimes(1);
    ia.flushCasters();
    expect(set).toHaveBeenCalledTimes(1);
    // A waiting list that is overtaken is dropped, not handed over.
    group._rebuildSingle = undefined;
    a.addShadowCasterNode({ name: 'other', material: { _buildGroup: group } });
    await new Promise((r) => setTimeout(r, 0));
    a.removeShadowCasterNode(chunk);
    ia.flushCasters();
    expect(ia.pendingCasters.size).toBe(0);
  });
});

describe('BabylonLiteAdapter thin instances that arrive after the PBR build (Lite 1.37)', () => {
  const pbr = Object.assign(async () => ({ renderables: [] }), { _materialFamily: 'pbr', _rebuildSingle: () => ({}) });
  const std = Object.assign(async () => ({ renderables: [] }), { _materialFamily: 'standard' });
  const widen = (a: unknown, s: unknown) => (a as { widenPbrGroupForLateMeshes(s: unknown): void }).widenPbrGroupForLateMeshes(s);

  it('lacksThinInstanceCode: only a thin-instanced mesh, and only when the PBR build loaded no thin-instance code', async () => {
    const { lacksThinInstanceCode } = await import('./BabylonLiteAdapter');
    const ti = { thinInstances: {} };
    expect(lacksThinInstanceCode({ _pbrGeomContext: { _syncThinInstanceForDraw: null } }, ti)).toBe(true);
    expect(lacksThinInstanceCode({ _pbrGeomContext: { _syncThinInstanceForDraw: () => null } }, ti)).toBe(false);
    expect(lacksThinInstanceCode({}, ti)).toBe(false); // no PBR build yet: the first build sees it
    expect(lacksThinInstanceCode({ _pbrGeomContext: {} }, { thinInstances: null })).toBe(false);
    expect(lacksThinInstanceCode({ _pbrGeomContext: {} }, null)).toBe(false);
  });

  it("wraps the PBR group's widening test so a late thin-instanced mesh takes Lite's full-rebuild path", () => {
    const a = new BabylonLiteAdapter();
    const texCaps = Object.assign((m: unknown) => (m === 'needs-texture-caps' ? 2 : 0), { _c: 7 });
    const pbrGroup = Object.assign([] as unknown[], { _w: texCaps as unknown });
    const stdGroup = Object.assign([] as unknown[], { _w: undefined as unknown });
    const scene = { _groups: new Map<unknown, unknown>([[std, stdGroup], [pbr, pbrGroup]]), _pbrGeomContext: { _syncThinInstanceForDraw: null as unknown } };
    widen(a, scene);
    const w = pbrGroup._w as ((m: unknown) => unknown) & { _c?: number };
    expect(w).not.toBe(texCaps);
    expect(w._c).toBe(7); // Lite reads the caps the build loaded back off it
    expect(w('needs-texture-caps')).toBe(2);
    expect(w({ thinInstances: {} })).toBe(true);
    expect(w({})).toBe(false);
    expect(stdGroup._w).toBeUndefined();
    // Once wrapped, a later frame leaves it alone; a group rebuild replaces it and it is wrapped again.
    widen(a, scene);
    expect(pbrGroup._w).toBe(w);
    pbrGroup._w = null;
    scene._pbrGeomContext._syncThinInstanceForDraw = () => null;
    widen(a, scene);
    const again = pbrGroup._w as unknown as ((m: unknown) => unknown) & { _c?: number };
    expect(again._c).toBeUndefined();
    expect(again({ thinInstances: {} })).toBe(false);
  });

  it('a scene with no groups, or no PBR group, is left alone', () => {
    const a = new BabylonLiteAdapter();
    expect(() => widen(a, {})).not.toThrow();
    const stdGroup = Object.assign([] as unknown[], { _w: undefined });
    widen(a, { _groups: new Map([[std, stdGroup]]) });
    expect(stdGroup._w).toBeUndefined();
  });

  it('holds a thin-instanced caster until the PBR build has thin-instance code (its shadow drawing would throw)', async () => {
    const BL = await import('@babylonjs/lite');
    const set = BL.setShadowTaskCasterMeshes as unknown as ReturnType<typeof vi.fn>;
    const a = new BabylonLiteAdapter();
    const ia = a as unknown as { shadowGenerators: Map<unknown, unknown>; flushCasters(): void; pendingCasters: Map<unknown, unknown>; scene: unknown };
    const ctx = { _syncThinInstanceForDraw: null as unknown };
    ia.scene = { _pbrGeomContext: ctx };
    const gen = { _preloadShadowTask: vi.fn(() => Promise.resolve()) };
    const light = 'light' as unknown as LightHandle;
    ia.shadowGenerators.set(light, gen);
    set.mockClear();
    a.addShadowCasterNode({ name: 'block', thinInstances: {}, material: { _buildGroup: pbr } });
    await new Promise((r) => setTimeout(r, 0));
    expect(set).not.toHaveBeenCalled();
    ctx._syncThinInstanceForDraw = () => null;
    ia.flushCasters();
    expect(set).toHaveBeenCalledTimes(1);
  });
});

describe('BabylonLiteAdapter thin-instance primer', () => {
  it('adds one unpickable Standard box with a single zero-scale instance, so every Standard build loads thin-instance code', async () => {
    const BL = await import('@babylonjs/lite');
    const { addThinInstancePrimer } = await import('./BabylonLiteAdapter');
    const scene = { scene: true };
    addThinInstancePrimer({} as never, scene as never);
    const box = (BL.createBox as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)!.value as { name: string; material: { _buildGroup?: unknown }; pickable: boolean };
    expect(box.name).toBe('bjsm-lite-thin-instance-primer');
    expect(box.pickable).toBe(false);
    expect(box.material._buildGroup).toBe((BL.createStandardMaterial() as { _buildGroup?: unknown })._buildGroup);
    const [mesh, matrices, count] = (BL.setThinInstances as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(mesh).toBe(box);
    expect(count).toBe(1);
    expect(Array.from(matrices as Float32Array)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect((BL.addToScene as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([scene, box]);
  });
});
