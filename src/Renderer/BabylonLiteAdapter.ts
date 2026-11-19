/**
 * BabylonLiteAdapter — RendererAdapter backed by `@babylonjs/lite` (Babylon Lite).
 *
 * Babylon Lite is a WebGPU-only, FUNCTIONAL (classless) rewrite of the engine:
 * everything is free functions over plain context objects (`EngineContext`,
 * `SceneContext`, `Mesh`, `ArcRotateCamera`, …) rather than methods on classes.
 * There is no built-in render loop — the caller drives frames with
 * `renderFrame(engine, deltaMs)`.
 *
 * IMPORTANT CONSTRAINTS / STATUS
 * - WebGPU-only: `createEngine` only succeeds in a real browser with a WebGPU
 *   device, so this adapter is BROWSER-ONLY. The jsdom contract runs
 *   (`runRendererAdapterContract`) exercise Babylon + Three + the mock; this
 *   adapter is intentionally left out of those and excluded from coverage. It
 *   only needs to type-check and be structurally correct.
 * - PROVISIONAL: it targets a preview engine whose API is still moving. Several
 *   capabilities Babylon Lite doesn't yet expose cleanly (synchronous picking,
 *   physics, text labels, procedural sky) are implemented as documented STUBS
 *   that still track handles and never throw — matching ThreeAdapter's stub
 *   style. Revisit once Lite's Havok glue / sprite-text / sky helpers land.
 *
 * Math note: Babylon Lite's `Vec3` is an OBJECT `{x,y,z}`, whereas this
 * package's `Vec3` (from ./types) is a tuple `[number,number,number]`. The two
 * are converted explicitly at every boundary below.
 */

import type * as BLNS from '@babylonjs/lite';
import * as BL from '@babylonjs/lite';
import { boxGeometryLikeThree, mirrorZ } from './meshGeometry';
import { LiteGlowLayer, type LiteGlowModule, type LiteGlowScene } from './liteGlowLayer';

import type {
  ArcCameraSpec,
  BillboardMode,
  CameraHandle,
  Color,
  DirectionalLightSpec,
  EnvironmentTextureOpts,
  HemisphericLightSpec,
  LabelHandle,
  LabelSpec,
  LightHandle,
  LineHandle,
  LoadModelTemplateOptions,
  MaterialSpec,
  MeshHandle,
  MeshGeometry,
  MeshLoadResult,
  MeshLoadSpec,
  ModelInstantiateSpec,
  ModelFitSpec,
  PointLightSpec,
  MeshSkinSpec,
  PhysicsBodyOpts,
  PhysicsBodySnapshot,
  PickOptions,
  PickResult,
  PrimitiveSpec,
  RendererAdapter,
  RendererInitOptions,
  ShadowCasterHandle,
  SkyboxHandle,
  SkyboxSpec,
  TextureHandle,
  TextureLoadOpts,
  CardMeshSpec,
  PerspectiveCameraSpec,
  Quaternion,
  ScreenPoint,
  Vec3,
  // ─── Phase-3 visual capabilities ───
  ProceduralMeshSpec,
  DynamicTextureSpec,
  ParticleBurstSpec,
  ParticleEmitterSpec,
  ParticleEmitterHandle,
  GlowSpec,
  SunSpec,
  SpotLightSpec,
  FogSpec,
  SoundSpec,
  SoundHandle,
  RenderStats,
  FrameTimings,
  RenderPassInfo,
} from './types';

/** Babylon Lite mesh-like node (Mesh extends SceneNode; both carry transforms). */
type LiteMesh = BLNS.Mesh;

/**
 * Hide or show what a handle stands for, the way BabylonAdapter does.
 *
 * A node that draws (it has geometry) is hidden ALONE, like Babylon's
 * `isVisible`: a Pool blueprint hides its MeshPrimitive proxy while the GLB
 * parented under it keeps drawing. A node that draws nothing itself — a glTF
 * root, a plugin-built car from `adoptMesh` — stands for its parts, so the
 * whole subtree goes (Lite's `setMeshVisible`); hiding only the empty root
 * would leave every part on screen.
 */
function setNodeVisible(node: LiteMesh, visible: boolean): void {
  // Lite 1.37 made SceneNode.visible read-only: setMeshVisible sets it down
  // the subtree and bumps Lite's private render version. A drawing mesh
  // hides alone, so it goes through with its children out of view for the
  // one call.
  if ((node as { _gpu?: unknown })._gpu !== undefined) {
    const kids = node.children;
    (node as { children: unknown }).children = [];
    try {
      BL.setMeshVisible(node, visible);
    } finally {
      (node as { children: unknown }).children = kids;
    }
  } else BL.setMeshVisible(node, visible);
}

/** Label texture size, the same as ThreeAdapter's. */
const LABEL_TEX_W = 512;
const LABEL_TEX_H = 256;

interface LiteLabel {
  slot: { texture: BLNS.Texture2D; system: BLNS.FacingBillboardSpriteSystem | null };
  plane?: LiteMesh;
  canvas: HTMLCanvasElement;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  background?: string;
  borderColor?: string;
  /** World size at scale 1. */
  size: [number, number];
  color: [number, number, number, number];
  /** Canonical (right-handed). */
  position: [number, number, number];
  visible: boolean;
  alpha: number;
  scale?: number;
}

