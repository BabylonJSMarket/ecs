/**
 * ThreeAdapter — RendererAdapter backed by three.js.
 *
 * Three is loaded at runtime from a CDN (not from node_modules). Types come
 * from @types/three (a dev-only dependency). The HTML that hosts this adapter
 * must declare an `<script type="importmap">` mapping "three" and "three/addons/".
 *
 * Physics: the adapter owns a Rapier.js world (@dimforge/rapier3d-compat) by
 * default — the same role Havok plays in BabylonAdapter. Rapier is a WASM module
 * loaded lazily the first time a body is created (creates queue until it's
 * ready). A caller may instead inject a pure-JS `physicsFactory`
 * (IPhysicsInstance) via the constructor to override Rapier with a custom
 * integrator; when a factory is present the Rapier path is never engaged.
 */

import type * as THREE from 'three';
import type * as RAPIER from '@dimforge/rapier3d-compat';

/** The Rapier module namespace (World ctor, RigidBodyDesc/ColliderDesc statics, init). */
type RapierModule = typeof import('@dimforge/rapier3d-compat');
import type {
  ArcCameraSpec,
  BillboardMode,
  CameraHandle,
  DirectionalLightSpec,
  HemisphericLightSpec,
  IPhysicsInstance,
  LabelHandle,
  LabelSpec,
  LineHandle,
  LightHandle,
  MaterialSpec,
  MeshGeometry,
  MeshHandle,
  MeshLoadResult,
  MeshLoadSpec,
  LoadModelTemplateOptions,
  ModelInstantiateSpec,
  PhysicsBodyOpts,
  PhysicsBodySnapshot,
  PhysicsFactory,
  PickOptions,
  PickResult,
  PrimitiveSpec,
  RendererAdapter,
  RendererInitOptions,
  ShadowCasterHandle,
  SkyboxHandle,
  SkyboxSpec,
  EnvironmentTextureOpts,
  PbrMaterialSpec,
  PointLightSpec,
  MeshSkinSpec,
  ThinFieldHandle,
  ThinFieldSpec,
  TextureHandle,
  TextureLoadOpts,
  CardMeshSpec,
  PerspectiveCameraSpec,
  LargeWorldSpec,
  Quaternion,
  ScreenPoint,
  Vec3,
  // Phase-3 visual capabilities.
  ProceduralMeshSpec,
  DynamicTextureSpec,
  ParticleBurstSpec,
  ParticleEmitterSpec,
  ParticleEmitterHandle,
  GlowSpec,
  BloomSpec,
  MeshRenderOptions,
  SunSpec,
  Color4,
  ModelFitSpec,
} from './types';
import type { Color } from './types';

export interface ThreeAdapterOptions {
  /**
   * Optional pure-JS physics integrator factory. Three.js has no native physics
   * engine, so by default the adapter drives a Rapier.js world. Supply a factory
   * to override Rapier with a custom integrator (the Rapier path stays dormant).
   */
  physicsFactory?: PhysicsFactory;
}

