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
  MeshGeometry,
  MeshHandle,
  MeshLoadResult,
  MeshLoadSpec,
  ModelInstantiateSpec,
  PbrMaterialSpec,
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
  ThinFieldHandle,
  ThinFieldSpec,
  TextureHandle,
  TextureLoadOpts,
  CardMeshSpec,
  LargeWorldSpec,
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
  BloomSpec,
  MeshRenderOptions,
  SunSpec,
  SpotLightSpec,
  FogSpec,
  SoundSpec,
  SoundHandle,
} from './types';

/** Babylon Lite mesh-like node (Mesh extends SceneNode; both carry transforms). */
type LiteMesh = BLNS.Mesh;
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

/** Deterministic [0,1) hash of three integers — mirrors MockRendererAdapter.mockHash3. */
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
  private originOffset: Vec3 = [0, 0, 0];
  /** Large-world enable flag recorded by {@link configureLargeWorld} (Phase-1: no active rebase). */
  private largeWorldEnabled = false;
  private shadowGenerators = new Map<LightHandle, BLNS.ShadowGenerator>();
  private shadowCasters = new Map<
    ShadowCasterHandle,
    { light: LightHandle; meshes: LiteMesh[] }
  >();
  /** Accumulated caster meshes per light — setShadowTaskCasterMeshes replaces the list. */
  private shadowCasterMeshes = new Map<LightHandle, LiteMesh[]>();
  /** Set once the scene is registered with the engine (required before anything renders). */
  private sceneRegistered = false;

  // ─── Havok physics (lazily WASM-loaded on first body, like BabylonAdapter) ───
  private havokWorld: BLNS.PhysicsWorld | null = null;
  private havokReady = false;
  private havokInitPromise: Promise<void> | null = null;
  private pendingPhysicsCreates: Array<{ meshId: string; opts: PhysicsBodyOpts }> = [];
  private aggregates = new Map<string, BLNS.PhysicsAggregate>();
  private physicsViewer: BLNS.PhysicsViewer | null = null;
  private savedTimestep: number | null = null;
  /** Animation groups keyed by `${meshId}/${clipName}`, registered at load time. */
  private animationGroups = new Map<string, BLNS.AnimationGroup>();
  /** Loaded model templates, deduped by url (see loadModelTemplate). */
  private modelTemplates = new Map<string, LiteTemplate>();
  private instantiatedModelRoots = new Map<string, LiteMesh>();
  /** Thin-instance fields: master mesh + stored normalization scale. */
  private thinFields = new Map<ThinFieldHandle, { mesh: LiteMesh; baseScale: number }>();
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
   * Continuous particle emitters (space dust, trails). Lite's preview build has
   * no ParticleSystem function (only the billboard-sprite / node-block-emitter
   * surface), so — matching this adapter's other documented stubs — the emitter
   * tracks position/follow state and round-trips create→setPosition→dispose
   * without yet streaming GPU particles. See createParticleEmitter.
   */
  private particleEmitters = new Map<ParticleEmitterHandle, { position: Vec3; followCamera: boolean }>();
  /** Selective-glow config + whitelist (empty until addGlowMesh). Null = disabled. */
  private glowSpec: GlowSpec | null = null;
  private glowMeshes = new Set<MeshHandle>();
  /** HDR bloom config recorded for the pipeline. Null = disabled. */
  private bloomSpec: BloomSpec | null = null;
  /**
   * The camera-following sun: its directional light, the emissive disc parked at
   * a fixed offset from the active camera, and a `disposed` flag the per-frame
   * follow observer checks (Lite's onBeforeRender has no unsubscribe handle).
   */
  private sun?: { light: BLNS.DirectionalLight; disc: LiteMesh; offsetLH: Vec3; disposed: boolean };

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
    this.engine = await BL.createEngine(canvas);
    this.scene = BL.createSceneContext(this.engine.surfaces[0]);
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

    // Non-uniform box: Lite only takes a uniform size, so scale to width/height/depth.
    if (prim.kind === 'box') {
      const base = prim.width ?? prim.height ?? prim.depth ?? 1;
      mesh.scaling.set((prim.width ?? base) / base, (prim.height ?? base) / base, (prim.depth ?? base) / base);
    }

    // Base-pivot: Lite primitives are centered on the origin like Babylon, so
    // lift by half-height. The tube primitive is conceptually always
    // base-pivoted but our cylinder fallback is centered, so honor the flag
    // for it too.
    const pivotOffsetY = (prim.pivotAtBottom || prim.kind === 'tube')
      ? (prim.kind === 'sphere' ? (prim.diameter ?? 1) / 2 : (prim.height ?? 1) / 2)
      : 0;
    // Place the base at the current y (0) so an un-moved pivoted mesh sits on origin.
    if (pivotOffsetY) mesh.position.set(mesh.position.x, mesh.position.y + pivotOffsetY, mesh.position.z);

    if (mat) this.applyMaterialSpec(mesh, prim, mat);

    BL.addToScene(scene, mesh);

    const handle = this.makeHandle<MeshHandle>('mesh', id);
    this.meshes.set(handle, mesh);
    this.meshesByMeshId.set(id, mesh);
    if (pivotOffsetY) this.pivotOffsets.set(handle, pivotOffsetY);
    return handle;
  }

  /** Build and assign a Lite material from a renderer-agnostic MaterialSpec. */
  private applyMaterialSpec(mesh: LiteMesh, prim: PrimitiveSpec, mat: MaterialSpec): void {
    const hasTextures =
      !!mat.albedoTexture || !!mat.normalTexture || !!mat.roughnessTexture || !!mat.ambientTexture;
    if (hasTextures) {
      // Textured → PBR path. Texture *loading* (URL → Texture2D) needs Lite's
      // async texture loader, which isn't wired in this provisional adapter, so
      // we set scalar PBR factors only and leave the texture slots null. The
      // base color still tints the surface. Provisional: add texture loads once
      // Lite's loader surface is confirmed.
      const pbr = BL.createPbrMaterial({
        baseColorFactor: mat.diffuse
          ? [mat.diffuse[0], mat.diffuse[1], mat.diffuse[2], mat.alpha ?? 1]
          : [1, 1, 1, mat.alpha ?? 1],
        metallicFactor: mat.metallic ?? 0,
        roughnessFactor: mat.roughness ?? 1,
        emissiveColor: mat.emissive ? [mat.emissive[0], mat.emissive[1], mat.emissive[2]] : undefined,
        alpha: mat.alpha ?? 1,
      });
      mesh.material = pbr;
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

  createDebugBox(id: string, parent: MeshHandle, color: Color): MeshHandle | null {
    const engine = this.requireEngine();
    const scene = this.requireScene();
    const parentMesh = this.meshes.get(parent);
    if (!parentMesh) return null;

    const box = BL.createBox(engine, 1);
    box.name = id;
    box.pickable = false;
    const mat = BL.createStandardMaterial();
    mat.emissiveColor = [color[0], color[1], color[2]];
    mat.diffuseColor = [0, 0, 0];
    box.material = mat;
    // Parent so setMeshPosition/setMeshScale apply in LOCAL space.
    box.parent = parentMesh;
    BL.addToScene(scene, box);

    const handle = this.makeHandle<MeshHandle>('debugBox', id);
    this.meshes.set(handle, box);
    return handle;
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
  setMeshScale(h: MeshHandle, sx: number, sy: number, sz: number): void {
    this.meshes.get(h)?.scaling.set(sx, sy, sz);
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
    if (mesh) mesh.visible = visible;
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
    this.boxExtents.set(h, { min: [...min], max: [...max] });
    mesh.boundMin = [min[0], min[1], min[2]];
    mesh.boundMax = [max[0], max[1], max[2]];
  }
  getMeshBoundingBoxExtents(h: MeshHandle): { min: Vec3; max: Vec3 } | null {
    const override = this.boxExtents.get(h);
    if (override) return { min: [...override.min], max: [...override.max] };
    const mesh = this.meshes.get(h);
    if (!mesh) return null;
    const lo = mesh.boundMin;
    const hi = mesh.boundMax;
    if (!lo || !hi) return null;
    return { min: [lo[0], lo[1], lo[2]], max: [hi[0], hi[1], hi[2]] };
  }
  disposeMesh(h: MeshHandle): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    // Babylon Lite exposes no per-mesh dispose function; hide it and drop our
    // references (and any physics body) so the slot is reclaimable. The GPU
    // geometry is freed when the scene/engine is disposed.
    mesh.visible = false;
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
  async loadThinField(spec: ThinFieldSpec): Promise<ThinFieldHandle | null> {
    const engine = this.requireEngine();
    const scene = this.requireScene();
    let container: BLNS.AssetContainer;
    try {
      container = await BL.loadGltf(engine, spec.src);
    } catch (err) {
      console.error('[BabylonLiteAdapter] loadThinField failed to load', spec.src, err);
      return null;
    }
    // Lite has no geometry-merge utility (unlike Three's BufferGeometryUtils),
    // so we can't fuse the node's sub-meshes into one master here. Use the first
    // mesh entity as the instancing master and normalize its largest bounding
    // dimension to desiredSize. Provisional: a true merge needs a Lite geometry
    // util that isn't in this preview build.
    const master = this.firstMeshEntity(container);
    if (!master) {
      console.warn('[BabylonLiteAdapter] loadThinField: no mesh under', spec.nodeName, 'in', spec.src);
      return null;
    }
    master.name = `thinField_${spec.nodeName}`;
    master.pickable = false;
    let baseScale = 1;
    if (master.boundMin && master.boundMax) {
      const dx = master.boundMax[0] - master.boundMin[0];
      const dy = master.boundMax[1] - master.boundMin[1];
      const dz = master.boundMax[2] - master.boundMin[2];
      const maxDim = Math.max(dx, dy, dz);
      if (maxDim > 1e-5) baseScale = spec.desiredSize / maxDim;
    }
    BL.setThinInstanceCount(master, 0);
    BL.addToScene(scene, master);

    const handle = this.makeHandle<ThinFieldHandle>('thinField', spec.nodeName);
    this.thinFields.set(handle, { mesh: master, baseScale });
    return handle;
  }

  setThinFieldInstances(handle: ThinFieldHandle, packed: Float32Array, count: number): void {
    const field = this.thinFields.get(handle);
    if (!field) return;
    const { mesh, baseScale } = field;
    // 16 floats (one Mat4) per instance. Reuse a scratch buffer sized to the
    // packed count so the per-frame sweep stays allocation-free.
    const needed = count * 16;
    if (!this._tfMatrices || this._tfMatrices.length < needed) {
      this._tfMatrices = new Float32Array(needed);
    }
    const out = this._tfMatrices;
    for (let i = 0; i < count; i++) {
      const o = i * 5;
      const x = packed[o]!;
      const y = packed[o + 1]!;
      const z = packed[o + 2]!;
      const yaw = packed[o + 3]!;
      const s = baseScale * packed[o + 4]!;
      // Quaternion for a yaw about +Y: (0, sin(yaw/2), 0, cos(yaw/2)).
      const half = yaw * 0.5;
      const qy = Math.sin(half);
      const qw = Math.cos(half);
      const m = BL.mat4Compose(x, y, z, 0, qy, 0, qw, s, s, s);
      for (let j = 0; j < 16; j++) out[i * 16 + j] = m[j]!;
    }
    BL.setThinInstances(mesh, out, count);
  }

  disposeThinField(handle: ThinFieldHandle): void {
    const field = this.thinFields.get(handle);
    if (!field) return;
    // No per-mesh dispose in Lite — hide the master and drop the record.
    field.mesh.visible = false;
    this.thinFields.delete(handle);
  }

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
    const inv = BL.mat4Invert(vp);
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
      // replaceMeshGeometry), so the parabolic bow can't be baked into the
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

  setMeshAlbedoColor(h: MeshHandle, r: number, g: number, b: number): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    const m = mesh.material as Partial<BLNS.StandardMaterialProps & BLNS.PbrMaterialProps>;
    if (m.baseColorFactor) m.baseColorFactor = [r, g, b, m.baseColorFactor[3] ?? 1];
    else if (m.diffuseColor) m.diffuseColor = [r, g, b];
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

  getAspectRatio(): number {
    const c = this.canvas;
    if (!c) return 1;
    const w = c.clientWidth || c.width || 0;
    const hgt = c.clientHeight || c.height || 0;
    return hgt > 0 ? w / hgt : 1;
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
      // The ortho X/Y bounds auto-fit the caster AABBs; orthoMinZ/maxZ are the
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
      entry.camera.target.z = z;
    }
  }
  getCameraTarget(h: CameraHandle, out: Vec3): Vec3 {
    const entry = this.cameras.get(h);
    if (entry) {
      out[0] = entry.camera.target.x;
      out[1] = entry.camera.target.y;
      out[2] = entry.camera.target.z;
    } else {
      out[0] = out[1] = out[2] = 0;
    }
    return out;
  }
  getCameraAngles(h: CameraHandle): { alpha: number; beta: number; radius: number } {
    const entry = this.cameras.get(h);
    if (!entry) return { alpha: 0, beta: 0, radius: 0 };
    return { alpha: entry.camera.alpha, beta: entry.camera.beta, radius: entry.camera.radius };
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
    // Forward = unit(target − cameraPosition).
    const pos = BL.getCameraPosition(entry.camera);
    const t = entry.camera.target;
    const dx = t.x - pos.x;
    const dy = t.y - pos.y;
    const dz = t.z - pos.z;
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

  getMeshWorldBounds(meshId: string, outMin: Vec3, outMax: Vec3): boolean {
    const entry = this.meshesByMeshId?.get(meshId);
    if (!entry) return false;
    const b = (entry as { boundMin?: number[]; boundMax?: number[] });
    if (!b.boundMin || !b.boundMax) return false;
    outMin[0] = b.boundMin[0]; outMin[1] = b.boundMin[1]; outMin[2] = b.boundMin[2];
    outMax[0] = b.boundMax[0]; outMax[1] = b.boundMax[1]; outMax[2] = b.boundMax[2];
    return true;
  }

  getCameraRight(h: CameraHandle, out: Vec3): Vec3 {
    // Babylon is left-handed: right = up × forward, with up = (0,1,0).
    this.getCameraForward(h, out);
    const fx = out[0];
    const fy = out[1];
    const fz = out[2];
    // cross((0,1,0), (fx,fy,fz)) = (1·fz − 0·fy, 0·fx − 0·fz, 0·fy − 1·fx) = (fz, 0, -fx)
    out[0] = fz;
    out[1] = 0;
    out[2] = -fx;
    void fy;
    return out;
  }
  nudgeCameraAlpha(h: CameraHandle, delta: number): void {
    const entry = this.cameras.get(h);
    if (entry) entry.camera.alpha += delta;
  }
  nudgeCameraBeta(h: CameraHandle, delta: number): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    let next = entry.camera.beta + delta;
    const lo = entry.camera.lowerBetaLimit;
    const hi = entry.camera.upperBetaLimit;
    if (lo !== undefined) next = Math.max(lo, next);
    if (hi !== undefined) next = Math.min(hi, next);
    entry.camera.beta = next;
  }
  nudgeCameraTarget(h: CameraHandle, dx: number, dy: number, dz: number): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    entry.camera.target.x += dx;
    entry.camera.target.y += dy;
    entry.camera.target.z += dz;
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
  getOriginOffset(out: Vec3): Vec3 {
    // Stored LH; present it RH (un-negate Z) — the inverse of setOriginOffset, so
    // the round-trip is exact and the sign convention matches positions/cameras.
    out[0] = this.originOffset[0];
    out[1] = this.originOffset[1];
    out[2] = -this.originOffset[2];
    return out;
  }

  setOriginOffset(x: number, y: number, z: number): void {
    // Record only (Phase-1 contract-only — no active per-frame rebase). RH→LH:
    // negate Z so the stored offset stays consistent with the rest of the adapter.
    this.originOffset[0] = x;
    this.originOffset[1] = y;
    this.originOffset[2] = -z;
  }

  configureLargeWorld(spec: LargeWorldSpec): void {
    this.largeWorldEnabled = spec.enabled;
    // Optionally widen the active perspective camera's far plane (~200000 for a
    // space sim). Phase-1 records the config and may push the plane out, but
    // performs NO active rebasing.
    if (spec.farPlane !== undefined && this.activePerspective) {
      this.activePerspective.camera.farPlane = spec.farPlane;
    }
  }

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
    if (gen && list.length) BL.setShadowTaskCasterMeshes(gen, list);
    const handle = this.makeHandle<ShadowCasterHandle>('shadow', `${String(light)}+${String(mesh)}`);
    this.shadowCasters.set(handle, { light, meshes: m ? [m] : [] });
    return handle;
  }
  detachShadowCaster(h: ShadowCasterHandle): void {
    const pair = this.shadowCasters.get(h);
    if (!pair) return;
    const gen = this.shadowGenerators.get(pair.light);
    // Re-set with an empty caster list to clear this generator's casters.
    if (gen) BL.setShadowTaskCasterMeshes(gen, []);
    this.shadowCasters.delete(h);
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
    // Fire-and-forget the async HDR load so the sync contract is honored; we
    // don't await it. Errors are logged, not thrown. Provisional: Lite's IBL
    // strength/level wiring (opts.level) is left to the loader defaults.
    const scene = this.scene;
    if (!scene) return;
    void opts;
    void Promise.resolve(BL.loadHdrEnvironment(scene, url)).catch((err) =>
      console.error('[BabylonLiteAdapter] setEnvironmentTexture failed', url, err),
    );
  }
  clearEnvironmentTexture(): void {
    // Lite exposes no "clear environment" call in this preview; no-op.
  }

  applyPbrMaterial(handle: MeshHandle, spec: PbrMaterialSpec): void {
    const mesh = this.meshes.get(handle);
    if (!mesh) return;
    const pbr = BL.createPbrMaterial({
      baseColorFactor: spec.albedoColor
        ? [spec.albedoColor[0], spec.albedoColor[1], spec.albedoColor[2], 1]
        : [1, 1, 1, 1],
      metallicFactor: spec.metallic ?? 1,
      roughnessFactor: spec.roughness ?? 0,
      environmentIntensity: spec.environmentIntensity,
    });
    mesh.material = pbr;
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
      if (spec.scale !== undefined) root.scaling.set(spec.scale, spec.scale, spec.scale);
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

  // ── Extension seam ─────────────────────────────────────────────────────────
  private extensions = new Map<string, object>();
  registerExtension(name: string, impl: object): void {
    this.extensions.set(name, impl);
  }
  extension<T = object>(name: string): T | undefined {
    return this.extensions.get(name) as T | undefined;
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
      if (spec?.position) root.position.set(spec.position[0], spec.position[1], spec.position[2]);
      if (spec?.rotation) root.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
      if (spec?.scale !== undefined) root.scaling.set(spec.scale, spec.scale, spec.scale);
      root.visible = false; // start parked; setModelVisible reveals it
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
    if (root) root.visible = visible;
  }
  setModelAlpha(id: string, alpha: number): void {
    const root = this.instantiatedModelRoots.get(id);
    if (!root) return;
    const m = root.material as Partial<BLNS.StandardMaterialProps & BLNS.PbrMaterialProps> | undefined;
    if (m) m.alpha = alpha;
  }
  disposeModel(id: string, h: MeshHandle): void {
    const root = this.instantiatedModelRoots.get(id);
    if (root) root.visible = false;
    this.instantiatedModelRoots.delete(id);
    this.meshesByMeshId.delete(id);
    for (const key of [...this.animationGroups.keys()]) {
      if (key.startsWith(`${id}/`)) this.animationGroups.delete(key);
    }
    this.meshes.delete(h);
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
  listBones(_meshId: string): string[] {
    return [];
  }
  getBoneWorldPose(
    _meshId: string,
    _boneName: string,
    _outPosition: Vec3,
    _outOrientation: Quaternion,
  ): boolean {
    return false;
  }
  playAnimationOnce(meshId: string, clipName: string): number {
    const g = this.animationGroups.get(`${meshId}/${clipName}`);
    if (!g) return 0;
    g.loopAnimation = false;
    (g as unknown as { currentFrame: number }).currentFrame = 0;
    g.isPlaying = true;
    return g.duration ?? 0;
  }

  // ─── Labels ───
  // Babylon Lite's text/sprite rendering needs a glyph atlas + font pipeline
  // that's too heavy to stand up for this provisional adapter. createLabel
  // returns a tracked handle; the setters are no-ops. Revisit once Lite's
  // text-renderable surface is confirmed.
  createLabel(id: string, spec: LabelSpec): LabelHandle {
    void spec;
    return this.makeHandle<LabelHandle>('label', id);
  }
  setLabelText(h: LabelHandle, text: string): void {
    void h;
    void text;
  }
  setLabelPosition(h: LabelHandle, x: number, y: number, z: number): void {
    void h;
    void x;
    void y;
    void z;
  }
  setLabelColor(h: LabelHandle, r: number, g: number, b: number): void {
    void h;
    void r;
    void g;
    void b;
  }
  setLabelAlpha(h: LabelHandle, alpha: number): void {
    void h;
    void alpha;
  }
  setLabelScale(h: LabelHandle, scale: number): void {
    void h;
    void scale;
  }
  setLabelVisible(h: LabelHandle, visible: boolean): void {
    void h;
    void visible;
  }
  disposeLabel(h: LabelHandle): void {
    void h;
  }

  // ─── Geometry / billboard ───
  replaceMeshGeometry(h: MeshHandle, geom: MeshGeometry): void {
    // Babylon Lite's preview build exposes no in-place vertex-buffer swap on a
    // live Mesh, so geometry replacement (used by FlipperSystem) is a no-op
    // here. Provisional — wire a Lite geometry-update call once one exists.
    void h;
    void geom;
  }
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
        this.havokWorld = BL.createHavokWorld(scene, hk, { x: 0, y: -30, z: 0 });
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

  physicsCreateBody(meshId: string, opts: PhysicsBodyOpts): void {
    const mesh = this.meshesByMeshId.get(meshId);
    if (!mesh) return;
    if (!this.havokReady || !this.havokWorld) {
      this.pendingPhysicsCreates.push({ meshId, opts });
      void this.ensureHavok();
      return;
    }
    if (this.aggregates.has(meshId)) return;
    const shapeType = (opts.shapeType === 'sphere' ? 0 : opts.shapeType === 'capsule' ? 1 : 3) as unknown as BLNS.PhysicsShapeType;
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
  }

  physicsDestroyBody(meshId: string): void {
    // Lite exposes no per-body removal; drop our handle (the body is reclaimed
    // when the world is disposed). Acceptable for entity churn in a single scene.
    this.aggregates.delete(meshId);
  }

  physicsSetBodyVelocity(meshId: string, vx: number, vy: number, vz: number): void {
    const agg = this.aggregates.get(meshId);
    if (agg && this.havokWorld) BL.setPhysicsBodyLinearVelocity(this.havokWorld, agg.body, { x: vx, y: vy, z: vz });
  }

  physicsSetBodyAngularVelocity(meshId: string, vx: number, vy: number, vz: number): void {
    const agg = this.aggregates.get(meshId);
    if (agg && this.havokWorld) BL.setPhysicsBodyAngularVelocity(this.havokWorld, agg.body, { x: vx, y: vy, z: vz });
  }

  physicsSetBodyDrivenByMesh(meshId: string, drivenByMesh: boolean): void {
    // drivenByMesh=true → pre-step reads the mesh transform into the body.
    const agg = this.aggregates.get(meshId);
    if (agg) BL.setPhysicsBodyPreStep(agg.body, drivenByMesh);
  }

  physicsSetGravity(x: number, y: number, z: number): void {
    // Gravity is set at world creation; Lite exposes no runtime gravity setter.
    void x; void y; void z;
  }

  physicsResizeBoxBody(meshId: string, halfExtents: Vec3): void {
    // Reshaping needs createPhysicsShape + setPhysicsBodyShape; not wired (unused
    // by current scenes). Documented gap rather than a silent wrong result.
    void meshId; void halfExtents;
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
    // The body drives the mesh, so the mesh transform IS the body pose. Lite
    // only exposes a linear-velocity getter; angular reads back as zero.
    const lv = BL.getPhysicsBodyLinearVelocity(this.havokWorld, agg.body);
    return {
      position: [mesh.position.x, mesh.position.y, mesh.position.z],
      rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
      linearVelocity: [lv.x, lv.y, lv.z],
      angularVelocity: [0, 0, 0],
    };
  }

  physicsSetBodyState(meshId: string, state: PhysicsBodySnapshot): void {
    const agg = this.aggregates.get(meshId);
    const mesh = this.meshesByMeshId.get(meshId);
    if (!agg || !mesh || !this.havokWorld) return;
    // Drive the mesh to the pose, read back its quaternion, and push both into
    // the body so the restore is exact and visible immediately.
    mesh.position.set(state.position[0], state.position[1], state.position[2]);
    mesh.rotation.x = state.rotation[0];
    mesh.rotation.y = state.rotation[1];
    mesh.rotation.z = state.rotation[2];
    const q = mesh.rotationQuaternion;
    BL.setPhysicsBodyTransform(
      this.havokWorld,
      agg.body,
      { x: state.position[0], y: state.position[1], z: state.position[2] },
      { x: q.x, y: q.y, z: q.z, w: q.w },
    );
    BL.setPhysicsBodyLinearVelocity(this.havokWorld, agg.body, {
      x: state.linearVelocity[0], y: state.linearVelocity[1], z: state.linearVelocity[2],
    });
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
  createProceduralMesh(id: string, spec: ProceduralMeshSpec, mat?: MaterialSpec): MeshHandle {
    const engine = this.requireEngine();
    const scene = this.requireScene();
    const isRock = spec.shape === 'asteroid' || spec.shape === 'oil-blob' || spec.shape === 'asteroid-drop';
    const mesh = isRock
      ? this.buildRockMesh(engine, id, spec)
      : this.buildNamedShape(engine, id, spec);
    mesh.name = id;
    this.applyProceduralMaterial(mesh, spec, mat);
    BL.addToScene(scene, mesh);

    const handle = this.makeHandle<MeshHandle>('procMesh', id);
    this.meshes.set(handle, mesh);
    this.meshesByMeshId.set(id, mesh);
    return handle;
  }

  /**
   * Tessellate a seeded rock: subdivide an icosphere, displace each unit vertex
   * by {@link sampleProceduralSurface} (the SAME deterministic noise the contract
   * asserts), then upload via Lite's `createMeshFromData`. Positions are negated
   * on Z and the winding reversed so the right-handed object surface renders with
   * outward faces in Lite's left-handed frame (the conjugate of the Z-flip the
   * rest of the adapter applies to positions/cameras).
   */
  private buildRockMesh(engine: BLNS.EngineContext, id: string, spec: ProceduralMeshSpec): LiteMesh {
    const sub = spec.subdivisions ?? 8;
    const depth = sub <= 4 ? 1 : sub <= 8 ? 2 : sub <= 16 ? 3 : 4;
    const { dirs, indices } = buildIcosphere(depth);

    const positions = new Float32Array(dirs.length * 3);
    const tmp: Vec3 = [0, 0, 0];
    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i];
      this.sampleProceduralSurface(spec, d[0], d[1], d[2], tmp);
      positions[i * 3] = tmp[0];
      positions[i * 3 + 1] = tmp[1];
      positions[i * 3 + 2] = -tmp[2]; // RH→LH
    }

    // Reverse winding (the Z-flip mirrors handedness, which inverts front faces).
    const tri = new Uint32Array(indices.length);
    for (let f = 0; f < indices.length; f += 3) {
      tri[f] = indices[f];
      tri[f + 1] = indices[f + 2];
      tri[f + 2] = indices[f + 1];
    }

    const normals = this.computeNormals(positions, tri);
    const mesh = BL.createMeshFromData(engine, id, positions, normals, tri);
    // Stamp local bounds so getMeshBoundingBoxExtents / shadow framing have an AABB.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    mesh.boundMin = [minX, minY, minZ];
    mesh.boundMax = [maxX, maxY, maxZ];
    return mesh;
  }

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
      mesh.material = BL.createPbrMaterial({
        unlit,
        baseColorFactor: [color[0], color[1], color[2], 1],
        emissiveColor: emissive > 0 ? [color[0] * emissive, color[1] * emissive, color[2] * emissive] : undefined,
        metallicFactor: 0,
        roughnessFactor: 1,
      });
    } else {
      const std = BL.createStandardMaterial();
      std.diffuseColor = [color[0], color[1], color[2]];
      mesh.material = std;
    }
  }

  sampleProceduralSurface(spec: ProceduralMeshSpec, dirX: number, dirY: number, dirZ: number, out: Vec3): Vec3 {
    const isRock = spec.shape === 'asteroid' || spec.shape === 'oil-blob' || spec.shape === 'asteroid-drop';
    if (!isRock) return out; // ship/missile/waypoint have no radial surface field
    const seed = spec.seed ?? 1;
    const radius = spec.size[0];
    const len = Math.hypot(dirX, dirY, dirZ) || 1;
    const nx = dirX / len, ny = dirY / len, nz = dirZ / len;
    // Deterministic multi-octave displacement keyed by seed + quantized dir, so
    // identical (seed, dir) ⇒ identical radius on every adapter/run.
    let amp = 0.5;
    let freq = 2;
    let disp = 0;
    for (let o = 0; o < 4; o++) {
      const qx = Math.round(nx * freq * 8);
      const qy = Math.round(ny * freq * 8);
      const qz = Math.round(nz * freq * 8);
      disp += (liteHash3(qx + seed, qy + seed * 31, qz + seed * 131) - 0.5) * amp;
      amp *= 0.5;
      freq *= 2;
    }
    let r = radius * (1 + disp * 0.5); // silhouette varies ±~25%
    // Optional cut-axis carve: flatten the cap on the far side of the plane.
    if (spec.cutAxis && spec.cutDepth && spec.cutDepth > 0) {
      const [cx, cy, cz] = spec.cutAxis;
      const cl = Math.hypot(cx, cy, cz) || 1;
      const proj = (nx * cx + ny * cy + nz * cz) / cl;
      const threshold = 1 - spec.cutDepth;
      if (proj > threshold) r = Math.min(r, radius * threshold);
    }
    out[0] = nx * r;
    out[1] = ny * r;
    out[2] = nz * r;
    return out;
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

  updateDynamicTexture(h: TextureHandle, pixels: Uint8ClampedArray | Uint8Array): void {
    const tex = this.dynamicTextureObjects.get(h);
    if (!tex || !this.engine) return;
    const data = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);
    BL.updateTexture2DFromPixels(this.engine, tex, data);
  }

  // ─── Phase-3: particle systems ───
  // Babylon Lite's preview build ships no ParticleSystem/GPUParticleSystem
  // function — its particle surface is the billboard-sprite system
  // (createFacingBillboardSystem / addBillboardSprite) and the node-block
  // emitter (loadNodeBlockEmitterWithGeometry). Standing a full GPU-compute
  // emitter on that is out of scope for this provisional adapter, so — exactly
  // like the line/label/sky stubs — bursts no-op and continuous emitters track
  // handle + position so the create→setPosition→dispose surface is structurally
  // correct. The GPU/CPU auto-select + ParticleBurst/Emitter spec mapping lives
  // in the (core-backed) Babylon adapter; revisit once Lite's emitter lands.
  createParticleBurst(spec: ParticleBurstSpec): void {
    void spec;
  }
  createParticleEmitter(id: string, spec: ParticleEmitterSpec): ParticleEmitterHandle {
    const handle = this.makeHandle<ParticleEmitterHandle>('emitter', id);
    this.particleEmitters.set(handle, {
      position: spec.position ? [...spec.position] as Vec3 : [0, 0, 0],
      followCamera: spec.followCamera ?? false,
    });
    return handle;
  }
  setParticleEmitterPosition(h: ParticleEmitterHandle, x: number, y: number, z: number): void {
    const rec = this.particleEmitters.get(h);
    if (rec) rec.position = [x, y, z];
  }
  disposeParticleEmitter(h: ParticleEmitterHandle): void {
    this.particleEmitters.delete(h);
  }

  // ─── Phase-3: glow / bloom / emissive / render ordering ───
  // Lite's post-process surface is createBloomPostProcessTask wired into the
  // scene frame graph; this provisional adapter doesn't stand up that graph, so
  // glow/bloom record their config + whitelist (mirroring the selective-glow
  // semantics: empty whitelist, cleared on disable) without yet compositing.
  // A handle stands for its whole subtree in that whitelist — a model root
  // included — the same root-level treatment setModelVisible gives it; the
  // engines that composite (Babylon/Three) walk the descendants themselves.
  // setMeshEmissiveById / setMeshRenderingOptions act for real on the material /
  // mesh fields Lite does expose.
  setGlowLayer(spec: GlowSpec | null): void {
    this.glowSpec = spec;
    if (!spec) this.glowMeshes.clear();
  }
  addGlowMesh(h: MeshHandle): void {
    if (this.glowSpec) this.glowMeshes.add(h);
  }
  removeGlowMesh(h: MeshHandle): void {
    this.glowMeshes.delete(h);
  }
  setBloom(spec: BloomSpec | null): void {
    this.bloomSpec = spec;
  }
  setMeshEmissiveById(meshId: string, r: number, g: number, b: number, intensity: number): void {
    const mesh = this.meshesByMeshId.get(meshId);
    if (!mesh) return;
    const m = mesh.material as { emissiveColor?: [number, number, number]; unlit?: boolean } | undefined;
    if (!m) return;
    // Unlit materials (waypoint gates, sun disc) output albedo directly, so a
    // multiplied emissive blows them to white under bloom/tonemap — clamp it.
    // Lit materials want emissive to overpower lighting → keep the 2.5× boost.
    const e = m.unlit === true ? Math.min(1, intensity) : intensity * 2.5;
    m.emissiveColor = [r * e, g * e, b * e];
  }
  setMeshRenderingOptions(h: MeshHandle, opts: MeshRenderOptions): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    // Lite exposes per-mesh pick + render-order; it has no rendering-GROUP
    // buckets, so renderingGroupId maps onto renderOrder (lower = drawn first).
    if (opts.pickable !== undefined) mesh.pickable = opts.pickable;
    if (opts.renderingGroupId !== undefined) mesh.renderOrder = opts.renderingGroupId;
    // disableDepthWrite / infiniteDistance / applyFog aren't modeled per-mesh in
    // this Lite preview (no skybox-locked depth path yet) — documented no-ops.
  }

  // ─── Phase-3: camera-following sun + directional-light query ───
  createSun(id: string, spec: SunSpec): LightHandle {
    const engine = this.requireEngine();
    const scene = this.requireScene();
    // Unit direction the light TRAVELS, RH→LH (negate Z, as elsewhere).
    const d = spec.direction;
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    const dirLH: Vec3 = [d[0] / dl, d[1] / dl, -d[2] / dl];

    const light = BL.createDirectionalLight([dirLH[0], dirLH[1], dirLH[2]], spec.intensity);
    light.diffuse = [spec.diffuse[0], spec.diffuse[1], spec.diffuse[2]];
    light.specular = [spec.specular[0], spec.specular[1], spec.specular[2]];
    BL.addToScene(scene, light);

    const handle = this.makeHandle<LightHandle>('sun', id);
    this.lights.set(handle, light);

    if (spec.shadow?.enabled) {
      // The ortho X/Y bounds auto-fit the casters; depth runs from just in front
      // of the disc out to its distance. Lite's ShadowGenerator is opaque, so the
      // darkness/bias/normalBias/forceBackFacesOnly tuning isn't settable here.
      const gen = BL.createPcfDirectionalShadowGenerator(engine, light, {
        mapSize: spec.shadow.mapSize,
        orthoMinZ: 1,
        orthoMaxZ: spec.distance,
      });
      light.shadowGenerator = gen;
      this.shadowGenerators.set(handle, gen);
    }

    // Emissive disc parked OPPOSITE the light direction so it reads as the star.
    const disc = BL.createSphere(engine, { diameter: spec.discDiameter ?? 90, segments: 16 });
    disc.name = `${id}-disc`;
    disc.pickable = false;
    const dc = spec.discColor ?? [14, 12, 8.5];
    disc.material = BL.createPbrMaterial({
      unlit: true,
      baseColorFactor: [dc[0], dc[1], dc[2], 1],
      emissiveColor: [dc[0], dc[1], dc[2]],
      metallicFactor: 0,
      roughnessFactor: 1,
    });
    BL.addToScene(scene, disc);

    // disc = camera − direction*distance  (all in the LH frame).
    const offsetLH: Vec3 = [-dirLH[0] * spec.distance, -dirLH[1] * spec.distance, -dirLH[2] * spec.distance];
    const rec = { light, disc, offsetLH, disposed: false };
    this.sun = rec;
    const cam0 = this.activeCameraPositionLH();
    disc.position.set(cam0[0] + offsetLH[0], cam0[1] + offsetLH[1], cam0[2] + offsetLH[2]);
    // Re-seat the disc on the active camera each frame; Lite's onBeforeRender has
    // no unsubscribe, so the closure early-returns once the sun is disposed.
    BL.onBeforeRender(scene, () => {
      if (rec.disposed) return;
      const c = this.activeCameraPositionLH();
      rec.disc.position.set(c[0] + rec.offsetLH[0], c[1] + rec.offsetLH[1], c[2] + rec.offsetLH[2]);
    });
    return handle;
  }

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

  getSunWorldPosition(out: Vec3): Vec3 | null {
    if (!this.sun) return null;
    const p = this.sun.disc.position;
    out[0] = p.x;
    out[1] = p.y;
    out[2] = -p.z; // LH→RH (see createArcCamera)
    return out;
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
        const now = performance.now();
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        this.onFrame?.(dt);
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
        if (casters && casters.length) BL.setShadowTaskCasterMeshes(gen, casters);
      }
      void BL.startEngine(engine);
    }).catch((err: unknown) => {
      console.error('[BabylonLiteAdapter] registerScene failed:', err);
      this.sceneRegistered = false;
    });
  }
  stopLoop(): void {
    if (this.engine) BL.stopEngine(this.engine);
    this.onFrame = undefined;
  }
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
    this.savedTimestep = null;
    this.aggregates.clear();
    this.pendingPhysicsCreates = [];
    if (this.scene) BL.disposeScene(this.scene);
    if (this.engine) BL.disposeEngine(this.engine);
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
    this.originOffset = [0, 0, 0];
    this.largeWorldEnabled = false;
    this.shadowGenerators.clear();
    this.shadowCasters.clear();
    this.shadowCasterMeshes.clear();
    this.sceneRegistered = false;
    this.onBeforeRenderHooked = false;
    this.animationGroups.clear();
    this.modelTemplates.clear();
    this.instantiatedModelRoots.clear();
    this.thinFields.clear();
    this.texturesByKey.clear();
    this.cards.clear();
    this.boxExtents.clear();
    this.pivotOffsets.clear();
    // Phase-3 visual state.
    if (this.sun) this.sun.disposed = true;
    this.sun = undefined;
    this.dynamicTextures.clear();
    this.dynamicTextureObjects.clear();
    this.particleEmitters.clear();
    this.glowMeshes.clear();
    this.glowSpec = null;
    this.bloomSpec = null;
  }
}