/** Draw label text the way ThreeAdapter does and return its RGBA pixels (null without a 2-D context). */
function drawLabelPixels(
  canvas: HTMLCanvasElement, text: string, fontSize: number, fontWeight: 'normal' | 'bold', background?: string, borderColor?: string,
  flipRows = false,
): Uint8Array | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (borderColor) {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    }
  }
  ctx.font = `${fontWeight} ${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(4, fontSize * 0.14);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = '#ffffff';
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  if (!flipRows) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  // Lite's createPlane maps v the other way up from a 2-D canvas: a world-fixed
  // sign gets its rows reversed, or the text draws upside down (seen on
  // screen: "∀ЯCADE" on the NeonSign wall).
  const row = canvas.width * 4;
  const out = new Uint8Array(d.length);
  for (let y = 0; y < canvas.height; y++) out.set(d.subarray(y * row, (y + 1) * row), (canvas.height - 1 - y) * row);
  return out;
}

/** The live Lite engine for each canvas — see BabylonLiteAdapter.init. */
const LITE_ENGINES = new WeakMap<HTMLCanvasElement, BLNS.EngineContext>();

/** Sprites one shared particle layer holds; past that a frame drops the rest. */
const PARTICLE_LAYER_CAPACITY = 16384;

/** One continuous emitter's live state: canonical positions, ring-buffered particles. */
interface LiteEmitter {
  position: Vec3;
  followCamera: boolean;
  spec: ParticleEmitterSpec;
  layerKey: string;
  texture: TextureHandle;
  cap: number;
  pos: Float32Array;
  vel: Float32Array;
  age: Float32Array;
  life: Float32Array;
  size: Float32Array;
  tint: Float32Array;
  /** Ring index of the next particle to (re)use. */
  next: number;
  /** Fractional particles the rate has owed so far. */
  owed: number;
}

/** A white RGBA dot fading to transparent at its rim — the default particle sprite. */
export function softDotPixels(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - c, y - c) / c;
    const a = Math.max(0, 1 - d);
    const o = (y * size + x) * 4;
    px[o] = 255; px[o + 1] = 255; px[o + 2] = 255;
    px[o + 3] = Math.round(255 * a * a);
  }
  return px;
}

/** The SceneContext internals {@link BabylonLiteAdapter.buildLateMaterialGroups} reads (Lite 1.8.0, unexported). */
interface LiteSceneInternals {
  _built?: boolean;
  _deferredBuilders?: (() => Promise<void>)[];
  _renderables: { order?: number; mesh?: unknown }[];
  _renderableVersion: number;
  _materialSwapQueue?: unknown[];
  _groups?: Map<LiteGroupBuilder, unknown[]>;
  _builtGroups?: Set<LiteGroupBuilder>;
  _meshDisposables?: Map<unknown, (() => void)[]>;
  _uniformUpdaters?: unknown[];
  surface?: { engine?: { _device?: { queue?: { onSubmittedWorkDone?(): Promise<unknown> } } } };
  _frameGraph?: { build(): void };
}

/** Lite's widening test on a material group (`group._w`, 1.37): truthy = this mesh needs a fresh group build. */
type LiteWidening = ((mesh: unknown) => unknown) & { _c?: number; [WIDENED]?: true };
/** A material group as {@link BabylonLiteAdapter.widenPbrGroupForLateMeshes} sees it. */
interface LiteWidenableGroup {
  _w?: LiteWidening | null;
}
/** Marks a widening test this adapter already wrapped. */
const WIDENED = Symbol('bjsm.widened');

/**
 * True when `mesh` is thin-instanced but the scene's current PBR build loaded
 * no thin-instance code (Lite 1.37 keeps that build's context on
 * `scene._pbrGeomContext`).
 */
export function lacksThinInstanceCode(scene: unknown, mesh: unknown): boolean {
  if (!(mesh as { thinInstances?: unknown } | null)?.thinInstances) return false;
  const ctx = (scene as { _pbrGeomContext?: { _syncThinInstanceForDraw?: unknown } })._pbrGeomContext;
  return !!ctx && typeof ctx._syncThinInstanceForDraw !== 'function';
}

/**
 * Put one invisible thin-instanced StandardMaterial mesh in a new scene.
 *
 * Lite (1.37) builds the Standard group once, at registerScene, and loads its
 * thin-instance code only if a mesh it has then is thin-instanced. A
 * thin-instanced mesh drawn through that build later — a plugin's chunk that
 * arrives after registration, or a glow / AO pass drawing a PBR chunk through
 * an emissive Standard stand-in — gets no thin-instance code and, unlike PBR,
 * no error: it draws ONE copy at its own transform. The glow pass then lost
 * every wall of the city, so lights inside the blocks glowed through them.
 * This mesh makes every Standard build load the code. It has one instance,
 * scaled to nothing, so it draws no pixel.
 */
export function addThinInstancePrimer(engine: BLNS.EngineContext, scene: BLNS.SceneContext): void {
  const primer = BL.createBox(engine, 1);
  primer.name = 'bjsm-lite-thin-instance-primer';
  primer.pickable = false;
  primer.material = BL.createStandardMaterial();
  const zero = new Float32Array(16);
  zero[15] = 1;
  BL.setThinInstances(primer, zero, 1);
  BL.addToScene(scene, primer);
}

/** A Lite material family's group builder (`material._buildGroup`, 1.8.0). */
type LiteGroupBuilder = ((scene: unknown, meshes: unknown[]) => Promise<{ renderables: { order?: number; mesh?: unknown }[]; updater?: unknown }>) & {
  _rebuildSingle?: unknown;
};

/** Negate a coordinate across the RH↔LH Z mirror without minting −0 (0 stays 0). */
const flipZ = (v: number): number => (v === 0 ? 0 : -v);

/**
 * Euler [x, y, z] (Babylon's yaw(Y)·pitch(X)·roll(Z) order — the inverse of
 * applyEulerQuat before its mirror, and of BabylonAdapter's
 * Quaternion.toEulerAngles) from a unit quaternion.
 */
function quatToEulerYXZ(qx: number, qy: number, qz: number, qw: number): [number, number, number] {
  const zAxisY = qy * qz - qx * qw;
  const limit = 0.4999999;
  if (zAxisY < -limit) return [Math.PI / 2, 2 * Math.atan2(qy, qw), 0];
  if (zAxisY > limit) return [-Math.PI / 2, 2 * Math.atan2(qy, qw), 0];
  const sqw = qw * qw, sqz = qz * qz, sqx = qx * qx, sqy = qy * qy;
  return [
    Math.asin(-2 * zAxisY),
    Math.atan2(2 * (qz * qx + qy * qw), sqz - sqx - sqy + sqw),
    Math.atan2(2 * (qx * qy + qz * qw), -sqz - sqx + sqy + sqw),
  ];
}
/** A loaded-model template: the container plus the names of its clips. */
interface LiteTemplate {
  container: BLNS.AssetContainer;
  animationNames: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Phase-3 shared pure math (engine-free). Identical to the reference noise in
// MockRendererAdapter so seeded asteroid/oil-blob geometry is byte-identical
// across adapters: the same `seed` produces the same silhouette on every
// client, whether the surface is tessellated here (WebGPU) or only sampled in
// a test. Kept at module scope (no `this`) so it can't drift per-instance.
// ─────────────────────────────────────────────────────────────────────────

/** Deterministic [0,1) hash of three integers — the same hash the asteroid kernel uses. */
function liteHash3(a: number, b: number, c: number): number {
  let n = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/** Normalize a 3-tuple in place-free style (returns a fresh unit tuple). */
function unit3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/**
 * Generate a unit icosphere by recursively subdividing an icosahedron `depth`
 * times (triangles = 20·4^depth). Returns shared-vertex unit directions plus
 * triangle indices. The directions are fed through `sampleProceduralSurface`
 * to displace the rock; the topology is deterministic so the geometry is too.
 */
function buildIcosphere(depth: number): { dirs: Array<[number, number, number]>; indices: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const dirs: Array<[number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => unit3(x, y, z));
  let faces: Array<[number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const midCache = new Map<number, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? a * 100000 + b : b * 100000 + a;
    const hit = midCache.get(key);
    if (hit !== undefined) return hit;
    const va = dirs[a];
    const vb = dirs[b];
    const m = unit3((va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2);
    const idx = dirs.length;
    dirs.push(m);
    midCache.set(key, idx);
    return idx;
  };
  for (let d = 0; d < depth; d++) {
    const next: Array<[number, number, number]> = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const indices: number[] = [];
  for (const [a, b, c] of faces) indices.push(a, b, c);
  return { dirs, indices };
}

/**
 * Lite 1.8.0 bug workaround. Setting `mesh.material` queues a swap
 * (processMaterialSwaps) that adds the new renderable but never removes the
 * old one: the mesh draws twice, and once the old one's buffers are freed
 * every frame fails WebGPU validation ("Buffer used in submit while
 * destroyed") and the canvas stays black. Lite's own rebuildSceneMesh does
 * remove it; this is that missing step, run right before the swap is queued.
 * It bit the skee balls: meshes made before the scene's first build, whose
 * texture maps arrived after it.
 */
function dropStaleRenderables(scene: unknown, mesh: unknown): void {
  const sc = scene as {
    _renderables?: { mesh: unknown }[];
    _renderableVersion?: number;
    _groups?: Map<unknown, unknown[]>;
  } | null;
  const list = sc?._renderables;
  if (!list) return;
  // Its build group too: the group's uniform updater keeps writing the old
  // per-mesh buffer for every mesh still listed, after the swap frees it.
  const build = (mesh as { material?: { _buildGroup?: unknown } }).material?._buildGroup;
  const group = build ? sc!._groups?.get(build) : undefined;
  const gi = group ? group.indexOf(mesh) : -1;
  if (gi >= 0) group!.splice(gi, 1);
  let dropped = false;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.mesh === mesh) {
      list.splice(i, 1);
      dropped = true;
    }
  }
  if (dropped && typeof sc!._renderableVersion === "number") sc!._renderableVersion++;
}

export class BabylonLiteAdapter implements RendererAdapter {
  readonly kind = 'babylon-lite' as const;

  private engine?: BLNS.EngineContext;
  private scene?: BLNS.SceneContext;
  private canvas: HTMLCanvasElement | null = null;

  // Per-concern handle bookkeeping, mirroring BabylonAdapter / ThreeAdapter.
  private meshes = new Map<MeshHandle, LiteMesh>();
  /** Parallel meshId → mesh lookup used by physics/animation methods. */
  private meshesByMeshId = new Map<string, LiteMesh>();
  private lights = new Map<LightHandle, BLNS.DirectionalLight | BLNS.HemisphericLight | BLNS.PointLight | BLNS.SpotLight>();
  /** Handles issued by the (silent) createSound stub — see the audio section. */
  private sounds = new Set<SoundHandle>();
  private cameras = new Map<CameraHandle, { camera: BLNS.ArcRotateCamera; detach?: () => void }>();
  /**
   * Free 6-DOF perspective cameras (chase / flight), kept separate from the
   * orbit `cameras` map: Lite backs them with a `FreeCamera` (position + target)
   * rather than an `ArcRotateCamera`, but both implement Lite's `Camera`. The
   * `orientation` quaternion is stored VERBATIM so {@link getCameraPose}
   * round-trips it losslessly — a position+target FreeCamera can't represent
   * roll on its own, so the stored quaternion is the source of truth, not a
   * re-decomposition of the camera's look direction.
   */
  private perspectiveCameras = new Map<CameraHandle, { camera: BLNS.FreeCamera; orientation: Quaternion }>();
  /** The active perspective camera (last created); {@link worldToScreen} projects through it. */
  private activePerspective?: { camera: BLNS.FreeCamera; orientation: Quaternion };
  /**
   * Floating-origin offset, stored in the adapter's LEFT-handed frame (Z negated
   * vs. the caller's right-handed frame, matching positions/cameras). Phase-1 is
   * contract-only / dormant: recorded here but never applied as an active rebase.
   */
  /** Large-world enable flag recorded by {@link configureLargeWorld} (Phase-1: no active rebase). */
  private largeWorldEnabled = false;
  private shadowGenerators = new Map<LightHandle, BLNS.ShadowGenerator>();
  private shadowCasters = new Map<
    ShadowCasterHandle,
    { light: LightHandle; meshes: LiteMesh[] }
  >();
  /** Accumulated caster meshes per light — setShadowTaskCasterMeshes replaces the list. */
  private shadowCasterMeshes = new Map<LightHandle, LiteMesh[]>();
  /** Nodes plugins made casters (addShadowCasterNode): every light casts them, a later one too. */
  private pluginShadowCasters = new Set<LiteMesh>();
  /** Set once the scene is registered with the engine (required before anything renders). */
  private sceneRegistered = false;

  // ─── Havok physics (lazily WASM-loaded on first body, like BabylonAdapter) ───
  private havokWorld: BLNS.PhysicsWorld | null = null;
  private havokReady = false;
  private havokInitPromise: Promise<void> | null = null;
  /** The scene's gravity, held so the world is created with it however early it was set. */
  private gravity: BLNS.Vec3 = { x: 0, y: -30, z: 0 };
  private pendingPhysicsCreates: Array<{ meshId: string; opts: PhysicsBodyOpts }> = [];
  private aggregates = new Map<string, BLNS.PhysicsAggregate>();
  /** Reverse of `aggregates`: casts report a body, plugins need its meshId. */
  private bodyMeshIds = new Map<BLNS.PhysicsBody, string>();
  private physicsViewer: BLNS.PhysicsViewer | null = null;
  private savedTimestep: number | null = null;
  /** Animation groups keyed by `${meshId}/${clipName}`, registered at load time. */
  private animationGroups = new Map<string, BLNS.AnimationGroup>();
  /** Loaded model templates, deduped by url (see loadModelTemplate). */
  private modelTemplates = new Map<string, LiteTemplate>();
  private instantiatedModelRoots = new Map<string, LiteMesh>();
  /**
   * Texture handles, deduped by key. Babylon Lite's preview build doesn't wire a
   * URL→Texture2D loader through this adapter (see applyMaterialSpec), so the
   * handle is a provisional STUB that still dedupes by key and never throws —
   * matching the label/sky stubs. Card faces track which handle is assigned so
   * the surface is structurally correct once Lite's texture loader lands.
   */
  private texturesByKey = new Map<string, TextureHandle>();
  /** Card meshes: the master mesh plus the assigned front/back texture handles. */
  private cards = new Map<MeshHandle, { mesh: LiteMesh; front?: TextureHandle; back?: TextureHandle }>();
  /** Custom local-space bounding boxes declared via setMeshBoundingBoxExtents. */
  private boxExtents = new Map<MeshHandle, { min: Vec3; max: Vec3 }>();
  /**
   * Per-mesh base-pivot offset (half-height). Lite primitives are origin-centered
   * and there's no geometry-translate, so pivotAtBottom is emulated by adding this
   * offset in setMeshPosition (and removing it in getMeshWorldPosition) — otherwise
   * a later setMeshPosition would clobber a position-baked pivot and sink the mesh.
   */
  private pivotOffsets = new Map<MeshHandle, number>();

  // ─── Phase-3 visual state ───
  /** Dynamic textures (CPU pixel buffer → GPU), deduped by key like loadTexture. */
  private dynamicTextures = new Map<string, TextureHandle>();
  /** Handle → live Texture2D, so updateDynamicTexture can re-upload pixels. */
  private dynamicTextureObjects = new Map<TextureHandle, BLNS.Texture2D>();
  /**
   * Continuous particle emitters (space dust, smoke, trails), simulated on the
   * CPU and drawn as camera-facing billboard sprites — Lite 1.8.0 has no
   * ParticleSystem. See createParticleEmitter.
   */
  private particleEmitters = new Map<ParticleEmitterHandle, LiteEmitter>();
  /** One billboard system per (blend, texture), shared by every emitter that draws with it. */
  private particleLayers = new Map<string, BLNS.FacingBillboardSpriteSystem>();
  private particleDot: BLNS.SpriteAtlas | null = null;
  /** Selective-glow config + whitelist (empty until addGlowMesh). Null = disabled. */
  private glowSpec: GlowSpec | null = null;
  private glowMeshes = new Set<MeshHandle>();
  /** The include-only glow pass (liteGlowLayer.ts); built on the first setGlowLayer with a scene. */
  private glowLayer: LiteGlowLayer | null = null;
  /** HDR bloom config recorded for the pipeline. Null = disabled. */
  /**
   * The camera-following sun: its directional light, the emissive disc parked at
   * a fixed offset from the active camera, and a `disposed` flag the per-frame
   * follow observer checks (Lite's onBeforeRender has no unsubscribe handle).
   */

  private onFrame?: (dt: number) => void;
  /** True once the per-frame onBeforeRender hook is installed (install once). */
  private onBeforeRenderHooked = false;

  // Reused per-frame scratch so thin-instance sweeps never allocate.
  private _tfMatrices?: Float32Array;

  // ─── Lifecycle ───
  async init(canvas: HTMLCanvasElement, _opts: RendererInitOptions = {}): Promise<void> {
    this.canvas = canvas;
    // WebGPU device acquisition — only resolves in a real browser. clearColor /
    // antialias from RendererInitOptions are forwarded only where Lite's
    // EngineOptions accept them; the preview engine derives most defaults, so we
    // keep the call minimal and let provisional callers extend it.
    // One engine per canvas for the life of the page: Lite 1.8.0 keeps GPU
    // objects (bind-group layouts, pipelines) in module-level caches, so a
    // SECOND device on the same page is handed layouts made on the first and
    // every frame fails validation. A round reset builds a new adapter on the
    // same canvas; it reuses the engine and gets a fresh scene.
    let engine = LITE_ENGINES.get(canvas);
    if (!engine) {
      // Browsers only expose WebGPU on a secure page (https:// or localhost).
      // Without this the failure is "reading 'requestAdapter' of undefined".
      if (!(globalThis.navigator as { gpu?: unknown } | undefined)?.gpu) {
        throw new Error(
          globalThis.isSecureContext === false
            ? 'Babylon Lite needs WebGPU, and browsers only allow it on https:// or localhost. Open this page over https.'
            : 'Babylon Lite needs WebGPU, and this browser has none.',
        );
      }
      engine = await BL.createEngine(canvas);
      LITE_ENGINES.set(canvas, engine);
    }
    this.engine = engine;
    this.scene = BL.createSceneContext(this.engine.surfaces[0]);
    addThinInstancePrimer(engine, this.scene);
    void _opts;
  }

  getRenderingCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  setClearColor(r: number, g: number, b: number, a = 1): void {
    if (this.scene) this.scene.clearColor = { r, g, b, a };
  }

  private requireEngine(): BLNS.EngineContext {
    if (!this.engine) throw new Error('BabylonLiteAdapter: call init() first');
    return this.engine;
  }
  private requireScene(): BLNS.SceneContext {
    if (!this.scene) throw new Error('BabylonLiteAdapter: call init() first');
    return this.scene;
  }

  private makeHandle<T>(kind: string, id: string): T {
    return { __handle: `${kind}:${id}:${this.handleCounter++}` } as unknown as T;
  }
  private handleCounter = 0;

  // ─── Meshes ───
  createMesh(id: string, prim: PrimitiveSpec, mat?: MaterialSpec): MeshHandle {
    const engine = this.requireEngine();
    const scene = this.requireScene();

    let mesh: LiteMesh;
    switch (prim.kind) {
      case 'box':
        // Lite's createBox takes a single uniform `size`; non-uniform box dims
        // are approximated by building a unit box and scaling (below).
        mesh = BL.createBox(engine, prim.width ?? prim.height ?? prim.depth ?? 1);
        break;
      case 'sphere':
        mesh = BL.createSphere(engine, { diameter: prim.diameter ?? 1, segments: prim.segments ?? 32 });
        break;
      case 'cylinder':
        mesh = BL.createCylinder(engine, {
          height: prim.height ?? 1,
          diameter: prim.diameter,
          diameterTop: prim.diameterTop,
          diameterBottom: prim.diameterBottom,
          tessellation: prim.tessellation ?? 24,
          subdivisions: prim.subdivisions,
        });
        break;
      case 'capsule':
        mesh = BL.createCapsule(engine, {
          height: prim.height ?? 1,
          radius: prim.radius ?? 0.5,
          tessellation: prim.tessellation ?? 16,
          subdivisions: prim.subdivisions,
        });
        break;
      case 'ground':
        // A ground is a horizontal XZ plane: width→X, depth (or height as a
        // fallback) →Z; depth wins when both are given.
        mesh = BL.createGround(engine, {
          width: prim.width ?? 10,
          height: prim.depth ?? prim.height ?? 10,
          subdivisions: prim.subdivisions,
        });
        break;
      case 'torus':
        mesh = BL.createTorus(engine, {
          diameter: prim.diameter ?? 1,
          thickness: prim.thickness ?? 0.3,
          tessellation: prim.tessellation ?? 24,
        });
        break;
      case 'disc':
        mesh = BL.createDisc(engine, { radius: prim.radius ?? 0.5, tessellation: prim.tessellation ?? 24 });
        break;
      case 'plane':
        mesh = BL.createPlane(engine, { width: prim.width ?? 10, height: prim.height ?? 10 });
        break;
      case 'tube':
        // Babylon Lite ships no tube/extruded-shell builder. Fall back to an
        // (un-capped-look) cylinder sized to the tube's outer diameter + height
        // so the silhouette is correct; a real inner wall (`thickness`) isn't
        // modeled. Provisional until Lite exposes a tube/extrusion helper.
        mesh = BL.createCylinder(engine, {
          height: prim.height ?? 1,
          diameter: prim.diameter ?? 1,
          tessellation: prim.tessellation ?? 32,
        });
        break;
      default: {
        // Exhaustiveness guard — unreachable for the typed union.
        const _never: never = prim.kind;
        throw new Error(`BabylonLiteAdapter.createMesh: unknown primitive "${String(_never)}"`);
      }
    }

    mesh.name = id;

    // A box gets Three's box, to size: Lite only takes a uniform size, and
    // its faces swap u and v the way Babylon's do, so a texture ran across a
    // box here and along it on Three (meshGeometry.boxGeometryLikeThree).
    if (prim.kind === 'box') {
      const m = mirrorZ(boxGeometryLikeThree(prim.width ?? 1, prim.height ?? 1, prim.depth ?? 1));
      BL.resizeMeshGeometry(engine, mesh, m.positions, m.normals, m.indices, m.uvs);
      mesh.scaling.set(1, 1, 1);
    }

    // Base-pivot: Lite primitives are centered on the origin like Babylon, so
    // lift by half-height. The tube primitive is conceptually always
    // base-pivoted but our cylinder fallback is centered, so honor the flag
    // for it too.
    const pivotOffsetY = (prim.pivotAtBottom || prim.kind === 'tube')
      ? (prim.kind === 'sphere' ? (prim.diameter ?? 1) / 2 : (prim.height ?? 1) / 2)
      : 0;
    // Bake it into the vertices, as Babylon and Three do, so the base stays the
    // origin under any rotation and scale. (A position offset in world Y only
    // works for an upright, unscaled mesh: EngineFlame's plume, a cone turned
    // to point back along a ship and scaled to the throttle, drew as a dot
    // floating beside the nozzle.) In local units: a box carries its size as
    // scale.
    const baked = pivotOffsetY !== 0 && this.bakePivot(engine, mesh, pivotOffsetY / (mesh.scaling.y || 1));
    // Fallback, for a mesh whose CPU copy Lite did not keep: place the base at
    // the current y (0) so an un-moved pivoted mesh sits on origin.
    if (pivotOffsetY && !baked) mesh.position.set(mesh.position.x, mesh.position.y + pivotOffsetY, mesh.position.z);

    if (mat) this.applyMaterialSpec(mesh, prim, mat);

    BL.addToScene(scene, mesh);

    const handle = this.makeHandle<MeshHandle>('mesh', id);
    this.meshes.set(handle, mesh);
    this.meshesByMeshId.set(id, mesh);
    if (pivotOffsetY && !baked) this.pivotOffsets.set(handle, pivotOffsetY);
    return handle;
  }

  /**
   * Lift a fresh primitive's vertices by `dy` (local units) so its base sits on
   * its origin. Reads the CPU copy Lite keeps of what it uploaded (internal
   * `_cpu*` fields, checked); false when there is none, and the caller falls
   * back to the position offset.
   */
  private bakePivot(engine: BLNS.EngineContext, mesh: LiteMesh, dy: number): boolean {
    const cpu = mesh as unknown as {
      _cpuPositions?: Float32Array; _cpuNormals?: Float32Array; _cpuIndices?: Uint32Array; _cpuUvs?: Float32Array;
    };
    if (!cpu._cpuPositions || !cpu._cpuNormals || !cpu._cpuIndices) return false;
    const positions = Float32Array.from(cpu._cpuPositions);
    for (let k = 1; k < positions.length; k += 3) positions[k] = positions[k]! + dy;
    BL.resizeMeshGeometry(engine, mesh, positions, cpu._cpuNormals, cpu._cpuIndices, cpu._cpuUvs);
    return true;
  }

  /** Build and assign a Lite material from a renderer-agnostic MaterialSpec. */
  private applyMaterialSpec(mesh: LiteMesh, prim: PrimitiveSpec, mat: MaterialSpec): void {
    const hasTextures =
      !!mat.albedoTexture || !!mat.normalTexture || !!mat.roughnessTexture || !!mat.ambientTexture;
    if (hasTextures || mat.pbr) {
      // Textured → PBR path. The factors go on now so the surface draws on
      // its first frame; the maps follow (loadTextureMaps) as a second
      // material once they have all loaded.
      const pbr = BL.createPbrMaterial({
        baseColorFactor: mat.diffuse
          ? [mat.diffuse[0], mat.diffuse[1], mat.diffuse[2], mat.alpha ?? 1]
          : [1, 1, 1, mat.alpha ?? 1],
        metallicFactor: mat.metallic ?? 0,
        roughnessFactor: mat.roughness ?? 1,
        alpha: mat.alpha ?? 1,
      });
      // Emissive is an opt-in extension since Lite 1.34 (tree shaking).
      if (mat.emissive) BL.setPbrEmissive(pbr, [mat.emissive[0], mat.emissive[1], mat.emissive[2]]);
      mesh.material = pbr;
      if (hasTextures) this.loadTextureMaps(mesh, pbr, mat);
      return;
    }
    const std = BL.createStandardMaterial();
    if (mat.diffuse) std.diffuseColor = [mat.diffuse[0], mat.diffuse[1], mat.diffuse[2]];
    if (mat.specular) std.specularColor = [mat.specular[0], mat.specular[1], mat.specular[2]];
    if (mat.emissive) std.emissiveColor = [mat.emissive[0], mat.emissive[1], mat.emissive[2]];
    if (mat.alpha !== undefined) std.alpha = mat.alpha;
    mesh.material = std;
    void prim;
  }

  /**
   * Put a MaterialSpec's maps on a Lite PBR mesh, the way BabylonAdapter's
   * PBRMaterial branch does: albedo (sRGB), normal, roughness from the GREEN
   * channel (Lite's ORM slot reads roughness there, and `metallicFactor`
   * already zeroes its blue), ambient occlusion as its own texture, each tiled
   * by uScale/vScale.
   *
   * Without this the factors drew alone, and a factor tuned to tint a dark map
   * (the billiard felt's diffuse (0.01, 7, 0.75) over a velvet map) drew as
   * flat lime.
   *
   * A texture slot is part of the pipeline, so the maps go on a NEW material
   * assigned once every load has settled — Lite's material setter queues the
   * swap that rebuilds the drawing. A failed load just leaves its slot empty.
   * Nothing happens if the mesh has had another material put on it meanwhile.
   * The UV transform needs Lite's internal `_hasUvTx` material flag (what its
   * glTF loader sets for KHR_texture_transform); without it the maps draw
   * untiled.
   */
  private loadTextureMaps(mesh: LiteMesh, base: BLNS.PbrMaterialProps, mat: MaterialSpec): void {
    const engine = this.engine;
    if (!engine) return;
    const uScale = mat.uScale ?? 1;
    const vScale = mat.vScale ?? 1;
    const tiled = uScale !== 1 || vScale !== 1;
    const load = (url: string | undefined, srgb: boolean): Promise<BLNS.Texture2D | undefined> => {
      if (!url) return Promise.resolve(undefined);
      return BL.loadTexture2D(engine, url, { srgb }).then(
        // loadTexture2D caches one wrapper per URL; the tiling goes on a clone.
        (t) => (tiled ? BL.cloneTexture2D(t, { uScale, vScale }) : t),
        (err: unknown) => {
          console.warn(`[BabylonLiteAdapter] could not load texture ${url}`, err);
          return undefined;
        },
      );
    };
    void Promise.all([
      load(mat.albedoTexture, true),
      load(mat.normalTexture, false),
      load(mat.roughnessTexture, false),
      load(mat.ambientTexture, false),
    ]).then(([albedo, normal, rough, ao]) => {
      if (this.engine !== engine || mesh.material !== base) return;
      if (!albedo && !normal && !rough && !ao) return;
      const textured = BL.createPbrMaterial({
        baseColorFactor: base.baseColorFactor,
        metallicFactor: base.metallicFactor,
        roughnessFactor: base.roughnessFactor,
        alpha: base.alpha,
        ...(albedo ? { baseColorTexture: albedo } : {}),
        ...(normal ? { normalTexture: normal } : {}),
        ...(rough ? { ormTexture: rough } : {}),
        // A separate AO map means ORM red is not read for occlusion; without
        // one, the roughness map's red would darken the surface as AO.
        ...(ao ? { occlusionTexture: ao, occlusionStrength: 1 } : rough ? { occlusionStrength: 0 } : {}),
      });
      const emissive = BL.getPbrEmissiveColor(base);
      if (emissive) BL.setPbrEmissive(textured, [emissive[0], emissive[1], emissive[2]]);
      if (tiled) (textured as { _hasUvTx?: boolean })._hasUvTx = true;
      dropStaleRenderables(this.scene, mesh);
      mesh.material = textured;
    });
  }

  setMeshPosition(h: MeshHandle, x: number, y: number, z: number): void {
    // Add any base-pivot offset so the *base* lands at y (matches Babylon/Three,
    // which bake the pivot into geometry). Negate Z: RH→LH (see createArcCamera).
    this.meshes.get(h)?.position.set(x, y + (this.pivotOffsets.get(h) ?? 0), -z);
  }
  setMeshRotation(h: MeshHandle, x: number, y: number, z: number): void {
    const mesh = this.meshes.get(h);
    if (mesh) this.applyEulerQuat(mesh, x, y, z);
  }
  setMeshOrientation(h: MeshHandle, orientation: Quaternion): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    // RH→LH conjugation by diag(1,1,−1): negate X and Y, keep Z and W — same
    // reflection applyEulerQuat bakes in, applied to the caller's quaternion.
    mesh.rotationQuaternion.set(-orientation.x, -orientation.y, orientation.z, orientation.w);
  }

  /**
   * Set a mesh's orientation from an RH Euler triple via quaternion. We build the
   * quaternion with Babylon's exact yaw(Y)·pitch(X)·roll(Z) order and set
   * rotationQuaternion directly — going through Lite's Euler PROXY would apply a
   * different composition order, so a multi-axis orientation (tilt + spin) landed
   * on the wrong axis. Then we conjugate by the diag(1,1,−1) RH→LH reflection the
   * rest of the adapter applies to positions/camera, which for a quaternion is
   * exactly "negate X and Y, keep Z and W" — so rotations read the same direction
   * as the right-handed Babylon/Three adapters (and, being a quaternion, the axis
   * stays correct for multi-axis rotations, which per-component Euler negation can't).
   */
  private applyEulerQuat(mesh: LiteMesh, x: number, y: number, z: number): void {
    const hx = x * 0.5, hy = y * 0.5, hz = z * 0.5;
    const sx = Math.sin(hx), cx = Math.cos(hx);
    const sy = Math.sin(hy), cy = Math.cos(hy);
    const sz = Math.sin(hz), cz = Math.cos(hz);
    mesh.rotationQuaternion.set(
      -(cy * sx * cz + sy * cx * sz), // x
      -(sy * cx * cz - cy * sx * sz), // y
      cy * cx * sz - sy * sx * cz, // z
      cy * cx * cz + sy * sx * sz, // w
    );
  }
  /** The base-pivot offset of a mesh found by object (physics is keyed by meshId, pivots by handle). */
  private pivotOffsetOf(mesh: LiteMesh): number {
    for (const [h, off] of this.pivotOffsets) if (this.meshes.get(h) === mesh) return off;
    return 0;
  }
  setMeshScale(h: MeshHandle, sx: number, sy: number, sz: number): void {
    const mesh = this.meshes.get(h);
    // A glTF root keeps its handedness flip under any scale (see seatGltfRoot).
    if (mesh && this.gltfRoots.has(mesh)) mesh.scaling.set(sx, sy, -sz);
    else mesh?.scaling.set(sx, sy, sz);
  }
  setMeshColor(h: MeshHandle, r: number, g: number, b: number): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    const m = mesh.material as Partial<BLNS.StandardMaterialProps & BLNS.PbrMaterialProps>;
    if (m.diffuseColor) m.diffuseColor = [r, g, b];
    if (m.baseColorFactor) m.baseColorFactor = [r, g, b, m.baseColorFactor[3] ?? 1];
  }
  setMeshVisible(h: MeshHandle, visible: boolean): void {
    const mesh = this.meshes.get(h);
    if (mesh) setNodeVisible(mesh, visible);
  }
  setMeshGeometry(h: MeshHandle, geom: MeshGeometry): void {
    const mesh = this.meshes.get(h);
    const engine = this.engine;
    if (!mesh || !engine) return;
    // Lite runs left-handed (it negates z everywhere), so mirror the data, and
    // drop the scale a non-uniform box was faked with: the data is to size.
    const m = mirrorZ(geom);
    BL.resizeMeshGeometry(engine, mesh, m.positions, m.normals, m.indices, m.uvs);
    mesh.scaling.set(1, 1, 1);
  }
  getMeshWorldPosition(h: MeshHandle, out: Vec3): Vec3 {
    const mesh = this.meshes.get(h);
    if (!mesh) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    // worldMatrix is column-major 4x4; translation lives in indices 12,13,14.
    // Subtract the base-pivot offset so the reported y matches what setMeshPosition got.
    const m = mesh.worldMatrix;
    out[0] = m[12] ?? mesh.position.x;
    out[1] = (m[13] ?? mesh.position.y) - (this.pivotOffsets.get(h) ?? 0);
    out[2] = -(m[14] ?? mesh.position.z); // LH→RH (see createArcCamera)
    return out;
  }
  setMeshBoundingBoxExtents(h: MeshHandle, min: Vec3, max: Vec3): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    // Record the override (used to size box colliders when physics lands) and
    // stamp Lite's boundMin/boundMax so getMeshBoundingBoxExtents reflects it.
    // The box lives mirrored like the geometry: canonical z ∈ [min, max] is
    // Lite z ∈ [−max, −min].
    this.boxExtents.set(h, { min: [...min], max: [...max] });
    mesh.boundMin = [min[0], min[1], -max[2]];
    mesh.boundMax = [max[0], max[1], -min[2]];
  }
  getMeshBoundingBoxExtents(h: MeshHandle): { min: Vec3; max: Vec3 } | null {
    const override = this.boxExtents.get(h);
    if (override) return { min: [...override.min], max: [...override.max] };
    const mesh = this.meshes.get(h);
    if (!mesh) return null;
    const lo = mesh.boundMin;
    const hi = mesh.boundMax;
    if (!lo || !hi) return null;
    return { min: [lo[0], lo[1], -hi[2]], max: [hi[0], hi[1], -lo[2]] }; // LH→RH
  }
  disposeMesh(h: MeshHandle): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    // Babylon Lite exposes no per-mesh dispose function; hide it and drop our
    // references (and any physics body) so the slot is reclaimable. The GPU
    // geometry is freed when the scene/engine is disposed.
    setNodeVisible(mesh, false);
    for (const [id, m] of this.meshesByMeshId) {
      if (m === mesh) {
        this.physicsDestroyBody(id);
        this.meshesByMeshId.delete(id);
      }
    }
    this.meshes.delete(h);
    this.boxExtents.delete(h);
    this.pivotOffsets.delete(h);
  }

  // ─── Debug lines ───
  // Babylon Lite ships no standalone polyline primitive in this preview build,
  // so the line-system methods track handles but render nothing. Provisional —
  // wire a line/ribbon builder here once Lite exposes one.
  createLineSystem(id: string, lines: Vec3[][], color?: Color): LineHandle {
    void lines;
    void color;
    return this.makeHandle<LineHandle>('lineSystem', id);
  }
  updateLineSystem(h: LineHandle, lines: Vec3[][], color?: Color): void {
    void h;
    void lines;
    void color;
  }
  setLineSystemVisible(h: LineHandle, visible: boolean): void {
    void h;
    void visible;
  }
  disposeLineSystem(h: LineHandle): void {
    void h;
  }

  // ─── Thin-instance fields ───

  /** First entity in a container that looks like a Mesh (has a `material` field). */
  private firstMeshEntity(container: BLNS.AssetContainer): LiteMesh | undefined {
    for (const e of container.entities) {
      if ('material' in e) return e as LiteMesh;
    }
    return undefined;
  }

  /** Resolve a handle to its underlying Lite camera from EITHER camera map (orbit or free). */
  private liteCamera(h: CameraHandle): BLNS.Camera | undefined {
    return this.cameras.get(h)?.camera ?? this.perspectiveCameras.get(h)?.camera;
  }

  screenToWorldPoint(camera: CameraHandle, nx: number, ny: number, distance: number, out: Vec3): Vec3 {
    const cam = this.liteCamera(camera);
    const canvas = this.canvas;
    if (!cam || !canvas) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    // Build a ray through the normalized screen point by inverting the
    // view-projection matrix and unprojecting near/far clip points. Input
    // fraction has origin top-left, so flip Y into NDC (+Y up).
    const aspect = (canvas.clientWidth || canvas.width || 1) / (canvas.clientHeight || canvas.height || 1);
    const vp = BL.getViewProjectionMatrix(cam, aspect);
    const inv = BL.invertMat4(vp);
    if (!inv) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    const ndcX = nx * 2 - 1;
    const ndcY = -(ny * 2 - 1);
    const near = this.unproject(inv, ndcX, ndcY, 0);
    const far = this.unproject(inv, ndcX, ndcY, 1);
    let dx = far[0] - near[0];
    let dy = far[1] - near[1];
    let dz = far[2] - near[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    out[0] = near[0] + dx * distance;
    out[1] = near[1] + dy * distance;
    out[2] = -(near[2] + dz * distance); // LH→RH (see createArcCamera)
    return out;
  }

  /** Unproject an NDC point (x,y,z in clip space) through an inverse VP matrix. */
  private unproject(inv: BLNS.Mat4, x: number, y: number, z: number): [number, number, number] {
    // Column-major mat4 * vec4(x,y,z,1), then perspective-divide.
    const cx = inv[0]! * x + inv[4]! * y + inv[8]! * z + inv[12]!;
    const cy = inv[1]! * x + inv[5]! * y + inv[9]! * z + inv[13]!;
    const cz = inv[2]! * x + inv[6]! * y + inv[10]! * z + inv[14]!;
    const cw = inv[3]! * x + inv[7]! * y + inv[11]! * z + inv[15]!;
    const iw = cw !== 0 ? 1 / cw : 1;
    return [cx * iw, cy * iw, cz * iw];
  }

  // ─── Textures & cards ───
  // Babylon Lite's preview build doesn't expose a URL→texture loader through
  // this adapter (see applyMaterialSpec), so texture LOADING is a documented
  // stub: loadTexture dedupes by key and returns a tracked handle, but no GPU
  // texture is created and setMeshFaceTexture can't swap an albedo map yet. The
  // card MESH itself (bowed, rounded silhouette best-effort) is built for real.
  loadTexture(key: string, url: string, opts?: TextureLoadOpts): TextureHandle {
    void url;
    void opts;
    const cached = this.texturesByKey.get(key);
    if (cached) return cached;
    const handle = this.makeHandle<TextureHandle>('texture', key);
    this.texturesByKey.set(key, handle);
    return handle;
  }

  preloadTexture(url: string): Promise<void> {
    // No texture I/O wired in this preview adapter — resolve immediately so the
    // deal animation never hangs. Provisional: await a real load once Lite's
    // texture loader is confirmed.
    void url;
    return Promise.resolve();
  }

  createCardMesh(id: string, spec: CardMeshSpec): MeshHandle {
    const engine = this.requireEngine();
    const scene = this.requireScene();
    // A ground is a flat horizontal quad; bow it along its width (X). The
    // rounded-corner alpha mask (a DynamicTexture in Babylon, a CanvasTexture in
    // Three) can't be generated here — Lite has no canvas/dynamic-texture path in
    // this preview — so the card renders as a square-cornered bowed quad.
    const mesh = BL.createGround(engine, {
      width: spec.width,
      height: spec.height,
      subdivisions: spec.subdivisions ?? 16,
    });
    mesh.name = id;

    const bow = spec.bow ?? 0;
    if (bow !== 0) {
      // Lite exposes no in-place vertex-buffer mutation in this preview (see
      // the Flipper plugin's geometry rewrite), so the parabolic bow can't be baked into the
      // geometry; the flat quad is the provisional fallback.
      void bow;
    }

    const std = BL.createStandardMaterial();
    std.alpha = 1;
    mesh.material = std;
    BL.addToScene(scene, mesh);

    const handle = this.makeHandle<MeshHandle>('card', id);
    this.meshes.set(handle, mesh);
    this.meshesByMeshId.set(id, mesh);
    this.cards.set(handle, { mesh, front: spec.front, back: spec.back });
    return handle;
  }

  setMeshFaceTexture(h: MeshHandle, side: 'front' | 'back', tex: TextureHandle): void {
    // Track the assignment so the surface is structurally correct; applying it
    // to the material needs Lite's texture loader, which isn't wired here.
    const card = this.cards.get(h);
    if (!card) return;
    if (side === 'front') card.front = tex;
    else card.back = tex;
  }

  disposeTexture(h: TextureHandle): void {
    // Lite exposes no per-texture dispose; drop the dedupe entry that minted it.
    for (const [key, handle] of this.texturesByKey) {
      if (handle === h) {
        this.texturesByKey.delete(key);
        break;
      }
    }
  }

  // ─── Fog ───
  setFog(spec: FogSpec | null): void {
    const scene = this.scene;
    if (!scene) return; // safe before init, like setClearColor
    // Lite's mode numbering matches Babylon's: 0 none, 1 exp, 2 exp2, 3 linear.
    // Disabling goes through setFog with mode 0 (not `scene.fog = null`) so the
    // scene-UBO contributor it registered keeps writing a consistent "none".
    const mode: 0 | 1 | 2 | 3 = !spec ? 0 : spec.mode === 'exp' ? 1 : spec.mode === 'exp2' ? 2 : 3;
    BL.setFog(scene, {
      mode,
      density: spec?.density ?? 0.05,
      start: spec?.start ?? 10,
      end: spec?.end ?? 100,
      color: spec ? [spec.color[0], spec.color[1], spec.color[2]] : [0, 0, 0],
    });
  }

  // ─── Lights ───
  createDirectionalLight(id: string, spec: DirectionalLightSpec): LightHandle {
    const scene = this.requireScene();
    const light = BL.createDirectionalLight(
      [spec.direction[0], spec.direction[1], -spec.direction[2]], // RH→LH
      spec.intensity,
    );
    light.diffuse = [spec.diffuse[0], spec.diffuse[1], spec.diffuse[2]];
    light.specular = [spec.specular[0], spec.specular[1], spec.specular[2]];
    // In Lite the light's position is the shadow camera ORIGIN (the ortho X/Y
    // bounds auto-fit the casters regardless). Place it outside the scene like
    // the working examples so the depth range [minZ,maxZ] reaches the casters.
    if (spec.position) light.position.set(spec.position[0], spec.position[1], -spec.position[2]);
    BL.addToScene(scene, light);

    const handle = this.makeHandle<LightHandle>('dirLight', id);
    this.lights.set(handle, light);

    if (spec.shadow?.enabled) {
      // The ortho X/Y bounds auto-fit the caster AABBs, so `shadow.extent` has
      // nothing to set here; orthoMinZ/maxZ are the
      // DEPTH range measured from the light position along its direction. With the
      // light placed outside the scene, a positive near + a far that reaches past
      // the scene captures all casters (matches the working scene207 setup).
      const gen = BL.createPcfDirectionalShadowGenerator(this.requireEngine(), light, {
        mapSize: spec.shadow.mapSize,
        orthoMinZ: spec.shadow.minZ,
        orthoMaxZ: spec.shadow.maxZ,
      });
      // The shadow task discovers generators via each light's `.shadowGenerator`
      // (NOT via addToScene); this assignment is what makes the light cast shadows.
      light.shadowGenerator = gen;
      this.shadowGenerators.set(handle, gen);
      if (this.pluginShadowCasters.size) this.setCasters(handle, [...this.pluginShadowCasters]);
    }
    return handle;
  }
  createHemisphericLight(id: string, spec: HemisphericLightSpec): LightHandle {
    const scene = this.requireScene();
    const light = BL.createHemisphericLight(
      [spec.direction[0], spec.direction[1], -spec.direction[2]], // RH→LH
      spec.intensity,
    );
    light.diffuseColor = [spec.diffuse[0], spec.diffuse[1], spec.diffuse[2]];
    light.groundColor = [spec.groundColor[0], spec.groundColor[1], spec.groundColor[2]];
    light.specularColor = [spec.specular[0], spec.specular[1], spec.specular[2]];
    BL.addToScene(scene, light);

    const handle = this.makeHandle<LightHandle>('hemLight', id);
    this.lights.set(handle, light);
    return handle;
  }
  createPointLight(id: string, spec: PointLightSpec): LightHandle {
    const scene = this.requireScene();
    // Z negated like every other position that crosses this seam — Lite is
    // left-handed internally while the ECS frame is right-handed.
    const light = BL.createPointLight(
      [spec.position[0], spec.position[1], -spec.position[2]],
      spec.intensity,
    );
    light.diffuse = [spec.diffuse[0], spec.diffuse[1], spec.diffuse[2]];
    if (spec.specular) light.specular = [spec.specular[0], spec.specular[1], spec.specular[2]];
    if (spec.range) light.range = spec.range;
    BL.addToScene(scene, light);

    const handle = this.makeHandle<LightHandle>('pointLight', id);
    this.lights.set(handle, light);
    return handle;
  }
  createSpotLight(id: string, spec: SpotLightSpec): LightHandle {
    const scene = this.requireScene();
    const diffuse = spec.diffuse ?? [1, 1, 1];
    const specular = spec.specular ?? [1, 1, 1];
    // Lite's spot takes the full aperture + exponent like Babylon's. Position
    // AND direction cross the RH→LH seam, so both negate Z.
    const light = BL.createSpotLight(
      [spec.position[0], spec.position[1], -spec.position[2]],
      [spec.direction[0], spec.direction[1], -spec.direction[2]],
      spec.angle ?? Math.PI / 3,
      spec.exponent ?? 2,
      spec.intensity ?? 1,
    );
    light.diffuse = [diffuse[0], diffuse[1], diffuse[2]];
    light.specular = [specular[0], specular[1], specular[2]];
    light.range = spec.range ?? 10;
    BL.addToScene(scene, light);

    const handle = this.makeHandle<LightHandle>('spotLight', id);
    this.lights.set(handle, light);
    if (spec.shadow?.enabled) {
      // Like the directional: the shadow task finds the generator on the light.
      const gen = BL.createPcfSpotlightShadowGenerator(this.requireEngine(), light, {
        mapSize: spec.shadow.mapSize,
        near: spec.shadow.minZ,
        far: spec.shadow.maxZ,
        ...(spec.shadow.darkness !== undefined ? { darkness: spec.shadow.darkness } : {}),
      });
      light.shadowGenerator = gen;
      this.shadowGenerators.set(handle, gen);
      if (this.pluginShadowCasters.size) this.setCasters(handle, [...this.pluginShadowCasters]);
    }
    return handle;
  }
  setLightPosition(h: LightHandle, x: number, y: number, z: number): void {
    const light = this.lights.get(h) as { position?: [number, number, number] } | undefined;
    if (light?.position) light.position = [x, y, -z];
  }
  setLightDirection(h: LightHandle, x: number, y: number, z: number): void {
    const light = this.lights.get(h);
    // Only the aimed kinds (spot, directional) are re-aimed; a point /
    // hemispheric light is left alone. Z negated: RH→LH.
    if (light && (light.lightType === 'spot' || light.lightType === 'directional')) {
      light.direction.set(x, y, -z);
    }
  }
  setLightColor(h: LightHandle, r: number, g: number, b: number): void {
    const light = this.lights.get(h);
    if (!light) return;
    // Lite names the hemispheric light's diffuse `diffuseColor`; the rest use `diffuse`.
    if (light.lightType === 'hemispheric') light.diffuseColor = [r, g, b];
    else light.diffuse = [r, g, b];
  }
  updateLightIntensity(h: LightHandle, intensity: number): void {
    const light = this.lights.get(h);
    if (light) light.intensity = intensity;
  }
  disposeLight(h: LightHandle): void {
    // Babylon Lite has no light-dispose function. Best-effort: zero the
    // intensity so it stops contributing, then drop our references.
    const light = this.lights.get(h);
    if (light) light.intensity = 0;
    this.lights.delete(h);
    this.shadowGenerators.delete(h);
  }

  // ─── Camera ───
  createArcCamera(id: string, spec: ArcCameraSpec): CameraHandle {
    // Babylon Lite is LEFT-handed (its docs: "Babylon.js convention: left-handed"),
    // but this ECS — like BabylonAdapter (useRightHandedSystem=true) and Three — is
    // RIGHT-handed. We bridge by negating Z wherever coordinates cross the boundary.
    // For the arc camera: target.z → −z and alpha → −alpha (azimuth around Y flips
    // sign under a Z flip), which reproduces the RH view exactly.
    const camera = BL.createArcRotateCamera(-spec.alpha, spec.beta, spec.radius, {
      x: spec.target[0],
      y: spec.target[1],
      z: -spec.target[2],
    });
    camera.lowerRadiusLimit = spec.minRadius;
    camera.upperRadiusLimit = spec.maxRadius;
    camera.lowerBetaLimit = spec.minBeta;
    camera.upperBetaLimit = spec.maxBeta;
    camera.inertia = spec.inertia;

    // The scene renders from scene.camera; without this nothing is drawn.
    this.requireScene().camera = camera;

    let detach: (() => void) | undefined;
    if ((spec.controlsEnabled ?? true) && this.canvas) {
      detach = BL.attachControl(camera, this.canvas, this.scene);
    }

    const handle = this.makeHandle<CameraHandle>('arcCamera', id);
    this.cameras.set(handle, { camera, detach });
    return handle;
  }
  setCameraTarget(h: CameraHandle, x: number, y: number, z: number): void {
    const entry = this.cameras.get(h);
    if (entry) {
      entry.camera.target.x = x;
      entry.camera.target.y = y;
      entry.camera.target.z = -z; // RH→LH (see createArcCamera)
    }
  }
  getCameraTarget(h: CameraHandle, out: Vec3): Vec3 {
    const entry = this.cameras.get(h);
    if (entry) {
      out[0] = entry.camera.target.x;
      out[1] = entry.camera.target.y;
      out[2] = -entry.camera.target.z; // LH→RH
    } else {
      out[0] = out[1] = out[2] = 0;
    }
    return out;
  }
  getCameraAngles(h: CameraHandle): { alpha: number; beta: number; radius: number } {
    const entry = this.cameras.get(h);
    if (!entry) return { alpha: 0, beta: 0, radius: 0 };
    // createArcCamera hands Lite −alpha (azimuth flips under the Z mirror), so
    // the canonical alpha is the negation of Lite's.
    return { alpha: -entry.camera.alpha, beta: entry.camera.beta, radius: entry.camera.radius };
  }
  getCameraForward(h: CameraHandle, out: Vec3): Vec3 {
    // A free 6-DOF perspective camera carries a full orientation quaternion; its
    // forward is `q · (+Z)` — the canonical convention (identity → +Z) the
    // contract locks. (setCameraPose already aims this camera that way.)
    const persp = this.perspectiveCameras.get(h);
    if (persp) {
      const f = this.rotateVecByQuat(persp.orientation, 0, 0, 1);
      out[0] = f[0]; out[1] = f[1]; out[2] = f[2];
      return out;
    }
    const entry = this.cameras.get(h);
    if (!entry) {
      out[0] = 0;
      out[1] = 0;
      out[2] = -1;
      return out;
    }
    // Forward = unit(target − cameraPosition), measured in Lite's frame and
    // handed back mirrored (LH→RH).
    const pos = BL.getCameraPosition(entry.camera);
    const t = entry.camera.target;
    const dx = t.x - pos.x;
    const dy = t.y - pos.y;
    const dz = pos.z - t.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    out[0] = dx / len;
    out[1] = dy / len;
    out[2] = dz / len;
    return out;
  }
  getCameraUp(h: CameraHandle, out: Vec3): Vec3 {
    const persp = this.perspectiveCameras.get(h);
    if (persp) {
      // Derived from the stored orientation, because this backend's free camera
      // is position+target with NO up vector at all (`@babylonjs/lite`'s
      // FreeCamera exposes neither `upVector` nor a rotation quaternion). So the
      // lite renderer genuinely cannot draw a rolled camera; the orientation we
      // were handed is the only truth available, and this reports it. Anything
      // that needs a rolling chase camera on screen wants the full BabylonAdapter.
      const u = this.rotateVecByQuat(persp.orientation, 0, 1, 0);
      out[0] = u[0]; out[1] = u[1]; out[2] = u[2];
      return out;
    }
    out[0] = 0; out[1] = 1; out[2] = 0;
    return out;
  }

  getCameraRight(h: CameraHandle, out: Vec3): Vec3 {
    // getCameraForward is canonical (right-handed), so right = forward × up,
    // exactly as BabylonAdapter/ThreeAdapter compute it: cross((fx,fy,fz),
    // (0,1,0)) = (−fz, 0, fx), normalized over its horizontal length so a
    // pitched camera still yields a unit vector.
    this.getCameraForward(h, out);
    const fx = out[0];
    const fz = out[2];
    const len = Math.hypot(fx, fz) || 1;
    out[0] = -fz / len;
    out[1] = 0;
    out[2] = fx / len;
    return out;
  }
  nudgeCameraAlpha(h: CameraHandle, delta: number): void {
    const entry = this.cameras.get(h);
    if (entry) entry.camera.alpha -= delta; // canonical +delta = Lite −delta
  }
  nudgeCameraRadius(h: CameraHandle, delta: number): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    let next = entry.camera.radius + delta;
    const lo = entry.camera.lowerRadiusLimit;
    const hi = entry.camera.upperRadiusLimit;
    if (lo !== undefined) next = Math.max(lo, next);
    if (hi !== undefined) next = Math.min(hi, next);
    entry.camera.radius = next;
  }
  setCameraRadius(h: CameraHandle, radius: number): void {
    const entry = this.cameras.get(h);
    if (entry) entry.camera.radius = radius;
  }
  setCameraRadiusLimits(h: CameraHandle, min: number, max: number): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    entry.camera.lowerRadiusLimit = min;
    entry.camera.upperRadiusLimit = max;
  }
  setCameraFov(h: CameraHandle, fov: number): void {
    const entry = this.cameras.get(h);
    if (entry) {
      entry.camera.fov = fov;
      return;
    }
    // Also accept a free 6-DOF perspective camera (fov lives on Lite's `Camera`).
    const persp = this.perspectiveCameras.get(h);
    if (persp) persp.camera.fov = fov;
  }
  setCameraControlsEnabled(h: CameraHandle, enabled: boolean): void {
    const entry = this.cameras.get(h);
    if (!entry || !this.canvas) return;
    if (enabled) {
      if (!entry.detach) entry.detach = BL.attachControl(entry.camera, this.canvas, this.scene);
    } else if (entry.detach) {
      entry.detach();
      entry.detach = undefined;
    }
  }

  // ─── Free 6-DOF perspective camera (chase / flight) ───
  createPerspectiveCamera(id: string, spec: PerspectiveCameraSpec): CameraHandle {
    const scene = this.requireScene();
    const position = spec.position ?? [0, 0, 0];
    const orientation = spec.orientation ?? { x: 0, y: 0, z: 0, w: 1 };
    // Build a FreeCamera at the LH origin looking down −Z (which is +Z in our RH
    // frame — Mock's "identity orientation looks down +Z" convention). The real
    // pose is applied by setCameraPose below; the constructor target only needs
    // to differ from the position so the initial look matrix isn't degenerate.
    const camera = BL.createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    camera.fov = spec.fov;
    camera.nearPlane = spec.near;
    camera.farPlane = spec.far;
    // Render from this camera — mark it active, like createArcCamera sets scene.camera.
    scene.camera = camera;

    const handle = this.makeHandle<CameraHandle>('perspectiveCamera', id);
    const entry = { camera, orientation: { ...orientation } };
    this.perspectiveCameras.set(handle, entry);
    this.activePerspective = entry;
    // Apply the initial pose (negates Z, derives the LH look target).
    this.setCameraPose(handle, position, orientation);
    return handle;
  }

  setCameraPose(h: CameraHandle, position: Vec3, orientation: Quaternion): void {
    const entry = this.perspectiveCameras.get(h);
    if (!entry) return;
    // Store the orientation VERBATIM so getCameraPose round-trips it losslessly —
    // a position+target FreeCamera can't represent roll, so the quaternion is the
    // source of truth, not a re-decomposition of the look direction.
    entry.orientation.x = orientation.x;
    entry.orientation.y = orientation.y;
    entry.orientation.z = orientation.z;
    entry.orientation.w = orientation.w;
    // RH→LH: negate the position's Z (same reflection createArcCamera applies).
    entry.camera.position.set(position[0], position[1], -position[2]);
    // Aim the LH camera by deriving a look target from the orientation: forward =
    // q · (+Z) in RH, mapped into LH by negating its Z, added to the LH position.
    const f = this.rotateVecByQuat(orientation, 0, 0, 1);
    // Straight up or down, a position+target camera has no defined roll — Lite's
    // look-at against world +Y degenerates and the frame draws NOTHING (a top
    // view: SpaceGolf, the axis-view cameras). Lean the target a hair toward
    // the orientation's own up, which pins the roll to the one asked for.
    if (Math.abs(f[1]) > 0.999) {
      const u = this.rotateVecByQuat(orientation, 0, 1, 0);
      const k = 1e-3;
      f[0] += u[0] * k;
      f[1] += u[1] * k;
      f[2] += u[2] * k;
    }
    entry.camera.target.set(position[0] + f[0], position[1] + f[1], -position[2] - f[2]);
  }

  getCameraPose(h: CameraHandle, outPosition: Vec3, outOrientation: Quaternion): void {
    const entry = this.perspectiveCameras.get(h);
    if (!entry) return; // unknown handle — leave the outs untouched
    // Position: LH→RH (un-negate Z), the inverse of setCameraPose.
    outPosition[0] = entry.camera.position.x;
    outPosition[1] = entry.camera.position.y;
    outPosition[2] = -entry.camera.position.z;
    // Orientation: hand back the verbatim-stored quaternion (lossless round-trip).
    outOrientation.x = entry.orientation.x;
    outOrientation.y = entry.orientation.y;
    outOrientation.z = entry.orientation.z;
    outOrientation.w = entry.orientation.w;
  }

  /**
   * Rotate the vector `(vx,vy,vz)` by the unit quaternion `q`, returning a fresh
   * tuple. Standard `v' = v + 2·qw·(qv×v) + 2·(qv×(qv×v))` (the quaternion
   * Rodrigues form). Used by setCameraPose to turn the orientation into a look
   * target without leaking a quaternion onto the position+target FreeCamera.
   */
  private rotateVecByQuat(q: Quaternion, vx: number, vy: number, vz: number): [number, number, number] {
    // t = 2·(qv × v);  v' = v + qw·t + qv × t
    const tx = 2 * (q.y * vz - q.z * vy);
    const ty = 2 * (q.z * vx - q.x * vz);
    const tz = 2 * (q.x * vy - q.y * vx);
    return [
      vx + q.w * tx + (q.y * tz - q.z * ty),
      vy + q.w * ty + (q.z * tx - q.x * tz),
      vz + q.w * tz + (q.x * ty - q.y * tx),
    ];
  }

  worldToScreen(x: number, y: number, z: number, out: ScreenPoint): boolean {
    const entry = this.activePerspective;
    const canvas = this.canvas;
    if (!entry || !canvas) return false;
    const width = canvas.clientWidth || canvas.width || 1;
    const height = canvas.clientHeight || canvas.height || 1;
    const vp = BL.getViewProjectionMatrix(entry.camera, width / height);
    // RH→LH world point (negate Z), then column-major VP · vec4(.,.,.,1) → clip.
    const wx = x, wy = y, wz = -z;
    const cx = vp[0]! * wx + vp[4]! * wy + vp[8]! * wz + vp[12]!;
    const cy = vp[1]! * wx + vp[5]! * wy + vp[9]! * wz + vp[13]!;
    const cw = vp[3]! * wx + vp[7]! * wy + vp[11]! * wz + vp[15]!;
    // Behind the camera (or on the plane): clip w ≤ 0. Branch BEFORE writing so
    // a behind-camera miss leaves `out` untouched (the HUD draws an off-screen
    // arrow instead of a bracket at a mirrored phantom position).
    if (cw <= 0) return false;
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    // NDC (+y up) → pixels (origin top-left, +y down).
    out.x = (ndcX * 0.5 + 0.5) * width;
    out.y = (0.5 - ndcY * 0.5) * height;
    return true;
  }

  // ─── Floating origin / large world (Phase-1: contract-only, dormant) ───

  pickAtScreenPoint(x: number, y: number, opts?: PickOptions): PickResult | null {
    // Babylon Lite only offers GPU-async picking (`createGpuPicker` + async
    // `pickAsync`), which cannot satisfy this SYNCHRONOUS contract. Documented
    // stub returning null — pointer tools that need sync picks aren't supported
    // on the Lite preview yet.
    void x;
    void y;
    void opts;
    return null;
  }

  // ─── Shadows ───
  attachShadowCaster(light: LightHandle, mesh: MeshHandle): ShadowCasterHandle {
    const gen = this.shadowGenerators.get(light);
    const m = this.meshes.get(mesh);
    // setShadowTaskCasterMeshes REPLACES the caster list, so accumulate every
    // caster for this light and pass the full set each time.
    const list = this.shadowCasterMeshes.get(light) ?? [];
    if (m) list.push(m);
    this.shadowCasterMeshes.set(light, list);
    if (gen && list.length) this.handOverCasters(light, gen, list);
    const handle = this.makeHandle<ShadowCasterHandle>('shadow', `${String(light)}+${String(mesh)}`);
    this.shadowCasters.set(handle, { light, meshes: m ? [m] : [] });
    return handle;
  }
  detachShadowCaster(h: ShadowCasterHandle): void {
    const pair = this.shadowCasters.get(h);
    if (!pair) return;
    const gen = this.shadowGenerators.get(pair.light);
    // Take out THIS caster's meshes and hand the generator the rest. (It used to
    // hand it an empty list: one detach — a pooled ball re-seated, a Shadow
    // removed — dropped every caster. Lite then fits its ortho box to a ±1 m
    // default round the light and draws an empty map, so everything inside
    // that box read as shadowed: the billiard felt and balls went dark with
    // lit triangles at the rail corners.)
    const list = this.shadowCasterMeshes.get(pair.light);
    if (list) {
      for (const m of pair.meshes) {
        const i = list.indexOf(m);
        if (i >= 0) list.splice(i, 1);
      }
    }
    if (gen) {
      if (list) this.handOverCasters(pair.light, gen, list);
      else BL.setShadowTaskCasterMeshes(gen, []);
    }
    this.shadowCasters.delete(h);
  }
  /**
   * Host accessor for adapter plugins: make a node the plugin built cast
   * shadows under every shadow-casting light — Lite's twin of Babylon's
   * `generator.addShadowCaster(mesh)`. Lite's only call,
   * `setShadowTaskCasterMeshes`, REPLACES a generator's list, and this adapter
   * owns that list, so a plugin calling it wiped every Shadow component's
   * caster. Here the node joins the adapter's own list instead (as a NEW
   * array, so Lite builds its depth drawing), and a light made later picks it
   * up too. Callers: ProceduralCity and RoadsideScenery.
   */
  addShadowCasterNode(node: object): void {
    const m = node as LiteMesh;
    if (this.pluginShadowCasters.has(m)) return;
    this.pluginShadowCasters.add(m);
    for (const light of this.shadowGenerators.keys()) {
      const list = this.shadowCasterMeshes.get(light) ?? [];
      if (!list.includes(m)) this.setCasters(light, [...list, m]);
    }
  }
  /** Take a plugin's node back out of every light's casters. */
  removeShadowCasterNode(node: object): void {
    const m = node as LiteMesh;
    if (!this.pluginShadowCasters.delete(m)) return;
    for (const [light, list] of this.shadowCasterMeshes) {
      if (list.includes(m)) this.setCasters(light, list.filter((x) => x !== m));
    }
  }
  private setCasters(light: LightHandle, list: LiteMesh[]): void {
    this.shadowCasterMeshes.set(light, list);
    const gen = this.shadowGenerators.get(light);
    if (gen) this.handOverCasters(light, gen, list);
  }
  /**
   * Give Lite a light's caster list.
   *
   * A PBR caster's depth drawing needs Lite's PBR no-colour module, which
   * the generator imports in `_preloadShadowTask`. setShadowTaskCasterMeshes
   * starts that import but does not wait, and the next frame's shadow pass
   * records first: "createPbrNoColorMaterialView is not a function", every
   * frame. So load it first, and hand the list over once it has landed (if
   * it is still the list this light should cast). Every hand-over goes
   * through here: a Shadow component attached while a plugin's PBR casters
   * were still loading handed Lite the list early, and the frame threw.
   */
  private handOverCasters(light: LightHandle, gen: BLNS.ShadowGenerator, list: LiteMesh[]): void {
    const preload = (gen as unknown as { _preloadShadowTask?: (m: readonly LiteMesh[]) => Promise<void> })._preloadShadowTask;
    if (typeof preload !== 'function') {
      BL.setShadowTaskCasterMeshes(gen, list);
      return;
    }
    void preload.call(gen, list).then(
      () => {
        if (this.shadowCasterMeshes.get(light) !== list || this.shadowGenerators.get(light) !== gen) return;
        this.pendingCasters.set(light, { gen, list });
        this.flushCasters();
      },
      (err: unknown) => console.error('[BabylonLiteAdapter] a shadow caster could not load its depth shader', err),
    );
  }
  /** Lists waiting for their casters' material families to be built. */
  private pendingCasters = new Map<LightHandle, { gen: BLNS.ShadowGenerator; list: LiteMesh[] }>();
  /**
   * Hand Lite each waiting list whose casters can all be drawn. The shadow
   * pass draws a caster through its material family's single-mesh builder,
   * which Lite makes with the family's first mesh — a plugin's first PBR
   * mesh is built a frame or two after it lands (buildLateMaterialGroups), and
   * a list handed over before then threw on record. Likewise a thin-instanced
   * caster while the PBR build has no thin-instance code (see
   * widenPbrGroupForLateMeshes): it waits for the group rebuild. Called after
   * the preload and every frame.
   */
  private flushCasters(): void {
    for (const [light, { gen, list }] of this.pendingCasters) {
      if (this.shadowCasterMeshes.get(light) !== list || this.shadowGenerators.get(light) !== gen) {
        this.pendingCasters.delete(light);
        continue;
      }
      const drawable = list.every((m) => {
        const group = (m as { material?: { _buildGroup?: { _rebuildSingle?: unknown } } | null }).material?._buildGroup;
        if (lacksThinInstanceCode(this.scene, m)) return false;
        return !group || typeof group._rebuildSingle === 'function';
      });
      if (!drawable) continue;
      this.pendingCasters.delete(light);
      BL.setShadowTaskCasterMeshes(gen, list);
    }
  }
  setMeshReceiveShadows(h: MeshHandle, receive: boolean): void {
    const mesh = this.meshes.get(h);
    if (mesh) mesh.receiveShadows = receive;
  }

  // ─── Skybox ───
  // Babylon Lite's sky/env helpers (`loadHdrEnvironment`, `loadDdsSkybox`) are
  // ASYNC and don't model the procedural gradient+sun-disc this interface
  // describes. createSkybox returns a tracked handle but renders nothing, and
  // the sun/dispose calls are no-ops. Provisional until a Lite procedural-sky
  // builder exists.
  createSkybox(id: string, spec: SkyboxSpec): SkyboxHandle {
    void spec;
    return this.makeHandle<SkyboxHandle>('skybox', id);
  }
  updateSkyboxSun(h: SkyboxHandle, sunDirection: Vec3, sunColor?: Color): void {
    void h;
    void sunDirection;
    void sunColor;
  }
  disposeSkybox(h: SkyboxHandle): void {
    void h;
  }

  setEnvironmentTexture(url: string, opts?: EnvironmentTextureOpts): void {
    // Fire-and-forget the async load so the sync contract is honored; we
    // don't await it. Errors are logged, not thrown. Lite has no scene-wide IBL
    // strength, so opts.level is not applied.
    //
    // By file type, as Babylon's own loader decides: a Babylon .env goes to
    // Lite's loadEnvironment (it used to be handed to the .hdr parser, which
    // rejected every one with "Invalid HDR: missing #? signature"), anything
    // else to loadHdrEnvironment. Neither adds a skybox or ground: Babylon's
    // scene.environmentTexture lights the scene and draws nothing.
    const scene = this.scene;
    if (!scene) return;
    void opts;
    const isEnv = /\.env($|[?#])/i.test(url);
    const load = isEnv
      ? import('./liteEnvironmentBrdf').then(({ LITE_ENVIRONMENT_BRDF_URL }) =>
          BL.loadEnvironment(scene, url, { brdfUrl: LITE_ENVIRONMENT_BRDF_URL, skipSkybox: true, skipGround: true }),
        )
      : Promise.resolve(BL.loadHdrEnvironment(scene, url, { skipGround: true }));
    void load.catch((err: unknown) => console.error('[BabylonLiteAdapter] setEnvironmentTexture failed', url, err));
  }
  clearEnvironmentTexture(): void {
    // Lite exposes no "clear environment" call in this preview; no-op.
  }

  /**
   * No-op. A skin is inherently PER-CLONE, and this adapter has no container
   * clone API — `instantiateModel` above reuses the template's own root as the
   * instance. Repainting it here would therefore repaint the shared template
   * (and so every "clone" of it) rather than one model, which the contract
   * explicitly forbids. Revisit when Babylon Lite ships a clone helper.
   */
  setMeshSkin(_handle: MeshHandle, _spec: MeshSkinSpec): void {}

  // ─── GLB / animation ───
  async loadMesh(id: string, spec: MeshLoadSpec): Promise<MeshLoadResult> {
    const engine = this.requireEngine();
    const scene = this.requireScene();
    const container = await BL.loadGltf(engine, spec.url);
    BL.addToScene(scene, container);

    // Treat the first entity (glTF root TransformNode) as the addressable root.
    const root = (container.entities[0] ?? this.firstMeshEntity(container)) as LiteMesh | undefined;
    const handle = this.makeHandle<MeshHandle>('loadedMesh', id);
    if (root) {
      root.name = id;
      // RH→LH: negate Z on position and route rotation through the quaternion
      // helper, same as setMeshPosition/setMeshRotation (see createArcCamera).
      if (spec.position) root.position.set(spec.position[0], spec.position[1], -spec.position[2]);
      if (spec.rotation) this.applyEulerQuat(root, spec.rotation[0], spec.rotation[1], spec.rotation[2]);
      this.seatGltfRoot(root, spec.scale ?? 1);
      this.meshes.set(handle, root);
      this.meshesByMeshId.set(id, root);
    }

    const animationNames: string[] = [];
    for (const g of container.animationGroups ?? []) {
      this.animationGroups.set(`${id}/${g.name}`, g);
      animationNames.push(g.name);
    }
    return { meshId: id, handle, animationNames };
  }

  /**
   * Put a loaded glTF's root into the canonical frame.
   *
   * glTF is right-handed, like the canonical frame, and Lite is left-handed.
   * Lite's loader converts by mirroring X on the root (`__root__` scaling
   * (−1, 1, 1)); this adapter converts every canonical position by mirroring
   * Z. The two differ by a half turn about Y, so a model kept on the loader's
   * mirror faces 180° away from where the frame says — and one whose root
   * scale was simply overwritten (`spec.scale`, setMeshScale) lost its mirror
   * and drew as its own mirror image. The root is given the adapter's mirror
   * instead, (s, s, −s), and setMeshScale keeps it for every glTF root.
   * Verified on screen against BabylonAdapter: the spaceshooter ship's tail
   * now faces the chase camera on both.
   */
  private seatGltfRoot(root: LiteMesh, scale: number): void {
    root.scaling.set(scale, scale, -scale);
    this.gltfRoots.add(root);
  }
  private gltfRoots = new WeakSet<object>();

  /** World-space AABB (Lite frame) of every mesh under `root` that carries a local box. */
  private hierarchyBounds(root: LiteMesh): { min: [number, number, number]; max: [number, number, number] } | null {
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const walk = (n: LiteMesh): void => {
      if (n.visible !== false && n.boundMin && n.boundMax) {
        const m = n.worldMatrix;
        for (let c = 0; c < 8; c++) {
          const x = c & 1 ? n.boundMax[0] : n.boundMin[0];
          const y = c & 2 ? n.boundMax[1] : n.boundMin[1];
          const z = c & 4 ? n.boundMax[2] : n.boundMin[2];
          const w = [x * m[0]! + y * m[4]! + z * m[8]! + m[12]!, x * m[1]! + y * m[5]! + z * m[9]! + m[13]!, x * m[2]! + y * m[6]! + z * m[10]! + m[14]!];
          for (let k = 0; k < 3; k++) {
            if (w[k]! < lo[k]!) lo[k] = w[k]!;
            if (w[k]! > hi[k]!) hi[k] = w[k]!;
          }
        }
      }
      for (const ch of n.children ?? []) walk(ch as LiteMesh);
    };
    walk(root);
    return Number.isFinite(lo[0]) ? { min: lo, max: hi } : null;
  }

  /**
   * ModelInstantiateSpec.fit, as BabylonAdapter and ThreeAdapter apply it:
   * measure the hierarchy at rest, scale its longest horizontal extent to
   * `fitLength` (or its height to `fitHeight`), turn it by the fit's
   * yaw/pitch, seat it, lift it by `yOffset`. Without this a fitted ship drew
   * at its authored size — the spaceshooter fighters came out a third of the
   * size they are on the other two engines.
   */
  private applyModelFit(root: LiteMesh, fit: ModelFitSpec, spec?: ModelInstantiateSpec): void {
    if (fit.meshNameFilter) {
      const filter = fit.meshNameFilter;
      const meshes: LiteMesh[] = [];
      const walk = (n: LiteMesh): void => {
        if ((n as { _gpu?: unknown })._gpu !== undefined) meshes.push(n);
        for (const ch of n.children ?? []) walk(ch as LiteMesh);
      };
      walk(root);
      if (meshes.some((m) => m.name.includes(filter))) for (const m of meshes) if (!m.name.includes(filter)) BL.setMeshVisible(m, false);
    }
    // Measure at rest: no turn, no offset, unit scale (the mirror kept).
    root.position.set(0, 0, 0);
    root.rotationQuaternion.set(0, 0, 0, 1);
    this.seatGltfRoot(root, 1);
    const b = this.hierarchyBounds(root);
    const sx = b ? b.max[0] - b.min[0] : 1;
    const sy = b ? b.max[1] - b.min[1] : 1;
    const sz = b ? b.max[2] - b.min[2] : 1;
    const scale =
      fit.fitHeight !== undefined
        ? fit.fitHeight / Math.max(sy, 1e-4)
        : fit.fitLength !== undefined
          ? fit.fitLength / Math.max(sx, sz, 1e-4)
          : (spec?.scale ?? 1);
    this.seatGltfRoot(root, scale);
    this.applyEulerQuat(root, fit.pitch ?? 0, fit.yaw ?? 0, 0);
    const p = spec?.position ?? [0, 0, 0];
    root.position.set(p[0], p[1], -p[2]);
    if (fit.seatOnGround) {
      const after = this.hierarchyBounds(root);
      if (after) root.position.set(p[0], root.position.y + p[1] - after.min[1], -p[2]);
    }
    if (fit.yOffset) root.position.set(root.position.x, root.position.y + fit.yOffset, root.position.z);
  }

  // ── Extension seam ─────────────────────────────────────────────────────────
  private extensions = new Map<string, object>();
  registerExtension(name: string, impl: object): void {
    this.extensions.set(name, impl);
  }
  extension<T = object>(name: string): T | undefined {
    return this.extensions.get(name) as T | undefined;
  }

  // Engine-typed host accessors for adapter plugins — the Lite twins of
  // BabylonAdapter's. They live on the CLASS, not the RendererAdapter
  // interface: holding a SceneContext or a PhysicsBody is a plugin's business.
  // Every value they hand out is in Lite's LEFT-handed frame; a plugin that
  // writes positions negates Z itself, as this adapter does.

  /** The live Lite SceneContext, or null before init(). The engine is `scene.surface.engine`, or {@link getEngine}. */
  getScene(): BLNS.SceneContext | null {
    return this.scene ?? null;
  }
  /** The Lite EngineContext (GPU device, texture uploads), or null before init(). */
  getEngine(): BLNS.EngineContext | null {
    return this.engine ?? null;
  }
  /**
   * The BRDF lookup image Lite's `loadEnvironment` needs for a `.env` — the
   * one Babylon embeds (liteEnvironmentBrdf.ts, loaded on first ask). For a
   * plugin that loads `.env` skies itself, as setEnvironmentTexture does.
   */
  async getEnvironmentBrdfUrl(): Promise<string> {
    return (await import('./liteEnvironmentBrdf')).LITE_ENVIRONMENT_BRDF_URL;
  }
  /** The ArcRotateCamera behind a handle, for the ArcCamera plugin's pitch. */
  getOrbitCamera(h: CameraHandle): BLNS.ArcRotateCamera | null {
    return this.cameras.get(h)?.camera ?? null;
  }
  /** The Havok body on a mesh, for the Physics plugin's body controls. */
  getPhysicsBody(meshId: string): BLNS.PhysicsBody | null {
    return this.aggregates.get(meshId)?.body ?? null;
  }
  /** The Havok world, or null until the WASM has landed — Lite's twin of BabylonAdapter.getHavokPlugin. */
  getHavokWorld(): BLNS.PhysicsWorld | null {
    return this.havokReady ? this.havokWorld : null;
  }
  /** Which mesh a cast result's body belongs to — casts report bodies, not ids. */
  getMeshIdForBody(body: BLNS.PhysicsBody): string | undefined {
    return this.bodyMeshIds.get(body);
  }
  /**
   * The Lite mesh (or glTF root node, for loadMesh/instantiateModel) behind a
   * handle — Lite's twin of BabylonAdapter.getMeshObject. A plugin parents its
   * extra meshes to it so they inherit position and setMeshScale. Null once
   * the mesh is disposed. Its transform is LEFT-handed (z negated).
   */
  getMeshObject(h: MeshHandle): LiteMesh | null {
    return this.meshes.get(h) ?? null;
  }
  /**
   * Register a node a PLUGIN built (and added to the scene), so the handle it
   * gets back works with every ordinary mesh op — position, scale, visibility,
   * physics by id. Lite's twin of BabylonAdapter.adoptMesh.
   */
  adoptMesh(id: string, node: LiteMesh): MeshHandle {
    const handle = this.makeHandle<MeshHandle>('plugin', id);
    this.meshes.set(handle, node);
    this.meshesByMeshId.set(id, node);
    return handle;
  }
  /** The same object by meshId — Lite's twin of BabylonAdapter.getMeshRoot. */
  getMeshRoot(meshId: string): LiteMesh | null {
    return this.meshesByMeshId.get(meshId) ?? null;
  }

  async loadModelTemplate(
    url: string,
    opts?: LoadModelTemplateOptions,
  ): Promise<{ animationNames: string[] }> {
    // lockRootMotion is a Babylon (full) feature; the Lite preview doesn't yet
    // expose track editing, so the flag is accepted but not applied here.
    void opts;
    const cached = this.modelTemplates.get(url);
    if (cached) return { animationNames: [...cached.animationNames] };
    const engine = this.requireEngine();
    const container = await BL.loadGltf(engine, url);
    const animationNames = (container.animationGroups ?? []).map((g) => g.name);
    // Kept OFF the scene; instantiateModel re-adds clones (see note there).
    this.modelTemplates.set(url, { container, animationNames });
    return { animationNames: [...animationNames] };
  }

  instantiateModel(id: string, url: string, spec?: ModelInstantiateSpec): MeshHandle {
    const scene = this.requireScene();
    const template = this.modelTemplates.get(url);
    if (!template) {
      throw new Error(
        `BabylonLiteAdapter.instantiateModel: template not loaded for "${url}" — await loadModelTemplate first`,
      );
    }
    // Babylon Lite's preview build has no documented container/skeleton clone
    // helper, so a single template can't be cheaply duplicated per entity. We
    // reuse the template's root as the instance (correct for one instance; a
    // true pool of N skinned clones needs a Lite clone API). Provisional.
    const root = (template.container.entities[0] ?? this.firstMeshEntity(template.container)) as
      | LiteMesh
      | undefined;
    const handle = this.makeHandle<MeshHandle>('model', id);
    if (root) {
      root.name = id;
      // RH→LH, the same mirror loadMesh applies (see createArcCamera).
      if (spec?.position) root.position.set(spec.position[0], spec.position[1], -spec.position[2]);
      if (spec?.rotation) this.applyEulerQuat(root, spec.rotation[0], spec.rotation[1], spec.rotation[2]);
      this.seatGltfRoot(root, spec?.scale ?? 1);
      if (spec?.fit) this.applyModelFit(root, spec.fit, spec);
      BL.setMeshVisible(root, false); // start parked; setModelVisible reveals it
      BL.addToScene(scene, root);
      this.meshes.set(handle, root);
      this.instantiatedModelRoots.set(id, root);
      this.meshesByMeshId.set(id, root);
    }
    // Register the template's clips under this id so animation calls resolve.
    for (const g of template.container.animationGroups ?? []) {
      this.animationGroups.set(`${id}/${g.name}`, g);
    }
    return handle;
  }

  setModelVisible(h: MeshHandle, visible: boolean): void {
    const root = this.meshes.get(h);
    if (root) setNodeVisible(root, visible);
  }
  setModelAlpha(id: string, alpha: number): void {
    const root = this.instantiatedModelRoots.get(id);
    if (!root) return;
    const m = root.material as Partial<BLNS.StandardMaterialProps & BLNS.PbrMaterialProps> | undefined;
    if (m) m.alpha = alpha;
  }
  disposeModel(id: string, h: MeshHandle): void {
    const root = this.instantiatedModelRoots.get(id);
    if (root) BL.setMeshVisible(root, false);
    this.instantiatedModelRoots.delete(id);
    this.meshesByMeshId.delete(id);
    for (const key of [...this.animationGroups.keys()]) {
      if (key.startsWith(`${id}/`)) this.animationGroups.delete(key);
    }
    this.meshes.delete(h);
  }

  /**
   * One clip on one mesh, for a plugin that drives playback the interface's
   * play/stop pair cannot express (SkeletonAnimator's play-once). Lite's twin
   * of BabylonAdapter.getAnimationGroup; scoped to the mesh, so two entities
   * loaded from one GLB never share a clip.
   */
  getAnimationGroup(meshId: string, clipName: string): BLNS.AnimationGroup | null {
    return this.animationGroups.get(`${meshId}/${clipName}`) ?? null;
  }

  playAnimation(meshId: string, clipName: string, loop = true): void {
    const g = this.animationGroups.get(`${meshId}/${clipName}`);
    if (!g) return;
    // Lite's AnimationGroup exposes no play() method (groups are advanced by the
    // scene AnimationManager once registered via addToScene); we drive the
    // documented mixing fields instead. Idempotent: skip if already playing.
    g.loopAnimation = loop;
    if (!g.isPlaying) {
      g.isPlaying = true;
      (g as unknown as { currentFrame: number }).currentFrame = 0;
    }
  }
  stopAnimation(meshId: string, clipName: string): void {
    const g = this.animationGroups.get(`${meshId}/${clipName}`);
    if (g) g.isPlaying = false;
  }
  setAnimationWeight(meshId: string, clipName: string, weight: number): void {
    const g = this.animationGroups.get(`${meshId}/${clipName}`);
    if (g) g.weight = weight;
  }
  setAnimationSpeed(meshId: string, clipName: string, speed: number): void {
    const g = this.animationGroups.get(`${meshId}/${clipName}`);
    if (g) g.speedRatio = speed;
  }

  // Lite's glTF loader carries no skeletons, so every mesh honestly reports
  // "no bones" — the same answer the full adapters give for an unrigged prop.

  // ─── Labels ───
  // Text is drawn on a 2-D canvas (as ThreeAdapter does), uploaded with
  // createTexture2DFromPixels, and shown as ONE camera-facing billboard
  // sprite in a billboard system of its own — Lite has no text sprite. A
  // world-fixed label (`billboard: false`) is an unlit textured plane instead.
  // Lite cannot take a billboard system out of a scene, so a disposed label's
  // slot (system + texture) is kept and handed to the next label.
  createLabel(id: string, spec: LabelSpec): LabelHandle {
    const handle = this.makeHandle<LabelHandle>('label', id);
    const engine = this.engine;
    const scene = this.scene;
    if (!engine || !scene || typeof document === 'undefined') return handle;
    const canvas = document.createElement('canvas');
    canvas.width = LABEL_TEX_W;
    canvas.height = LABEL_TEX_H;
    const fontSize = spec.fontSize ?? 64;
    const fontWeight = spec.fontWeight ?? 'bold';
    const pixels = drawLabelPixels(canvas, spec.text, fontSize, fontWeight, spec.background, spec.borderColor, spec.billboard === false);
    if (!pixels) return handle;
    const scale = spec.scale ?? 1;
    const size: [number, number] = [scale * (LABEL_TEX_W / LABEL_TEX_H), scale];
    const color: [number, number, number, number] = spec.color ? [spec.color[0], spec.color[1], spec.color[2], 1] : [1, 1, 1, 1];
    let slot: LiteLabel['slot'];
    let plane: LiteMesh | undefined;
    if (spec.billboard === false) {
      const texture = BL.createTexture2DFromPixels(engine, pixels, LABEL_TEX_W, LABEL_TEX_H, { minFilter: 'linear', magFilter: 'linear', srgb: true });
      plane = BL.createPlane(engine, { width: size[0], height: size[1] });
      plane.name = `Label_${id}`;
      const labelMat = BL.createPbrMaterial({ baseColorTexture: texture, baseColorFactor: color, doubleSided: true, alphaBlend: true });
      BL.setPbrUnlit(labelMat);
      plane.material = labelMat;
      plane.pickable = false;
      if (spec.rotation) this.applyEulerQuat(plane, spec.rotation[0], spec.rotation[1], spec.rotation[2]);
      BL.addToScene(scene, plane);
      slot = { texture, system: null };
    } else {
      const reused = this.freeLabelSlots.pop();
      if (reused) {
        BL.updateTexture2DFromPixels(engine, reused.texture, pixels);
        slot = reused;
      } else {
        const texture = BL.createTexture2DFromPixels(engine, pixels, LABEL_TEX_W, LABEL_TEX_H, { minFilter: 'linear', magFilter: 'linear', srgb: true });
        const atlas = BL.createGridSpriteAtlas(texture, { cellWidthPx: LABEL_TEX_W, cellHeightPx: LABEL_TEX_H });
        // Drawn after the scene's meshes so a label is not occluded in-plane.
        const system = BL.createFacingBillboardSystem(atlas, { capacity: 1, blendMode: BL.billboardBlendAlpha, order: 999 });
        BL.addFacingBillboardSystem(scene, system);
        slot = { texture, system };
      }
      BL.clearBillboardSprites(slot.system!);
      BL.addBillboardSpriteIndex(slot.system!, { position: [0, 0, 0], sizeWorld: size, color });
      slot.system!.visible = true;
    }
    this.labelRecords.set(handle, {
      slot, plane, canvas, fontSize, fontWeight, background: spec.background, borderColor: spec.borderColor,
      size, color, position: [0, 0, 0], visible: true, alpha: 1,
    });
    return handle;
  }
  private labelRecords = new Map<LabelHandle, LiteLabel>();
  private freeLabelSlots: { texture: BLNS.Texture2D; system: BLNS.FacingBillboardSpriteSystem }[] = [];
  /** Rewrite a billboard label's one sprite from its record. */
  private syncLabel(rec: LiteLabel): void {
    const sys = rec.slot.system;
    if (sys) {
      BL.updateBillboardSpriteIndex(sys, 0, {
        position: [rec.position[0], rec.position[1], -rec.position[2]],
        sizeWorld: [rec.size[0] * (rec.scale ?? 1), rec.size[1] * (rec.scale ?? 1)],
        color: [rec.color[0], rec.color[1], rec.color[2], rec.color[3] * rec.alpha],
      });
      sys.visible = rec.visible;
    } else if (rec.plane) {
      rec.plane.position.set(rec.position[0], rec.position[1], -rec.position[2]);
      const s = rec.scale ?? 1;
      rec.plane.scaling.set(s, s, s);
      BL.setMeshVisible(rec.plane, rec.visible);
      const m = rec.plane.material as Partial<BLNS.PbrMaterialProps>;
      m.baseColorFactor = [rec.color[0], rec.color[1], rec.color[2], rec.color[3] * rec.alpha];
      BL.markMaterialUboDirty(rec.plane.material);
    }
  }
  setLabelText(h: LabelHandle, text: string): void {
    const rec = this.labelRecords.get(h);
    if (!rec || !this.engine) return;
    const px = drawLabelPixels(rec.canvas, text, rec.fontSize, rec.fontWeight, rec.background, rec.borderColor, !rec.slot.system);
    if (px) BL.updateTexture2DFromPixels(this.engine, rec.slot.texture, px);
  }
  setLabelPosition(h: LabelHandle, x: number, y: number, z: number): void {
    const rec = this.labelRecords.get(h);
    if (!rec) return;
    rec.position = [x, y, z];
    this.syncLabel(rec);
  }
  setLabelColor(h: LabelHandle, r: number, g: number, b: number): void {
    const rec = this.labelRecords.get(h);
    if (!rec) return;
    rec.color = [r, g, b, rec.color[3]];
    this.syncLabel(rec);
  }
  setLabelAlpha(h: LabelHandle, alpha: number): void {
    const rec = this.labelRecords.get(h);
    if (!rec) return;
    rec.alpha = alpha;
    this.syncLabel(rec);
  }
  setLabelVisible(h: LabelHandle, visible: boolean): void {
    const rec = this.labelRecords.get(h);
    if (!rec) return;
    rec.visible = visible;
    this.syncLabel(rec);
  }
  /**
   * Uniform scale on a label, multiplying the size it was created at — the
   * plugin-host twin of BabylonAdapter.getLabelPlane / ThreeAdapter.getLabelObject
   * for FloatingDamageNumbers' pop. Class-only. False on an unknown handle.
   */
  setLabelScale(h: LabelHandle, scale: number): boolean {
    const rec = this.labelRecords.get(h);
    if (!rec) return false;
    rec.scale = scale;
    this.syncLabel(rec);
    return true;
  }
  disposeLabel(h: LabelHandle): void {
    const rec = this.labelRecords.get(h);
    if (!rec) return;
    this.labelRecords.delete(h);
    if (rec.slot.system) {
      BL.clearBillboardSprites(rec.slot.system);
      rec.slot.system.visible = false;
      this.freeLabelSlots.push(rec.slot as { texture: BLNS.Texture2D; system: BLNS.FacingBillboardSpriteSystem });
    } else if (rec.plane) {
      if (this.scene) BL.removeFromScene(this.scene, rec.plane);
      BL.disposeMeshGpu(rec.plane);
    }
  }

  // ─── Geometry / billboard ───
  setMeshBillboardMode(h: MeshHandle, mode: BillboardMode): void {
    // Per-mesh camera-facing billboard isn't modeled for arbitrary meshes in
    // this Lite preview (Lite has dedicated billboard *sprite* systems, not a
    // mesh flag). Documented no-op; HealthBar bars fall back to fixed orientation.
    void h;
    void mode;
  }

  // ─── Havok physics ───
  // Babylon Lite drives rigid bodies through Havok, created via
  // `createHavokWorld(scene, hknp, gravity)`. The world steps automatically
  // inside `renderFrame` (there is no manual step function — `physicsStep` is a
  // no-op, exactly like BabylonAdapter where Havok advances during scene render).
  // Havok is a WASM module loaded lazily on first body; creates queue until ready.
  //
  // PhysicsShapeType / PhysicsMotionType are Lite `const enum`s (no runtime value
  // through a namespace import), so the numeric members are used directly:
  //   ShapeType  SPHERE=0 CAPSULE=1 BOX=3
  //   MotionType STATIC=0 ANIMATED(kinematic)=1 DYNAMIC=2

  private ensureHavok(): Promise<void> {
    if (this.havokReady) return Promise.resolve();
    if (this.havokInitPromise) return this.havokInitPromise;
    const scene = this.scene;
    if (!scene) {
      return Promise.reject(new Error('BabylonLiteAdapter.physicsCreateBody: call init() first'));
    }
    this.havokInitPromise = import('@babylonjs/havok')
      .then((mod) => (mod.default ?? (mod as unknown as () => Promise<unknown>))())
      .then((hk) => {
        this.havokWorld = BL.createHavokWorld(scene, hk, { ...this.gravity });
        this.havokReady = true;
        const pending = this.pendingPhysicsCreates;
        this.pendingPhysicsCreates = [];
        for (const p of pending) this.physicsCreateBody(p.meshId, p.opts);
      })
      .catch((err: unknown) => {
        console.error('[BabylonLiteAdapter] Havok init failed:', err);
      });
    return this.havokInitPromise;
  }

  physicsCreateBody(meshId: string, opts: PhysicsBodyOpts): boolean {
    const mesh = this.meshesByMeshId.get(meshId);
    if (!mesh) return false;
    if (!this.havokReady || !this.havokWorld) {
      if (!this.pendingPhysicsCreates.some((p) => p.meshId === meshId)) {
        this.pendingPhysicsCreates.push({ meshId, opts });
      }
      void this.ensureHavok();
      return true;
    }
    if (this.aggregates.has(meshId)) return true;
    // PhysicsShapeType: SPHERE 0, CAPSULE 1, BOX 3, MESH 6. A mesh collider is
    // static/animated only, so a dynamic body asking for one gets the box.
    const shapeType = (
      opts.shapeType === 'sphere' ? 0
        : opts.shapeType === 'capsule' ? 1
          : opts.shapeType === 'mesh' && opts.motionType !== 'dynamic' ? 6
            : 3
    ) as unknown as BLNS.PhysicsShapeType;
    // Shape geometry is auto-sized from the mesh bounding box. mass 0 → static.
    const agg = BL.createPhysicsAggregate(this.havokWorld, mesh, shapeType, {
      mass: opts.motionType === 'static' ? 0 : opts.mass,
      friction: opts.friction,
      restitution: opts.restitution,
    });
    if (opts.motionType === 'kinematic') {
      BL.setPhysicsBodyMotionType(this.havokWorld, agg.body, 1 as unknown as BLNS.PhysicsMotionType);
    } else if (opts.motionType === 'dynamic') {
      // Body-authoritative: stop reading the (static) mesh transform each step so
      // it actually falls; the after-step sync writes the body pose back to the mesh.
      BL.setPhysicsBodyPreStep(agg.body, false);
    }
    this.aggregates.set(meshId, agg);
    this.bodyMeshIds.set(agg.body, meshId);
    return true;
  }

  physicsDestroyBody(meshId: string): void {
    // Lite exposes no per-body removal; drop our handle (the body is reclaimed
    // when the world is disposed). Acceptable for entity churn in a single scene.
    const agg = this.aggregates.get(meshId);
    if (agg) this.bodyMeshIds.delete(agg.body);
    this.aggregates.delete(meshId);
  }

  physicsSetBodyVelocity(meshId: string, vx: number, vy: number, vz: number): void {
    const agg = this.aggregates.get(meshId);
    // RH→LH: a velocity is an ordinary vector, so only Z flips.
    if (agg && this.havokWorld) BL.setPhysicsBodyLinearVelocity(this.havokWorld, agg.body, { x: vx, y: vy, z: flipZ(vz) });
  }

  physicsSetGravity(x: number, y: number, z: number): void {
    // Kept as well as applied, so a call made while the WASM is still loading
    // becomes the gravity the world is created with (see BabylonAdapter).
    this.gravity = { x, y, z: flipZ(z) }; // RH→LH, like every other vector
    if (this.havokWorld) BL.setPhysicsGravity(this.havokWorld, { ...this.gravity });
  }

  physicsStep(dt: number): void {
    // No-op: Havok advances inside renderFrame (same as BabylonAdapter). Exposed
    // so Systems can call it uniformly across adapters.
    void dt;
  }

  physicsSetPaused(paused: boolean): void {
    if (!this.havokWorld) return;
    if (paused) {
      if (this.savedTimestep === null) {
        this.savedTimestep = BL.getPhysicsTimestep(this.havokWorld);
        BL.setPhysicsTimestep(this.havokWorld, 0);
      }
    } else if (this.savedTimestep !== null) {
      BL.setPhysicsTimestep(this.havokWorld, this.savedTimestep);
      this.savedTimestep = null;
    }
  }

  physicsGetBodyState(meshId: string): PhysicsBodySnapshot | null {
    const agg = this.aggregates.get(meshId);
    const mesh = this.meshesByMeshId.get(meshId);
    if (!agg || !mesh || !this.havokWorld) return null;
    // The body drives the mesh, so the mesh transform IS the body pose. All of
    // it is read in Lite's left-handed frame and handed back canonical (LH→RH):
    // position and linear velocity negate Z; the orientation un-conjugates the
    // diag(1,1,−1) mirror (negate quaternion X and Y) before going to Euler.
    // Lite only exposes a linear-velocity getter; angular reads back as zero.
    const lv = BL.getPhysicsBodyLinearVelocity(this.havokWorld, agg.body);
    const q = mesh.rotationQuaternion;
    return {
      position: [mesh.position.x, mesh.position.y - this.pivotOffsetOf(mesh), flipZ(mesh.position.z)],
      rotation: quatToEulerYXZ(-q.x, -q.y, q.z, q.w),
      linearVelocity: [lv.x, lv.y, flipZ(lv.z)],
      angularVelocity: [0, 0, 0],
    };
  }

  physicsSetBodyState(meshId: string, state: PhysicsBodySnapshot): void {
    const agg = this.aggregates.get(meshId);
    const mesh = this.meshesByMeshId.get(meshId);
    if (!agg || !mesh || !this.havokWorld) return;
    // Drive the mesh to the pose, read back its quaternion, and push both into
    // the body so the restore is exact and visible immediately. The snapshot is
    // canonical (right-handed); into Lite it goes through the same mirror as
    // setMeshPosition / setMeshRotation. Angular velocity is a PSEUDOVECTOR: a
    // reflection flips it AND reverses its sense, so under z → −z it maps to
    // (−x, −y, z), the same rule as a quaternion's vector part.
    const px = state.position[0];
    const py = state.position[1] + this.pivotOffsetOf(mesh);
    const pz = flipZ(state.position[2]);
    mesh.position.set(px, py, pz);
    this.applyEulerQuat(mesh, state.rotation[0], state.rotation[1], state.rotation[2]);
    const q = mesh.rotationQuaternion;
    BL.setPhysicsBodyTransform(this.havokWorld, agg.body, { x: px, y: py, z: pz }, { x: q.x, y: q.y, z: q.z, w: q.w });
    BL.setPhysicsBodyLinearVelocity(this.havokWorld, agg.body, {
      x: state.linearVelocity[0], y: state.linearVelocity[1], z: flipZ(state.linearVelocity[2]),
    });
    const [ax, ay, az] = state.angularVelocity;
    BL.setPhysicsBodyAngularVelocity(this.havokWorld, agg.body, { x: flipZ(ax), y: flipZ(ay), z: az });
  }

  physicsSetTimeStep(hz: number): void {
    if (hz > 0 && this.havokWorld) BL.setPhysicsTimestep(this.havokWorld, 1 / hz);
  }

  physicsSetRestitution(meshId: string, restitution: number): void {
    // Lite exposes no per-body restitution setter post-creation. Documented gap.
    void meshId; void restitution;
  }

  setCollidersVisible(visible: boolean): void {
    if (!this.havokWorld || !this.scene) return;
    if (visible) {
      if (!this.physicsViewer) this.physicsViewer = BL.createPhysicsViewer(this.scene, this.havokWorld);
    } else if (this.physicsViewer) {
      BL.disposePhysicsViewer(this.physicsViewer);
      this.physicsViewer = null;
    }
  }

  // ─── Phase-3: procedural seeded geometry ───

  /** Per-vertex normals from face cross-products (Lite's createMeshFromData wants explicit normals). */
  private computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
    const normals = new Float32Array(positions.length);
    for (let f = 0; f < indices.length; f += 3) {
      const ia = indices[f] * 3, ib = indices[f + 1] * 3, ic = indices[f + 2] * 3;
      const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
      const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
      const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
      normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
      normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
    }
    for (let i = 0; i < normals.length; i += 3) {
      const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
    }
    return normals;
  }

  /**
   * Build a named ship / projectile / gate silhouette. Lite's preview build has
   * no welded-primitive-group builder, so these are best-effort primitive
   * approximations sized to {@link ProceduralMeshSpec.size} (`[width, height,
   * length]`) — enough to display and address like any mesh. The full bespoke
   * hull geometry (Spaceplane/Kilrathi/Freighter) is deferred with the GLB path.
   */
  private buildNamedShape(engine: BLNS.EngineContext, id: string, spec: ProceduralMeshSpec): LiteMesh {
    const [w, h, l] = spec.size;
    switch (spec.shape) {
      case 'missile':
        return BL.createCylinder(engine, { height: l || 4, diameter: w || 0.5, tessellation: 12 });
      case 'waypoint':
        return BL.createTorus(engine, {
          diameter: (w || 10) * 2,
          thickness: Math.max(1, (w || 10) * 0.08),
          tessellation: 48,
        });
      default: {
        // spaceplane / kilrathi / freighter-head / freighter-car → a hull-sized box.
        const mesh = BL.createBox(engine, 1);
        mesh.scaling.set(w || 1, h || 1, l || 1);
        return mesh;
      }
    }
  }

  /** Material for a procedural mesh: explicit MaterialSpec, else color/emissive from the spec. */
  private applyProceduralMaterial(mesh: LiteMesh, spec: ProceduralMeshSpec, mat?: MaterialSpec): void {
    if (mat) {
      this.applyMaterialSpec(mesh, { kind: 'box' } as PrimitiveSpec, mat);
      return;
    }
    const color = spec.color ?? [0.5, 0.5, 0.5];
    const emissive = spec.emissive ?? 0;
    const unlit = spec.shape === 'waypoint';
    if (unlit || emissive > 0) {
      const glow = BL.createPbrMaterial({
        baseColorFactor: [color[0], color[1], color[2], 1],
        metallicFactor: 0,
        roughnessFactor: 1,
      });
      if (unlit) BL.setPbrUnlit(glow);
      if (emissive > 0) BL.setPbrEmissive(glow, [color[0] * emissive, color[1] * emissive, color[2] * emissive]);
      mesh.material = glow;
    } else {
      const std = BL.createStandardMaterial();
      std.diffuseColor = [color[0], color[1], color[2]];
      mesh.material = std;
    }
  }

  // ─── Phase-3: runtime dynamic textures (CPU pixel buffer → GPU texture) ───
  // Real on Lite: the WebGPU raw-texture path via createTexture2DFromPixels /
  // updateTexture2DFromPixels (the rawTexture extension Lite registers itself).
  createDynamicTexture(key: string, spec: DynamicTextureSpec): TextureHandle {
    const engine = this.requireEngine();
    const cached = this.dynamicTextures.get(key);
    if (cached) return cached;
    const data = spec.pixels instanceof Uint8Array ? spec.pixels : new Uint8Array(spec.pixels);
    // String-literal union rather than naming `GPUAddressMode` (the @webgpu/types
    // global isn't installed in this package); it's accepted by the option type.
    const addr: 'clamp-to-edge' | 'mirror-repeat' | 'repeat' =
      spec.wrap === 'clamp' ? 'clamp-to-edge' : spec.wrap === 'mirror' ? 'mirror-repeat' : 'repeat';
    const tex = BL.createTexture2DFromPixels(engine, data, spec.width, spec.height, {
      srgb: spec.srgb ?? false,
      addressModeU: addr,
      addressModeV: addr,
      minFilter: 'linear',
      magFilter: 'linear',
    });
    const handle = this.makeHandle<TextureHandle>('dynTex', key);
    this.dynamicTextures.set(key, handle);
    this.dynamicTextureObjects.set(handle, tex);
    return handle;
  }

  // ─── Phase-3: particle systems ───
  // Babylon Lite 1.8.0 ships no ParticleSystem. A continuous emitter is
  // simulated here on the CPU — Babylon's sphere emitter, in the canonical
  // frame — and drawn through Lite's camera-facing billboard sprites, one
  // draw per (blend, texture) for every emitter that shares it. Bursts
  // (createParticleBurst) are still a no-op here; SpaceShooterFX draws its own.
  createParticleEmitter(id: string, spec: ParticleEmitterSpec): ParticleEmitterHandle {
    const handle = this.makeHandle<ParticleEmitterHandle>('emitter', id);
    const cap = Math.max(1, Math.floor(spec.capacity));
    const e: LiteEmitter = {
      position: spec.position ? [...spec.position] as Vec3 : [0, 0, 0],
      followCamera: spec.followCamera ?? false,
      spec,
      layerKey: `${spec.blend ?? 'add'}|${String((spec.texture as unknown as { __handle?: string })?.__handle ?? 'dot')}`,
      texture: spec.texture,
      cap,
      pos: new Float32Array(cap * 3),
      vel: new Float32Array(cap * 3),
      age: new Float32Array(cap),
      life: new Float32Array(cap),
      size: new Float32Array(cap),
      tint: new Float32Array(cap * 4),
      next: 0,
      owed: 0,
    };
    this.particleEmitters.set(handle, e);
    // Pre-warm, so a field is already populated on its first frame.
    const warm = Math.min(600, Math.max(0, spec.preWarmCycles ?? 0));
    for (let k = 0; k < warm; k++) this.stepEmitter(e, 1 / 60);
    return handle;
  }
  disposeParticleEmitter(h: ParticleEmitterHandle): void {
    this.particleEmitters.delete(h);
  }
  /**
   * The canonical seat of an emitter, for a plugin that moves it (SmokeScreen):
   * `position` is the emitter's own array, so writing it moves the emitter.
   * The Lite twin of BabylonAdapter.getParticleEmitterSeat.
   */
  getParticleEmitterSeat(h: ParticleEmitterHandle): { position: Vec3; followsCamera: boolean } | undefined {
    const e = this.particleEmitters.get(h);
    return e ? { position: e.position, followsCamera: e.followCamera } : undefined;
  }

  /** Advance one emitter: age and move the live particles, then spawn what the rate owes. */
  private stepEmitter(e: LiteEmitter, dt: number): void {
    const s = e.spec;
    const g = s.gravity;
    for (let i = 0; i < e.cap; i++) {
      if (e.life[i]! <= 0) continue;
      e.age[i] = e.age[i]! + dt;
      if (e.age[i]! >= e.life[i]!) {
        e.life[i] = 0;
        continue;
      }
      const p = i * 3;
      if (g) {
        e.vel[p] = e.vel[p]! + g[0] * dt;
        e.vel[p + 1] = e.vel[p + 1]! + g[1] * dt;
        e.vel[p + 2] = e.vel[p + 2]! + g[2] * dt;
      }
      e.pos[p] = e.pos[p]! + e.vel[p]! * dt;
      e.pos[p + 1] = e.pos[p + 1]! + e.vel[p + 1]! * dt;
      e.pos[p + 2] = e.pos[p + 2]! + e.vel[p + 2]! * dt;
    }
    e.owed += Math.max(0, s.emitRate) * dt;
    let spawn = Math.min(Math.floor(e.owed), e.cap);
    e.owed -= Math.floor(e.owed);
    const range = Math.min(1, Math.max(0, s.emitRadiusRange ?? 0.2));
    const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
    while (spawn-- > 0) {
      const i = e.next;
      e.next = (e.next + 1) % e.cap;
      // A uniform direction; the start point on (or, with range, inside) the sphere.
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const dx = r * Math.cos(t), dy = u, dz = r * Math.sin(t);
      const rad = s.emitRadius * (1 - range * Math.random());
      const p = i * 3;
      e.pos[p] = e.position[0] + dx * rad;
      e.pos[p + 1] = e.position[1] + dy * rad;
      e.pos[p + 2] = e.position[2] + dz * rad;
      const power = rnd(s.minEmitPower, s.maxEmitPower);
      e.vel[p] = dx * power;
      e.vel[p + 1] = dy * power;
      e.vel[p + 2] = dz * power;
      e.age[i] = 0;
      e.life[i] = Math.max(1e-3, rnd(s.minLifeTime, s.maxLifeTime));
      e.size[i] = rnd(s.minSize, s.maxSize);
      const k = Math.random();
      for (let c = 0; c < 4; c++) e.tint[i * 4 + c] = s.color1[c]! + (s.color2[c]! - s.color1[c]!) * k;
    }
  }

  /** The frame's particle work: re-seat camera-followers, step, and rewrite every layer's sprites. */
  private stepParticles(dt: number): void {
    const scene = this.scene;
    const engine = this.engine;
    if (!scene || !engine || this.particleEmitters.size === 0) {
      for (const layer of this.particleLayers.values()) {
        if (layer.visible) {
          BL.clearBillboardSprites(layer);
          layer.visible = false;
        }
      }
      return;
    }
    const cam = scene.camera as { worldMatrix?: ArrayLike<number> } | null;
    for (const layer of this.particleLayers.values()) BL.clearBillboardSprites(layer);
    const used = new Set<string>();
    const sprite = { position: [0, 0, 0] as [number, number, number], sizeWorld: [0, 0] as [number, number], color: [0, 0, 0, 0] as [number, number, number, number] };
    for (const e of this.particleEmitters.values()) {
      if (e.followCamera && cam?.worldMatrix) {
        const m = cam.worldMatrix;
        e.position[0] = m[12]!;
        e.position[1] = m[13]!;
        e.position[2] = -m[14]!; // LH → canonical
      }
      this.stepEmitter(e, dt);
      const layer = this.particleLayer(engine, scene, e);
      if (!layer) continue;
      used.add(e.layerKey);
      const dead = e.spec.colorDead;
      for (let i = 0; i < e.cap; i++) {
        if (e.life[i]! <= 0) continue;
        const p = i * 3;
        sprite.position[0] = e.pos[p]!;
        sprite.position[1] = e.pos[p + 1]!;
        sprite.position[2] = -e.pos[p + 2]!; // canonical → LH
        sprite.sizeWorld[0] = e.size[i]!;
        sprite.sizeWorld[1] = e.size[i]!;
        const k = e.age[i]! / e.life[i]!;
        for (let c = 0; c < 4; c++) sprite.color[c] = e.tint[i * 4 + c]! + (dead[c]! - e.tint[i * 4 + c]!) * k;
        if (layer.count >= PARTICLE_LAYER_CAPACITY) break;
        BL.addBillboardSpriteIndex(layer, sprite);
      }
    }
    for (const [key, layer] of this.particleLayers) layer.visible = used.has(key) && layer.count > 0;
  }

  /** The shared billboard system an emitter draws into, built on first use. */
  private particleLayer(engine: BLNS.EngineContext, scene: BLNS.SceneContext, e: LiteEmitter): BLNS.FacingBillboardSpriteSystem | null {
    let layer = this.particleLayers.get(e.layerKey);
    if (layer) return layer;
    const tex = this.dynamicTextureObjects.get(e.texture);
    let atlas: BLNS.SpriteAtlas;
    if (tex) {
      atlas = BL.createGridSpriteAtlas(tex, { cellWidthPx: tex.width, cellHeightPx: tex.height });
    } else {
      // A texture this adapter never loaded (loadTexture is not wired yet): a soft round dot.
      this.particleDot ??= BL.createGridSpriteAtlas(
        BL.createTexture2DFromPixels(engine, softDotPixels(32), 32, 32, { minFilter: 'linear', magFilter: 'linear' }),
        { cellWidthPx: 32, cellHeightPx: 32 },
      );
      atlas = this.particleDot;
    }
    const blend = e.spec.blend ?? 'add';
    layer = BL.createFacingBillboardSystem(atlas, {
      capacity: PARTICLE_LAYER_CAPACITY,
      blendMode: blend === 'add' ? BL.billboardBlendAdditive : BL.billboardBlendAlpha,
    });
    BL.addFacingBillboardSystem(scene, layer);
    this.particleLayers.set(e.layerKey, layer);
    return layer;
  }

  // ─── Phase-3: glow / bloom / emissive / render ordering ───
  // Lite 1.8 has no glow layer, so liteGlowLayer.ts builds Babylon's
  // include-only one from frame-graph tasks: enrolled meshes draw their
  // emissive, other opaque meshes black, the buffer is blurred and added. A
  // handle stands for its whole subtree (a model root included). The
  // whitelist starts empty and is cleared on disable, as on Babylon.
  // setMeshEmissiveById / setMeshRenderingOptions act on the material / mesh
  // fields Lite exposes.
  setGlowLayer(spec: GlowSpec | null): void {
    this.glowSpec = spec;
    if (!spec) this.glowMeshes.clear();
    const layer = this.ensureGlowLayer();
    if (!layer) return;
    layer.setSettings(spec ? { intensity: spec.intensity, textureRatio: spec.textureRatio, blurKernelSize: spec.blurKernelSize } : null);
    // Enrolment made before the layer existed, or kept across a settings change.
    if (spec) for (const h of this.glowMeshes) this.includeGlowHandle(h);
  }
  addGlowMesh(h: MeshHandle): void {
    if (!this.glowSpec) return;
    this.glowMeshes.add(h);
    this.includeGlowHandle(h);
  }
  removeGlowMesh(h: MeshHandle): void {
    this.glowMeshes.delete(h);
    const node = this.meshes.get(h);
    if (node) this.glowLayer?.exclude(node);
  }
  /**
   * Host accessor for adapter plugins — the Lite twin of Babylon's
   * `glow.addIncludedOnlyMesh(mesh)`, plus `referenceMeshToUseItsOwnMaterial`
   * when `ownMaterial` is true. Enrols a node the plugin built (and its
   * subtree). False when no glow layer is up: a plugin retries each frame, as
   * on Babylon, since the GlowLayer component may arrive after its mesh.
   */
  addGlowNode(node: object, ownMaterial = false): boolean {
    if (!this.glowSpec || !this.glowLayer) return false;
    this.glowLayer.include(node, ownMaterial);
    return true;
  }
  /** Take a plugin's node out of the glow layer. */
  removeGlowNode(node: object): void {
    this.glowLayer?.exclude(node);
  }
  private includeGlowHandle(h: MeshHandle): void {
    const node = this.meshes.get(h);
    if (node) this.glowLayer?.include(node);
  }
  private ensureGlowLayer(): LiteGlowLayer | null {
    if (this.glowLayer) return this.glowLayer;
    if (!this.scene || !this.engine) return null;
    this.glowLayer = new LiteGlowLayer(BL as unknown as LiteGlowModule, this.engine, this.scene as unknown as LiteGlowScene);
    return this.glowLayer;
  }
  setMeshEmissiveById(meshId: string, r: number, g: number, b: number, intensity: number): void {
    const mesh = this.meshesByMeshId.get(meshId);
    if (!mesh) return;
    const m = mesh.material as (BLNS.PbrMaterialProps & { diffuseColor?: unknown; emissiveColor?: [number, number, number] }) | undefined;
    if (!m) return;
    // StandardMaterial still owns a plain emissiveColor; PBR keeps emissive and
    // unlit in opt-in extensions (Lite 1.34+), read and written through BL.
    const isStandard = m.diffuseColor !== undefined;
    // Unlit materials (waypoint gates, sun disc) output albedo directly, so a
    // multiplied emissive blows them to white under bloom/tonemap — clamp it.
    // Lit materials want emissive to overpower lighting → keep the 2.5× boost.
    const unlit = !isStandard && BL.getPbrUnlit(m) !== undefined;
    const e = unlit ? Math.min(1, intensity) : intensity * 2.5;
    if (isStandard) m.emissiveColor = [r * e, g * e, b * e];
    else BL.setPbrEmissive(m, [r * e, g * e, b * e]);
  }

  // ─── Phase-3: camera-following sun + directional-light query ───

  /** World-space position (LH frame) of the active camera, for the camera-locked sun. */
  private activeCameraPositionLH(): Vec3 {
    if (this.activePerspective) {
      const p = this.activePerspective.camera.position;
      return [p.x, p.y, p.z];
    }
    const cam = this.scene?.camera;
    if (cam) {
      const p = BL.getCameraPosition(cam);
      return [p.x, p.y, p.z];
    }
    return [0, 0, 0];
  }

  // Lite owns its own swap-chain sizing and exposes no scaling hook, so this is
  // recorded and reported rather than applied — a caller reading it back gets
  // the truth instead of a number that did nothing.
  private renderScale = 1;

  setRenderScale(scale: number): void {
    this.renderScale = Math.min(1, Math.max(0.25, scale));
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  /**
   * Rolling frame-time split in ms. Lite drives its own loop through
   * `startEngine`, so this adapter sees the ECS callback and the interval
   * between callbacks — but never the draw. `render` is therefore not measured
   * and Lite's own submission cost lands in `outside` along with everything
   * else; `renderMeasured: false` is what says so.
   */
  private frameMs = 0;
  private tickMs = 0;
  private timedFrames = 0;

  profileFrame(_on: boolean): void {
    // @babylonjs/lite exposes no instrumentation classes — nothing to attach.
  }

  listRenderPasses(): RenderPassInfo[] {
    // Lite runs its own frame graph and exposes no pass list to reach into.
    // Empty reads correctly as "nothing switchable here".
    return [];
  }

  setRenderPassEnabled(_id: string, _enabled: boolean): void {}

  getFrameTimings(): FrameTimings {
    return {
      frame: this.frameMs,
      tick: this.tickMs,
      render: 0,
      outside: Math.max(0, this.frameMs - this.tickMs),
      gpu: 0,
      activeMeshEval: 0,
      renderTargets: 0,
      particles: 0,
      renderMeasured: false,
      gpuMeasured: false,
      breakdownMeasured: false,
    };
  }

  getRenderStats(): RenderStats {
    // Lite's scene graph is opaque from here — it exposes no counters, so this
    // reports the one number it can stand behind rather than inventing the rest.
    return { ...{ meshes: 0, activeMeshes: 0, drawCalls: 0, faces: 0, materials: 0, textures: 0, particleSystems: 0, renderTargets: 0, frames: 0 }, meshes: this.meshes.size };
  }

  // ─── Loop / resize / dispose ───
  // ─── Spatial audio — silent stubs ───
  // @babylonjs/lite is a WebGPU render preview with no audio subsystem (the
  // AudioEngineV2 lives in @babylonjs/core, which Lite deliberately does not
  // pull in). The surface is kept so a scene authored against the full adapter
  // loads and runs here — silently: initAudio reports "no engine", createSound
  // still hands back a handle so callers needn't special-case Lite, and the
  // playback calls accept that handle and do nothing.
  initAudio(): Promise<boolean> {
    return Promise.resolve(false);
  }
  attachAudioListener(_camera: CameraHandle): void {}
  createSound(id: string, _spec: SoundSpec): Promise<SoundHandle | null> {
    const handle = this.makeHandle<SoundHandle>('sound', id);
    this.sounds.add(handle);
    return Promise.resolve(handle);
  }
  playSound(_handle: SoundHandle): void {}
  stopSound(_handle: SoundHandle): void {}
  setSoundVolume(_handle: SoundHandle, _volume: number): void {}
  attachSoundToMesh(_handle: SoundHandle, _mesh: MeshHandle): void {}
  disposeSound(handle: SoundHandle): void {
    this.sounds.delete(handle);
  }

  startLoop(onFrame: (dtSeconds: number) => void): void {
    const engine = this.requireEngine();
    const scene = this.requireScene();
    this.onFrame = onFrame;

    // Per-frame ECS callback via Lite's hook. CRUCIAL: the loop is driven by
    // startEngine, which executes the scene's frame graph — including the shadow
    // task installed by registerSceneWithShadowSupport. A manual renderFrame loop
    // renders the main pass but does NOT schedule shadows, which is why a
    // hand-rolled rAF + renderFrame produced an unshadowed scene.
    if (!this.onBeforeRenderHooked) {
      this.onBeforeRenderHooked = true;
      // Derive dt from wall-clock (like the Babylon/Three adapters) instead of
      // trusting Lite's supplied per-frame delta, so animation speed matches the
      // other panes regardless of Lite's frame pacing. Clamp big stalls.
      let last = performance.now();
      BL.onBeforeRender(scene, () => {
        this.inFrame = true;
        try {
          this.widenPbrGroupForLateMeshes(scene);
          this.buildLateMaterialGroups(scene);
          if (this.pendingCasters.size) this.flushCasters();
          const now = performance.now();
          const interval = now - last;
          const dt = Math.min(0.1, interval / 1000);
          last = now;
          if (this.timedFrames > 0) this.frameMs = this.frameMs * 0.9 + interval * 0.1;
          this.timedFrames++;
          this.onFrame?.(dt);
          this.stepParticles(dt);
          this.dropSwappedRenderables(scene);
          this.glowLayer?.sync();
          this.tickMs = this.tickMs * 0.9 + (performance.now() - now) * 0.1;
        } finally {
          this.inFrame = false;
        }
      });
    }

    if (this.sceneRegistered) {
      void BL.startEngine(engine);
      return;
    }
    this.sceneRegistered = true;
    // A scene renders only after registration (builds GPU pipelines + frame
    // graph). Shadow scenes need the shadow-aware variant. registerScene is
    // async; start the engine once it resolves.
    const register = this.shadowGenerators.size > 0
      ? BL.registerSceneWithShadowSupport(scene)
      : BL.registerScene(scene);
    register.then(() => {
      for (const [light, gen] of this.shadowGenerators) {
        const casters = this.shadowCasterMeshes.get(light);
        if (casters && casters.length) this.handOverCasters(light, gen, casters);
      }
      void BL.startEngine(engine);
    }).catch((err: unknown) => {
      console.error('[BabylonLiteAdapter] registerScene failed:', err);
      this.sceneRegistered = false;
    });
  }
  /**
   * Draw meshes whose material FAMILY first appeared after registerScene.
   *
   * Lite (1.8.0) builds one render group per material family (Standard, PBR,
   * each ShaderMaterial…) and only inside `registerScene`. A mesh added later
   * whose family already has a group is drawn, through its single-mesh
   * rebuild; a mesh whose family is NEW queues the group's builder on
   * `_deferredBuilders`, which nothing runs again — so it is silently never
   * drawn. That is every plugin that brings a material of its own once the
   * scene is up (NebulaSky's unlit PBR faces, every WGSL ShaderMaterial), every
   * GLB that lands after registration, and every adapter mesh in a scene that
   * had no Standard mesh when it registered.
   *
   * There is no public call for it, so this does from the frame hook what
   * `registerScene` does with that queue. Internal fields, so each is checked;
   * a Lite that renames them leaves this a no-op.
   */
  private buildLateMaterialGroups(scene: BLNS.SceneContext): void {
    const s = scene as unknown as LiteSceneInternals;
    if (!s._built || !Array.isArray(s._deferredBuilders) || s._deferredBuilders.length === 0) return;
    if (this.lateBuilding) return;
    this.lateBuilding = true;
    // Exactly what registerScene does with the same queue: run the builders
    // (each adds its group's renderables and updater and marks it built),
    // sort by order, bump the version, and re-record the frame graph so every
    // task sees the new renderables.
    const builders = s._deferredBuilders.splice(0);
    void Promise.all(builders.map((b) => b())).then(
      () => {
        this.lateBuilding = false;
        if (this.scene !== scene) return; // disposed meanwhile
        s._renderables.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        s._renderableVersion++;
        s._frameGraph?.build();
      },
      (err: unknown) => {
        this.lateBuilding = false;
        console.error('[BabylonLiteAdapter] building a late material group failed', err);
      },
    );
  }
  private lateBuilding = false;

  /**
   * Let a thin-instanced mesh that arrives after the PBR group was built be drawn.
   *
   * Lite (1.37) builds the PBR group once and decides THEN whether to load the
   * thin-instance code, by looking at the meshes it has. A mesh added later goes
   * through that build's single-mesh rebuild, which has no thin-instance code:
   * its first frame throws `syncThinInstanceForDraw is not a function` and the
   * whole frame is lost — a black canvas. ProceduralCity's buildings and
   * TownCrowd's citizens are all thin-instanced and all arrive late.
   *
   * Lite already has the way out: before it rebuilds a queued mesh it asks the
   * group's widening test (`group._w`), and a mesh that needs more than the
   * build loaded is sent down the first-build path, which rebuilds the whole
   * PBR group with the right code. Its test only knows about texture caps, so
   * this wraps it to also say yes for a thin-instanced mesh when the group's
   * build has no thin-instance code. Re-wrapped each frame, since every group
   * build replaces it. Internal fields, each checked; a Lite without them
   * leaves this a no-op.
   */
  private widenPbrGroupForLateMeshes(scene: BLNS.SceneContext): void {
    const s = scene as unknown as LiteSceneInternals;
    const groups = s._groups;
    if (!(groups instanceof Map)) return;
    for (const [builder, group] of groups) {
      if ((builder as { _materialFamily?: string })._materialFamily !== 'pbr') continue;
      const g = group as unknown as LiteWidenableGroup;
      const current = g._w;
      if (current && (current as LiteWidening)[WIDENED]) return;
      const wrapped: LiteWidening = Object.assign(
        (mesh: unknown): unknown => current?.(mesh) || lacksThinInstanceCode(s, mesh),
        { _c: current?._c, [WIDENED]: true as const },
      );
      g._w = wrapped;
      return;
    }
  }

  /**
   * Take a queued mesh's OLD renderable out of the scene before Lite rebuilds it.
   *
   * Lite (1.8.0) answers a material change, and a mesh added after the scene
   * registered, through its material-swap queue, which it drains right after
   * the onBeforeRender callbacks. The drain builds the mesh a new renderable and
   * destroys the old one's uniform buffers once the GPU is done with them — but
   * unlike `rebuildMaterial` it never removes the old renderable from
   * `_renderables`. The scene pass keeps updating it, writes land in a
   * destroyed buffer, and every frame's command buffer is rejected: a black
   * canvas and a flood of "used in submit while destroyed" warnings. A pooled
   * entity that is built once and then re-shown is enough to do it.
   *
   * Runs as the last thing in our onBeforeRender hook, so it sees every swap the
   * ECS tick queued. Does exactly what `rebuildMaterial` does before its rebuild;
   * internal fields, each checked, so a Lite that renames them leaves it a no-op.
   */
  private dropSwappedRenderables(scene: BLNS.SceneContext): void {
    const s = scene as unknown as LiteSceneInternals;
    const q = s._materialSwapQueue;
    if (!Array.isArray(q) || !Array.isArray(s._renderables)) return;
    // Swaps held back last frame while a late group was building.
    if (this.heldSwaps.size > 0) {
      for (const m of this.heldSwaps) if (!q.includes(m)) q.push(m);
      this.heldSwaps.clear();
    }
    if (q.length === 0) return;
    this.rekeyShadowCasters(q);
    this.adoptNewFamilySwaps(s, q);
    // Only meshes Lite WILL rebuild (it skips one whose material has no
    // single-mesh builder), so nothing loses its only renderable.
    const queued = new Set(
      q.filter((m) => typeof (m as { material?: { _buildGroup?: { _rebuildSingle?: unknown } } }).material?._buildGroup?._rebuildSingle === 'function'),
    );
    if (queued.size === 0) return;
    for (let i = s._renderables.length - 1; i >= 0; i--) {
      const m = s._renderables[i]!.mesh;
      if (m !== undefined && queued.has(m)) s._renderables.splice(i, 1);
    }
  }
  /**
   * A shadow caster whose material is about to change: hand its generator a
   * NEW caster array, so Lite rebuilds the shadow pass's drawings for it.
   *
   * Lite keys a generator's shadow-pass state on the caster ARRAY's identity
   * and builds each caster's depth drawing once, from the material it had
   * then. A swap destroys that drawing's uniform buffers (they are the ones
   * registered for the mesh) and nothing tells the shadow pass, so every frame
   * after drew on destroyed buffers and was rejected — the billiard table went
   * black the moment its balls were dressed. Same list, new array: the state
   * is rebuilt on the next shadow pass, after the swap has run.
   */
  private rekeyShadowCasters(queued: readonly unknown[]): void {
    for (const [light, list] of this.shadowCasterMeshes) {
      if (!list.some((m) => queued.includes(m))) continue;
      const copy = list.slice();
      this.shadowCasterMeshes.set(light, copy);
      const gen = this.shadowGenerators.get(light);
      if (gen) this.handOverCasters(light, gen, copy);
    }
  }

  /** Swaps waiting for a late group build to finish (see adoptNewFamilySwaps). */
  private heldSwaps = new Set<unknown>();

  /**
   * A mesh that SWAPS to a material family this scene has never built.
   *
   * Lite's swap drain rebuilds a mesh through its family's `_rebuildSingle`,
   * which exists only once that family's group has been built in a scene — so
   * a plugin that turns a Standard mesh into a PBR one (Plunger's chrome ball,
   * in a scene with no other PBR mesh) is silently dropped: the old drawing is
   * thrown away and nothing replaces it. (After a round reset it is worse: the
   * builder still carries the previous scene's `_rebuildSingle`.)
   *
   * The answer is what `addToScene` does for a mesh of a new family: put it in
   * that family's group and queue the group's builder, which
   * {@link buildLateMaterialGroups} runs on the next frame. Its old drawing goes
   * now, its old GPU buffers once the GPU is done with them, as Lite's own swap
   * would. Internal fields, each checked; a Lite without them leaves this a
   * no-op.
   */
  private adoptNewFamilySwaps(s: LiteSceneInternals, q: unknown[]): void {
    const groups = s._groups;
    const built = s._builtGroups;
    if (!(groups instanceof Map) || !(built instanceof Set) || !Array.isArray(s._deferredBuilders)) return;
    let changed = false;
    for (let i = q.length - 1; i >= 0; i--) {
      const mesh = q[i];
      const build = (mesh as { material?: { _buildGroup?: LiteGroupBuilder } }).material?._buildGroup;
      if (typeof build !== 'function' || built.has(build)) continue;
      q.splice(i, 1);
      let group = groups.get(build);
      if (group && this.lateBuilding) {
        // Its builder may be walking the group right now; try next frame.
        this.heldSwaps.add(mesh);
        continue;
      }
      if (!group) {
        const g: unknown[] = [];
        group = g;
        groups.set(build, g);
        s._deferredBuilders.push(async () => {
          const result = await build(s, g);
          s._renderables.push(...result.renderables);
          if (result.updater) s._uniformUpdaters?.push(result.updater);
          built.add(build);
        });
      }
      if (!group.includes(mesh)) group.push(mesh);
      for (let j = s._renderables.length - 1; j >= 0; j--) {
        if (s._renderables[j]!.mesh === mesh) s._renderables.splice(j, 1);
      }
      const old = s._meshDisposables?.get(mesh);
      if (old) {
        s._meshDisposables!.delete(mesh);
        const done = s.surface?.engine?._device?.queue?.onSubmittedWorkDone?.();
        void (done ?? Promise.resolve()).then(() => {
          try {
            for (const fn of old) fn();
          } catch {
            // Already gone with its scene.
          }
        });
      }
      changed = true;
    }
    if (changed) s._renderableVersion++;
  }

  stopLoop(): void {
    if (this.engine) {
      BL.stopEngine(this.engine);
      // Stopped from inside a frame (a round reset tears the game down from
      // the ECS tick): Lite's frame callback reschedules itself with
      // `requestAnimationFrame(engine._renderFn)` AFTER the frame, and
      // stopEngine has just nulled that — a TypeError on every reset. A no-op
      // in its place is scheduled once and does nothing.
      if (this.inFrame) (this.engine as unknown as { _renderFn: unknown })._renderFn = () => {};
    }
    this.onFrame = undefined;
  }
  /** True while our onBeforeRender hook runs (see stopLoop). */
  private inFrame = false;
  resize(): void {
    // Babylon Lite has no resize entry point in this preview build; the
    // swapchain follows the canvas backing store automatically. No-op.
  }
  dispose(): void {
    this.stopLoop();
    for (const entry of this.cameras.values()) entry.detach?.();
    // Tear down physics before the scene/engine it references.
    if (this.physicsViewer) { BL.disposePhysicsViewer(this.physicsViewer); this.physicsViewer = null; }
    if (this.havokWorld) BL.disposePhysics(this.havokWorld);
    this.havokWorld = null;
    this.havokReady = false;
    this.havokInitPromise = null;
    this.gravity = { x: 0, y: -30, z: 0 };
    this.savedTimestep = null;
    this.aggregates.clear();
    this.bodyMeshIds.clear();
    this.pendingPhysicsCreates = [];
    if (this.scene) BL.disposeScene(this.scene);
    // The engine stays with its canvas for the next adapter (see init); one
    // whose canvas is gone is released.
    if (this.engine && (!this.canvas || LITE_ENGINES.get(this.canvas) !== this.engine)) BL.disposeEngine(this.engine);
    this.scene = undefined;
    this.engine = undefined;
    this.canvas = null;
    this.meshes.clear();
    this.meshesByMeshId.clear();
    this.lights.clear();
    this.sounds.clear();
    this.cameras.clear();
    this.perspectiveCameras.clear();
    this.activePerspective = undefined;
    this.largeWorldEnabled = false;
    this.shadowGenerators.clear();
    this.shadowCasters.clear();
    this.shadowCasterMeshes.clear();
    this.pluginShadowCasters.clear();
    this.pendingCasters.clear();
    this.sceneRegistered = false;
    this.onBeforeRenderHooked = false;
    this.animationGroups.clear();
    this.modelTemplates.clear();
    this.instantiatedModelRoots.clear();
    this.texturesByKey.clear();
    this.cards.clear();
    this.boxExtents.clear();
    this.pivotOffsets.clear();
    // Phase-3 visual state.
    this.dynamicTextures.clear();
    this.dynamicTextureObjects.clear();
    this.particleEmitters.clear();
    this.particleLayers.clear();
    this.particleDot = null;
    this.labelRecords.clear();
    this.freeLabelSlots = [];
    this.glowMeshes.clear();
    this.glowSpec = null;
    this.glowLayer?.dispose();
    this.glowLayer = null;
  }
}