function sphericalToCartesian(alpha: number, beta: number, radius: number, target: Vec3) {
  // Babylon uses: x = target.x + radius * sin(beta) * cos(alpha)
  //               y = target.y + radius * cos(beta)
  //               z = target.z + radius * sin(beta) * sin(alpha)
  const sinBeta = Math.sin(beta);
  return {
    x: target[0] + radius * sinBeta * Math.cos(alpha),
    y: target[1] + radius * Math.cos(beta),
    z: target[2] + radius * sinBeta * Math.sin(alpha),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Phase-3 shared pure math. These are ENGINE-FREE so the displaced
// rock geometry the adapter tessellates and the surface point
// `sampleProceduralSurface` reports come from ONE function — collision/occlusion
// code and the renderer therefore agree on a single silhouette. The hash + octave
// field are byte-identical to MockRendererAdapter's reference so the same seed
// yields the same rock on every engine (Babylon/Three/Mock).
// ─────────────────────────────────────────────────────────────────────────

/** Deterministic [0,1) hash of three integers — the asteroid noise source. */
function rockHash3(a: number, b: number, c: number): number {
  let n = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/** The three seeded-noise rock shapes share one radial displacement field. */
function isRockShape(shape: ProceduralMeshSpec['shape']): boolean {
  return shape === 'asteroid' || shape === 'oil-blob' || shape === 'asteroid-drop';
}

/**
 * Displace a (need-not-be-unit) direction onto the seeded rock surface, writing
 * the object-local point into `out`. Non-rock shapes (ship/missile/waypoint) have
 * no radial field, so `out` is returned untouched. Identical to the Mock
 * reference — same `(seed, dir)` ⇒ same point, on every adapter.
 */
function sampleRockSurface(spec: ProceduralMeshSpec, dirX: number, dirY: number, dirZ: number, out: Vec3): Vec3 {
  if (!isRockShape(spec.shape)) return out;
  const seed = spec.seed ?? 1;
  const radius = spec.size[0];
  const len = Math.hypot(dirX, dirY, dirZ) || 1;
  const nx = dirX / len, ny = dirY / len, nz = dirZ / len;
  // Deterministic multi-octave displacement keyed by seed + quantized direction.
  // Quantizing maps the same vertex direction to the same offset on every run,
  // so coincident icosphere vertices stay welded (no surface cracks).
  let amp = 0.5;
  let freq = 2;
  let disp = 0;
  for (let o = 0; o < 4; o++) {
    const qx = Math.round(nx * freq * 8);
    const qy = Math.round(ny * freq * 8);
    const qz = Math.round(nz * freq * 8);
    disp += (rockHash3(qx + seed, qy + seed * 31, qz + seed * 131) - 0.5) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  let r = radius * (1 + disp * 0.5); // silhouette varies ±~25%
  // Optional cut-axis carve: flatten the cap on the far side of the plane.
  if (spec.cutAxis && spec.cutDepth && spec.cutDepth > 0) {
    const [cx, cy, cz] = spec.cutAxis;
    const cl = Math.hypot(cx, cy, cz) || 1;
    const proj = (nx * cx + ny * cy + nz * cz) / cl; // -1..1 along the cut normal
    const threshold = 1 - spec.cutDepth;
    if (proj > threshold) r = Math.min(r, radius * threshold);
  }
  out[0] = nx * r;
  out[1] = ny * r;
  out[2] = nz * r;
  return out;
}

export class ThreeAdapter implements RendererAdapter {
  readonly kind = 'three' as const;

  THREE?: typeof THREE;
  renderer?: THREE.WebGLRenderer;
  scene?: THREE.Scene;

  private meshes = new Map<MeshHandle, THREE.Mesh>();
  // Debug line systems (ray-cast helpers etc.) — polylines flattened to segments.
  private lines = new Map<LineHandle, THREE.LineSegments>();
  /** Parallel meshId → mesh lookup used by the physics adapter methods. */
  private meshesByMeshId = new Map<string, THREE.Mesh>();
  private lights = new Map<LightHandle, THREE.Light>();
  private cameras = new Map<CameraHandle, { camera: THREE.PerspectiveCamera; controls?: unknown; orientation?: { x: number; y: number; z: number; w: number } }>();
  /**
   * 180° rotation about +Y, lazily built from `this.THREE`. Post-multiplied onto
   * a free perspective camera's quaternion so it renders looking down +Z at
   * identity. Three cameras natively look down their LOCAL −Z; the canonical
   * convention (Mock / Babylon-LH, locked by the contract) is identity → +Z, so
   * the chase camera trails a +Z-facing ship and looks toward it. The flip makes
   * `getWorldDirection` = `q · (+Z)` for any orientation.
   */
  private _perspLookFlip?: THREE.Quaternion;
  private shadowCasters = new Map<ShadowCasterHandle, { light: LightHandle; mesh: MeshHandle }>();
  private labels = new Map<LabelHandle, {
    /** Sprite (billboard) or Mesh (world-fixed sign) — both are Object3D. */
    sprite: THREE.Object3D;
    material: THREE.SpriteMaterial | THREE.MeshBasicMaterial;
    texture: THREE.CanvasTexture;
    canvas: HTMLCanvasElement;
    baseScale: number;
    fontSize: number;
    fontWeight: 'normal' | 'bold';
    aspect: number;
    background?: string; // optional opaque sign plate, persisted across setLabelText
    borderColor?: string; // optional border stroked inside the plate
  }>();
  private shadowMapEnabled = false;
  private onFrame?: (dt: number) => void;
  private lastTime = 0;
  private rafId: number | null = null;
  /**
   * Optional injected pure-JS integrator. When a `physicsFactory` is supplied
   * to the constructor this takes over and Rapier is never engaged (back-compat
   * for callers that want a custom, deterministic integrator). Bodies are lazy.
   */
  private physicsCore: IPhysicsInstance | null = null;
  private physicsFactory?: PhysicsFactory;
  private physicsPaused = false;
  /**
   * Default physics backend: a Rapier.js world owned by the adapter (the role
   * Havok plays in BabylonAdapter). Lazily WASM-loaded the first time a body is
   * created; engaged only when no `physicsFactory` override was supplied.
   */
  private rapier: RapierPhysics | null = null;
  private rapierReady = false;
  private rapierInitPromise: Promise<void> | null = null;
  private pendingRapierCreates: Array<{ meshId: string; opts: PhysicsBodyOpts }> = [];
  /** Custom bounding-box extents declared via setMeshBoundingBoxExtents, used to size box colliders. */
  private boxExtentOverrides = new Map<MeshHandle, { min: Vec3; max: Vec3 }>();
  /** Rapier collider debug wireframe (built on demand by setCollidersVisible). */
  private collidersVisible = false;
  private colliderDebugLines?: THREE.LineSegments;
  /** Meshes with an active billboard mode, oriented toward the active camera each frame. */
  private billboards = new Map<MeshHandle, BillboardMode>();

  constructor(options: ThreeAdapterOptions = {}) {
    this.physicsFactory = options.physicsFactory;
  }

  /** True when Rapier (not an injected factory) is the active physics backend. */
  private get usesRapier(): boolean {
    return !this.physicsFactory;
  }

  /**
   * Per-meshId animation state. Three's AnimationMixer is created on demand
   * the first time a clip is played for a mesh. Primitive meshes (capsules,
   * boxes) have no mixer and every animation call is a no-op on them — same
   * semantics as BabylonAdapter.
   */
  private animationMixers = new Map<string, THREE.AnimationMixer>();
  private animationActions = new Map<string, THREE.AnimationAction>();
  /**
   * Instanced-model templates loaded once per url by `loadModelTemplate`, then
   * cloned per entity by `instantiateModel`. Babylon is the shipping renderer
   * for the pooled-character path; this Three implementation is functional but
   * uses a plain `clone()` (correct for static rigs; skinned characters would
   * want SkeletonUtils — fine until a Three demo needs many skinned clones).
   */
  private modelTemplates = new Map<string, { root: THREE.Object3D; animations: THREE.AnimationClip[] }>();
  private instantiatedModelRoots = new Map<string, THREE.Object3D>();
  /**
   * Thin-instance fields (coin piles, debris) realized as THREE.InstancedMesh.
   * Each holds the instanced mesh and the stored normalization scale applied
   * per instance in setThinFieldInstances.
   */
  private thinFields = new Map<ThinFieldHandle, { mesh: THREE.InstancedMesh; baseScale: number }>();
  /** Loaded textures deduped by the caller's key (see loadTexture). */
  private textures = new Map<TextureHandle, THREE.Texture>();
  private texturesByKey = new Map<string, TextureHandle>();
  /**
   * Card meshes built by createCardMesh: the standard material, its rounded-rect
   * alpha map, and the front/back face textures swapped on the flip.
   */
  private cards = new Map<MeshHandle, {
    material: THREE.MeshStandardMaterial;
    cornerMask: THREE.CanvasTexture;
    front?: THREE.Texture;
    back?: THREE.Texture;
  }>();
  // Reused per instance-matrix compose so a sweep over thousands of slots never
  // allocates. Created lazily once THREE is available.
  private _tfPos?: THREE.Vector3;
  private _tfQuat?: THREE.Quaternion;
  private _tfScale?: THREE.Vector3;
  private _tfMat?: THREE.Matrix4;
  // Reused by screenToWorldPoint.
  private _tfRaycaster?: THREE.Raycaster;
  private _tfNdc?: THREE.Vector2;
  private _tfUpY?: THREE.Vector3;

  // ─── Phase-3 state ───
  /**
   * Dynamic textures (CPU pixel buffer → DataTexture) deduped by the caller's
   * key. The texture object itself lives in the shared `textures` map so the
   * particle systems and `disposeTexture` resolve a handle uniformly, whether it
   * came from `loadTexture` or `createDynamicTexture`.
   */
  private dynamicTexturesByKey = new Map<string, TextureHandle>();
  /**
   * Live particle systems (one-shot bursts + continuous emitters), advanced by
   * the CPU integrator each render tick. Bursts auto-remove once every particle
   * has died; emitters live until `disposeParticleEmitter`.
   */
  private particleRuntimes = new Set<ParticleRuntime>();
  /** Continuous emitters addressable by handle for reposition / dispose. */
  private particleEmitters = new Map<ParticleEmitterHandle, ParticleRuntime>();
  /** Selective-glow config + whitelist, and HDR bloom config (approximated by a shared bloom pass). */
  private glowSpec: GlowSpec | null = null;
  private bloomSpec: BloomSpec | null = null;
  private glowMeshes = new Set<MeshHandle>();
  /**
   * The post-process composer (RenderPass → UnrealBloomPass → OutputPass), built
   * lazily once a real WebGLRenderer + the three/addons postprocessing bundle are
   * available. Stays undefined under the headless contract (the stub renderer is
   * rejected by `ensureComposer`'s capability guard), so glow/bloom are pure
   * config bookkeeping there.
   */
  private composer?: { render(): void; setSize(w: number, h: number): void; dispose?(): void };
  private bloomPass?: { strength: number; threshold: number; radius: number };
  private composerPending = false;
  /** Skybox-style meshes re-seated at the active camera each frame (infiniteDistance). */
  private infiniteDistanceMeshes = new Set<THREE.Object3D>();
  /**
   * Camera-following sun: a DirectionalLight plus an emissive disc parked at a
   * fixed offset from the active camera (so it reads as an infinitely distant
   * star). Null until `createSun`; `getSunWorldPosition` reads the disc's world
   * position.
   */
  private sun?: { light: THREE.DirectionalLight; disc: THREE.Mesh; direction: Vec3; distance: number };
  private _sunVec?: THREE.Vector3;

  async init(canvas: HTMLCanvasElement, opts: RendererInitOptions = {}): Promise<void> {
    // Vite's import-analysis plugin resolves bare literal dynamic imports at
    // dev-time, before honoring /* @vite-ignore */. Using a non-literal
    // specifier bypasses the analyzer entirely; the browser's import map
    // (declared in Examples/index.three.html) handles resolution at runtime.
    const threeSpec = 'three';
    const addonsSpec = 'three/addons/controls/OrbitControls.js';
    const T = await import(/* @vite-ignore */ threeSpec);
    this.THREE = T as unknown as typeof THREE;
    const OrbitMod = (await import(/* @vite-ignore */ addonsSpec)) as unknown as {
      OrbitControls: new (...args: unknown[]) => unknown;
    };
    this.OrbitControlsCtor = OrbitMod.OrbitControls;

    this.renderer = new this.THREE.WebGLRenderer({ canvas, antialias: opts.antialias ?? true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.canvas = canvas;
    this.resize();

    this.scene = new this.THREE.Scene();
    if (opts.clearColor) {
      const [r, g, b, a] = opts.clearColor;
      this.renderer.setClearColor(new this.THREE.Color(r, g, b), a);
    }

    // Fallback camera so scenes without an ArcCamera can still render something.
    // Scene-provided ArcCameras take precedence (the first one registered is
    // used in the render loop). FOV matches Babylon's ArcRotateCamera default.
    this.defaultCamera = new this.THREE.PerspectiveCamera(
      (0.8 * 180) / Math.PI,
      this.canvasAspect(),
      0.1,
      200,
    );
    this.defaultCamera.position.set(10, 8, 12);
    this.defaultCamera.lookAt(0, 1, 0);

    window.addEventListener('resize', () => this.resize());
  }

  private defaultCamera?: THREE.PerspectiveCamera;
  private OrbitControlsCtor?: new (...args: unknown[]) => unknown;
  private canvas?: HTMLCanvasElement;
  private _lastCanvasW = 0;
  private _lastCanvasH = 0;

  /**
   * Aspect ratio from the render canvas (NOT the window). Babylon's engine
   * derives this automatically; Three needs it set explicitly, or a camera in a
   * sub-window pane comes out stretched.
   */
  private canvasAspect(): number {
    const c = this.canvas;
    const w = c?.clientWidth || c?.width || window.innerWidth;
    const h = c?.clientHeight || c?.height || window.innerHeight;
    return h > 0 ? w / h : 1;
  }

  getRenderingCanvas(): HTMLCanvasElement | null {
    return this.renderer?.domElement ?? this.canvas ?? null;
  }

  setClearColor(r: number, g: number, b: number, a = 1): void {
    if (this.renderer && this.THREE) {
      this.renderer.setClearColor(new this.THREE.Color(r, g, b), a);
    }
  }

  createMesh(id: string, prim: PrimitiveSpec, mat?: MaterialSpec): MeshHandle {
    const T = this.requireThree();
    const scene = this.scene!;

    let geometry: THREE.BufferGeometry;

    switch (prim.kind) {
      case 'box':
        geometry = new T.BoxGeometry(prim.width ?? 1, prim.height ?? 1, prim.depth ?? 1);
        break;
      case 'sphere':
        geometry = new T.SphereGeometry(
          (prim.diameter ?? 1) / 2,
          prim.segments ?? 32,
          prim.segments ?? 32,
        );
        break;
      case 'cylinder':
        geometry = new T.CylinderGeometry(
          (prim.diameterTop ?? prim.diameter ?? 1) / 2,
          (prim.diameterBottom ?? prim.diameter ?? 1) / 2,
          prim.height ?? 1,
          prim.tessellation ?? 24,
        );
        break;
      case 'capsule':
        // THREE.CapsuleGeometry: args (radius, length, capSegments, radialSegments)
        geometry = new T.CapsuleGeometry(
          prim.radius ?? 0.5,
          Math.max(0, (prim.height ?? 1) - (prim.radius ?? 0.5) * 2),
          8,
          prim.tessellation ?? 24,
        );
        break;
      case 'plane':
        geometry = new T.PlaneGeometry(prim.width ?? 10, prim.height ?? 10);
        break;
      case 'ground':
        // PlaneGeometry is built on the XY plane; rotate it into XZ and bake
        // the transform so the System's setMeshRotation(0,0,0) doesn't
        // clobber it. Babylon's CreateGround is already horizontal.
        // A ground is a horizontal XZ plane: width→X, depth (or height as a
        // fallback) →Z; depth wins when both are given. The PlaneGeometry's
        // second dimension becomes Z after the rotateX below.
        geometry = new T.PlaneGeometry(
          prim.width ?? 10,
          prim.depth ?? prim.height ?? 10,
          prim.subdivisions ?? 1,
          prim.subdivisions ?? 1,
        );
        geometry.rotateX(-Math.PI / 2);
        break;
      case 'torus':
        geometry = new T.TorusGeometry(
          (prim.diameter ?? 1) / 2,
          (prim.thickness ?? 0.3) / 2,
          16,
          prim.tessellation ?? 24,
        );
        break;
      case 'disc':
        // Match Babylon's disc, which is baked horizontal (XZ plane).
        geometry = new T.CircleGeometry(prim.radius ?? 0.5, prim.tessellation ?? 24);
        geometry.rotateX(-Math.PI / 2);
        break;
      case 'tube': {
        // Open-ended (uncapped) cylinder shell along +Y to match Babylon's
        // CreateTube silo wall. Three's CylinderGeometry is centered on the
        // origin, so we translate up by height/2 to base-pivot it (Babylon's
        // tube grows from y=0 to y=height). `openEnded:true` drops the caps.
        // Single-surface shell — `thickness` (a real inner wall) isn't modeled
        // here; double-side rendering below makes the wall visible from inside.
        const radius = (prim.diameter ?? 1) / 2;
        const tubeHeight = prim.height ?? 1;
        geometry = new T.CylinderGeometry(
          radius,
          radius,
          tubeHeight,
          prim.tessellation ?? 32,
          1,
          true, // openEnded
        );
        geometry.translate(0, tubeHeight / 2, 0);
        break;
      }
      default:
        throw new Error(`ThreeAdapter.createMesh: unknown primitive kind "${prim.kind}"`);
    }

    if (prim.pivotAtBottom && prim.kind !== 'tube') {
      const h = prim.kind === 'sphere' ? (prim.diameter ?? 1) / 2 : (prim.height ?? 1) / 2;
      geometry.translate(0, h, 0);
    }

    // MeshPhongMaterial is the closest analogue to Babylon's classic
    // StandardMaterial (Blinn-Phong + diffuse/specular/emissive). Colors from
    // scene JSON are authored in sRGB (how Babylon's StandardMaterial interprets
    // them), so we mark them as sRGB here — otherwise Three treats them as
    // linear and the final image looks washed out / too bright.
    const toColor = (rgb: [number, number, number]): THREE.Color =>
      new T.Color().setRGB(rgb[0], rgb[1], rgb[2], T.SRGBColorSpace);

    const side = prim.kind === 'tube' ? T.DoubleSide : T.FrontSide;
    const hasTextures =
      !!mat?.albedoTexture || !!mat?.normalTexture || !!mat?.roughnessTexture || !!mat?.ambientTexture;

    let material: THREE.Material;
    if (hasTextures && mat) {
      // Textured PBR path — mirrors the Babylon `PBRMaterial` branch. A
      // MeshStandardMaterial carries map/normalMap/roughnessMap/aoMap, each
      // tiled by uScale/vScale via RepeatWrapping.
      const loader = new T.TextureLoader();
      const uScale = mat.uScale ?? 1;
      const vScale = mat.vScale ?? 1;
      const load = (url: string, srgb: boolean): THREE.Texture => {
        const tex = loader.load(url);
        tex.wrapS = T.RepeatWrapping;
        tex.wrapT = T.RepeatWrapping;
        tex.repeat.set(uScale, vScale);
        if (srgb) tex.colorSpace = T.SRGBColorSpace;
        return tex;
      };
      const std = new T.MeshStandardMaterial({
        color: mat.diffuse ? toColor(mat.diffuse) : new T.Color(1, 1, 1),
        emissive: mat.emissive ? toColor(mat.emissive) : new T.Color(0, 0, 0),
        metalness: mat.metallic ?? 0,
        roughness: mat.roughness ?? 1,
        transparent: (mat.alpha ?? 1) < 1,
        opacity: mat.alpha ?? 1,
        side,
      });
      if (mat.albedoTexture) std.map = load(mat.albedoTexture, true);
      if (mat.normalTexture) std.normalMap = load(mat.normalTexture, false);
      if (mat.roughnessTexture) std.roughnessMap = load(mat.roughnessTexture, false);
      if (mat.ambientTexture) std.aoMap = load(mat.ambientTexture, false);
      material = std;
    } else {
      material = new T.MeshPhongMaterial({
        color: mat?.diffuse ? toColor(mat.diffuse) : new T.Color().setRGB(1, 1, 1, T.SRGBColorSpace),
        specular: mat?.specular
          ? toColor(mat.specular)
          : new T.Color().setRGB(1, 1, 1, T.SRGBColorSpace),
        emissive: mat?.emissive ? toColor(mat.emissive) : new T.Color(0, 0, 0),
        shininess: 64,
        transparent: (mat?.alpha ?? 1) < 1,
        opacity: mat?.alpha ?? 1,
        // The open-ended tube shell has no caps, so its inner face is exposed;
        // render both sides (matches Babylon's Mesh.DOUBLESIDE on the silo).
        side,
      });
    }

    const mesh = new T.Mesh(geometry, material);
    mesh.name = id;
    mesh.castShadow = false;
    mesh.receiveShadow = prim.kind === 'ground' || prim.kind === 'plane';
    scene.add(mesh);

    const handle = this.makeHandle<MeshHandle>('mesh', id);
    this.meshes.set(handle, mesh);
    this.meshesByMeshId.set(id, mesh);
    return handle;
  }

  createDebugBox(id: string, parent: MeshHandle, color: Color): MeshHandle | null {
    const T = this.requireThree();
    const parentMesh = this.meshes.get(parent);
    if (!parentMesh) return null;

    const geometry = new T.BoxGeometry(1, 1, 1);
    const material = new T.MeshBasicMaterial({
      color: new T.Color().setRGB(color[0], color[1], color[2], T.SRGBColorSpace),
      wireframe: true,
    });
    const box = new T.Mesh(geometry, material);
    box.name = id;
    // Non-pickable: drop it out of raycasts (the Three idiom — pickAtScreenPoint
    // raycasts the scene graph).
    box.raycast = () => {};
    // Parent to the target mesh so setMeshPosition/setMeshScale apply in LOCAL space.
    parentMesh.add(box);

    const handle = this.makeHandle<MeshHandle>('debugBox', id);
    this.meshes.set(handle, box);
    return handle;
  }

  setMeshPosition(h: MeshHandle, x: number, y: number, z: number): void {
    const mesh = this.meshes.get(h);
    if (mesh) mesh.position.set(x, y, z);
  }
  setMeshRotation(h: MeshHandle, x: number, y: number, z: number): void {
    const mesh = this.meshes.get(h);
    if (mesh) mesh.rotation.set(x, y, z);
  }
  setMeshColor(h: MeshHandle, r: number, g: number, b: number): void {
    const T = this.THREE;
    const mesh = this.meshes.get(h);
    const mat = mesh?.material as THREE.MeshPhongMaterial | undefined;
    if (mat?.color && T) mat.color.setRGB(r, g, b, T.SRGBColorSpace);
  }
  setMeshVisible(h: MeshHandle, visible: boolean): void {
    const mesh = this.meshes.get(h);
    if (mesh) mesh.visible = visible;
  }
  setMeshScale(h: MeshHandle, sx: number, sy: number, sz: number): void {
    const m = this.meshes.get(h);
    if (m) m.scale.set(sx, sy, sz);
  }
  replaceMeshGeometry(h: MeshHandle, geom: MeshGeometry): void {
    const T = this.THREE;
    const mesh = this.meshes.get(h);
    if (!mesh || !T) return;
    // Build a fresh BufferGeometry from the supplied buffers and hot-swap it,
    // disposing the old one. Mirrors BabylonAdapter.replaceMeshGeometry (used
    // for flipper geometry rewrites).
    const next = new T.BufferGeometry();
    next.setAttribute('position', new T.Float32BufferAttribute(geom.positions, 3));
    next.setIndex(geom.indices);
    if (geom.normals) {
      next.setAttribute('normal', new T.Float32BufferAttribute(geom.normals, 3));
    } else {
      // No normals supplied — compute from positions so lighting works.
      next.computeVertexNormals();
    }
    if (geom.uvs) next.setAttribute('uv', new T.Float32BufferAttribute(geom.uvs, 2));
    next.computeBoundingBox();
    next.computeBoundingSphere();
    mesh.geometry.dispose();
    mesh.geometry = next;
  }
  setMeshBillboardMode(h: MeshHandle, mode: BillboardMode): void {
    // Three has no built-in billboard mode, so the mesh is registered here and
    // oriented toward the active camera each frame in the render loop. 'none'
    // clears the registration (and the mesh keeps its last orientation).
    if (!this.meshes.has(h)) return;
    if (mode === 'none') this.billboards.delete(h);
    else this.billboards.set(h, mode);
  }
  getMeshWorldPosition(h: MeshHandle, out: Vec3): Vec3 {
    const mesh = this.meshes.get(h);
    if (!mesh || !this.THREE) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    if (!this._tmpThreeVec) this._tmpThreeVec = new this.THREE.Vector3();
    mesh.getWorldPosition(this._tmpThreeVec);
    out[0] = this._tmpThreeVec.x;
    out[1] = this._tmpThreeVec.y;
    out[2] = this._tmpThreeVec.z;
    return out;
  }
  setMeshBoundingBoxExtents(h: MeshHandle, min: Vec3, max: Vec3): void {
    const T = this.THREE;
    const mesh = this.meshes.get(h);
    if (!mesh || !T) return;
    // Record the override so a later Rapier box collider fits these extents
    // instead of the raw geometry bounds, and stamp the geometry's boundingBox
    // so getMeshBoundingBoxExtents reflects it immediately.
    this.boxExtentOverrides.set(h, { min: [...min], max: [...max] });
    mesh.geometry.boundingBox = new T.Box3(
      new T.Vector3(min[0], min[1], min[2]),
      new T.Vector3(max[0], max[1], max[2]),
    );
  }
  getMeshBoundingBoxExtents(h: MeshHandle): { min: Vec3; max: Vec3 } | null {
    const mesh = this.meshes.get(h);
    if (!mesh || !this.THREE) return null;
    const geom = mesh.geometry;
    if (!geom.boundingBox) geom.computeBoundingBox();
    const bb = geom.boundingBox;
    if (!bb) return null;
    return {
      min: [bb.min.x, bb.min.y, bb.min.z],
      max: [bb.max.x, bb.max.y, bb.max.z],
    };
  }
  disposeMesh(h: MeshHandle): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    // Drop any associated physics body and id lookup first.
    for (const [id, m] of this.meshesByMeshId) {
      if (m === mesh) {
        this.physicsDestroyBody(id);
        this.meshesByMeshId.delete(id);
      }
    }
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      mat.forEach((m) => m.dispose());
    } else {
      (mat as THREE.Material | undefined)?.dispose();
    }
    this.scene?.remove(mesh);
    this.meshes.delete(h);
    this.billboards.delete(h);
    this.boxExtentOverrides.delete(h);
  }

  createLineSystem(id: string, lines: Vec3[][], color?: Color): LineHandle {
    if (!this.THREE || !this.scene) throw new Error('ThreeAdapter.createLineSystem: call init() first');
    const geom = new this.THREE.BufferGeometry();
    geom.setAttribute('position', new this.THREE.Float32BufferAttribute(flattenSegments(lines), 3));
    const mat = new this.THREE.LineBasicMaterial({
      color: new this.THREE.Color(color?.[0] ?? 1, color?.[1] ?? 1, color?.[2] ?? 1),
    });
    const segments = new this.THREE.LineSegments(geom, mat);
    segments.name = `${id}_lines`;
    this.scene.add(segments);
    const handle = this.makeHandle<LineHandle>('lineSystem', id);
    this.lines.set(handle, segments);
    return handle;
  }

  updateLineSystem(h: LineHandle, lines: Vec3[][], color?: Color): void {
    const segments = this.lines.get(h);
    if (!segments || !this.THREE) return;
    const flat = flattenSegments(lines);
    const attr = segments.geometry.getAttribute('position');
    if (attr && attr.array.length === flat.length) {
      (attr.array as Float32Array).set(flat);
      attr.needsUpdate = true;
    } else {
      segments.geometry.dispose();
      segments.geometry = new this.THREE.BufferGeometry();
      segments.geometry.setAttribute('position', new this.THREE.Float32BufferAttribute(flat, 3));
    }
    if (color) (segments.material as THREE.LineBasicMaterial).color.setRGB(color[0], color[1], color[2]);
  }

  setLineSystemVisible(h: LineHandle, visible: boolean): void {
    const segments = this.lines.get(h);
    if (segments) segments.visible = visible;
  }

  disposeLineSystem(h: LineHandle): void {
    const segments = this.lines.get(h);
    if (!segments) return;
    segments.geometry.dispose();
    (segments.material as THREE.Material).dispose();
    this.scene?.remove(segments);
    this.lines.delete(h);
  }

  // ─── Thin-instance fields ───
  async loadThinField(spec: ThinFieldSpec): Promise<ThinFieldHandle | null> {
    const T = this.requireThree();
    if (!this.scene) throw new Error('ThreeAdapter.loadThinField: call init() first');

    // GLTFLoader + BufferGeometryUtils live in the addons bundle; loaded via
    // non-literal specifiers so Vite's import analyzer leaves them alone (same
    // trick as loadMesh / OrbitControls).
    const loaderSpec = 'three/addons/loaders/GLTFLoader.js';
    const utilSpec = 'three/addons/utils/BufferGeometryUtils.js';
    let gltf: { scene: THREE.Object3D };
    let mergeGeometries: (geoms: THREE.BufferGeometry[], useGroups?: boolean) => THREE.BufferGeometry | null;
    try {
      const loaderMod = (await import(/* @vite-ignore */ loaderSpec)) as unknown as {
        GLTFLoader: new () => { loadAsync(url: string): Promise<{ scene: THREE.Object3D }> };
      };
      const utilMod = (await import(/* @vite-ignore */ utilSpec)) as unknown as {
        mergeGeometries: (geoms: THREE.BufferGeometry[], useGroups?: boolean) => THREE.BufferGeometry | null;
      };
      mergeGeometries = utilMod.mergeGeometries;
      const loader = new loaderMod.GLTFLoader();
      gltf = await loader.loadAsync(spec.src);
    } catch (err) {
      console.error('[ThreeAdapter] loadThinField failed to load', spec.src, err);
      return null;
    }

    // Find the named node, then collect every Mesh geometry under it (baking
    // each mesh's world transform into a clone so the merge is positionally
    // correct regardless of how the GLB split the node).
    const node = gltf.scene.getObjectByName(spec.nodeName);
    if (!node) {
      console.warn('[ThreeAdapter] loadThinField: node', spec.nodeName, 'missing in', spec.src);
      return null;
    }
    node.updateWorldMatrix(true, true);
    const geoms: THREE.BufferGeometry[] = [];
    let material: THREE.Material | undefined;
    node.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const g = m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);
      geoms.push(g);
      if (!material) {
        material = Array.isArray(m.material) ? m.material[0] : m.material;
      }
    });
    if (!geoms.length) return null;

    const merged = geoms.length === 1 ? geoms[0]! : mergeGeometries(geoms, false);
    if (!merged) return null;
    if (geoms.length > 1) for (const g of geoms) g.dispose();

    // Recenter on the merged bounding-box center so instance positions are
    // exact, then normalize the largest dimension to desiredSize via baseScale.
    merged.computeBoundingBox();
    const bb = merged.boundingBox!;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    const cz = (bb.min.z + bb.max.z) / 2;
    merged.translate(-cx, -cy, -cz);
    merged.computeBoundingBox();
    const ext = merged.boundingBox!;
    const maxDim = Math.max(ext.max.x - ext.min.x, ext.max.y - ext.min.y, ext.max.z - ext.min.z);
    const baseScale = maxDim > 1e-5 ? spec.desiredSize / maxDim : 1;

    const mesh = new T.InstancedMesh(merged, material ?? new T.MeshPhongMaterial(), spec.capacity);
    mesh.name = `thinField_${spec.nodeName}`;
    mesh.count = 0; // grows to the drawn count in setThinFieldInstances
    mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    // Field spans the arena; skip per-instance frustum culling so it never pops
    // out when the (origin) bounds leave view.
    mesh.frustumCulled = false;
    (mesh as unknown as { raycast: () => void }).raycast = () => {}; // non-pickable
    this.scene.add(mesh);

    const handle = this.makeHandle<ThinFieldHandle>('thinField', spec.nodeName);
    this.thinFields.set(handle, { mesh, baseScale });
    return handle;
  }

  setThinFieldInstances(handle: ThinFieldHandle, packed: Float32Array, count: number): void {
    const field = this.thinFields.get(handle);
    const T = this.THREE;
    if (!field || !T) return;
    if (!this._tfPos) this._tfPos = new T.Vector3();
    if (!this._tfQuat) this._tfQuat = new T.Quaternion();
    if (!this._tfScale) this._tfScale = new T.Vector3();
    if (!this._tfMat) this._tfMat = new T.Matrix4();
    if (!this._tfUpY) this._tfUpY = new T.Vector3(0, 1, 0);
    const { mesh, baseScale } = field;
    for (let i = 0; i < count; i++) {
      const o = i * 5;
      const s = baseScale * packed[o + 4]!;
      this._tfPos.set(packed[o]!, packed[o + 1]!, packed[o + 2]!);
      // Yaw about +Y.
      this._tfQuat.setFromAxisAngle(this._tfUpY, packed[o + 3]!);
      this._tfScale.set(s, s, s);
      this._tfMat.compose(this._tfPos, this._tfQuat, this._tfScale);
      mesh.setMatrixAt(i, this._tfMat);
    }
    mesh.count = count;
    if (count > 0) mesh.instanceMatrix.needsUpdate = true;
  }

  disposeThinField(handle: ThinFieldHandle): void {
    const field = this.thinFields.get(handle);
    if (!field) return;
    this.scene?.remove(field.mesh);
    field.mesh.geometry.dispose();
    field.mesh.dispose();
    this.thinFields.delete(handle);
  }

  screenToWorldPoint(camera: CameraHandle, nx: number, ny: number, distance: number, out: Vec3): Vec3 {
    const T = this.THREE;
    const entry = this.cameras.get(camera);
    if (!T || !entry) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    if (!this._tfRaycaster) this._tfRaycaster = new T.Raycaster();
    if (!this._tfNdc) this._tfNdc = new T.Vector2();
    // Normalized device coords: x in [-1,1], y in [-1,1] with +Y up. The input
    // fraction has origin top-left, so flip y.
    this._tfNdc.set(nx * 2 - 1, -(ny * 2 - 1));
    this._tfRaycaster.setFromCamera(this._tfNdc, entry.camera);
    const ray = this._tfRaycaster.ray;
    out[0] = ray.origin.x + ray.direction.x * distance;
    out[1] = ray.origin.y + ray.direction.y * distance;
    out[2] = ray.origin.z + ray.direction.z * distance;
    return out;
  }

  // ─── Textures & cards ───
  loadTexture(key: string, url: string, opts?: TextureLoadOpts): TextureHandle {
    const T = this.requireThree();
    const cached = this.texturesByKey.get(key);
    if (cached) return cached;
    const tex = new T.TextureLoader().load(url);
    if (opts?.flipU) {
      // Mirror horizontally: a negative repeat needs a wrap mode that tiles.
      tex.wrapS = T.RepeatWrapping;
      tex.repeat.x = -1;
    }
    if (opts?.rotate) {
      tex.center.set(0.5, 0.5); // rotate about the texture center
      tex.rotation = opts.rotate;
    }
    if (opts?.srgb) tex.colorSpace = T.SRGBColorSpace;
    const handle = this.makeHandle<TextureHandle>('texture', key);
    this.textures.set(handle, tex);
    this.texturesByKey.set(key, handle);
    return handle;
  }

  preloadTexture(url: string): Promise<void> {
    const T = this.THREE;
    if (!T) return Promise.resolve();
    return new Promise<void>((resolve) => {
      new T.TextureLoader().load(
        url,
        () => resolve(),
        undefined,
        () => resolve(), // resolve on error too — the deal shouldn't hang
      );
    });
  }

  createCardMesh(id: string, spec: CardMeshSpec): MeshHandle {
    const T = this.requireThree();
    if (!this.scene) throw new Error('ThreeAdapter.createCardMesh: call init() first');
    const w = spec.width;
    const h = spec.height;
    const subs = spec.subdivisions ?? 16;

    // Plane on the XZ plane (like a Babylon ground), bowed along its width (X).
    const geometry = new T.PlaneGeometry(w, h, subs, subs);
    geometry.rotateX(-Math.PI / 2);
    const bow = spec.bow ?? 0;
    if (bow !== 0) {
      const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i);
        const nx = x / (w * 0.5);
        posAttr.setY(i, bow * (1 - nx * nx));
      }
      posAttr.needsUpdate = true;
      geometry.computeVertexNormals();
    }

    const cornerMask = this.buildCardCornerMask(w, h, spec.cornerRadius);
    const material = new T.MeshStandardMaterial({
      alphaMap: cornerMask,
      transparent: true,
      alphaTest: 0.5,
      roughness: 0.85,
      metalness: 0,
      side: T.DoubleSide,
    });
    const mesh = new T.Mesh(geometry, material);
    mesh.name = id;
    mesh.castShadow = true;
    this.scene.add(mesh);

    const handle = this.makeHandle<MeshHandle>('card', id);
    this.meshes.set(handle, mesh);
    this.meshesByMeshId.set(id, mesh);

    const front = spec.front ? this.textures.get(spec.front) : undefined;
    const back = spec.back ? this.textures.get(spec.back) : undefined;
    this.cards.set(handle, { material, cornerMask, front, back });
    if (front) {
      material.map = front;
      material.needsUpdate = true;
    }
    return handle;
  }

  /** Build a rounded-rect alpha mask on an off-DOM canvas → CanvasTexture. */
  private buildCardCornerMask(w: number, h: number, cornerRadius: number | undefined): THREE.CanvasTexture {
    const T = this.requireThree();
    const tw = 256;
    const th = Math.round((tw * h) / w);
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d')!;
    const r = Math.max(1, Math.round(Math.min(tw, th) * (cornerRadius ?? 0.08)));
    ctx.clearRect(0, 0, tw, th);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(tw - r, 0);
    ctx.quadraticCurveTo(tw, 0, tw, r);
    ctx.lineTo(tw, th - r);
    ctx.quadraticCurveTo(tw, th, tw - r, th);
    ctx.lineTo(r, th);
    ctx.quadraticCurveTo(0, th, 0, th - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    const tex = new T.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  setMeshFaceTexture(h: MeshHandle, side: 'front' | 'back', tex: TextureHandle): void {
    const card = this.cards.get(h);
    const texture = this.textures.get(tex);
    if (!card || !texture) return;
    if (side === 'front') card.front = texture;
    else card.back = texture;
    card.material.map = texture;
    card.material.needsUpdate = true;
  }

  setMeshAlbedoColor(h: MeshHandle, r: number, g: number, b: number): void {
    const T = this.THREE;
    const mesh = this.meshes.get(h);
    const mat = mesh?.material as THREE.MeshStandardMaterial | THREE.MeshPhongMaterial | undefined;
    if (mat?.color && T) mat.color.setRGB(r, g, b, T.SRGBColorSpace);
  }

  disposeTexture(h: TextureHandle): void {
    const tex = this.textures.get(h);
    if (!tex) return;
    tex.dispose();
    this.textures.delete(h);
    for (const [key, handle] of this.texturesByKey) {
      if (handle === h) {
        this.texturesByKey.delete(key);
        break;
      }
    }
  }

  getAspectRatio(): number {
    return this.canvasAspect();
  }

  /**
   * Lazily boot Rapier the first time a body is requested (the role
   * ensureHavok plays in BabylonAdapter). Subsequent callers share the same
   * promise so the WASM module loads once per session; queued creates drain
   * once the world is live.
   */
  private ensureRapier(): Promise<void> {
    if (this.rapierReady) return Promise.resolve();
    if (this.rapierInitPromise) return this.rapierInitPromise;
    // Literal specifier: Rapier is a real npm dependency (unlike `three`, which
    // is CDN-loaded via an import map), so the consumer's bundler resolves it.
    this.rapierInitPromise = import('@dimforge/rapier3d-compat')
      .then(async (mod) => {
        const R = (mod.default ?? mod) as RapierModule;
        await R.init();
        this.rapier = new RapierPhysics(R);
        this.rapierReady = true;
        const pending = this.pendingRapierCreates;
        this.pendingRapierCreates = [];
        for (const p of pending) this.physicsCreateBody(p.meshId, p.opts);
      })
      .catch((err) => {
        console.error('[ThreeAdapter] Rapier failed to initialize:', err);
      });
    return this.rapierInitPromise;
  }

  /** World-space half-extents of a mesh: geometry bounds (or override) × scale. */
  private meshHalfExtents(h: MeshHandle, mesh: THREE.Mesh): { x: number; y: number; z: number } {
    const override = this.boxExtentOverrides.get(h);
    let minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number;
    if (override) {
      [minX, minY, minZ] = override.min;
      [maxX, maxY, maxZ] = override.max;
    } else {
      const g = mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) return { x: 0.5, y: 0.5, z: 0.5 };
      ({ x: minX, y: minY, z: minZ } = bb.min);
      ({ x: maxX, y: maxY, z: maxZ } = bb.max);
    }
    return {
      x: Math.max(1e-3, ((maxX - minX) / 2) * mesh.scale.x),
      y: Math.max(1e-3, ((maxY - minY) / 2) * mesh.scale.y),
      z: Math.max(1e-3, ((maxZ - minZ) / 2) * mesh.scale.z),
    };
  }

  /** Find the MeshHandle for a given meshId (Rapier collider sizing). */
  private handleForMeshId(meshId: string): MeshHandle | undefined {
    const mesh = this.meshesByMeshId.get(meshId);
    if (!mesh) return undefined;
    for (const [h, m] of this.meshes) if (m === mesh) return h;
    return undefined;
  }

  physicsCreateBody(meshId: string, opts: PhysicsBodyOpts): void {
    const mesh = this.meshesByMeshId.get(meshId);
    if (!mesh) return;

    if (!this.usesRapier) {
      // Injected pure-JS integrator path (back-compat).
      if (!this.physicsCore) this.physicsCore = this.physicsFactory!();
      this.physicsCore.createBody(meshId, {
        shapeType: opts.shapeType,
        motionType: opts.motionType,
        mass: opts.mass,
        friction: opts.friction,
        restitution: opts.restitution,
        lockRotation: opts.lockRotation,
        posX: mesh.position.x,
        posY: mesh.position.y,
        posZ: mesh.position.z,
      });
      return;
    }

    // Rapier path (default). Queue until the WASM world is live.
    if (!this.rapierReady || !this.rapier) {
      this.pendingRapierCreates.push({ meshId, opts });
      void this.ensureRapier();
      return;
    }
    const h = this.handleForMeshId(meshId);
    const half = h ? this.meshHalfExtents(h, mesh) : { x: 0.5, y: 0.5, z: 0.5 };
    const q = mesh.quaternion;
    this.rapier.createBody(
      meshId,
      opts,
      { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
      { x: q.x, y: q.y, z: q.z, w: q.w },
      half,
    );
  }

  physicsDestroyBody(meshId: string): void {
    if (this.usesRapier) this.rapier?.destroyBody(meshId);
    else this.physicsCore?.destroyBody(meshId);
  }

  physicsSetBodyVelocity(meshId: string, vx: number, vy: number, vz: number): void {
    if (this.usesRapier) this.rapier?.setLinearVelocity(meshId, vx, vy, vz);
    else this.physicsCore?.setBodyVelocity(meshId, vx, vy, vz);
  }

  physicsSetBodyAngularVelocity(meshId: string, vx: number, vy: number, vz: number): void {
    // The injected pure-core integrator doesn't track angular velocity; the
    // default Rapier backend does.
    this.rapier?.setAngularVelocity(meshId, vx, vy, vz);
  }

  physicsSetBodyDrivenByMesh(meshId: string, drivenByMesh: boolean): void {
    // drivenByMesh=true → the mesh transform is pushed into the body each step
    // (Rapier kinematic target); false → physics owns the transform.
    this.rapier?.setDrivenByMesh(meshId, drivenByMesh);
  }

  physicsSetGravity(x: number, y: number, z: number): void {
    this.rapier?.setGravity(x, y, z);
  }

  physicsResizeBoxBody(meshId: string, halfExtents: Vec3): void {
    this.rapier?.resizeBoxBody(meshId, halfExtents[0], halfExtents[1], halfExtents[2]);
  }

  physicsSetTimeStep(hz: number): void {
    // The injected pure-core integrator steps with whatever dt the loop hands
    // it; the Rapier backend honors a fixed timestep via an accumulator.
    this.rapier?.setTimeStep(hz);
  }

  physicsSetRestitution(meshId: string, restitution: number): void {
    this.rapier?.setRestitution(meshId, restitution);
  }

  setCollidersVisible(visible: boolean): void {
    this.collidersVisible = visible;
    if (this.usesRapier) {
      if (!visible) this.clearColliderDebug();
      // When turning on, the wireframe is (re)built on the next physicsStep.
    }
  }

  physicsSetPaused(paused: boolean): void {
    // Both backends only advance during physicsStep, so a flag that gates the
    // step fully freezes the sim.
    this.physicsPaused = paused;
  }

  physicsGetBodyState(meshId: string): PhysicsBodySnapshot | null {
    if (this.usesRapier) {
      const raw = this.rapier?.getRaw(meshId);
      if (!raw) return null;
      return {
        position: [raw.t.x, raw.t.y, raw.t.z],
        rotation: this.quatToEuler(raw.r.x, raw.r.y, raw.r.z, raw.r.w),
        linearVelocity: [raw.lv.x, raw.lv.y, raw.lv.z],
        angularVelocity: [raw.av.x, raw.av.y, raw.av.z],
      };
    }
    if (!this.physicsCore) return null;
    const body = this.physicsCore.bodies().find((b) => b.meshId === meshId);
    if (!body) return null;
    // The injected pure-core integrator exposes position only.
    return {
      position: [body.posX, body.posY, body.posZ],
      rotation: [0, 0, 0],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    };
  }

  physicsSetBodyState(meshId: string, state: PhysicsBodySnapshot): void {
    const mesh = this.meshesByMeshId.get(meshId);
    if (this.usesRapier) {
      const q = this.eulerToQuat(state.rotation[0], state.rotation[1], state.rotation[2]);
      this.rapier?.setBodyState(
        meshId,
        { x: state.position[0], y: state.position[1], z: state.position[2] },
        q,
        { x: state.linearVelocity[0], y: state.linearVelocity[1], z: state.linearVelocity[2] },
        { x: state.angularVelocity[0], y: state.angularVelocity[1], z: state.angularVelocity[2] },
      );
      // Mirror the pose onto the mesh so it's visible immediately while paused.
      if (mesh) {
        mesh.position.set(state.position[0], state.position[1], state.position[2]);
        mesh.quaternion.set(q.x, q.y, q.z, q.w);
      }
      return;
    }
    // Pure-core: only the linear-velocity setter exists; sync the mesh pose too.
    this.physicsCore?.setBodyVelocity(
      meshId,
      state.linearVelocity[0],
      state.linearVelocity[1],
      state.linearVelocity[2],
    );
    if (mesh) mesh.position.set(state.position[0], state.position[1], state.position[2]);
  }

  physicsStep(dt: number): void {
    if (this.physicsPaused) return;

    if (this.usesRapier) {
      const rapier = this.rapier;
      if (!rapier) return;
      // Push mesh-driven bodies' transforms into their kinematic targets first.
      rapier.forEachBody((meshId, driven) => {
        if (!driven) return;
        const mesh = this.meshesByMeshId.get(meshId);
        if (!mesh) return;
        const q = mesh.quaternion;
        rapier.pushKinematic(
          meshId,
          mesh.position.x, mesh.position.y, mesh.position.z,
          q.x, q.y, q.z, q.w,
        );
      });
      rapier.step(dt);
      // Write physics-owned poses back to their meshes.
      rapier.forEachBody((meshId, driven) => {
        if (driven) return;
        const mesh = this.meshesByMeshId.get(meshId);
        const raw = rapier.getRaw(meshId);
        if (!mesh || !raw) return;
        mesh.position.set(raw.t.x, raw.t.y, raw.t.z);
        mesh.quaternion.set(raw.r.x, raw.r.y, raw.r.z, raw.r.w);
      });
      if (this.collidersVisible) this.updateColliderDebug();
      return;
    }

    // Injected pure-core path.
    if (!this.physicsCore) return;
    this.physicsCore.step(dt);
    for (const body of this.physicsCore.bodies()) {
      const mesh = this.meshesByMeshId.get(body.meshId);
      if (!mesh) continue;
      mesh.position.set(body.posX, body.posY, body.posZ);
    }
  }

  // ─── Quaternion ↔ Euler helpers (renderer-agnostic snapshot conversion) ───
  private _qe?: THREE.Euler;
  private _qq?: THREE.Quaternion;
  private quatToEuler(x: number, y: number, z: number, w: number): Vec3 {
    const T = this.THREE;
    if (!T) return [0, 0, 0];
    if (!this._qe) this._qe = new T.Euler();
    if (!this._qq) this._qq = new T.Quaternion();
    this._qq.set(x, y, z, w);
    this._qe.setFromQuaternion(this._qq);
    return [this._qe.x, this._qe.y, this._qe.z];
  }
  private eulerToQuat(x: number, y: number, z: number): { x: number; y: number; z: number; w: number } {
    const T = this.THREE;
    if (!T) return { x: 0, y: 0, z: 0, w: 1 };
    if (!this._qe) this._qe = new T.Euler();
    if (!this._qq) this._qq = new T.Quaternion();
    this._qe.set(x, y, z);
    this._qq.setFromEuler(this._qe);
    return { x: this._qq.x, y: this._qq.y, z: this._qq.z, w: this._qq.w };
  }

  /** Rebuild the Rapier collider wireframe from world.debugRender() each step. */
  private updateColliderDebug(): void {
    const T = this.THREE;
    if (!T || !this.scene || !this.rapier) return;
    const { vertices, colors } = this.rapier.debugRender();
    if (!this.colliderDebugLines) {
      const geom = new T.BufferGeometry();
      const mat = new T.LineBasicMaterial({ vertexColors: true });
      this.colliderDebugLines = new T.LineSegments(geom, mat);
      this.colliderDebugLines.name = 'rapierColliderDebug';
      (this.colliderDebugLines as unknown as { raycast: () => void }).raycast = () => {};
      this.colliderDebugLines.frustumCulled = false;
      this.scene.add(this.colliderDebugLines);
    }
    const geom = this.colliderDebugLines.geometry;
    geom.setAttribute('position', new T.BufferAttribute(vertices, 3));
    // Rapier emits RGBA colors; LineBasicMaterial vertexColors wants RGB.
    const rgb = new Float32Array((colors.length / 4) * 3);
    for (let i = 0, j = 0; i < colors.length; i += 4, j += 3) {
      rgb[j] = colors[i]!; rgb[j + 1] = colors[i + 1]!; rgb[j + 2] = colors[i + 2]!;
    }
    geom.setAttribute('color', new T.BufferAttribute(rgb, 3));
  }

  private clearColliderDebug(): void {
    if (!this.colliderDebugLines) return;
    this.scene?.remove(this.colliderDebugLines);
    this.colliderDebugLines.geometry.dispose();
    (this.colliderDebugLines.material as THREE.Material).dispose();
    this.colliderDebugLines = undefined;
  }

  async loadMesh(id: string, spec: MeshLoadSpec): Promise<MeshLoadResult> {
    const T = this.requireThree();
    if (!this.scene) throw new Error('ThreeAdapter.loadMesh: call init() first');
    // GLTFLoader lives in the addons bundle; loaded via non-literal specifier
    // so Vite's import analyzer leaves it alone (same trick as OrbitControls).
    const spec2 = 'three/addons/loaders/GLTFLoader.js';
    const mod = (await import(/* @vite-ignore */ spec2)) as unknown as {
      GLTFLoader: new () => {
        loadAsync(url: string): Promise<{
          scene: THREE.Object3D;
          animations: THREE.AnimationClip[];
        }>;
      };
    };
    const loader = new mod.GLTFLoader();
    const gltf = await loader.loadAsync(spec.url);

    // Treat the imported scene root as a "mesh" for the interface's purposes.
    // Some of our MeshHandle operations (position/rotation/visible) work on any
    // Object3D, so a non-Mesh root is fine. We keep the Map typed as Mesh for
    // compatibility with the rest of the adapter — a safe cast since we only
    // touch transform/visibility methods on it.
    const root = gltf.scene as unknown as THREE.Mesh;
    root.name = id;

    if (spec.position) root.position.set(spec.position[0], spec.position[1], spec.position[2]);
    if (spec.rotation) root.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
    if (spec.scale !== undefined) root.scale.setScalar(spec.scale);
    this.scene.add(root);

    const handle = this.makeHandle<MeshHandle>('loadedMesh', id);
    this.meshes.set(handle, root);

    // Wire animations. A single AnimationMixer per mesh drives all clips.
    const animationNames: string[] = [];
    if (gltf.animations.length > 0) {
      const mixer = new T.AnimationMixer(root);
      this.animationMixers.set(id, mixer);
      for (const clip of gltf.animations) {
        const action = mixer.clipAction(clip);
        this.animationActions.set(`${id}/${clip.name}`, action);
        animationNames.push(clip.name);
      }
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
  // Engine-typed host accessors for adapter plugins (see RendererAdapter docs).
  /** The AnimationMixer a mesh's clips play on (created by loadMesh when the
   *  mesh ships any clip). Plugins bind extra clips onto it. */
  getMixer(meshId: string): THREE.AnimationMixer | undefined {
    return this.animationMixers.get(meshId);
  }
  /** Register a clip action so `playAnimation(meshId, name)` finds it. */
  addClipAction(meshId: string, name: string, action: THREE.AnimationAction): void {
    this.animationActions.set(`${meshId}/${name}`, action);
  }

  async loadModelTemplate(
    url: string,
    _opts?: LoadModelTemplateOptions,
  ): Promise<{ animationNames: string[] }> {
    // _opts.lockRootMotion is honored by the Babylon adapter (the shipping
    // renderer for the pooled-character path); the Three path does not strip
    // root motion yet.
    if (!this.scene) throw new Error('ThreeAdapter.loadModelTemplate: call init() first');
    const cached = this.modelTemplates.get(url);
    if (cached) return { animationNames: cached.animations.map((c) => c.name) };
    const spec2 = 'three/addons/loaders/GLTFLoader.js';
    const mod = (await import(/* @vite-ignore */ spec2)) as unknown as {
      GLTFLoader: new () => {
        loadAsync(url: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>;
      };
    };
    const loader = new mod.GLTFLoader();
    const gltf = await loader.loadAsync(url);
    // Keep the template OFF the scene; instantiateModel clones from it.
    this.modelTemplates.set(url, { root: gltf.scene, animations: gltf.animations });
    return { animationNames: gltf.animations.map((c) => c.name) };
  }

  instantiateModel(id: string, url: string, spec?: ModelInstantiateSpec): MeshHandle {
    const T = this.requireThree();
    if (!this.scene) throw new Error('ThreeAdapter.instantiateModel: call init() first');
    const template = this.modelTemplates.get(url);
    if (!template) {
      throw new Error(
        `ThreeAdapter.instantiateModel: template not loaded for "${url}" — await loadModelTemplate first`,
      );
    }
    const root = template.root.clone(true);
    root.name = id;
    // `Object3D.clone()` copies the hierarchy but shares material objects by
    // reference, so repainting this clone would repaint every other one. A skin
    // therefore needs its own copies first.
    if (spec?.skin) {
      root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.material) return;
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((m) => m.clone())
          : mesh.material.clone();
      });
      this.skinMaterialTree(root, spec.skin);
    }
    if (spec?.fit) {
      // Auto-fit a displayed ship GLB: measure the natural hierarchy (root still
      // at clone-identity), normalize its longest HORIZONTAL extent to fitLength,
      // then apply facing + offset so the nose points +Z. fitLength overrides the
      // fixed scale multiplier.
      this.applyModelFit(root, spec.fit, spec);
    } else {
      if (spec?.position) root.position.set(spec.position[0], spec.position[1], spec.position[2]);
      if (spec?.rotation) root.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
      if (spec?.scale !== undefined) root.scale.setScalar(spec.scale);
    }
    root.visible = false; // start parked; setModelVisible reveals it
    this.scene.add(root);
    this.instantiatedModelRoots.set(id, root);

    const handle = this.makeHandle<MeshHandle>('model', id);
    // Stored as Mesh for the shared transform helpers; we only touch
    // position/rotation/visible on it, all present on Object3D.
    this.meshes.set(handle, root as unknown as THREE.Mesh);

    // Per-clone mixer + actions keyed by id, mirroring loadMesh.
    if (template.animations.length > 0) {
      const mixer = new T.AnimationMixer(root);
      this.animationMixers.set(id, mixer);
      for (const clip of template.animations) {
        this.animationActions.set(`${id}/${clip.name}`, mixer.clipAction(clip));
      }
    }
    return handle;
  }

  /**
   * Measure-and-normalize a loaded GLB hierarchy per {@link ModelFitSpec}: filter
   * to the wanted body, scale its longest horizontal extent to `fitLength`, and
   * apply yaw/pitch + yOffset so it faces +Z. Mirrors the BabylonRenderer's
   * `setupShipGlb` fit-up. (Phase 3 just DISPLAYS — no blow-apart proxy.)
   */
  private applyModelFit(root: THREE.Object3D, fit: ModelFitSpec, spec?: ModelInstantiateSpec): void {
    const T = this.THREE;
    if (!T) return;
    // meshNameFilter: one GLB can hold several bodies (freighter = TrainCar +
    // TrainEngine) — keep only meshes whose name includes the substring.
    if (fit.meshNameFilter) {
      const filter = fit.meshNameFilter;
      let anyMatch = false;
      root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.name.includes(filter)) anyMatch = true; });
      if (anyMatch) {
        const drop: THREE.Object3D[] = [];
        root.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.name.includes(filter)) drop.push(o); });
        for (const o of drop) o.parent?.remove(o);
      }
    }
    // Natural hierarchy size (root is at clone-identity here, so the bbox isn't
    // contaminated by our own fit transform).
    const size = new T.Box3().setFromObject(root).getSize(new T.Vector3());
    const longest = Math.max(size.x, size.z, 1e-4); // longest HORIZONTAL extent
    const scale = fit.fitLength !== undefined ? fit.fitLength / longest : (spec?.scale ?? 1);
    root.scale.setScalar(scale);
    root.rotation.set(fit.pitch ?? 0, fit.yaw ?? 0, 0);
    const p = spec?.position ?? [0, 0, 0];
    root.position.set(p[0], p[1] + (fit.yOffset ?? 0), p[2]);
  }

  setModelVisible(h: MeshHandle, visible: boolean): void {
    const root = this.meshes.get(h);
    if (root) root.visible = visible;
  }

  setModelAlpha(id: string, alpha: number): void {
    const root = this.instantiatedModelRoots.get(id);
    if (!root) return;
    root.traverse((o) => {
      const mesh = o as unknown as { material?: { transparent?: boolean; opacity?: number } | Array<{ transparent?: boolean; opacity?: number }> };
      const mat = mesh.material;
      if (!mat) return;
      const apply = (m: { transparent?: boolean; opacity?: number }) => {
        m.transparent = true;
        m.opacity = alpha;
      };
      if (Array.isArray(mat)) mat.forEach(apply);
      else apply(mat);
    });
  }

  disposeModel(id: string, h: MeshHandle): void {
    const root = this.instantiatedModelRoots.get(id);
    if (root) {
      this.scene?.remove(root);
      this.instantiatedModelRoots.delete(id);
    }
    this.animationMixers.get(id)?.stopAllAction();
    this.animationMixers.delete(id);
    for (const key of [...this.animationActions.keys()]) {
      if (key.startsWith(`${id}/`)) this.animationActions.delete(key);
    }
    this.meshes.delete(h);
  }

  playAnimationOnce(meshId: string, clipName: string): number {
    const action = this.findAnimationAction(meshId, clipName);
    if (!action || !this.THREE) return 0;
    action.setLoop(this.THREE.LoopOnce, 1);
    action.reset();
    action.clampWhenFinished = true;
    action.play();
    return action.getClip().duration;
  }

  private _tmpThreeVec?: THREE.Vector3;

  private requireThree(): typeof THREE {
    if (!this.THREE) throw new Error('ThreeAdapter: call init() first');
    return this.THREE;
  }

  private makeHandle<T>(kind: string, id: string): T {
    return { __handle: `${kind}:${id}:${this.handleCounter++}` } as unknown as T;
  }
  private handleCounter = 0;

  createDirectionalLight(id: string, spec: DirectionalLightSpec): LightHandle {
    const T = this.requireThree();
    const light = new T.DirectionalLight(
      new T.Color().setRGB(spec.diffuse[0], spec.diffuse[1], spec.diffuse[2], T.SRGBColorSpace),
      spec.intensity,
    );
    light.name = `DirectionalLight_${id}`;
    const pos = spec.position ?? [spec.direction[0] * -30, spec.direction[1] * -30, spec.direction[2] * -30];
    light.position.set(pos[0], pos[1], pos[2]);
    // Three lights aim at a Vector3 target. Set target so rays point along spec.direction.
    light.target.position.set(
      pos[0] + spec.direction[0],
      pos[1] + spec.direction[1],
      pos[2] + spec.direction[2],
    );
    this.scene!.add(light);
    this.scene!.add(light.target);

    if (spec.shadow?.enabled) {
      this.enableShadowMap();
      light.castShadow = true;
      light.shadow.mapSize.width = spec.shadow.mapSize;
      light.shadow.mapSize.height = spec.shadow.mapSize;
      light.shadow.camera.near = Math.max(0.1, spec.shadow.minZ);
      light.shadow.camera.far = spec.shadow.maxZ;
      // Tune the orthographic camera extent for the scene size
      const extent = spec.shadow.maxZ / 3;
      light.shadow.camera.left = -extent;
      light.shadow.camera.right = extent;
      light.shadow.camera.top = extent;
      light.shadow.camera.bottom = -extent;
      light.shadow.bias = -0.0005;
    }

    const handle = this.makeHandle<LightHandle>('dirLight', id);
    this.lights.set(handle, light);
    return handle;
  }
  createHemisphericLight(id: string, spec: HemisphericLightSpec): LightHandle {
    const T = this.requireThree();
    // Three calls this a HemisphereLight. Map sky/ground colors directly.
    // sRGB-tagged to match how Babylon interprets these scene-JSON numbers.
    const light = new T.HemisphereLight(
      new T.Color().setRGB(spec.diffuse[0], spec.diffuse[1], spec.diffuse[2], T.SRGBColorSpace),
      new T.Color().setRGB(spec.groundColor[0], spec.groundColor[1], spec.groundColor[2], T.SRGBColorSpace),
      spec.intensity,
    );
    light.name = `HemisphericLight_${id}`;
    // Position is implied by the "up" direction; Three doesn't take position but we can set the light's position for debug visualizations.
    light.position.set(spec.direction[0], spec.direction[1], spec.direction[2]);
    this.scene!.add(light);

    const handle = this.makeHandle<LightHandle>('hemLight', id);
    this.lights.set(handle, light);
    return handle;
  }
  createPointLight(id: string, spec: PointLightSpec): LightHandle {
    const T = this.requireThree();
    // Three's `distance` is Babylon's `range`; 0 means "never cut off" in both.
    const light = new T.PointLight(
      new T.Color().setRGB(spec.diffuse[0], spec.diffuse[1], spec.diffuse[2], T.SRGBColorSpace),
      spec.intensity,
      spec.range ?? 0,
    );
    light.name = `PointLight_${id}`;
    light.position.set(spec.position[0], spec.position[1], spec.position[2]);
    this.scene!.add(light);

    const handle = this.makeHandle<LightHandle>('pointLight', id);
    this.lights.set(handle, light);
    return handle;
  }
  setLightPosition(h: LightHandle, x: number, y: number, z: number): void {
    this.lights.get(h)?.position.set(x, y, z);
  }
  updateLightIntensity(h: LightHandle, intensity: number): void {
    const light = this.lights.get(h);
    if (light) light.intensity = intensity;
  }
  disposeLight(h: LightHandle): void {
    const light = this.lights.get(h);
    if (!light) return;
    this.scene?.remove(light);
    light.dispose?.();
    this.lights.delete(h);
  }

  createArcCamera(id: string, spec: ArcCameraSpec): CameraHandle {
    const T = this.requireThree();
    if (!this.renderer) throw new Error('ThreeAdapter.createArcCamera: call init() first');

    // Babylon's ArcRotateCamera default FOV is 0.8 rad (~45.84°). Match it so
    // the same scene framing lines up across renderers.
    const fovDeg = (0.8 * 180) / Math.PI;
    const camera = new T.PerspectiveCamera(fovDeg, this.canvasAspect(), 0.1, 1000);
    // Position derived from spherical coords (alpha, beta, radius) around target.
    const target = spec.target;
    const { x, y, z } = sphericalToCartesian(spec.alpha, spec.beta, spec.radius, target);
    camera.position.set(x, y, z);
    camera.lookAt(target[0], target[1], target[2]);

    const controls = new this.OrbitControlsCtor!(camera, this.renderer.domElement) as unknown as {
      target: THREE.Vector3;
      minDistance: number;
      maxDistance: number;
      minPolarAngle: number;
      maxPolarAngle: number;
      enableDamping: boolean;
      dampingFactor: number;
      zoomSpeed: number;
      rotateSpeed: number;
      update(): void;
      dispose(): void;
    };
    controls.target.set(target[0], target[1], target[2]);
    controls.minDistance = spec.minRadius;
    controls.maxDistance = spec.maxRadius;
    controls.minPolarAngle = spec.minBeta;
    controls.maxPolarAngle = spec.maxBeta;
    controls.enableDamping = spec.inertia > 0;
    controls.dampingFactor = 1 - spec.inertia;
    controls.zoomSpeed = 50 / spec.wheelPrecision;
    controls.rotateSpeed = 1000 / spec.angularSensibility;
    controls.update();

    const handle = this.makeHandle<CameraHandle>('arcCamera', id);
    this.cameras.set(handle, { camera, controls });
    return handle;
  }
  setCameraTarget(h: CameraHandle, x: number, y: number, z: number): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    const ctrl = entry.controls as { target: { set(x: number, y: number, z: number): void }; update(): void } | undefined;
    if (ctrl) {
      ctrl.target.set(x, y, z);
      ctrl.update();
    } else {
      entry.camera.lookAt(x, y, z);
    }
  }
  getCameraTarget(h: CameraHandle, out: Vec3): Vec3 {
    const entry = this.cameras.get(h);
    const t = (entry?.controls as { target: THREE.Vector3 } | undefined)?.target;
    if (t) {
      out[0] = t.x;
      out[1] = t.y;
      out[2] = t.z;
    } else {
      out[0] = out[1] = out[2] = 0;
    }
    return out;
  }
  getCameraAngles(h: CameraHandle): { alpha: number; beta: number; radius: number } {
    const entry = this.cameras.get(h);
    if (!entry) return { alpha: 0, beta: 0, radius: 0 };
    const ctrl = entry.controls as { target: THREE.Vector3 } | undefined;
    const tx = ctrl?.target.x ?? 0;
    const ty = ctrl?.target.y ?? 0;
    const tz = ctrl?.target.z ?? 0;
    const dx = entry.camera.position.x - tx;
    const dy = entry.camera.position.y - ty;
    const dz = entry.camera.position.z - tz;
    const radius = Math.hypot(dx, dy, dz);
    const beta = radius > 0 ? Math.acos(Math.max(-1, Math.min(1, dy / radius))) : 0;
    const alpha = Math.atan2(dz, dx);
    return { alpha, beta, radius };
  }
  getCameraForward(h: CameraHandle, out: Vec3): Vec3 {
    const entry = this.cameras.get(h);
    if (!entry) {
      out[0] = 0; out[1] = 0; out[2] = -1;
      return out;
    }
    // A free 6-DOF perspective camera (no OrbitControls) is posed directly: its
    // rendered look direction is `getWorldDirection` (Three's local −Z, world).
    // After the +Y look-flip baked in setCameraPose, an identity-orientation
    // camera reports forward = +Z — the canonical convention the contract locks.
    if (!entry.controls && this.THREE) {
      const d = entry.camera.getWorldDirection(this._wtsVec ??= new this.THREE.Vector3());
      out[0] = d.x; out[1] = d.y; out[2] = d.z;
      return out;
    }
    const ctrl = entry.controls as { target: THREE.Vector3 } | undefined;
    const tx = ctrl?.target.x ?? 0;
    const ty = ctrl?.target.y ?? 0;
    const tz = ctrl?.target.z ?? 0;
    const dx = tx - entry.camera.position.x;
    const dy = ty - entry.camera.position.y;
    const dz = tz - entry.camera.position.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    out[0] = dx / len; out[1] = dy / len; out[2] = dz / len;
    return out;
  }
  getCameraRight(h: CameraHandle, out: Vec3): Vec3 {
    // Three.js is right-handed: right = normalize(forward × up), up = (0,1,0).
    this.getCameraForward(h, out);
    const fx = out[0], fz = out[2];
    // cross((fx,fy,fz), (0,1,0)) = (-fz, 0, fx); its length is hypot(fx,fz) < 1
    // whenever forward tilts off the XZ plane, so normalize to stay a unit axis.
    const len = Math.hypot(fx, fz) || 1;
    out[0] = -fz / len;
    out[1] = 0;
    out[2] = fx / len;
    return out;
  }
  nudgeCameraAlpha(h: CameraHandle, delta: number): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    const ctrl = entry.controls as { target: THREE.Vector3; update(): void } | undefined;
    const tx = ctrl?.target.x ?? 0;
    const ty = ctrl?.target.y ?? 0;
    const tz = ctrl?.target.z ?? 0;
    // Rotate camera around world-up axis (Y) around the target
    const dx = entry.camera.position.x - tx;
    const dz = entry.camera.position.z - tz;
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    const newDx = dx * cos - dz * sin;
    const newDz = dx * sin + dz * cos;
    entry.camera.position.set(tx + newDx, entry.camera.position.y, tz + newDz);
    entry.camera.lookAt(tx, ty, tz);
    ctrl?.update();
  }
  nudgeCameraTarget(h: CameraHandle, dx: number, dy: number, dz: number): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    const ctrl = entry.controls as { target: THREE.Vector3; update(): void } | undefined;
    if (ctrl) {
      ctrl.target.x += dx;
      ctrl.target.y += dy;
      ctrl.target.z += dz;
      ctrl.update();
    }
  }
  nudgeCameraRadius(h: CameraHandle, delta: number): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    const ctrl = entry.controls as { target: THREE.Vector3; update(): void } | undefined;
    const tx = ctrl?.target.x ?? 0;
    const ty = ctrl?.target.y ?? 0;
    const tz = ctrl?.target.z ?? 0;
    const dx = entry.camera.position.x - tx;
    const dy = entry.camera.position.y - ty;
    const dz = entry.camera.position.z - tz;
    const radius = Math.hypot(dx, dy, dz);
    if (radius < 1e-6) return;
    const next = Math.max(0.01, radius + delta);
    const s = next / radius;
    entry.camera.position.set(tx + dx * s, ty + dy * s, tz + dz * s);
    entry.camera.lookAt(tx, ty, tz);
    ctrl?.update();
  }
  nudgeCameraBeta(h: CameraHandle, delta: number): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    const ctrl = entry.controls as { target: THREE.Vector3; update(): void } | undefined;
    const tx = ctrl?.target.x ?? 0;
    const ty = ctrl?.target.y ?? 0;
    const tz = ctrl?.target.z ?? 0;
    const dx = entry.camera.position.x - tx;
    const dy = entry.camera.position.y - ty;
    const dz = entry.camera.position.z - tz;
    const radius = Math.hypot(dx, dy, dz);
    if (radius < 1e-6) return;
    // Convert to spherical, adjust polar angle, convert back. Three's
    // OrbitControls treats y as up; polar = angle from +Y axis.
    const polar = Math.acos(Math.max(-1, Math.min(1, dy / radius)));
    const nextPolar = Math.max(0.05, Math.min(Math.PI - 0.05, polar + delta));
    const azimuth = Math.atan2(dx, dz);
    const sinP = Math.sin(nextPolar);
    const nx = radius * sinP * Math.sin(azimuth);
    const ny = radius * Math.cos(nextPolar);
    const nz = radius * sinP * Math.cos(azimuth);
    entry.camera.position.set(tx + nx, ty + ny, tz + nz);
    entry.camera.lookAt(tx, ty, tz);
    ctrl?.update();
  }
  setCameraRadius(h: CameraHandle, radius: number): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    const ctrl = entry.controls as { target: THREE.Vector3; update(): void } | undefined;
    const tx = ctrl?.target.x ?? 0;
    const ty = ctrl?.target.y ?? 0;
    const tz = ctrl?.target.z ?? 0;
    const dx = entry.camera.position.x - tx;
    const dy = entry.camera.position.y - ty;
    const dz = entry.camera.position.z - tz;
    const cur = Math.hypot(dx, dy, dz);
    if (cur < 1e-6) return;
    const s = Math.max(0.01, radius) / cur;
    entry.camera.position.set(tx + dx * s, ty + dy * s, tz + dz * s);
    entry.camera.lookAt(tx, ty, tz);
    ctrl?.update();
  }
  setCameraRadiusLimits(h: CameraHandle, min: number, max: number): void {
    const entry = this.cameras.get(h);
    const ctrl = entry?.controls as { minDistance: number; maxDistance: number; update(): void } | undefined;
    if (!ctrl) return;
    ctrl.minDistance = min;
    ctrl.maxDistance = max;
    ctrl.update();
  }
  setCameraFov(h: CameraHandle, fov: number): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    // Three's PerspectiveCamera takes FOV in degrees; interface ships radians.
    entry.camera.fov = (fov * 180) / Math.PI;
    entry.camera.updateProjectionMatrix();
  }
  setCameraControlsEnabled(h: CameraHandle, enabled: boolean): void {
    const entry = this.cameras.get(h);
    const ctrl = entry?.controls as { enabled: boolean } | undefined;
    if (ctrl) ctrl.enabled = enabled;
  }

  // ─── Free 6-DOF perspective camera (chase / flight) ───
  /**
   * The active free perspective camera: the one {@link worldToScreen} projects
   * against and the one the render loop draws through. Set by
   * {@link createPerspectiveCamera}; null falls back to the first registered /
   * default camera.
   */
  private activePerspectiveCamera: CameraHandle | null = null;
  /** Scratch vector reused by {@link worldToScreen} so the HUD re-projects allocation-free. */
  private _wtsVec?: THREE.Vector3;

  /**
   * The THREE camera the render loop / resize / pick should use: the active free
   * perspective camera if one exists, else the first registered arc camera, else
   * the default fallback (built in init()).
   */
  private renderCamera(): THREE.PerspectiveCamera | undefined {
    if (this.activePerspectiveCamera) {
      const entry = this.cameras.get(this.activePerspectiveCamera);
      if (entry) return entry.camera;
    }
    const first = this.cameras.values().next().value;
    return first?.camera ?? this.defaultCamera;
  }

  createPerspectiveCamera(id: string, spec: PerspectiveCameraSpec): CameraHandle {
    const T = this.requireThree();
    // Three's PerspectiveCamera wants a VERTICAL fov in DEGREES; the interface
    // ships radians (matching Babylon), so convert — exactly as setCameraFov does.
    const camera = new T.PerspectiveCamera(
      T.MathUtils.radToDeg(spec.fov),
      this.canvasAspect(),
      spec.near,
      spec.far,
    );
    if (spec.position) camera.position.set(spec.position[0], spec.position[1], spec.position[2]);
    const orientation = spec.orientation ?? { x: 0, y: 0, z: 0, w: 1 };
    // Free camera: NO OrbitControls — it's posed directly each frame via
    // setCameraPose. The absent `controls` is also how the pose setters tell a
    // free camera apart from an arc camera in the shared `cameras` registry.
    const handle = this.makeHandle<CameraHandle>('perspCamera', id);
    this.cameras.set(handle, { camera, orientation: { x: 0, y: 0, z: 0, w: 1 } });
    this.activePerspectiveCamera = handle;
    this.setCameraPose(handle, spec.position ?? [0, 0, 0], orientation);
    return handle;
  }

  /** 180°-about-+Y quaternion, lazily built once `this.THREE` exists. */
  private perspLookFlip(): THREE.Quaternion {
    if (!this._perspLookFlip) {
      this._perspLookFlip = new this.THREE!.Quaternion().setFromAxisAngle(
        new this.THREE!.Vector3(0, 1, 0),
        Math.PI,
      );
    }
    return this._perspLookFlip;
  }

  setCameraPose(h: CameraHandle, position: Vec3, orientation: Quaternion): void {
    const entry = this.cameras.get(h);
    // No-op on an unknown handle or an arc camera (those carry OrbitControls and
    // are driven by orbit/target, not a direct pose).
    if (!entry || entry.controls) return;
    entry.camera.position.set(position[0], position[1], position[2]);
    // Remember the CANONICAL orientation verbatim (for getCameraPose), then bake
    // `q ⊗ yaw180` onto the camera so its rendered forward is `q · (+Z)` — looking
    // +Z at identity, the canonical convention. No quat→Euler round-trip, so
    // loops and rolls reach the renderer without gimbal flips.
    (entry.orientation ??= { x: 0, y: 0, z: 0, w: 1 });
    entry.orientation.x = orientation.x;
    entry.orientation.y = orientation.y;
    entry.orientation.z = orientation.z;
    entry.orientation.w = orientation.w;
    entry.camera.quaternion
      .set(orientation.x, orientation.y, orientation.z, orientation.w)
      .multiply(this.perspLookFlip());
    entry.camera.updateMatrixWorld();
  }

  getCameraPose(h: CameraHandle, outPosition: Vec3, outOrientation: Quaternion): void {
    const entry = this.cameras.get(h);
    if (!entry) return;
    const cam = entry.camera;
    outPosition[0] = cam.position.x;
    outPosition[1] = cam.position.y;
    outPosition[2] = cam.position.z;
    // Hand back the canonical orientation stored verbatim — NOT the baked
    // quaternion (which carries the +Y look-flip). Falls back to the raw camera
    // quaternion only for an entry created before this map existed.
    const q = entry.orientation ?? cam.quaternion;
    outOrientation.x = q.x;
    outOrientation.y = q.y;
    outOrientation.z = q.z;
    outOrientation.w = q.w;
  }

  worldToScreen(x: number, y: number, z: number, out: ScreenPoint): boolean {
    const T = this.THREE;
    const handle = this.activePerspectiveCamera;
    const entry = handle ? this.cameras.get(handle) : undefined;
    if (!T || !entry) return false;
    const camera = entry.camera;
    // Keep matrixWorldInverse current (Camera.updateMatrixWorld refreshes it);
    // Vector3.project reads it + projectionMatrix to land the point in NDC.
    camera.updateMatrixWorld();
    if (!this._wtsVec) this._wtsVec = new T.Vector3();
    const v = this._wtsVec.set(x, y, z).project(camera);
    // Three cameras look down −Z, so the perspective divide flips a point BEHIND
    // the camera to NDC z > 1. Treat that as behind: bail and leave `out`
    // untouched so HUD callers branch to an off-screen arrow.
    if (v.z > 1) return false;
    const { width, height } = this.renderPixelSize();
    out.x = (v.x * 0.5 + 0.5) * width;
    out.y = (-v.y * 0.5 + 0.5) * height; // NDC +Y up → pixel +Y down
    return true;
  }

  /**
   * CSS-pixel size of the render surface — the basis for HUD projection. Mirrors
   * canvasAspect's source order (client size → buffer dims → window), so
   * worldToScreen yields finite pixels even headless.
   */
  private renderPixelSize(): { width: number; height: number } {
    const c = this.canvas;
    const width = c?.clientWidth || c?.width || window.innerWidth || 1;
    const height = c?.clientHeight || c?.height || window.innerHeight || 1;
    return { width, height };
  }

  // ─── Floating origin / large world (Phase-1: contract-only, dormant) ───
  /**
   * Tracked floating-origin offset. Phase-1 is dormant: {@link setOriginOffset}
   * records it and {@link getOriginOffset} reports it, but nothing rebases the
   * scene graph — Three has no native floating origin, and the pure game keeps
   * passing real world coordinates (a camera-relative fallback).
   */
  private originOffset: Vec3 = [0, 0, 0];
  /** Recorded large-world config (Phase-1 records the flag; may widen the far plane). */
  private largeWorld: { enabled: boolean; farPlane?: number } = { enabled: false };

  getOriginOffset(out: Vec3): Vec3 {
    out[0] = this.originOffset[0];
    out[1] = this.originOffset[1];
    out[2] = this.originOffset[2];
    return out;
  }
  setOriginOffset(x: number, y: number, z: number): void {
    this.originOffset[0] = x;
    this.originOffset[1] = y;
    this.originOffset[2] = z;
  }
  configureLargeWorld(spec: LargeWorldSpec): void {
    this.largeWorld = { enabled: spec.enabled, farPlane: spec.farPlane };
    // Widen the active perspective camera's far plane if asked (~200000 for a
    // space sim). No active rebasing in Phase 1.
    if (spec.farPlane !== undefined) {
      const handle = this.activePerspectiveCamera;
      const entry = handle ? this.cameras.get(handle) : undefined;
      if (entry) {
        entry.camera.far = spec.farPlane;
        entry.camera.updateProjectionMatrix();
      }
    }
  }

  pickAtScreenPoint(x: number, y: number, opts?: PickOptions): PickResult | null {
    const T = this.THREE;
    // Pick against the active render camera (the free camera if one exists, else
    // the first registered arc camera, else the fallback). Inputs are pixel
    // coords relative to the canvas.
    const camera = this.renderCamera();
    const canvas = this.getRenderingCanvas();
    if (!T || !this.scene || !camera || !canvas) return null;

    if (!this._tfRaycaster) this._tfRaycaster = new T.Raycaster();
    if (!this._tfNdc) this._tfNdc = new T.Vector2();
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || canvas.width;
    const h = rect.height || canvas.height;
    // Pixel → normalized device coords (origin top-left → +Y up).
    this._tfNdc.set((x / w) * 2 - 1, -((y / h) * 2 - 1));
    this._tfRaycaster.setFromCamera(this._tfNdc, camera);

    // Map each pickable mesh back to its meshId so the predicate can filter and
    // the result can name the hit. Debug boxes / thin fields are non-pickable
    // (their raycast is stubbed at creation), so they never appear here.
    const idByMesh = new Map<THREE.Object3D, string>();
    const targets: THREE.Object3D[] = [];
    for (const [id, mesh] of this.meshesByMeshId) {
      if (opts?.meshPredicate && !opts.meshPredicate(id)) continue;
      // Honor the per-mesh pickable flag set via setMeshRenderingOptions
      // (decals / HUD widgets opt out of ray picks).
      if (mesh.userData?.pickable === false) continue;
      idByMesh.set(mesh, id);
      targets.push(mesh);
    }
    const hits = this._tfRaycaster.intersectObjects(targets, false);
    const hit = hits[0];
    if (!hit) return null;
    const meshId = idByMesh.get(hit.object);
    if (meshId === undefined) return null;
    return { x: hit.point.x, y: hit.point.y, z: hit.point.z, meshId };
  }

  attachShadowCaster(light: LightHandle, mesh: MeshHandle): ShadowCasterHandle {
    this.enableShadowMap();
    const m = this.meshes.get(mesh);
    if (m) m.castShadow = true;
    const handle = this.makeHandle<ShadowCasterHandle>('shadow', `${String(light)}+${String(mesh)}`);
    this.shadowCasters.set(handle, { light, mesh });
    return handle;
  }
  detachShadowCaster(h: ShadowCasterHandle): void {
    const pair = this.shadowCasters.get(h);
    if (!pair) return;
    const m = this.meshes.get(pair.mesh);
    if (m) m.castShadow = false;
    this.shadowCasters.delete(h);
  }
  setMeshReceiveShadows(h: MeshHandle, receive: boolean): void {
    const m = this.meshes.get(h);
    if (m) m.receiveShadow = receive;
  }

  createSkybox(id: string, _spec: SkyboxSpec): SkyboxHandle {
    return this.makeHandle<SkyboxHandle>('skybox', id);
  }
  updateSkyboxSun(_h: SkyboxHandle, _sunDirection: Vec3, _sunColor?: Color): void {}
  disposeSkybox(_h: SkyboxHandle): void {}

  // IBL on Three needs PMREMGenerator + a different file format than Babylon's
  // .env — no-op for now; a future implementation would load HDR/EXR + run
  // PMREM, then assign to scene.environment.
  setEnvironmentTexture(_url: string, _opts?: EnvironmentTextureOpts): void {}
  clearEnvironmentTexture(): void {}
  applyPbrMaterial(_handle: MeshHandle, _spec: PbrMaterialSpec): void {}

  setMeshSkin(handle: MeshHandle, spec: MeshSkinSpec): void {
    const obj = this.meshes.get(handle);
    if (!obj) return;
    this.skinMaterialTree(obj, spec);
  }

  /**
   * Shared body of {@link setMeshSkin}, also called from `instantiateModel`
   * before the clone is revealed.
   *
   * `GLTFLoader` parks glTF material `extras` on `material.userData` and bakes
   * `KHR_texture_transform` into each texture's offset/repeat/rotation — so the
   * atlas-region addressing we must preserve lives on the OLD texture object,
   * and the new one is a `.clone()` of it with only the image swapped.
   */
  private skinMaterialTree(root: THREE.Object3D, spec: MeshSkinSpec): void {
    const T = this.THREE;
    if (!T) return;
    const emissiveUrl = spec.emissiveTexture ?? spec.albedoTexture;
    const loader = new T.TextureLoader();
    // One material is bound to many meshes; re-skinning per mesh would reload
    // the same atlas repeatedly.
    const seen = new Set<THREE.Material>();

    root.traverse((node) => {
      const mat = (node as THREE.Mesh).material;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) seen.add(m);
    });

    for (const mat of seen) {
      if (spec.extrasFlag && !(mat.userData as Record<string, unknown>)?.[spec.extrasFlag]) continue;
      const std = mat as THREE.MeshStandardMaterial;

      const swap = (current: THREE.Texture | null, url: string): THREE.Texture | null => {
        if (!current) return current;
        // Clone carries offset/repeat/rotation/center/wrap — i.e. the atlas
        // region — then we point it at the new image and re-upload.
        const next = current.clone();
        next.image = loader.load(url, () => {
          next.needsUpdate = true;
        }).image;
        next.colorSpace = current.colorSpace;
        next.needsUpdate = true;
        return next;
      };

      const nextAlbedo = swap(std.map ?? null, spec.albedoTexture);
      if (nextAlbedo && nextAlbedo !== std.map) {
        std.map?.dispose();
        std.map = nextAlbedo;
      }
      // Emissive only where one already exists — that's what marks a part as
      // authored-to-glow.
      const nextEmissive = swap(std.emissiveMap ?? null, emissiveUrl);
      if (nextEmissive && nextEmissive !== std.emissiveMap) {
        std.emissiveMap?.dispose();
        std.emissiveMap = nextEmissive;
      }
      std.needsUpdate = true;
    }
  }

  createLabel(id: string, spec: LabelSpec): LabelHandle {
    const T = this.requireThree();
    const fontSize = spec.fontSize ?? 64;
    const fontWeight = spec.fontWeight ?? 'bold';
    const texW = 512;
    const texH = 256;
    const canvas = document.createElement('canvas');
    canvas.width = texW;
    canvas.height = texH;
    this.drawLabelText(canvas, spec.text, fontSize, fontWeight, spec.background, spec.borderColor);

    const texture = new T.CanvasTexture(canvas);
    // Canvas is authored in sRGB space. Without this the label looks washed out.
    texture.colorSpace = T.SRGBColorSpace;
    texture.needsUpdate = true;

    const material = new T.SpriteMaterial({
      map: texture,
      color: spec.color
        ? new T.Color().setRGB(spec.color[0], spec.color[1], spec.color[2], T.SRGBColorSpace)
        : new T.Color(1, 1, 1),
      transparent: true,
      depthWrite: false,
    });

    const aspect = texW / texH;
    const scale = spec.scale ?? 1;
    // A Sprite ALWAYS faces the camera — right for a nameplate, wrong for a
    // sign fixed to a wall. The world-fixed path builds a real quad instead,
    // and keeps the default render order so geometry in front of it occludes
    // it properly.
    let sprite: THREE.Object3D;
    let mat: THREE.SpriteMaterial | THREE.MeshBasicMaterial = material;
    if (spec.billboard === false) {
      mat = new T.MeshBasicMaterial({
        map: texture,
        color: material.color,
        transparent: true,
        depthWrite: false,
        side: T.DoubleSide,
      });
      sprite = new T.Mesh(new T.PlaneGeometry(scale * aspect, scale), mat);
      if (spec.rotation) {
        sprite.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
      }
    } else {
      sprite = new T.Sprite(material);
      sprite.scale.set(scale * aspect, scale, 1);
      // Draw sprites after meshes so the label doesn't get occluded in-plane.
      sprite.renderOrder = 999;
    }
    sprite.name = `Label_${id}`;
    this.scene!.add(sprite);

    const handle = this.makeHandle<LabelHandle>('label', id);
    this.labels.set(handle, {
      sprite,
      material: mat,
      texture,
      canvas,
      baseScale: scale,
      fontSize,
      fontWeight,
      aspect,
      background: spec.background,
      borderColor: spec.borderColor,
    });
    return handle;
  }

  setLabelText(h: LabelHandle, text: string): void {
    const entry = this.labels.get(h);
    if (!entry) return;
    this.drawLabelText(
      entry.canvas, text, entry.fontSize, entry.fontWeight,
      entry.background, entry.borderColor,
    );
    entry.texture.needsUpdate = true;
  }

  setLabelPosition(h: LabelHandle, x: number, y: number, z: number): void {
    const entry = this.labels.get(h);
    if (entry) entry.sprite.position.set(x, y, z);
  }

  setLabelColor(h: LabelHandle, r: number, g: number, b: number): void {
    const T = this.THREE;
    const entry = this.labels.get(h);
    if (entry && T) entry.material.color.setRGB(r, g, b, T.SRGBColorSpace);
  }

  setLabelAlpha(h: LabelHandle, alpha: number): void {
    const entry = this.labels.get(h);
    if (entry) entry.material.opacity = alpha;
  }

  setLabelScale(h: LabelHandle, scale: number): void {
    const entry = this.labels.get(h);
    if (entry) entry.sprite.scale.set(scale * entry.aspect, scale, 1);
  }

  setLabelVisible(h: LabelHandle, visible: boolean): void {
    const entry = this.labels.get(h);
    if (entry) entry.sprite.visible = visible;
  }

  disposeLabel(h: LabelHandle): void {
    const entry = this.labels.get(h);
    if (!entry) return;
    this.scene?.remove(entry.sprite);
    entry.material.dispose();
    entry.texture.dispose();
    this.labels.delete(h);
  }

  private drawLabelText(
    canvas: HTMLCanvasElement,
    text: string,
    fontSize: number,
    fontWeight: 'normal' | 'bold',
    background?: string,
    borderColor?: string,
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Optional sign plate: a filled background rect over the whole canvas with
    // an optional border stroked just inside its edge, drawn before the text
    // so the glyphs sit on top. Mirrors Buildings.createSignMeshes.
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
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.strokeText(text, cx, cy);
    ctx.fillText(text, cx, cy);
  }

  /**
   * Look up a cached AnimationAction for (meshId, clipName). Returns
   * undefined when the mesh has no mixer yet (primitive meshes always fall
   * in this bucket and all animation calls become no-ops on them — the
   * same semantics as BabylonAdapter).
   */
  private findAnimationAction(meshId: string, clipName: string) {
    return this.animationActions.get(`${meshId}/${clipName}`);
  }

  playAnimation(meshId: string, clipName: string, loop = true): void {
    const action = this.findAnimationAction(meshId, clipName);
    if (!action || !this.THREE) return;
    action.setLoop(
      loop ? this.THREE.LoopRepeat : this.THREE.LoopOnce,
      loop ? Infinity : 1,
    );
    if (!action.isRunning()) action.play();
  }
  stopAnimation(meshId: string, clipName: string): void {
    this.findAnimationAction(meshId, clipName)?.stop();
  }
  setAnimationWeight(meshId: string, clipName: string, weight: number): void {
    this.findAnimationAction(meshId, clipName)?.setEffectiveWeight(weight);
  }
  setAnimationSpeed(meshId: string, clipName: string, speed: number): void {
    this.findAnimationAction(meshId, clipName)?.setEffectiveTimeScale(speed);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase-3 visual capabilities.
  // ═══════════════════════════════════════════════════════════════════════

  // ─── Procedural seeded geometry ───
  createProceduralMesh(id: string, spec: ProceduralMeshSpec, mat?: MaterialSpec): MeshHandle {
    const T = this.requireThree();
    const scene = this.scene!;
    const isRock = isRockShape(spec.shape);
    const geometry = isRock ? this.buildRockGeometry(T, spec) : this.buildShipGeometry(T, spec);

    const col = spec.color ?? mat?.diffuse ?? [0.5, 0.5, 0.5];
    const emissive = spec.emissive ?? 0;
    const material = new T.MeshStandardMaterial({
      color: this.toSRGB(col),
      roughness: isRock ? 0.95 : 0.55,
      metalness: isRock ? 0.05 : 0.25,
      emissive: emissive > 0 ? this.toSRGB(col) : new T.Color(0, 0, 0),
      emissiveIntensity: emissive,
    });

    const mesh = new T.Mesh(geometry, material);
    mesh.name = id;
    mesh.castShadow = true;
    mesh.receiveShadow = isRock;
    scene.add(mesh);

    const handle = this.makeHandle<MeshHandle>('procMesh', id);
    this.meshes.set(handle, mesh);
    this.meshesByMeshId.set(id, mesh);
    return handle;
  }

  sampleProceduralSurface(spec: ProceduralMeshSpec, dirX: number, dirY: number, dirZ: number, out: Vec3): Vec3 {
    // Pure, engine-free shared math — usable before init(). Non-rock shapes leave
    // `out` untouched (they have no radial surface field).
    return sampleRockSurface(spec, dirX, dirY, dirZ, out);
  }

  /**
   * Build a seeded rock by displacing every vertex of a unit icosphere with the
   * SAME pure field `sampleProceduralSurface` exposes, so the rendered silhouette
   * and the sampled surface agree byte-for-byte. Three is right-handed (matching
   * the locked convention), so there's no winding flip. computeVertexNormals after
   * the displacement re-lights the faceted rock correctly.
   */
  private buildRockGeometry(T: typeof THREE, spec: ProceduralMeshSpec): THREE.BufferGeometry {
    // Map Babylon's edge-split `subdivisions` (triangles ≈ 20·N²) onto Three's
    // icosahedron `detail` (triangles = 20·4^detail ⇒ N = 2^detail).
    const subdivisions = spec.subdivisions ?? 14;
    const detail = Math.max(1, Math.min(5, Math.round(Math.log2(Math.max(2, subdivisions)))));
    const geo = new T.IcosahedronGeometry(1, detail);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const out: Vec3 = [0, 0, 0];
    for (let i = 0; i < pos.count; i++) {
      sampleRockSurface(spec, pos.getX(i), pos.getY(i), pos.getZ(i), out);
      pos.setXYZ(i, out[0], out[1], out[2]);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * Build a named ship/missile/waypoint silhouette as ONE merged BufferGeometry
   * from welded primitive groups. Every shape is `+Z` forward, `+Y` up (the locked
   * handedness). `size` is `[width, height, length]`.
   */
  private buildShipGeometry(T: typeof THREE, spec: ProceduralMeshSpec): THREE.BufferGeometry {
    const W = spec.size[0] || 1;
    const H = spec.size[1] || 0.5;
    const L = spec.size[2] || 2;
    const parts: THREE.BufferGeometry[] = [];
    const box = (sx: number, sy: number, sz: number, tx = 0, ty = 0, tz = 0) => {
      const g = new T.BoxGeometry(sx, sy, sz); g.translate(tx, ty, tz); return g;
    };
    // Cylinder/cone along +Z (Three builds them along +Y; rotateX(+90°) maps +Y→+Z).
    const cylZ = (r: number, len: number, tz = 0) => {
      const g = new T.CylinderGeometry(r, r, len, 12); g.rotateX(Math.PI / 2); g.translate(0, 0, tz); return g;
    };
    const coneZ = (r: number, len: number, tz = 0) => {
      const g = new T.ConeGeometry(r, len, 12); g.rotateX(Math.PI / 2); g.translate(0, 0, tz); return g;
    };
    switch (spec.shape) {
      case 'spaceplane':
      case 'kilrathi': {
        const wing = spec.shape === 'kilrathi' ? 0.85 : 1; // kilrathi = swept/stubbier
        parts.push(cylZ(W * 0.16, L * 0.7, 0));                  // fuselage
        parts.push(coneZ(W * 0.16, L * 0.32, L * 0.5));          // nose at +Z
        parts.push(box(W, H * 0.18, L * 0.34 * wing, 0, 0, -L * 0.05)); // wings
        parts.push(box(W * 0.08, H * 0.55, L * 0.18, 0, H * 0.3, -L * 0.4)); // tail fin
        break;
      }
      case 'freighter-head': {
        parts.push(box(W, H, L * 0.8));                          // locomotive body
        parts.push(box(W * 0.6, H * 0.7, L * 0.3, 0, H * 0.2, L * 0.45)); // cockpit nub
        break;
      }
      case 'freighter-car':
        parts.push(box(W, H, L));                                // long container car
        break;
      case 'missile':
        parts.push(cylZ(W * 0.4, L * 0.8, -L * 0.1));            // body
        parts.push(coneZ(W * 0.4, L * 0.3, L * 0.45));           // nose cone +Z
        parts.push(box(W * 1.2, H * 0.05, L * 0.12, 0, 0, -L * 0.4)); // tail fins
        break;
      case 'waypoint':
        parts.push(new T.TorusGeometry(W * 0.5, W * 0.06, 12, 32)); // gate ring (faces +Z)
        break;
      default:
        parts.push(box(W, H, L));
    }
    return mergeGeometriesPure(T, parts);
  }

  // ─── Runtime dynamic textures (CPU pixel buffer → DataTexture) ───
  createDynamicTexture(key: string, spec: DynamicTextureSpec): TextureHandle {
    const T = this.requireThree();
    const cached = this.dynamicTexturesByKey.get(key);
    if (cached) return cached;
    const tex = new T.DataTexture(spec.pixels, spec.width, spec.height, T.RGBAFormat, T.UnsignedByteType);
    tex.colorSpace = spec.srgb ? T.SRGBColorSpace : T.LinearSRGBColorSpace;
    const wrap =
      spec.wrap === 'clamp' ? T.ClampToEdgeWrapping :
      spec.wrap === 'mirror' ? T.MirroredRepeatWrapping :
      T.RepeatWrapping;
    tex.wrapS = wrap;
    tex.wrapT = wrap;
    if (spec.uScale !== undefined || spec.vScale !== undefined) {
      tex.repeat.set(spec.uScale ?? 1, spec.vScale ?? 1);
    }
    // DataTextures default to no mipmaps; keep it simple (no POT-warning paths).
    tex.minFilter = T.LinearFilter;
    tex.magFilter = T.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    const handle = this.makeHandle<TextureHandle>('dynTex', key);
    this.textures.set(handle, tex);
    this.dynamicTexturesByKey.set(key, handle);
    return handle;
  }

  updateDynamicTexture(h: TextureHandle, pixels: Uint8ClampedArray | Uint8Array): void {
    const tex = this.textures.get(h) as THREE.DataTexture | undefined;
    if (!tex || !tex.image) return;
    (tex.image as { data: Uint8ClampedArray | Uint8Array }).data = pixels;
    tex.needsUpdate = true;
  }

  // ─── Particle systems (THREE.Points pool + CPU integrator) ───
  createParticleBurst(spec: ParticleBurstSpec): void {
    const T = this.requireThree();
    const tex = this.textures.get(spec.texture);
    const rt = this.createParticleRuntime(T, {
      capacity: Math.max(1, spec.count),
      texture: tex,
      blend: spec.blend ?? 'add',
      position: spec.position,
      emitRadius: spec.emitRadius,
      emitRadiusRange: spec.emitRadiusRange ?? 1,
      minSize: spec.minSize, maxSize: spec.maxSize,
      minLifeTime: spec.minLifeTime, maxLifeTime: spec.maxLifeTime,
      minEmitPower: spec.minEmitPower, maxEmitPower: spec.maxEmitPower,
      color1: spec.color1, color2: spec.color2, colorDead: spec.colorDead,
      gravity: spec.gravity ?? [0, 0, 0],
    });
    rt.continuous = false;
    rt.duration = spec.duration ?? 0.06;
    // One-shot: emit the whole count now (Babylon's manualEmitCount).
    for (let i = 0; i < spec.count; i++) this.spawnParticle(rt);
    this.particleRuntimes.add(rt);
  }

  createParticleEmitter(id: string, spec: ParticleEmitterSpec): ParticleEmitterHandle {
    const T = this.requireThree();
    const tex = this.textures.get(spec.texture);
    const rt = this.createParticleRuntime(T, {
      capacity: spec.capacity,
      texture: tex,
      blend: spec.blend ?? 'add',
      position: spec.position,
      emitRadius: spec.emitRadius,
      emitRadiusRange: spec.emitRadiusRange ?? 0.2,
      minSize: spec.minSize, maxSize: spec.maxSize,
      minLifeTime: spec.minLifeTime, maxLifeTime: spec.maxLifeTime,
      minEmitPower: spec.minEmitPower, maxEmitPower: spec.maxEmitPower,
      color1: spec.color1, color2: spec.color2, colorDead: spec.colorDead,
      gravity: spec.gravity ?? [0, 0, 0],
    });
    rt.continuous = true;
    rt.followCamera = !!spec.followCamera;
    rt.emitRate = spec.emitRate;
    // Pre-warm so the field is already populated on frame 1 (Babylon preWarmCycles).
    const cycles = spec.preWarmCycles ?? 0;
    for (let c = 0; c < cycles; c++) this.advanceParticleRuntime(rt, 1 / 60, undefined);
    const handle = this.makeHandle<ParticleEmitterHandle>('emitter', id);
    this.particleRuntimes.add(rt);
    this.particleEmitters.set(handle, rt);
    return handle;
  }

  setParticleEmitterPosition(h: ParticleEmitterHandle, x: number, y: number, z: number): void {
    const rt = this.particleEmitters.get(h);
    if (!rt) return;
    rt.position = [x, y, z];
    // followCamera overrides this each frame; otherwise it sticks.
    if (!rt.followCamera) rt.points.position.set(x, y, z);
  }

  disposeParticleEmitter(h: ParticleEmitterHandle): void {
    const rt = this.particleEmitters.get(h);
    if (!rt) return; // idempotent
    this.disposeParticleRuntime(rt);
    this.particleEmitters.delete(h);
  }

  /** Allocate a Points pool + custom additive material; the integrator fills it. */
  private createParticleRuntime(
    T: typeof THREE,
    o: {
      capacity: number; texture?: THREE.Texture; blend: 'add' | 'standard' | 'multiply';
      position?: Vec3; emitRadius: number; emitRadiusRange: number;
      minSize: number; maxSize: number; minLifeTime: number; maxLifeTime: number;
      minEmitPower: number; maxEmitPower: number;
      color1: Color4; color2: Color4; colorDead: Color4; gravity: Vec3;
    },
  ): ParticleRuntime {
    const capacity = Math.max(1, o.capacity);
    const geometry = new T.BufferGeometry();
    const positions = new Float32Array(capacity * 3);
    const colors = new Float32Array(capacity * 3);
    const sizes = new Float32Array(capacity);
    const posAttr = new T.Float32BufferAttribute(positions, 3);
    const colAttr = new T.Float32BufferAttribute(colors, 3);
    const sizeAttr = new T.Float32BufferAttribute(sizes, 1);
    posAttr.setUsage(T.DynamicDrawUsage);
    colAttr.setUsage(T.DynamicDrawUsage);
    sizeAttr.setUsage(T.DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('pcolor', colAttr);
    geometry.setAttribute('psize', sizeAttr);
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = new T.Sphere(new T.Vector3(), 1e7); // never frustum-cull

    const blending =
      o.blend === 'standard' ? T.NormalBlending :
      o.blend === 'multiply' ? T.MultiplyBlending :
      T.AdditiveBlending;
    const material = new T.ShaderMaterial({
      uniforms: { map: { value: o.texture ?? null }, useMap: { value: o.texture ? 1 : 0 } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
    });

    const points = new T.Points(geometry, material);
    points.name = 'particles';
    points.frustumCulled = false;
    (points as unknown as { raycast: () => void }).raycast = () => {};
    const pos = o.position ?? [0, 0, 0];
    points.position.set(pos[0], pos[1], pos[2]);
    this.scene!.add(points);

    const slots: ParticleSlot[] = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      slots[i] = { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 0, size: 0, active: false };
    }
    return {
      points, geometry, material, posAttr, colAttr, sizeAttr,
      positions, colors, sizes, slots,
      continuous: false, followCamera: false, emitRate: 0, emitAccumulator: 0,
      age: 0, duration: undefined, position: [pos[0], pos[1], pos[2]],
      emitRadius: o.emitRadius, emitRadiusRange: o.emitRadiusRange,
      minSize: o.minSize, maxSize: o.maxSize, minLifeTime: o.minLifeTime, maxLifeTime: o.maxLifeTime,
      minEmitPower: o.minEmitPower, maxEmitPower: o.maxEmitPower,
      color1: o.color1, color2: o.color2, colorDead: o.colorDead, gravity: o.gravity,
    };
  }

  /** Activate one dead slot from a sphere emitter; returns false when full. */
  private spawnParticle(rt: ParticleRuntime): boolean {
    let slot: ParticleSlot | undefined;
    for (let i = 0; i < rt.slots.length; i++) {
      if (!rt.slots[i]!.active) { slot = rt.slots[i]; break; }
    }
    if (!slot) return false;
    // Random unit direction on a sphere (emitRadiusRange biases toward an outer
    // shell as it → 1; a thin inner core as it → 0).
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const dx = s * Math.cos(th), dy = s * Math.sin(th), dz = u;
    const rFrac = 1 - Math.random() * (1 - rt.emitRadiusRange);
    const r = rt.emitRadius * rFrac;
    slot.px = dx * r; slot.py = dy * r; slot.pz = dz * r; // LOCAL to the Points origin
    const power = rt.minEmitPower + Math.random() * (rt.maxEmitPower - rt.minEmitPower);
    slot.vx = dx * power; slot.vy = dy * power; slot.vz = dz * power;
    slot.life = rt.minLifeTime + Math.random() * (rt.maxLifeTime - rt.minLifeTime);
    slot.size = rt.minSize + Math.random() * (rt.maxSize - rt.minSize);
    slot.age = 0;
    slot.active = true;
    return true;
  }

  private _pcol: Color4 = [0, 0, 0, 0];
  /** Advance one particle system by `dt`, repacking live particles into the GPU buffers. */
  private advanceParticleRuntime(rt: ParticleRuntime, dt: number, camera?: THREE.PerspectiveCamera): void {
    if (rt.followCamera && camera) rt.points.position.copy(camera.position);
    if (rt.continuous) {
      rt.emitAccumulator += rt.emitRate * dt;
      while (rt.emitAccumulator >= 1) {
        rt.emitAccumulator -= 1;
        if (!this.spawnParticle(rt)) { rt.emitAccumulator = 0; break; }
      }
    }
    let live = 0;
    const col = this._pcol;
    for (let i = 0; i < rt.slots.length; i++) {
      const sl = rt.slots[i]!;
      if (!sl.active) continue;
      sl.age += dt;
      if (sl.age >= sl.life) { sl.active = false; continue; }
      sl.vx += rt.gravity[0] * dt; sl.vy += rt.gravity[1] * dt; sl.vz += rt.gravity[2] * dt;
      sl.px += sl.vx * dt; sl.py += sl.vy * dt; sl.pz += sl.vz * dt;
      // Two-segment color-over-life lerp: color1 → color2 → colorDead.
      lerpColor4(rt.color1, rt.color2, rt.colorDead, sl.age / sl.life, col);
      const a = col[3];
      const j3 = live * 3;
      rt.positions[j3] = sl.px; rt.positions[j3 + 1] = sl.py; rt.positions[j3 + 2] = sl.pz;
      // Pre-multiply by alpha so additive blending fades correctly without a
      // per-vertex alpha channel.
      rt.colors[j3] = col[0] * a; rt.colors[j3 + 1] = col[1] * a; rt.colors[j3 + 2] = col[2] * a;
      rt.sizes[live] = sl.size;
      live++;
    }
    rt.geometry.setDrawRange(0, live);
    rt.posAttr.needsUpdate = true;
    rt.colAttr.needsUpdate = true;
    rt.sizeAttr.needsUpdate = true;
    if (!rt.continuous) {
      rt.age += dt;
      // Auto-dispose a one-shot burst once every particle has died.
      if (live === 0 && rt.age > 0) this.disposeParticleRuntime(rt);
    }
  }

  private updateParticles(dt: number, camera: THREE.PerspectiveCamera): void {
    // Snapshot first: advanceParticleRuntime can dispose (mutating the set).
    for (const rt of [...this.particleRuntimes]) this.advanceParticleRuntime(rt, dt, camera);
  }

  private disposeParticleRuntime(rt: ParticleRuntime): void {
    this.scene?.remove(rt.points);
    rt.geometry.dispose();
    rt.material.dispose();
    this.particleRuntimes.delete(rt);
  }

  // ─── Post-process glow / bloom + emissive + render ordering ───
  setGlowLayer(spec: GlowSpec | null): void {
    this.glowSpec = spec;
    if (!spec) {
      for (const h of this.glowMeshes) this.meshes.get(h)?.layers.disable(BLOOM_LAYER);
      this.glowMeshes.clear();
    }
    this.refreshComposer();
  }

  addGlowMesh(h: MeshHandle): void {
    if (!this.glowSpec) return; // no-op when the glow layer is disabled
    this.glowMeshes.add(h);
    this.meshes.get(h)?.layers.enable(BLOOM_LAYER);
  }

  removeGlowMesh(h: MeshHandle): void {
    this.glowMeshes.delete(h);
    this.meshes.get(h)?.layers.disable(BLOOM_LAYER);
  }

  setBloom(spec: BloomSpec | null): void {
    this.bloomSpec = spec;
    this.refreshComposer();
  }

  /**
   * Reconcile the post-process composer with the current glow/bloom config.
   * Selective glow is APPROXIMATED by the same UnrealBloom pass (the whitelist is
   * tracked via {@link BLOOM_LAYER} for a future selective-bloom mask); both
   * `glowSpec` and `bloomSpec` drive one bloom pass. Building the composer is
   * lazy + capability-guarded, so headless callers (the contract) just bookkeep.
   */
  private refreshComposer(): void {
    if (this.bloomSpec || this.glowSpec) {
      void this.ensureComposer();
    } else {
      this.disposeComposer();
    }
    if (this.bloomPass) {
      this.bloomPass.strength = this.bloomSpec?.weight ?? this.glowSpec?.intensity ?? 0.8;
      if (this.bloomSpec?.threshold !== undefined) this.bloomPass.threshold = this.bloomSpec.threshold;
      if (this.bloomSpec?.scale !== undefined) this.bloomPass.radius = this.bloomSpec.scale;
    }
  }

  private async ensureComposer(): Promise<void> {
    if (this.composer || this.composerPending) return;
    const T = this.THREE;
    // Only a real WebGLRenderer (not the headless contract stub) exposes these —
    // bail otherwise so glow/bloom stay pure config bookkeeping in tests.
    const r = this.renderer as unknown as { getSize?: unknown; getPixelRatio?: unknown } | undefined;
    if (!T || !this.scene || !r || typeof r.getSize !== 'function' || typeof r.getPixelRatio !== 'function') {
      return;
    }
    this.composerPending = true;
    try {
      const ecSpec = 'three/addons/postprocessing/EffectComposer.js';
      const rpSpec = 'three/addons/postprocessing/RenderPass.js';
      const ubSpec = 'three/addons/postprocessing/UnrealBloomPass.js';
      const opSpec = 'three/addons/postprocessing/OutputPass.js';
      const [ec, rp, ub, op] = await Promise.all([
        import(/* @vite-ignore */ ecSpec) as Promise<{ EffectComposer: new (r: unknown) => { addPass(p: unknown): void; render(): void; setSize(w: number, h: number): void; dispose(): void } }>,
        import(/* @vite-ignore */ rpSpec) as Promise<{ RenderPass: new (s: unknown, c: unknown) => unknown }>,
        import(/* @vite-ignore */ ubSpec) as Promise<{ UnrealBloomPass: new (res: unknown, strength: number, radius: number, threshold: number) => { strength: number; threshold: number; radius: number } }>,
        import(/* @vite-ignore */ opSpec) as Promise<{ OutputPass: new () => unknown }>,
      ]);
      const size = (this.renderer as unknown as { getSize(v: THREE.Vector2): THREE.Vector2 }).getSize(new T.Vector2());
      const composer = new ec.EffectComposer(this.renderer);
      composer.addPass(new rp.RenderPass(this.scene, this.renderCamera()));
      const strength = this.bloomSpec?.weight ?? this.glowSpec?.intensity ?? 0.8;
      const bloom = new ub.UnrealBloomPass(
        new T.Vector2(size.x || 1, size.y || 1),
        strength,
        this.bloomSpec?.scale ?? 0.4,
        this.bloomSpec?.threshold ?? 0.85,
      );
      composer.addPass(bloom);
      composer.addPass(new op.OutputPass());
      this.composer = composer;
      this.bloomPass = bloom;
    } catch (err) {
      // Addons unavailable (or a non-GL renderer) — fall back to direct rendering.
      console.warn('[ThreeAdapter] bloom composer unavailable; rendering without post-process', err);
    } finally {
      this.composerPending = false;
    }
  }

  private disposeComposer(): void {
    this.composer?.dispose?.();
    this.composer = undefined;
    this.bloomPass = undefined;
  }

  setMeshEmissiveById(meshId: string, r: number, g: number, b: number, intensity: number): void {
    const mesh = this.meshesByMeshId.get(meshId);
    if (!mesh) return; // unknown id → no-op
    const apply = (m: THREE.Material): void => {
      const anyMat = m as unknown as {
        isMeshBasicMaterial?: boolean;
        color?: THREE.Color;
        emissive?: THREE.Color;
        emissiveIntensity?: number;
        needsUpdate?: boolean;
      };
      if (anyMat.isMeshBasicMaterial || !anyMat.emissive) {
        // Unlit material (sun disc, waypoint gate): treat the value as a literal,
        // clamped color so bloom + tonemap don't blow it to white.
        anyMat.color?.setRGB(clamp01(r), clamp01(g), clamp01(b));
      } else {
        // Lit material: emissive overpowers lighting at the given intensity.
        anyMat.emissive.setRGB(r, g, b);
        anyMat.emissiveIntensity = intensity;
      }
      anyMat.needsUpdate = true;
    };
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach(apply);
    else if (mat) apply(mat);
  }

  setMeshRenderingOptions(h: MeshHandle, opts: MeshRenderOptions): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    // renderingGroupId → renderOrder (higher draws later/on top); Three has no
    // separate render groups, but renderOrder gives the same layering.
    if (opts.renderingGroupId !== undefined) mesh.renderOrder = opts.renderingGroupId;
    const applyMat = (m: THREE.Material): void => {
      const anyMat = m as unknown as { depthWrite?: boolean; fog?: boolean; needsUpdate?: boolean };
      if (opts.disableDepthWrite !== undefined) anyMat.depthWrite = !opts.disableDepthWrite;
      if (opts.applyFog !== undefined && 'fog' in anyMat) anyMat.fog = opts.applyFog;
      anyMat.needsUpdate = true;
    };
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach(applyMat);
    else if (mat) applyMat(mat);
    // Three has no infiniteDistance flag — re-seat the mesh at the camera each
    // frame instead (skybox dome that never parallaxes).
    if (opts.infiniteDistance !== undefined) {
      if (opts.infiniteDistance) { this.infiniteDistanceMeshes.add(mesh); mesh.frustumCulled = false; }
      else this.infiniteDistanceMeshes.delete(mesh);
    }
    // pickable → a userData flag honored by pickAtScreenPoint's target filter.
    if (opts.pickable !== undefined) mesh.userData.pickable = opts.pickable;
  }

  private updateInfiniteDistance(camera: THREE.PerspectiveCamera): void {
    for (const mesh of this.infiniteDistanceMeshes) mesh.position.copy(camera.position);
  }

  // ─── Camera-following sun + directional-light query ───
  createSun(id: string, spec: SunSpec): LightHandle {
    const T = this.requireThree();
    const scene = this.scene!;
    // Directional light whose rays TRAVEL along spec.direction (it sits up-sun).
    const light = new T.DirectionalLight(this.toSRGB(spec.diffuse), spec.intensity);
    light.name = `Sun_${id}`;
    const dl = Math.hypot(spec.direction[0], spec.direction[1], spec.direction[2]) || 1;
    const dir: Vec3 = [spec.direction[0] / dl, spec.direction[1] / dl, spec.direction[2] / dl];
    scene.add(light);
    scene.add(light.target);

    if (spec.shadow?.enabled) {
      this.enableShadowMap();
      light.castShadow = true;
      light.shadow.mapSize.set(spec.shadow.mapSize, spec.shadow.mapSize);
      if (spec.shadow.bias !== undefined) light.shadow.bias = spec.shadow.bias;
      if (spec.shadow.normalBias !== undefined) light.shadow.normalBias = spec.shadow.normalBias;
      // Wide orthographic frustum so big rocks cast across the field.
      const cam = light.shadow.camera;
      const ext = Math.max(50, spec.distance / 20);
      cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
      cam.near = 0.5; cam.far = spec.distance * 2;
      cam.updateProjectionMatrix();
      // Three has no shadow `darkness`/`forceBackFacesOnly`; closest analogues:
      if (spec.shadow.forceBackFacesOnly) light.shadow.bias = light.shadow.bias || -0.0008;
    }

    // Emissive disc parked at `camera − direction*distance` so it reads as an
    // infinitely-distant star (unlit, never fogged, drawn after geometry).
    const discDiameter = spec.discDiameter ?? 90;
    const dc = spec.discColor ?? [10, 9, 7];
    const discMat = new T.MeshBasicMaterial({
      color: new T.Color(dc[0], dc[1], dc[2]), // HDR (raw, no sRGB clamp) to clear bloom
      depthWrite: false,
      fog: false,
    });
    const disc = new T.Mesh(new T.SphereGeometry(discDiameter / 2, 24, 24), discMat);
    disc.name = `SunDisc_${id}`;
    disc.frustumCulled = false;
    disc.renderOrder = 1;
    (disc as unknown as { raycast: () => void }).raycast = () => {};
    scene.add(disc);

    this.sun = { light, disc, direction: dir, distance: spec.distance };
    this.positionSunDisc(this.renderCamera());

    const handle = this.makeHandle<LightHandle>('sun', id);
    this.lights.set(handle, light);
    return handle;
  }

  getSunWorldPosition(out: Vec3): Vec3 | null {
    if (!this.sun || !this.THREE) return null;
    const v = this.sun.disc.getWorldPosition(this._sunVec ??= new this.THREE.Vector3());
    out[0] = v.x; out[1] = v.y; out[2] = v.z;
    return out;
  }

  /** Re-seat the sun disc + light up-sun of the active camera (parallax-free). */
  private positionSunDisc(camera?: THREE.PerspectiveCamera): void {
    if (!this.sun) return;
    const cam = camera ?? this.renderCamera();
    const cx = cam?.position.x ?? 0, cy = cam?.position.y ?? 0, cz = cam?.position.z ?? 0;
    const { direction: d, distance: dist } = this.sun;
    this.sun.disc.position.set(cx - d[0] * dist, cy - d[1] * dist, cz - d[2] * dist);
    // Park the directional light up-sun of the camera and aim it at the camera so
    // its ortho shadow frustum tracks the scene around the player.
    this.sun.light.position.set(cx - d[0] * dist * 0.5, cy - d[1] * dist * 0.5, cz - d[2] * dist * 0.5);
    this.sun.light.target.position.set(cx, cy, cz);
  }

  /** sRGB-tagged color (matches how scene-JSON numbers are authored). */
  private toSRGB(rgb: Color): THREE.Color {
    const T = this.THREE!;
    return new T.Color().setRGB(rgb[0], rgb[1], rgb[2], T.SRGBColorSpace);
  }

  startLoop(onFrame: (dtSeconds: number) => void): void {
    if (!this.renderer || !this.scene) {
      throw new Error('ThreeAdapter.startLoop: call init() first');
    }
    this.onFrame = onFrame;
    this.lastTime = performance.now();

    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;
      // Keep the drawing buffer + camera aspect synced to the canvas each frame
      // (Babylon's engine does this automatically; Three needs it explicit).
      const c = this.canvas;
      if (c && (c.clientWidth !== this._lastCanvasW || c.clientHeight !== this._lastCanvasH)) {
        this._lastCanvasW = c.clientWidth;
        this._lastCanvasH = c.clientHeight;
        if (c.clientWidth > 0 && c.clientHeight > 0) this.resize();
      }
      this.onFrame?.(dt);
      // Advance any registered animation mixers so playing clips actually
      // move. Mixers are lazily created the first time a mesh's clip is
      // played; primitive meshes have none.
      for (const mixer of this.animationMixers.values()) mixer.update(dt);
      // Draw through the active free camera if one exists, else the first
      // registered arc camera, else the default fallback.
      const camera = this.renderCamera();
      if (camera) {
        if (this.billboards.size > 0) this.updateBillboards(camera);
        // Phase-3: keep the camera-anchored sun + skybox-style meshes parked on
        // the camera, advance the CPU particle integrator, then draw — through
        // the bloom composer when one is live, else straight to the canvas.
        if (this.sun) this.positionSunDisc(camera);
        if (this.infiniteDistanceMeshes.size > 0) this.updateInfiniteDistance(camera);
        if (this.particleRuntimes.size > 0) this.updateParticles(dt, camera);
        if (this.composer) this.composer.render();
        else this.renderer!.render(this.scene!, camera);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.onFrame = undefined;
  }

  resize(): void {
    if (!this.renderer) return;
    const c = this.canvas;
    const w = c?.clientWidth || window.innerWidth;
    const h = c?.clientHeight || window.innerHeight;
    // `false` keeps the canvas CSS size intact (set by the grid layout); only
    // the drawing buffer resizes.
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    const aspect = w / h;
    for (const { camera } of this.cameras.values()) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
    if (this.defaultCamera) {
      this.defaultCamera.aspect = aspect;
      this.defaultCamera.updateProjectionMatrix();
    }
    // Resizing the WebGL drawing buffer clears it. Paint a fresh frame
    // synchronously so the compositor never picks up the cleared buffer
    // between the resize and the next rAF tick.
    if (this.scene) {
      const camera = this.renderCamera();
      if (camera) {
        if (this.composer) this.composer.render();
        else this.renderer.render(this.scene, camera);
      }
    }
  }

  dispose(): void {
    this.stopLoop();
    this.physicsCore?.reset();
    this.physicsCore = null;
    this.clearColliderDebug();
    this.rapier?.free();
    this.rapier = null;
    this.rapierReady = false;
    this.rapierInitPromise = null;
    this.pendingRapierCreates = [];
    this.billboards.clear();
    this.boxExtentOverrides.clear();
    // ─── Phase-3 teardown (while the scene still exists) ───
    for (const rt of this.particleRuntimes) {
      this.scene?.remove(rt.points);
      rt.geometry.dispose();
      rt.material.dispose();
    }
    this.particleRuntimes.clear();
    this.particleEmitters.clear();
    this.disposeComposer();
    this.glowMeshes.clear();
    this.glowSpec = null;
    this.bloomSpec = null;
    this.infiniteDistanceMeshes.clear();
    if (this.sun) {
      this.scene?.remove(this.sun.light);
      this.scene?.remove(this.sun.light.target);
      this.scene?.remove(this.sun.disc);
      this.sun.disc.geometry.dispose();
      (this.sun.disc.material as THREE.Material).dispose();
      this.sun = undefined;
    }
    this.dynamicTexturesByKey.clear();
    this.renderer?.dispose();
    this.renderer = undefined;
    this.scene = undefined;
    for (const field of this.thinFields.values()) {
      field.mesh.geometry.dispose();
      field.mesh.dispose();
    }
    this.thinFields.clear();
    for (const tex of this.textures.values()) tex.dispose();
    this.textures.clear();
    this.texturesByKey.clear();
    for (const card of this.cards.values()) card.cornerMask.dispose();
    this.cards.clear();
    this.lines.clear();
    this.meshes.clear();
    this.meshesByMeshId.clear();
    this.lights.clear();
    this.cameras.clear();
    this.labels.clear();
    this.animationMixers.clear();
    this.animationActions.clear();
  }

  private _bbCamPos?: THREE.Vector3;

  /**
   * Orient every billboarded mesh toward `camera`. 'all' copies the camera's
   * orientation so the mesh faces the screen plane (Babylon BILLBOARDMODE_ALL);
   * 'y' yaws the mesh to face the camera while staying upright (BILLBOARDMODE_Y).
   */
  private updateBillboards(camera: THREE.PerspectiveCamera): void {
    const T = this.THREE;
    if (!T) return;
    if (!this._bbCamPos) this._bbCamPos = new T.Vector3();
    camera.getWorldPosition(this._bbCamPos);
    for (const [h, mode] of this.billboards) {
      const mesh = this.meshes.get(h);
      if (!mesh) continue;
      if (mode === 'all') {
        mesh.quaternion.copy(camera.quaternion);
      } else {
        // Y-axis billboard: yaw toward the camera in the XZ plane only.
        const dx = this._bbCamPos.x - mesh.position.x;
        const dz = this._bbCamPos.z - mesh.position.z;
        mesh.rotation.set(0, Math.atan2(dx, dz), 0);
      }
    }
  }

  /** Lazily enables shadow map on the WebGLRenderer the first time a shadow-casting light is added. */
  enableShadowMap(): void {
    if (this.shadowMapEnabled || !this.renderer || !this.THREE) return;
    this.renderer.shadowMap.enabled = true;
    // PCFShadowMap (not PCFSoftShadowMap, deprecated in three r184+).
    this.renderer.shadowMap.type = this.THREE.PCFShadowMap;
    this.shadowMapEnabled = true;
  }
}

/** Flatten polylines into a flat XYZ buffer of segment endpoint pairs for THREE.LineSegments. */
function flattenSegments(lines: Vec3[][]): number[] {
  const out: number[] = [];
  for (const poly of lines) {
    for (let i = 0; i + 1 < poly.length; i++) {
      out.push(poly[i]![0], poly[i]![1], poly[i]![2]);
      out.push(poly[i + 1]![0], poly[i + 1]![1], poly[i + 1]![2]);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase-3 module-level helpers, constants, shaders + particle runtime types.
// ─────────────────────────────────────────────────────────────────────────

/** Three layer index used to mark glow-whitelisted meshes (selective-bloom mask). */
const BLOOM_LAYER = 1;

/** Clamp a scalar to [0,1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Two-segment color-over-life lerp `c1 → c2 → dead` at `t∈[0,1]`, written into
 * `out` (RGBA). The first half blends start→mid, the second half mid→dead — the
 * fire/energy color ramp.
 */
function lerpColor4(c1: Color4, c2: Color4, dead: Color4, t: number, out: Color4): Color4 {
  let a: Color4, b: Color4, f: number;
  if (t < 0.5) { a = c1; b = c2; f = t * 2; }
  else { a = c2; b = dead; f = (t - 0.5) * 2; }
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
  out[3] = a[3] + (b[3] - a[3]) * f;
  return out;
}

/**
 * Merge welded primitive groups into ONE non-indexed BufferGeometry by
 * concatenating position + normal attributes — a pure stand-in for the addons
 * `mergeGeometries` so the synchronous `createProceduralMesh` never needs the
 * (async) three/addons bundle. Each part's own translate/rotate is already baked
 * into its geometry before it reaches here.
 */
function mergeGeometriesPure(T: typeof THREE, parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  const flat: THREE.BufferGeometry[] = [];
  for (const p of parts) {
    if (!p.getAttribute('normal')) p.computeVertexNormals();
    const ni = p.index ? p.toNonIndexed() : p;
    total += (ni.getAttribute('position') as THREE.BufferAttribute).count;
    flat.push(ni);
  }
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  let off = 0;
  for (const ni of flat) {
    const pp = ni.getAttribute('position') as THREE.BufferAttribute;
    const nn = ni.getAttribute('normal') as THREE.BufferAttribute;
    positions.set(pp.array as ArrayLike<number>, off * 3);
    normals.set(nn.array as ArrayLike<number>, off * 3);
    off += pp.count;
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Soft-sprite point shader: per-particle size (size-attenuated by view depth) +
 * a pre-multiplied RGB color (alpha folded in so additive blending fades without
 * a per-vertex alpha channel), sampling the dot texture.
 */
const PARTICLE_VERT = /* glsl */ `
  attribute float psize;
  attribute vec3 pcolor;
  varying vec3 vColor;
  void main() {
    vColor = pcolor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = psize * (320.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const PARTICLE_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform int useMap;
  varying vec3 vColor;
  void main() {
    vec4 tex = useMap == 1 ? texture2D(map, gl_PointCoord) : vec4(1.0);
    gl_FragColor = vec4(vColor * tex.rgb, 1.0) * tex.a;
  }
`;

/** One CPU-integrated particle slot (object-local to its Points origin). */
interface ParticleSlot {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  age: number; life: number; size: number;
  active: boolean;
}

/** A live particle system (one-shot burst or continuous emitter). */
interface ParticleRuntime {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  posAttr: THREE.BufferAttribute;
  colAttr: THREE.BufferAttribute;
  sizeAttr: THREE.BufferAttribute;
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  slots: ParticleSlot[];
  continuous: boolean;
  followCamera: boolean;
  emitRate: number;
  emitAccumulator: number;
  age: number;
  duration?: number;
  position: Vec3;
  emitRadius: number;
  emitRadiusRange: number;
  minSize: number; maxSize: number;
  minLifeTime: number; maxLifeTime: number;
  minEmitPower: number; maxEmitPower: number;
  color1: Color4; color2: Color4; colorDead: Color4;
  gravity: Vec3;
}

interface XYZ { x: number; y: number; z: number }
interface XYZW { x: number; y: number; z: number; w: number }

/**
 * Rapier.js rigid-body world owned by ThreeAdapter — the engine-side physics
 * backend (the role Havok plays for BabylonAdapter). Pure numbers in, pure
 * numbers out: it never touches three.js, so the adapter handles all
 * mesh ↔ body transform syncing and quaternion ↔ Euler conversion. Lives inside
 * ThreeAdapter.ts (a coverage-excluded engine binding) because it can only run
 * with the WASM module loaded; it's exercised via browser/integration smoke,
 * not jsdom unit tests.
 */
class RapierPhysics {
  private readonly R: RapierModule;
  private world: RAPIER.World;
  private bodies = new Map<string, {
    body: RAPIER.RigidBody;
    collider: RAPIER.Collider;
    kinematic: boolean;
    drivenByMesh: boolean;
  }>();
  private fixedDt = 1 / 60;
  private accumulator = 0;

  constructor(R: RapierModule, gravityY = -30) {
    this.R = R;
    this.world = new R.World({ x: 0, y: gravityY, z: 0 });
    this.world.timestep = this.fixedDt;
  }

  createBody(meshId: string, opts: PhysicsBodyOpts, pos: XYZ, rot: XYZW, half: XYZ): void {
    if (this.bodies.has(meshId)) return;
    const R = this.R;
    const kinematic = opts.motionType === 'kinematic';
    const desc =
      opts.motionType === 'static'
        ? R.RigidBodyDesc.fixed()
        : kinematic
          ? R.RigidBodyDesc.kinematicPositionBased()
          : R.RigidBodyDesc.dynamic();
    desc.setTranslation(pos.x, pos.y, pos.z).setRotation(rot);
    if (opts.motionType === 'dynamic') desc.setAdditionalMass(opts.mass);
    // Match BabylonAdapter's lockRotation: suppress tumbling but keep Y turns.
    if (opts.lockRotation) desc.enabledRotations(false, true, false);
    const body = this.world.createRigidBody(desc);

    let cd: RAPIER.ColliderDesc;
    if (opts.shapeType === 'sphere') {
      cd = R.ColliderDesc.ball(Math.max(half.x, half.y, half.z));
    } else if (opts.shapeType === 'capsule') {
      const radius = Math.max(half.x, half.z);
      cd = R.ColliderDesc.capsule(Math.max(1e-3, half.y - radius), radius);
    } else {
      cd = R.ColliderDesc.cuboid(half.x, half.y, half.z);
    }
    // Density 0 so the body mass is exactly the additional mass set above.
    cd.setRestitution(opts.restitution).setFriction(opts.friction).setDensity(0);
    const collider = this.world.createCollider(cd, body);

    this.bodies.set(meshId, { body, collider, kinematic, drivenByMesh: false });
  }

  destroyBody(meshId: string): void {
    const rec = this.bodies.get(meshId);
    if (!rec) return;
    // Removing the body removes its attached colliders too.
    this.world.removeRigidBody(rec.body);
    this.bodies.delete(meshId);
  }

  setLinearVelocity(meshId: string, x: number, y: number, z: number): void {
    this.bodies.get(meshId)?.body.setLinvel({ x, y, z }, true);
  }

  setAngularVelocity(meshId: string, x: number, y: number, z: number): void {
    this.bodies.get(meshId)?.body.setAngvel({ x, y, z }, true);
  }

  setGravity(x: number, y: number, z: number): void {
    this.world.gravity = { x, y, z };
  }

  resizeBoxBody(meshId: string, hx: number, hy: number, hz: number): void {
    this.bodies.get(meshId)?.collider.setHalfExtents({ x: hx, y: hy, z: hz });
  }

  setRestitution(meshId: string, restitution: number): void {
    this.bodies.get(meshId)?.collider.setRestitution(restitution);
  }

  setTimeStep(hz: number): void {
    if (hz <= 0) return;
    this.fixedDt = 1 / hz;
    this.world.timestep = this.fixedDt;
  }

  setDrivenByMesh(meshId: string, drivenByMesh: boolean): void {
    const rec = this.bodies.get(meshId);
    if (rec) rec.drivenByMesh = drivenByMesh;
  }

  pushKinematic(
    meshId: string,
    x: number, y: number, z: number,
    qx: number, qy: number, qz: number, qw: number,
  ): void {
    const rec = this.bodies.get(meshId);
    if (!rec) return;
    if (rec.kinematic) {
      rec.body.setNextKinematicTranslation({ x, y, z });
      rec.body.setNextKinematicRotation({ x: qx, y: qy, z: qz, w: qw });
    } else {
      // Dynamic body driven by the mesh: teleport it into place.
      rec.body.setTranslation({ x, y, z }, true);
      rec.body.setRotation({ x: qx, y: qy, z: qz, w: qw }, true);
    }
  }

  setBodyState(meshId: string, pos: XYZ, rot: XYZW, lin: XYZ, ang: XYZ): void {
    const rec = this.bodies.get(meshId);
    if (!rec) return;
    rec.body.setTranslation(pos, true);
    rec.body.setRotation(rot, true);
    rec.body.setLinvel(lin, true);
    rec.body.setAngvel(ang, true);
  }

  getRaw(meshId: string): { t: XYZ; r: XYZW; lv: XYZ; av: XYZ } | null {
    const rec = this.bodies.get(meshId);
    if (!rec) return null;
    const t = rec.body.translation();
    const r = rec.body.rotation();
    const lv = rec.body.linvel();
    const av = rec.body.angvel();
    return {
      t: { x: t.x, y: t.y, z: t.z },
      r: { x: r.x, y: r.y, z: r.z, w: r.w },
      lv: { x: lv.x, y: lv.y, z: lv.z },
      av: { x: av.x, y: av.y, z: av.z },
    };
  }

  forEachBody(cb: (meshId: string, drivenByMesh: boolean) => void): void {
    for (const [meshId, rec] of this.bodies) cb(meshId, rec.drivenByMesh);
  }

  step(dt: number): void {
    // Fixed-timestep accumulator so simulation stays stable under variable dt.
    // Capped iterations avoid a "spiral of death" if the tab stalls.
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < 5) {
      this.world.step();
      this.accumulator -= this.fixedDt;
      steps++;
    }
    if (steps === 5) this.accumulator = 0;
  }

  debugRender(): { vertices: Float32Array; colors: Float32Array } {
    return this.world.debugRender();
  }

  free(): void {
    this.world.free();
    this.bodies.clear();
  }
}
