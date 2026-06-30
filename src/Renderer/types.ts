/**
 * RendererAdapter — renderer-agnostic 3D primitives interface.
 *
 * Implementations: BabylonAdapter, ThreeAdapter, MockRendererAdapter (tests).
 * Systems access the active adapter via `this.world.renderer`.
 *
 * No engine types leak through this interface. Adapters return opaque handles
 * (MeshHandle, LightHandle, CameraHandle) that only the adapter that made
 * them can interpret.
 */

export type Vec3 = [number, number, number];
export type Color = [number, number, number];

/**
 * A rotation quaternion `{ x, y, z, w }` (the renderer-agnostic orientation
 * primitive). Carried as a quaternion — not Euler angles — so a 6-DOF chase
 * camera that loops and rolls reaches the renderer without a lossy
 * quat→Euler→quat round-trip and the gimbal flips that invites. Adapters expect
 * a UNIT quaternion; the identity (no rotation) is `{ x: 0, y: 0, z: 0, w: 1 }`.
 */
export type Quaternion = { x: number; y: number; z: number; w: number };

/**
 * A mutable screen-pixel pair used as an `out` parameter so projection-heavy HUD
 * code (target brackets, crosshair, lead diamond, off-screen arrows, sun marker)
 * can re-project hundreds of points per frame without allocating. Pixel-space,
 * origin TOP-LEFT, +x right, +y DOWN.
 */
export interface ScreenPoint {
  x: number;
  y: number;
}

// Opaque handles. The `__brand` fields are phantom and exist only to make
// handle types distinct to TypeScript.
export type MeshHandle = { readonly __mesh: unique symbol };
export type LightHandle = { readonly __light: unique symbol };
export type CameraHandle = { readonly __camera: unique symbol };
export type ShadowCasterHandle = { readonly __shadow: unique symbol };
export type LabelHandle = { readonly __label: unique symbol };
export type SkyboxHandle = { readonly __skybox: unique symbol };
export type LineHandle = { readonly __line: unique symbol };
export type ThinFieldHandle = { readonly __thinField: unique symbol };
export type TextureHandle = { readonly __texture: unique symbol };

export interface PrimitiveSpec {
  kind: 'box' | 'sphere' | 'cylinder' | 'capsule' | 'ground' | 'torus' | 'disc' | 'plane' | 'tube';
  width?: number;
  height?: number;
  /**
   * Second in-plane dimension of a `ground` (its Z size). A ground is a
   * horizontal XZ plane sized `width` (X) × `depth` (Z). Authors may write
   * `depth` OR `height` for this Z dimension — both are honored, and `depth`
   * wins when both are given. (`height` is the natural word for many authors;
   * accepting it stops a `{ width, height }` ground from collapsing to a strip.)
   */
  depth?: number;
  diameter?: number;
  diameterTop?: number;
  diameterBottom?: number;
  segments?: number;
  tessellation?: number;
  radius?: number;
  /**
   * Wall thickness for the `tube` primitive: a positive value extrudes an
   * inner shell so the wall has real depth (inner radius = outer − thickness).
   * Omit / 0 → a single zero-thickness double-sided surface (what the silo
   * uses). Also reused as the torus tube thickness (existing behavior).
   */
  thickness?: number;
  subdivisions?: number;
  /**
   * Pivot the primitive at its base (y = 0) rather than centered. Honored by
   * box / sphere / cylinder / capsule. The `tube` primitive is ALWAYS
   * base-pivoted (it grows from y = 0 to y = height) regardless of this flag.
   */
  pivotAtBottom?: boolean;
}

export interface MaterialSpec {
  diffuse?: Color;
  specular?: Color;
  emissive?: Color;
  alpha?: number;
  /**
   * Texture maps. When ANY texture URL below is set, the adapter builds a
   * physically-based material (Babylon `PBRMaterial`, Three `MeshStandardMaterial`)
   * instead of the flat-color `StandardMaterial` path — so a `MeshPrimitive`
   * ground can show a tiled carpet/PBR set (albedo + normal + roughness + AO),
   * exactly like the raw-Babylon arcade room. Adapters without a PBR pipeline
   * (mocks) record the spec and no-op the actual texture load. URLs are loaded
   * by the adapter's native texture loader.
   */
  albedoTexture?: string;
  normalTexture?: string;
  roughnessTexture?: string;
  /** Ambient-occlusion map URL. */
  ambientTexture?: string;
  /** PBR scalars, applied only on the textured/PBR path. */
  metallic?: number;
  roughness?: number;
  /** Texture tiling repeated across the surface (UV scale). Applied to every map. */
  uScale?: number;
  vScale?: number;
}

export interface DirectionalLightSpec {
  direction: Vec3;
  position?: Vec3;
  intensity: number;
  diffuse: Color;
  specular: Color;
  shadow?: {
    enabled: boolean;
    mapSize: number;
    minZ: number;
    maxZ: number;
  };
}

export interface HemisphericLightSpec {
  direction: Vec3;
  intensity: number;
  diffuse: Color;
  groundColor: Color;
  specular: Color;
}

export interface ArcCameraSpec {
  alpha: number;
  beta: number;
  radius: number;
  minRadius: number;
  maxRadius: number;
  minBeta: number;
  maxBeta: number;
  target: Vec3;
  inertia: number;
  wheelPrecision: number;
  angularSensibility: number;
  /**
   * When true (default), the adapter calls `attachControl(canvas, true)` so
   * the user can orbit/pan/dolly with the mouse. Set false for fixed-camera
   * games (top-down shooter, pinball) where the camera should ignore input.
   */
  controlsEnabled?: boolean;
}

/**
 * Spec for {@link RendererAdapter.createPerspectiveCamera}: a FREE 6-DOF
 * perspective camera with no orbit target. Unlike {@link ArcCameraSpec} (which
 * frames a target via alpha/beta/radius), this camera is posed directly each
 * frame with {@link RendererAdapter.setCameraPose} — the surface a gimbal-safe
 * chase camera (loops, rolls, free flight) needs.
 */
export interface PerspectiveCameraSpec {
  /** Vertical field of view in RADIANS. */
  fov: number;
  /** Near clip-plane distance in world units. */
  near: number;
  /**
   * Far clip-plane distance in world units. A large-world / space scene pushes
   * this far out (~200000); see {@link LargeWorldSpec.farPlane}, which can widen
   * it on the active camera after creation.
   */
  far: number;
  /** Optional initial world-space position. Default `[0, 0, 0]`. */
  position?: Vec3;
  /** Optional initial orientation quaternion. Default identity `{ x:0, y:0, z:0, w:1 }`. */
  orientation?: Quaternion;
}

/**
 * Config for {@link RendererAdapter.configureLargeWorld}: the floating-origin /
 * large-world enable flag plus an optional far-plane override applied to the
 * active perspective camera. Phase-1 is CONTRACT-ONLY — the adapter records the
 * config (and may widen the far plane) but performs NO active per-frame
 * rebasing; the pure game keeps passing real world coordinates.
 */
export interface LargeWorldSpec {
  /** Enable large-world / floating-origin bookkeeping. */
  enabled: boolean;
  /** Far clip plane for the active perspective camera (~200000 for a space sim). */
  farPlane?: number;
}

export interface MeshLoadSpec {
  /** URL or path to the .glb / .gltf file. */
  url: string;
  /** Optional world-space position applied to the imported root. */
  position?: Vec3;
  /** Optional Euler rotation (radians) applied to the imported root. */
  rotation?: Vec3;
  /** Uniform scale applied to the imported root. Default: 1. */
  scale?: number;
}

export interface MeshLoadResult {
  /**
   * The same id that was passed into `loadMesh`. Returned so callers don't
   * have to thread the string through themselves. Used as the `meshId` for
   * `playAnimation` etc.
   */
  meshId: string;
  /** Opaque handle for the imported root mesh. */
  handle: MeshHandle;
  /** Names of animation clips discovered in the file. May be empty. */
  animationNames: string[];
}

/** Options for `loadModelTemplate`. */
export interface LoadModelTemplateOptions {
  /**
   * Strip baked horizontal root motion from the loaded clips so they play "in
   * place" (the adapter neutralizes the X/Z of any position track that actually
   * moves — i.e. the root/hips bone — keeping vertical motion). Applied once to
   * the shared template, so all clones inherit it. Default false.
   */
  lockRootMotion?: boolean;
}

/** Transform applied to a clone produced by `instantiateModel`. */
export interface ModelInstantiateSpec {
  /** World-space position applied to the clone root. */
  position?: Vec3;
  /** Euler rotation (radians) applied to the clone root. */
  rotation?: Vec3;
  /** Uniform scale applied to the clone root. Default: 1. */
  scale?: number;
  /**
   * Optional auto-fit (measure-and-normalize + facing correction + mesh filter)
   * for a displayed ship GLB. When `fit.fitLength` is set it overrides `scale`.
   * See {@link ModelFitSpec}. The Wingman ships use this to show a 6–19 MB model
   * at the right size/heading regardless of how the asset was authored.
   */
  fit?: ModelFitSpec;
}

export interface SkyboxSpec {
  /** Color at the top of the sky (looking straight up). */
  zenithColor: Color;
  /** Color where sky meets ground. The horizon haze tints toward the sun. */
  horizonColor: Color;
  /** Color below the horizon line (the "ground" portion of the dome). */
  groundColor: Color;
  /** Color of the sun disc + halo. */
  sunColor: Color;
  /** World-space direction TO the sun (will be normalized). */
  sunDirection: Vec3;
  /** Disc sharpness in [0,1]. Higher = smaller, harder sun disc. Default 0.9995. */
  sunSize?: number;
  /** Halo falloff. Higher = tighter glow. Default 60. */
  sunGlowSize?: number;
  /** Diameter of the sky dome in world units. Default 800. */
  size?: number;
}

export interface LabelSpec {
  /** Initial text. Can be replaced later with setLabelText. */
  text: string;
  /** RGB tint in [0,1]. Applied via emissive/tint, not as canvas fill. */
  color?: Color;
  /** Canvas font size in CSS pixels. Affects texture resolution, not world scale. */
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  /** World-space scale multiplier on the billboard quad/sprite. */
  scale?: number;
  /**
   * Optional opaque background plate drawn behind the text (a filled rect
   * covering the whole texture) — used for sign-style labels that need a
   * solid backing rather than the default transparent outline-only text. Any
   * CSS color string (e.g. `'rgba(15, 23, 42, 0.88)'`). Omit → no plate
   * (existing transparent behavior, unchanged for current callers).
   */
  background?: string;
  /**
   * Optional border stroked around the inside edge of the background plate,
   * drawn before the text. Any CSS color string. No effect unless `background`
   * is also set. Omit → no border.
   */
  borderColor?: string;
}

export interface EnvironmentTextureOpts {
  /** Reflection strength multiplier. 1.0 = neutral; higher = brighter IBL. */
  level?: number;
}

/**
 * Raw vertex data for a runtime geometry replacement. Positions and
 * indices are required; normals/UVs are optional (the adapter computes
 * normals if absent).
 */
export interface MeshGeometry {
  /** Flat xyz triples — length = vertexCount * 3. */
  positions: number[];
  /** Triangle indices into `positions`. */
  indices: number[];
  /** Flat xyz triples of vertex normals. Computed from positions if omitted. */
  normals?: number[];
  /** Flat uv pairs. */
  uvs?: number[];
}

export type BillboardMode = 'none' | 'all' | 'y';

/**
 * Spec for a GPU-instanced "field" of a single small mesh repeated thousands of
 * times (coin piles, debris, foliage). The adapter loads the GLB at `src`,
 * merges the geometry under `nodeName` into ONE master mesh, normalizes its
 * largest bounding-box dimension to `desiredSize`, and prepares an instance
 * buffer with `capacity` slots. Per-instance transforms are written later via
 * {@link RendererAdapter.setThinFieldInstances}.
 */
export interface ThinFieldSpec {
  /** GLB/glTF url. */
  src: string;
  /** Node whose geometry is merged into the instanced master. */
  nodeName: string;
  /** Largest bbox dimension of the master normalized to this world size. */
  desiredSize: number;
  /** Max concurrent instances (buffer capacity). */
  capacity: number;
}

export interface PickOptions {
  /**
   * Predicate over the adapter-side meshId. Returns true to include the
   * mesh in the ray test. Use to constrain a pick to a specific named
   * surface (e.g. only the Playfield).
   */
  meshPredicate?: (meshId: string) => boolean;
}

export interface PickResult {
  /** World-space coordinates of the pick. */
  x: number;
  y: number;
  z: number;
  /** meshId of the mesh that was hit. */
  meshId: string;
}

export interface RendererInitOptions {
  clearColor?: [number, number, number, number];
  antialias?: boolean;
}

/**
 * Physically-based material parameters for {@link RendererAdapter.applyPbrMaterial}.
 * All fields optional; adapters apply only what's provided. `albedoColor` is an
 * [r,g,b] tuple in 0..1. Adapters without a PBR pipeline no-op.
 */
export interface PbrMaterialSpec {
  name?: string;
  metallic?: number;
  roughness?: number;
  albedoColor?: Color;
  environmentIntensity?: number;
}

/**
 * Options for {@link RendererAdapter.loadTexture}. All optional; adapters apply
 * only what's provided. These map onto each engine's UV/orientation/color-space
 * knobs so a card front/back can be loaded and oriented without the component
 * ever touching `@babylonjs/*` or `three`.
 */
export interface TextureLoadOpts {
  /**
   * Mirror the texture horizontally. Babylon: `uScale = -1`; Three:
   * `repeat.x = -1` (with the wrap mode set to allow the negative repeat).
   * Card FRONTS are loaded flipped so the printed face reads correctly on the
   * concave side of a bowed quad.
   */
  flipU?: boolean;
  /**
   * Rotate the texture about its center, in radians. Babylon: `wAng`; Three:
   * `rotation` + a `(0.5, 0.5)` center. Card BACKS are rotated π so the back
   * pattern is upright when the card is face-down.
   */
  rotate?: number;
  /**
   * Treat the source as sRGB-encoded color data (albedo). Babylon textures are
   * sRGB by default; Three needs `colorSpace = SRGBColorSpace` set explicitly,
   * or the image renders washed out. Default behavior is engine-native.
   */
  srgb?: boolean;
}

/**
 * Spec for {@link RendererAdapter.createCardMesh}: a double-faced, optionally
 * parabolically-bowed, rounded-corner card quad. The rounded-rect ALPHA MASK is
 * generated INSIDE the adapter (no canvas escapes the component), and front/back
 * face albedo textures may be supplied now or attached later via
 * {@link RendererAdapter.setMeshFaceTexture}. The returned mesh is registered in
 * the adapter's normal mesh registry, so `setMeshPosition`/`setMeshRotation`/
 * `setMeshScale`/`setMeshVisible`, `attachShadowCaster`, `replaceMeshGeometry`
 * and `pickAtScreenPoint` all address it like any other mesh.
 */
export interface CardMeshSpec {
  /** Card width in world units (the shorter side for a poker card). */
  width: number;
  /** Card height in world units (the taller side). */
  height: number;
  /**
   * Quad subdivisions per axis. Higher = smoother bow. Default 16 (matches the
   * cardToss deck). Ignored visually when `bow` is 0/omitted but still sets the
   * tessellation of the underlying plane.
   */
  subdivisions?: number;
  /**
   * Radius (in alpha-mask texels' proportion of the card) of the rounded
   * corners drawn into the generated alpha mask. Default a gentle rounding.
   */
  cornerRadius?: number;
  /**
   * Peak height of the parabolic bow along the width axis (Y rise at the
   * center vs. the edges). 0/omitted → a flat quad. The cardToss deck uses a
   * shallow 0.06 bow so flipped cards stack with a slight curl.
   */
  bow?: number;
  /** Initial front-face albedo. May be set later with `setMeshFaceTexture`. */
  front?: TextureHandle;
  /** Initial back-face albedo. May be set later with `setMeshFaceTexture`. */
  back?: TextureHandle;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase-3 (Wingman) visual capabilities. Procedural seeded geometry, runtime
// dynamic textures, particle systems, post-process glow/bloom, and a
// camera-following sun — the surface the bespoke Wingman BabylonRenderer
// exposed, lifted onto the shared adapter so the space-sim components run on
// every engine. Handedness is locked elsewhere (identity camera → +Z forward,
// RIGHT-handed geometry); all placement below must stay consistent with it.
// ─────────────────────────────────────────────────────────────────────────

/** An RGBA color tuple in 0..1 (particle start/mid/dead colors carry alpha). */
export type Color4 = [number, number, number, number];

/** Opaque handle for a continuous particle emitter (space dust, trails). */
export type ParticleEmitterHandle = { readonly __particleEmitter: unique symbol };

/**
 * Named procedural mesh shapes built by {@link RendererAdapter.createProceduralMesh}.
 * `asteroid` / `oil-blob` / `asteroid-drop` are seeded rock geometry (a
 * subdivided icosphere displaced by deterministic multi-octave noise); the
 * remaining shapes are the bespoke Wingman ship / projectile / gate silhouettes
 * built from welded primitive groups. Every shape is `+Z` forward, `+Y` up.
 */
export type ProceduralMeshShape =
  | 'asteroid'
  | 'oil-blob'
  | 'asteroid-drop'
  | 'spaceplane'
  | 'kilrathi'
  | 'freighter-head'
  | 'freighter-car'
  | 'missile'
  | 'waypoint';

/**
 * Spec for {@link RendererAdapter.createProceduralMesh}: a deterministic,
 * seed-driven mesh. `createMesh` builds engine PRIMITIVES (box/sphere/…);
 * this builds the Wingman shapes — seeded asteroids/oil-blobs whose surface is
 * displaced by an integer-seeded noise field (same `seed` ⇒ byte-identical
 * geometry, so the same rock renders the same on every client and frame), plus
 * the named ship/missile/waypoint silhouettes. The pure surface-displacement
 * math is exposed separately via {@link RendererAdapter.sampleProceduralSurface}
 * so collision/occlusion code and the adapter agree on the same shape.
 */
export interface ProceduralMeshSpec {
  shape: ProceduralMeshShape;
  /**
   * Integer seed selecting the deterministic noise offset. Identical seed →
   * identical displaced geometry. Ignored by the non-seeded ship/missile/
   * waypoint shapes. Default 1.
   */
  seed?: number;
  /**
   * Base dimensions. For `asteroid` / `oil-blob` / `asteroid-drop` only `size[0]`
   * is read — the MEAN radius before displacement (silhouette varies ±~25%).
   * For ship/missile shapes it's `[diameter/width, height, length]`.
   */
  size: Vec3;
  /** Base surface color (rock tint / hull color). Default mid-grey. */
  color?: Color;
  /** Self-illumination 0..1 (waypoint gates, engine glow orbs). Default 0. */
  emissive?: number;
  /**
   * Optional carve: a plane normal (need not be unit — it's normalized) along
   * which the rock is sliced flat, giving a fractured/cleaved face instead of a
   * closed blob. Same `seed`+`cutAxis`+`cutDepth` is still deterministic. Only
   * honored by the rock shapes.
   */
  cutAxis?: Vec3;
  /** How deep the {@link cutAxis} plane bites in, as a fraction of the radius (0..1). */
  cutDepth?: number;
  /**
   * Icosphere subdivision count for rock shapes (triangles ≈ 20·N²). Higher =
   * smoother silhouette at GPU cost. Default engine-defined (~14). Ignored by
   * non-rock shapes.
   */
  subdivisions?: number;
}

/**
 * Auto-fit transform for a displayed GLB ship, layered on top of
 * {@link ModelInstantiateSpec}'s base position/rotation/scale. The Wingman ships
 * are authored at wildly different scales and facings, so the adapter measures
 * the loaded hierarchy's bounding box and normalizes its longest HORIZONTAL
 * (X or Z) extent to {@link fitLength}, then applies {@link yaw}/{@link pitch}
 * so the nose points `+Z`. (Phase 3 just DISPLAYS the model — the
 * dual-proxy/blow-apart composite is deferred to the combat phase.)
 */
export interface ModelFitSpec {
  /**
   * Normalize the longest horizontal extent of the loaded model to this world
   * length. When set, it OVERRIDES {@link ModelInstantiateSpec.scale} (which is
   * a fixed multiplier). The Wingman fighters fit to ~5; the freighter cars to ~12.
   */
  fitLength?: number;
  /** Extra yaw (radians) so the model's nose aligns to `+Z`. Default 0. */
  yaw?: number;
  /** Extra pitch (radians). Default 0. */
  pitch?: number;
  /** Vertical offset applied after the fit-scale. Default 0. */
  yOffset?: number;
  /**
   * Keep only loaded meshes whose name INCLUDES this substring, disposing the
   * rest. One GLB can hold several bodies (freighter.glb carries both `TrainCar`
   * and `TrainEngine`); this selects the one this instance shows. Omit → keep all.
   */
  meshNameFilter?: string;
}

/**
 * Spec for {@link RendererAdapter.createDynamicTexture}: a GPU texture built
 * from a raw RGBA8 PIXEL BUFFER the caller rasterized on the CPU (procedural
 * rock albedo/normal/metallic, soft particle dots, the sun starburst). The
 * canvas/pixel math stays in renderer-free component code (it's pure number
 * crunching, no engine types); the adapter only uploads. Keyed/deduped exactly
 * like {@link RendererAdapter.loadTexture}.
 */
export interface DynamicTextureSpec {
  /** Texture width in texels. */
  width: number;
  /** Texture height in texels. */
  height: number;
  /**
   * Tightly packed RGBA8 buffer, length = `width*height*4`, row-major, origin
   * TOP-LEFT, channel order R,G,B,A. Re-uploadable via
   * {@link RendererAdapter.updateDynamicTexture}.
   */
  pixels: Uint8ClampedArray | Uint8Array;
  /**
   * Treat the data as sRGB-encoded color (albedo). Normal/metallic/AO maps pass
   * `false` (linear data) or they decode wrong. Default false.
   */
  srgb?: boolean;
  /** The buffer carries meaningful alpha (sprite dots, starburst). Default false. */
  hasAlpha?: boolean;
  /** UV addressing for both axes. Default `'wrap'`. */
  wrap?: 'wrap' | 'clamp' | 'mirror';
  /** UV tiling repeat. Default 1. */
  uScale?: number;
  vScale?: number;
}

/**
 * Spec for {@link RendererAdapter.createParticleBurst}: a ONE-SHOT emitter that
 * fires {@link count} particles from a sphere around {@link position} then
 * auto-disposes. Explosions and muzzle/launch flashes. The adapter auto-selects
 * GPU vs CPU particles (Babylon `GPUParticleSystem.IsSupported`); Three uses a
 * points/sprite pool; BabylonLite a WebGPU compute emitter; the Mock records it.
 */
export interface ParticleBurstSpec {
  /** World-space center of the burst. */
  position: Vec3;
  /** Soft sprite texture (a {@link RendererAdapter.createDynamicTexture} dot). */
  texture: TextureHandle;
  /** Particles emitted in the single shot (`manualEmitCount`). */
  count: number;
  /** Sphere-emitter radius the particles spawn within. */
  emitRadius: number;
  /** Direction randomizer 0..1 (1 = fully spherical spread). Default 1. */
  emitRadiusRange?: number;
  minSize: number;
  maxSize: number;
  minLifeTime: number;
  maxLifeTime: number;
  /** Outward launch speed range. */
  minEmitPower: number;
  maxEmitPower: number;
  /** HDR start / mid / dead colors (RGBA, may exceed 1 for bloom). */
  color1: Color4;
  color2: Color4;
  colorDead: Color4;
  /** Blend mode. `'add'` for fire/energy; `'standard'` for smoke. Default `'add'`. */
  blend?: 'add' | 'standard' | 'multiply';
  /** Constant acceleration (e.g. `[0,0,0]` in space). Default `[0,0,0]`. */
  gravity?: Vec3;
  /** Seconds the system stays alive emitting before auto-dispose. Default ~0.06. */
  duration?: number;
}

/**
 * Spec for {@link RendererAdapter.createParticleEmitter}: a CONTINUOUS emitter
 * that streams particles until disposed (camera-anchored space dust, engine
 * trails). Same GPU/CPU auto-select as {@link ParticleBurstSpec}.
 */
export interface ParticleEmitterSpec {
  /** Initial world-space emitter position. Default `[0,0,0]`. */
  position?: Vec3;
  /** Soft sprite texture handle. */
  texture: TextureHandle;
  /** Max live particles (GPU buffer capacity). */
  capacity: number;
  /** Particles spawned per second. */
  emitRate: number;
  /** Sphere-emitter radius. */
  emitRadius: number;
  /** Direction randomizer / inner-radius fraction 0..1. Default 0.2. */
  emitRadiusRange?: number;
  minSize: number;
  maxSize: number;
  minLifeTime: number;
  maxLifeTime: number;
  minEmitPower: number;
  maxEmitPower: number;
  color1: Color4;
  color2: Color4;
  colorDead: Color4;
  blend?: 'add' | 'standard' | 'multiply';
  gravity?: Vec3;
  /**
   * Re-seat the emitter at the ACTIVE camera's world position every frame, so
   * the field is always "around you" (Wingman space dust). With floating-origin
   * world streaming this avoids spawning/culling real entities. Default false.
   */
  followCamera?: boolean;
  /** Pre-warm simulation cycles so the field is already populated on frame 1. */
  preWarmCycles?: number;
}

/**
 * Config for {@link RendererAdapter.setGlowLayer}: a SELECTIVE glow post-pass.
 * The layer starts with an EMPTY whitelist — only meshes added via
 * {@link RendererAdapter.addGlowMesh} bleed (the sun disc/flare, engine orbs),
 * so explosions/trails/stars don't smear. Pass `null` to disable.
 */
export interface GlowSpec {
  /** Glow strength. Wingman uses ~0.9. */
  intensity: number;
  /** Glow RTT downsample ratio (cheaper/blurrier as it drops). Default 0.5. */
  textureRatio?: number;
  /** MSAA samples on the glow RTT. Default 1. */
  samples?: number;
}

/**
 * Config for {@link RendererAdapter.setBloom}: HDR bloom on the default
 * rendering pipeline (depth-tested, so it naturally hides emissive pixels
 * occluded by nearer geometry — unlike the additive glow layer). Pass `null`
 * to disable.
 */
export interface BloomSpec {
  /** Bloom contribution weight. */
  weight: number;
  /** Brightness above which pixels bloom. Default engine-defined. */
  threshold?: number;
  /** Bloom blur scale. Default engine-defined. */
  scale?: number;
  /** Blur kernel size in px. Default engine-defined. */
  kernel?: number;
}

/**
 * Per-mesh draw-order / depth knobs for {@link RendererAdapter.setMeshRenderingOptions}.
 * These layer the skybox (behind everything, no depth write, camera-locked),
 * the sun/flare, decals, and HUD widgets so they composite correctly without a
 * component touching the engine. All fields optional; the adapter applies only
 * what's provided.
 */
export interface MeshRenderOptions {
  /**
   * Draw bucket. Group 0 (default) renders first; higher groups render after,
   * on top. The Wingman HUD plane + light gizmo use group 1 so asteroids can't
   * occlude them.
   */
  renderingGroupId?: number;
  /** Skip depth WRITES (skybox: never blocks the z-test of real geometry). */
  disableDepthWrite?: boolean;
  /** Render at the far plane, locked to the camera (skybox dome). */
  infiniteDistance?: boolean;
  /** Whether scene fog tints this mesh. Sun/flare/HUD set false. */
  applyFog?: boolean;
  /** Whether the mesh participates in ray picks. Decals/HUD set false. */
  pickable?: boolean;
}

/**
 * Spec for {@link RendererAdapter.createSun}: a camera-following sun — a
 * DirectionalLight whose rays travel along {@link direction}, plus an emissive
 * disc parked at {@link distance} from the active camera in the OPPOSITE
 * direction (so it reads as an infinitely-distant star that never parallaxes).
 * Optional shadow-generator tuning drives crisp rock-on-rock shadows. Returns a
 * {@link LightHandle} addressing the directional light; the disc is internal and
 * its world position is read back via {@link RendererAdapter.getSunWorldPosition}
 * (for the off-screen sun indicator).
 */
export interface SunSpec {
  /**
   * Unit world-space direction the light TRAVELS (rays go this way). The disc
   * sits at `camera − direction*distance`. RIGHT-handed; keep consistent with
   * the locked `+Z` forward convention.
   */
  direction: Vec3;
  /** Distance from the camera to the disc. Only affects parallax-free framing. */
  distance: number;
  intensity: number;
  diffuse: Color;
  specular: Color;
  /** Visible disc diameter at {@link distance}. Default engine-defined. */
  discDiameter?: number;
  /** HDR emissive color of the disc (may exceed 1 to clear the bloom threshold). */
  discColor?: Color;
  /** Optional shadow-generator tuning. Omit → no shadow pass (cheapest). */
  shadow?: {
    enabled: boolean;
    /** Shadow-map resolution (e.g. 2048 for sharp field shadows). */
    mapSize: number;
    /** Shadow darkness 0..1. Default engine-defined. */
    darkness?: number;
    bias?: number;
    normalBias?: number;
    /** Render only back-faces into the shadow map (fixes self-shadow acne on big rocks). */
    forceBackFacesOnly?: boolean;
  };
}

export interface RendererAdapter {
  readonly kind: 'babylon' | 'three' | 'babylon-lite';

  init(canvas: HTMLCanvasElement, opts?: RendererInitOptions): Promise<void>;

  /**
   * The DOM canvas the renderer draws into (the one passed to `init`), or null
   * if not yet initialized / headless. Pointer-driven tools (e.g. the
   * PinballBuilder freehand draw) attach listeners here and convert client
   * coordinates before calling `pickAtScreenPoint`. Prefer this over reaching
   * the engine for the canvas.
   */
  getRenderingCanvas(): HTMLCanvasElement | null;

  /**
   * Set the scene background / clear color (linear RGB, `a` default 1). This is
   * the runtime equivalent of {@link RendererInitOptions.clearColor} — the
   * SceneLoader applies a scene's top-level `clearColor` through it AFTER init,
   * so a scene authored with a dark-space background shows that color instead of
   * the engine default. Safe to call before init (no-op until the scene exists).
   */
  setClearColor(r: number, g: number, b: number, a?: number): void;

  createMesh(id: string, prim: PrimitiveSpec, mat?: MaterialSpec): MeshHandle;
  /**
   * Asynchronously load a 3D model (glTF/GLB) from `spec.url` and register it
   * under `id` so the animation adapter methods (`playAnimation`, etc.) can
   * address its clips by that same id. Babylon resolves via
   * `SceneLoader.ImportMeshAsync`; Three via `GLTFLoader.loadAsync`. Primitive
   * paths (e.g. mocks) may no-op but must still resolve. The returned Promise
   * fulfils once the mesh is present and its animations registered.
   */
  loadMesh(id: string, spec: MeshLoadSpec): Promise<MeshLoadResult>;
  setMeshPosition(h: MeshHandle, x: number, y: number, z: number): void;
  setMeshRotation(h: MeshHandle, x: number, y: number, z: number): void;
  /**
   * Visual scale multiplier on the mesh. Affects rendering only — physics
   * shapes / bounding-box extents don't follow. Used by HealthBar to
   * shrink the fill bar, PinballLayout to fit walls/floor to live table
   * dimensions, etc.
   */
  setMeshScale(h: MeshHandle, sx: number, sy: number, sz: number): void;
  /**
   * Replace the mesh's vertex buffer in place. The new geometry must be
   * supplied as flat arrays of positions (xyz xyz xyz) and triangle
   * indices. Adapters that can't mutate geometry no-op. Used by
   * FlipperSystem to retake the box mesh as a tapered prism with the
   * pivot at the origin.
   */
  replaceMeshGeometry(h: MeshHandle, geom: MeshGeometry): void;
  /**
   * Make the mesh always face the active camera. `none` disables
   * billboarding. Used by HealthBar's bar quads. Three.js equivalent is
   * Sprite/orient-to-camera-each-frame; not all adapters implement.
   */
  setMeshBillboardMode(h: MeshHandle, mode: BillboardMode): void;
  setMeshColor(h: MeshHandle, r: number, g: number, b: number): void;
  setMeshVisible(h: MeshHandle, visible: boolean): void;
  getMeshWorldPosition(h: MeshHandle, out: Vec3): Vec3;
  /**
   * Force the local-space bounding box reported by the mesh to the given
   * min/max in object-local coordinates. Used to inflate a physics BOX
   * collider beyond the visible geometry (anti-tunneling for fast-swept
   * kinematic meshes like pinball flippers). Adapters without box-fit
   * physics may no-op. MUST be called before `physicsCreateBody` so the
   * inflated extents are what the engine wraps. Babylon: calls
   * `mesh.setBoundingInfo(new BoundingInfo(min, max))`.
   */
  setMeshBoundingBoxExtents(h: MeshHandle, min: Vec3, max: Vec3): void;
  /**
   * Read back the current local-space bounding box of the mesh. Useful for
   * debug viz that wants to draw the collider outline. Returns null if the
   * adapter has no mesh under this handle yet.
   */
  getMeshBoundingBoxExtents(h: MeshHandle): { min: Vec3; max: Vec3 } | null;
  disposeMesh(h: MeshHandle): void;

  /**
   * Debug line drawing. A "line system" renders a set of independent polylines
   * (each polyline is an array of points) as a single unlit object — used for
   * ray-cast helpers, collider outlines, etc. `color` tints the whole system.
   * `updateLineSystem` repositions the same handle each frame (cheap when the
   * polyline count/lengths are unchanged).
   */
  createLineSystem(id: string, lines: Vec3[][], color?: Color): LineHandle;
  updateLineSystem(h: LineHandle, lines: Vec3[][], color?: Color): void;
  setLineSystemVisible(h: LineHandle, visible: boolean): void;
  disposeLineSystem(h: LineHandle): void;

  /**
   * Debug overlay box: a unit (1×1×1) wireframe cube parented to the mesh
   * referenced by `parent`, drawn unlit in `color`, non-pickable. Returned as a
   * normal MeshHandle so callers position/size it with the existing
   * `setMeshPosition` / `setMeshScale` (in LOCAL space, since it's parented to
   * `parent`) and remove it with `disposeMesh`. Used by debug viz that draws a
   * collider outline tracking a moving mesh (e.g. the flipper collider overlay).
   * Returns null if `parent` resolves to no mesh; adapters with no scene-graph
   * may return a no-op handle.
   */
  createDebugBox(id: string, parent: MeshHandle, color: Color): MeshHandle | null;

  // ─── Thin-instance fields ───
  /**
   * Load the GLB at `spec.src`, merge all geometry under the node named
   * `spec.nodeName` into ONE master mesh recentered on its own bounding-box
   * center, and set up GPU instancing (Babylon thin-instances / Three
   * InstancedMesh) with `spec.capacity` slots and an initial draw count of 0.
   * The master is added to the scene, made non-pickable, and has per-instance
   * frustum culling disabled so the field never pops out when the (origin)
   * master leaves view. The normalization scale (`desiredSize / largestBBoxDim`)
   * is STORED on the field record and applied per instance, not baked. Returns a
   * handle, or `null` if the node is missing or the load fails.
   */
  loadThinField(spec: ThinFieldSpec): Promise<ThinFieldHandle | null>;
  /**
   * Write the first `count` instances from `packed` (a flat Float32Array, stride
   * 5 per instance: `[x, y, z, yaw, scale]`) into the field's instance buffer.
   * Each instance's world matrix is translation(x,y,z) ∘ yaw-rotation about +Y ∘
   * uniform-scale(baseScale * scale). The drawn instance count is set to `count`
   * and the buffer flagged updated. Allocation-free (reuses scratch math on the
   * adapter).
   */
  setThinFieldInstances(handle: ThinFieldHandle, packed: Float32Array, count: number): void;
  /** Dispose the master mesh + instance buffers and drop the field record. */
  disposeThinField(handle: ThinFieldHandle): void;
  /**
   * Build a ray from `camera` through normalized screen fraction `(nx, ny)`
   * (both in [0,1], origin = top-left), project `distance` world units along it
   * from the ray origin, write the result into `out`, and return `out`. Render
   * width/height are read from the adapter internally.
   */
  screenToWorldPoint(camera: CameraHandle, nx: number, ny: number, distance: number, out: Vec3): Vec3;

  // ─── Textures & cards ───
  /**
   * Load a 2D texture from an app-resolved `url`, deduped by `key`: a second
   * call with the SAME key returns the SAME handle (and ignores `opts`),
   * letting a card deck reuse one texture per card id / per back design without
   * the component caching engine objects. Babylon: `new Texture(url, scene)`,
   * `flipU → uScale = -1`, `rotate → wAng`. Three: `TextureLoader`,
   * `flipU → repeat.x = -1`, `rotate → rotation` (+ center), `srgb → colorSpace`.
   * Adapters without a texture pipeline record the load and return a
   * key-deduped handle. The component never imports an engine texture type.
   */
  loadTexture(key: string, url: string, opts?: TextureLoadOpts): TextureHandle;
  /**
   * Eagerly load `url` and resolve once the GPU texture is ready (or
   * immediately if already cached). Used by the deal animation to wait for the
   * card-back image before the first card flies. Adapters that load
   * synchronously / have no real I/O resolve immediately.
   */
  preloadTexture(url: string): Promise<void>;
  /**
   * Build a double-faced, optionally-bowed, rounded-corner card quad (see
   * {@link CardMeshSpec}) registered under `id` in the mesh registry, and
   * return its {@link MeshHandle}. The rounded-rect alpha mask is generated
   * inside the adapter; no canvas crosses the boundary. Front/back albedo may
   * be supplied in the spec or attached later with `setMeshFaceTexture`.
   */
  createCardMesh(id: string, spec: CardMeshSpec): MeshHandle;
  /**
   * Swap a card face's albedo texture at runtime — the flip. `side` selects the
   * front (concave, printed face) or back (convex, card-back design). No-op on
   * an unknown mesh handle. Adapters without per-face material control no-op.
   */
  setMeshFaceTexture(h: MeshHandle, side: 'front' | 'back', tex: TextureHandle): void;
  /**
   * Tint a mesh's albedo/base color (the table-felt hue-shift). Distinct from
   * `setMeshColor`, which drives the flat `StandardMaterial` diffuse path;
   * this addresses the PBR albedo so a textured surface re-tints correctly.
   * No-op on an unknown handle.
   */
  setMeshAlbedoColor(h: MeshHandle, r: number, g: number, b: number): void;
  /** Release a loaded texture and drop it from the dedupe cache. Idempotent. */
  disposeTexture(h: TextureHandle): void;
  /**
   * Aspect ratio (width / height) of the rendering surface, for responsive
   * camera framing. Returns 1 when no canvas/engine is available yet.
   */
  getAspectRatio(): number;

  createDirectionalLight(id: string, spec: DirectionalLightSpec): LightHandle;
  createHemisphericLight(id: string, spec: HemisphericLightSpec): LightHandle;
  updateLightIntensity(h: LightHandle, intensity: number): void;
  disposeLight(h: LightHandle): void;

  createArcCamera(id: string, spec: ArcCameraSpec): CameraHandle;
  setCameraTarget(h: CameraHandle, x: number, y: number, z: number): void;
  getCameraTarget(h: CameraHandle, out: Vec3): Vec3;
  getCameraAngles(h: CameraHandle): { alpha: number; beta: number; radius: number };
  /** Unit forward vector of the camera in world space (camera → target). */
  getCameraForward(h: CameraHandle, out: Vec3): Vec3;
  /** Unit right vector of the camera in world space. Handedness-aware. */
  getCameraRight(h: CameraHandle, out: Vec3): Vec3;
  nudgeCameraAlpha(h: CameraHandle, delta: number): void;
  /**
   * Add `delta` to the orbit pitch (Babylon ArcRotateCamera.beta, Three
   * OrbitControls polar angle). Positive values pitch the camera DOWN toward
   * the horizon; negative values tilt UP toward overhead. Adapters clamp to
   * their configured beta limits.
   */
  nudgeCameraBeta(h: CameraHandle, delta: number): void;
  nudgeCameraTarget(h: CameraHandle, dx: number, dy: number, dz: number): void;
  /**
   * Add `delta` to the orbit radius (Babylon ArcRotateCamera.radius, Three
   * OrbitControls spherical radius). Positive values dolly the camera OUT
   * (further from the target); negative values dolly IN. Adapters should
   * respect their configured min/max clamps so auto-dolly mechanics don't
   * escape the user's bounds.
   */
  nudgeCameraRadius(h: CameraHandle, delta: number): void;
  /**
   * Absolute set of orbit radius. PinballCamera uses this to lock the
   * camera distance to the live table dimensions; freely orbiting
   * cameras should use `nudgeCameraRadius` instead.
   */
  setCameraRadius(h: CameraHandle, radius: number): void;
  /**
   * Clamp the orbit radius range. Equal min/max effectively locks the
   * camera distance. Used by PinballCameraSystem after `setCameraRadius`
   * to prevent any wheel-zoom escape.
   */
  setCameraRadiusLimits(h: CameraHandle, min: number, max: number): void;
  /**
   * Perspective field of view in radians. Babylon's ArcRotateCamera
   * default is ~0.8 (≈46°); pinball uses 1.15 (~66°) to fit a
   * regulation-ratio table without pushing the camera far back. Adapters
   * with orthographic-only cameras no-op.
   */
  setCameraFov(h: CameraHandle, fov: number): void;
  /**
   * Attach/detach pointer-driven controls at runtime. ArcCameraSpec
   * already accepts `controlsEnabled` at creation time; this method is
   * for systems that need to toggle later (e.g. a debug tool that
   * temporarily takes over the camera).
   */
  setCameraControlsEnabled(h: CameraHandle, enabled: boolean): void;

  // ─── Free 6-DOF perspective camera (chase / flight) ───
  /**
   * Create a FREE 6-DOF perspective camera (no orbit target) registered under
   * `id`, and make it the active camera. Where {@link createArcCamera} orbits a
   * target, this camera is driven directly each frame by {@link setCameraPose} —
   * the surface a gimbal-safe chase camera (loops, rolls, free flight) needs.
   * Babylon backs it with a `UniversalCamera`; Three with a `PerspectiveCamera`;
   * BabylonLite with its functional WebGPU camera. Returns an opaque
   * {@link CameraHandle}. The same handle is accepted by {@link setCameraPose},
   * {@link getCameraPose}, {@link setCameraFov} and {@link screenToWorldPoint}.
   */
  createPerspectiveCamera(id: string, spec: PerspectiveCameraSpec): CameraHandle;
  /**
   * Pose a perspective camera with a world-space `position` and a unit
   * `orientation` QUATERNION. Quaternion — not Euler — on purpose: a chase
   * camera that loops/rolls must reach the renderer without a lossy quat→Euler
   * round-trip (and the gimbal flips it invites). Adapters apply the orientation
   * directly (Babylon: `camera.rotationQuaternion`; Three: `camera.quaternion`;
   * BabylonLite: stored on its view matrix). No-op on an unknown / non-perspective
   * handle.
   */
  setCameraPose(h: CameraHandle, position: Vec3, orientation: Quaternion): void;
  /**
   * Read a perspective camera's current pose: world-space position into
   * `outPosition` and unit orientation quaternion into `outOrientation`. Lets the
   * chase camera read back its own pose and underpins the contract's pose
   * round-trip. The returned quaternion may be the sign-flipped twin of the one
   * passed to {@link setCameraPose} (q and −q are the same rotation). No-op
   * (leaves the outs untouched) on an unknown handle.
   */
  getCameraPose(h: CameraHandle, outPosition: Vec3, outOrientation: Quaternion): void;
  /**
   * Project a world-space point `(x, y, z)` to screen pixels, writing the result
   * into `out` (origin top-left, +y down). Returns `false` — and LEAVES `out`
   * UNTOUCHED — when the point is BEHIND the active camera, so HUD callers can
   * branch to an off-screen arrow instead of drawing a bracket at a mirrored
   * phantom position. The inverse of {@link screenToWorldPoint}; it drives the
   * entire Wingman HUD (target brackets, crosshair, lead diamond, off-screen
   * arrows, sun marker). Babylon: `Vector3.Project`; Three: `Vector3.project`
   * then NDC→pixels. Uses the active perspective camera and the adapter's current
   * render size.
   */
  worldToScreen(x: number, y: number, z: number, out: ScreenPoint): boolean;

  // ─── Floating origin / large world (Phase-1: contract-only, dormant) ───
  /**
   * Read the renderer's current floating-origin offset into `out` and return it.
   * Phase-1 is CONTRACT-ONLY / dormant: there is no active per-frame rebase, so
   * this returns whatever {@link setOriginOffset} last recorded (default
   * `[0, 0, 0]`, a camera-relative fallback). The pure game always passes real
   * world coordinates; this offset is how a future large-world backend would
   * report the rebase it applied.
   */
  getOriginOffset(out: Vec3): Vec3;
  /**
   * Record the desired floating-origin offset `(x, y, z)`. Phase-1
   * CONTRACT-ONLY — the adapter stores it (so {@link getOriginOffset}
   * round-trips) but does NOT yet rebase the scene graph each frame. Active
   * per-frame rebasing is out of scope for Phase 1.
   */
  setOriginOffset(x: number, y: number, z: number): void;
  /**
   * Configure large-world / floating-origin behavior: the `enabled` flag plus an
   * optional `farPlane` (~200000 for a space sim) applied to the active
   * perspective camera. Phase-1 records the config and may widen the far plane,
   * but performs NO active rebasing. Adapters without a far-plane knob record the
   * flag and no-op the plane.
   */
  configureLargeWorld(spec: LargeWorldSpec): void;

  /**
   * Cast a ray from a screen-space point and return the first world
   * intersection. Used by pointer-driven tools like the PinballBuilder's
   * freehand draw mode. The optional predicate restricts the test to a
   * subset of meshes by their adapter-side `meshId`. Adapters that can't
   * raycast return null.
   */
  pickAtScreenPoint(x: number, y: number, opts?: PickOptions): PickResult | null;

  attachShadowCaster(light: LightHandle, mesh: MeshHandle): ShadowCasterHandle;
  detachShadowCaster(h: ShadowCasterHandle): void;
  setMeshReceiveShadows(h: MeshHandle, receive: boolean): void;

  /**
   * Procedural gradient skybox driven by a fragment shader: vertical
   * horizon→zenith→ground gradient plus a sun disc + halo aimed by
   * `sunDirection`. `updateSkyboxSun` is cheap (one uniform write per call)
   * — drive it from a System that watches the active DirectionalLight to
   * keep sky and shadows agreeing. Returns LabelHandle-like opaque handle.
   * Adapters that don't support sky may return a no-op handle.
   */
  createSkybox(id: string, spec: SkyboxSpec): SkyboxHandle;
  updateSkyboxSun(h: SkyboxHandle, sunDirection: Vec3, sunColor?: Color): void;
  disposeSkybox(h: SkyboxHandle): void;

  /**
   * Image-based lighting. `url` points to a prefiltered cubemap (Babylon
   * `.env`, Three `.hdr` w/ PMREM, etc.). `level` scales the contribution
   * (1.0 default). Set to `null`/empty to clear. Adapters that don't
   * support IBL no-op. Renderer-agnostic in surface but each engine has
   * its own file format conventions for prefiltered data, so callers
   * generally ship one URL per renderer.
   */
  setEnvironmentTexture(url: string, opts?: EnvironmentTextureOpts): void;
  clearEnvironmentTexture(): void;

  /**
   * Apply a physically-based material to a mesh by handle (e.g. a chrome ball).
   * Adapters without a PBR pipeline no-op. Keeps material creation behind the
   * adapter boundary so Systems don't import engine material types directly.
   */
  applyPbrMaterial(handle: MeshHandle, spec: PbrMaterialSpec): void;

  /**
   * Skeletal/GLTF animation controls keyed by mesh + clip name. Additive:
   * adapters that don't know about a given mesh (e.g., primitive capsules
   * without imported animations) no-op. Used by locomotion blend systems
   * (Animation, Stride) to drive animation groups without leaking engine
   * types past the adapter boundary.
   */
  /**
   * Start playing the named clip on the mesh (looping by default). Idempotent
   * — calling twice on the same clip does not restart it.
   */
  playAnimation(meshId: string, clipName: string, loop?: boolean): void;
  /** Stop the named clip on the mesh. No-op if it's not playing. */
  stopAnimation(meshId: string, clipName: string): void;
  /**
   * Blend weight in [0,1] for the named clip. Used together with
   * `playAnimation` to produce cross-fades between idle/walk/run clips.
   */
  setAnimationWeight(meshId: string, clipName: string, weight: number): void;
  /** Playback rate multiplier for the named clip. 1 = normal. */
  setAnimationSpeed(meshId: string, clipName: string, speed: number): void;

  /**
   * Instanced model loading for pools of animated characters that share one
   * rigged asset (e.g. a wave of enemies). `loadModelTemplate` loads a
   * glTF/GLB ONCE into an off-scene container (deduped by url — concurrent
   * calls share a single load/parse); `instantiateModel` then produces a cheap
   * per-entity clone with its OWN skeleton + animation groups registered under
   * that entity id, so the `playAnimation`/`playAnimationOnce`/`stopAnimation`/
   * `setAnimationWeight`/`setAnimationSpeed` methods address the clone's clips
   * by id exactly like a `loadMesh` result. Prefer this over `loadMesh` when N
   * entities share one model — `loadMesh` would re-import the file N times.
   * Adapters that can't clone may no-op/fall back but must keep the surface.
   */
  loadModelTemplate(
    url: string,
    opts?: LoadModelTemplateOptions,
  ): Promise<{ animationNames: string[] }>;
  /**
   * Instantiate a clone of the already-loaded template `url` under `id`. The
   * returned MeshHandle addresses the clone's root transform, usable with
   * `setMeshPosition`/`setMeshRotation`. The clone starts hidden — call
   * `setModelVisible(handle, true)` to reveal it. Throws if the template for
   * `url` has not been loaded via `loadModelTemplate` yet.
   */
  instantiateModel(id: string, url: string, spec?: ModelInstantiateSpec): MeshHandle;
  /**
   * Show/hide a clone's entire node subtree. Park-aware pooling hides on park
   * (`false`) and reveals on reuse (`true`). Distinct from `setMeshVisible`
   * (which toggles a single Mesh, not a clone root's children).
   */
  setModelVisible(h: MeshHandle, visible: boolean): void;
  /**
   * Set the opacity (0..1) of a clone's entire subtree, keyed by the same id
   * passed to `instantiateModel`. Used to fade a model out (e.g. a dying enemy
   * dissolving before its pool slot recycles). 1 = fully opaque, 0 = invisible.
   * No-op for an unknown id.
   */
  setModelAlpha(id: string, alpha: number): void;
  /** Dispose a clone instantiated under `id` and free its animation groups. */
  disposeModel(id: string, h: MeshHandle): void;
  /**
   * Play a clip ONCE (non-looping) from frame 0, restarting it even if it was
   * already running (unlike `playAnimation`, which no-ops while the clip
   * plays). Returns the clip's duration in seconds (0 if unknown), so callers
   * can time a return-to-idle transition. Used for one-shot reactions (hit
   * stagger, death). No-ops on an unknown mesh id, returning 0.
   */
  playAnimationOnce(meshId: string, clipName: string): number;

  /**
   * Screen-facing text label at a world-space point. Implemented as a
   * billboarded textured quad (Babylon) or a Sprite (Three). Both renderers
   * draw the text into an offscreen canvas once at creation.
   */
  createLabel(id: string, spec: LabelSpec): LabelHandle;
  setLabelText(h: LabelHandle, text: string): void;
  setLabelPosition(h: LabelHandle, x: number, y: number, z: number): void;
  setLabelColor(h: LabelHandle, r: number, g: number, b: number): void;
  setLabelAlpha(h: LabelHandle, alpha: number): void;
  setLabelScale(h: LabelHandle, scale: number): void;
  setLabelVisible(h: LabelHandle, visible: boolean): void;
  disposeLabel(h: LabelHandle): void;

  /**
   * Rigid-body physics. `physicsCreateBody(meshId, opts)` binds a mesh created
   * via `createMesh(meshId, ...)` to a physics body. BabylonAdapter backs this
   * with Havok's `PhysicsAggregate`; ThreeAdapter uses a pure-core integrator
   * (no Three dependency) until Rapier.js is wired in. Adapters that cannot
   * simulate physics are still safe to call — they no-op.
   *
   * `physicsStep(dt)` is a no-op under Babylon (the scene's physics engine
   * advances during `scene.render`); it's required for the pure-core adapter
   * so tests and Three.js demos stay deterministic.
   */
  physicsCreateBody(meshId: string, opts: PhysicsBodyOpts): void;
  physicsDestroyBody(meshId: string): void;
  physicsSetBodyVelocity(meshId: string, vx: number, vy: number, vz: number): void;
  /**
   * Set the angular velocity of a kinematic/dynamic body. Used by Plunger
   * to zero the ball's spin on teleport. Adapters without per-body
   * angular control may no-op.
   */
  physicsSetBodyAngularVelocity(meshId: string, vx: number, vy: number, vz: number): void;
  /**
   * Switch a body between "driven by the mesh's transform" (true — the
   * usual mode for kinematic objects; Babylon's `disablePreStep = false`)
   * and "the body drives the mesh" (false — `disablePreStep = true`).
   * Plunger flips this off briefly so it can teleport the ball without
   * the physics step writing the ball back to its current pose.
   */
  physicsSetBodyDrivenByMesh(meshId: string, drivenByMesh: boolean): void;
  /**
   * Set the global gravity vector. Pinball uses this to install a tilted
   * gravity simulating a slanted playfield ([0, -12, 14] = -Y down, +Z
   * down-table). Adapters without a global gravity setting no-op.
   */
  physicsSetGravity(x: number, y: number, z: number): void;
  /**
   * Resize a BOX-type body's collider in place. Swaps just the shape on the
   * existing body — the body keeps its motion type / mass / restitution /
   * pose / velocity. Used to live-tune flipper colliders from a debug
   * panel without destroy+recreate cycles. `halfExtents` are world-space
   * half-dimensions of the box. No-op for non-box bodies / mockless
   * adapters.
   */
  physicsResizeBoxBody(meshId: string, halfExtents: Vec3): void;
  physicsStep(dt: number): void;
  /**
   * Pause/resume the physics simulation independently of the render loop.
   * Babylon's Havok advances inside `scene.render`, so a debugger that freezes
   * the ECS `world` does NOT freeze physics — call this to actually halt it
   * (Babylon: `havokPlugin.setTimeStep(0)`; pure-core: gate `physicsStep`).
   * Idempotent. Used by the State Stepper devtool to freeze bodies while
   * scrubbing/stepping through recorded state.
   */
  physicsSetPaused(paused: boolean): void;
  /**
   * Read a body's full kinematic state (world pose + linear/angular velocity),
   * or null if no body exists under `meshId`. The pose lives inside the physics
   * engine (Havok) — it is NOT reliably mirrored in ECS component data — so this
   * is the only correct way to snapshot a physics-driven entity for rewind.
   * Adapters whose integrator can't report a field return zeros for it.
   */
  physicsGetBodyState(meshId: string): PhysicsBodySnapshot | null;
  /**
   * Restore a body's full kinematic state. Implementations teleport the body
   * (Babylon: `setTargetTransform` + velocity setters) and sync the mesh so the
   * restore is visible immediately even while paused. Counterpart to
   * `physicsGetBodyState`; used by the State Stepper to "reverse on the entity".
   */
  physicsSetBodyState(meshId: string, state: PhysicsBodySnapshot): void;
  /**
   * Set the fixed simulation rate in Hertz. Higher Hz = smaller substep =
   * fewer tunneling/miss artifacts at the cost of CPU. Babylon implements
   * via `havokPlugin.setTimeStep(1/hz)`; adapters without a configurable
   * rate may no-op. Default Hz is engine-defined (Havok ships at 60).
   */
  physicsSetTimeStep(hz: number): void;
  /**
   * Update a body's restitution (bounciness) in place. Babylon swaps the
   * shape's PhysicsMaterial restitution; adapters without live material
   * control may no-op. Keyed by the same id passed to `physicsCreateBody`.
   */
  physicsSetRestitution(meshId: string, restitution: number): void;
  /**
   * Toggle wireframe outlines of every physics collider in the scene. Babylon
   * drives this with its built-in `PhysicsViewer` over all aggregates; other
   * adapters no-op. A debug aid — not a per-body control.
   */
  setCollidersVisible(visible: boolean): void;

  // ─── Phase-3: procedural seeded geometry ───
  /**
   * Build a deterministic, seed-driven mesh (Wingman asteroids/oil-blobs + the
   * named ship/missile/waypoint silhouettes) and register it under `id` so the
   * standard mesh ops (`setMeshPosition`/`setMeshRotation`/`setMeshScale`/
   * `setMeshVisible`/`disposeMesh`, `setMeshEmissiveById`, `attachShadowCaster`)
   * all address it. Distinct from {@link createMesh}, which builds engine
   * PRIMITIVES — this builds noise-displaced/welded geometry from a
   * {@link ProceduralMeshSpec}. Same `seed` (+`cutAxis`/`cutDepth`) ⇒ identical
   * geometry on every client. Adapters that can't tessellate procedurally may
   * fall back to a primitive of the same bounding size but MUST keep the handle
   * contract.
   */
  createProceduralMesh(id: string, spec: ProceduralMeshSpec, mat?: MaterialSpec): MeshHandle;
  /**
   * Pure, ENGINE-FREE surface evaluation for a seeded rock shape: given the
   * spec and a (need-not-be-unit) direction, write the displaced surface point
   * (object-local, before the mesh's own transform) into `out` and return it.
   * This is the SAME deterministic noise the adapter tessellates, exposed so
   * collision/occlusion code and the renderer agree on one silhouette — and so
   * the contract can prove determinism (same seed+dir ⇒ identical point) without
   * a GPU. Every adapter MUST return byte-identical results for identical inputs
   * (it's shared pure math, not an engine call). Returns `out` unchanged for the
   * non-rock shapes (ship/missile/waypoint), which have no radial surface field.
   */
  sampleProceduralSurface(spec: ProceduralMeshSpec, dirX: number, dirY: number, dirZ: number, out: Vec3): Vec3;

  // ─── Phase-3: runtime dynamic textures (CPU pixel buffer → GPU texture) ───
  /**
   * Upload a CPU-rasterized RGBA8 pixel buffer (see {@link DynamicTextureSpec})
   * as a GPU texture, deduped by `key` exactly like {@link loadTexture}: a
   * repeat call with the same key returns the same handle (ignoring the new
   * spec). The component owns the (renderer-free) pixel math — procedural rock
   * maps, the soft particle dot, the sun starburst — and never touches a canvas
   * type. Adapters without a texture pipeline record the upload and return a
   * key-deduped handle.
   */
  createDynamicTexture(key: string, spec: DynamicTextureSpec): TextureHandle;
  /**
   * Re-upload new pixels into a texture made by {@link createDynamicTexture}
   * (animated procedural maps). `pixels` must match the original width*height*4.
   * No-op on an unknown handle.
   */
  updateDynamicTexture(h: TextureHandle, pixels: Uint8ClampedArray | Uint8Array): void;

  // ─── Phase-3: particle systems ───
  /**
   * Fire a ONE-SHOT particle burst (explosion, muzzle/launch flash) at a world
   * point and auto-dispose it after {@link ParticleBurstSpec.duration}. The
   * adapter auto-selects GPU vs CPU particles. Fire-and-forget — no handle.
   */
  createParticleBurst(spec: ParticleBurstSpec): void;
  /**
   * Create a CONTINUOUS particle emitter (camera-anchored space dust, engine
   * trails) registered under `id`, returning a handle for repositioning /
   * disposal. With {@link ParticleEmitterSpec.followCamera} the adapter re-seats
   * it at the active camera each frame internally.
   */
  createParticleEmitter(id: string, spec: ParticleEmitterSpec): ParticleEmitterHandle;
  /** Move a continuous emitter (no-op when `followCamera` drives it / unknown handle). */
  setParticleEmitterPosition(h: ParticleEmitterHandle, x: number, y: number, z: number): void;
  /** Dispose a continuous emitter and free its GPU buffers. Idempotent. */
  disposeParticleEmitter(h: ParticleEmitterHandle): void;

  // ─── Phase-3: post-process glow / bloom + emissive + render ordering ───
  /**
   * Enable / configure the SELECTIVE glow post-pass (empty whitelist by
   * default — add meshes with {@link addGlowMesh}). Pass `null` to disable.
   * Adapters without a glow pipeline no-op.
   */
  setGlowLayer(spec: GlowSpec | null): void;
  /** Whitelist a mesh into the glow layer (sun disc/flare, engine orbs). No-op if no glow layer. */
  addGlowMesh(h: MeshHandle): void;
  /** Remove a mesh from the glow whitelist. No-op if absent / no glow layer. */
  removeGlowMesh(h: MeshHandle): void;
  /**
   * Enable / configure HDR bloom on the default pipeline (depth-tested, so it
   * respects occlusion — preferred over the glow layer for emissive gates
   * behind rocks). Pass `null` to disable. Adapters without a pipeline no-op.
   */
  setBloom(spec: BloomSpec | null): void;
  /**
   * Unlit-aware emissive setter keyed by the same id passed to
   * {@link createMesh}/{@link createProceduralMesh}. On a normal (lit) material
   * the emissive is the given color × `intensity` (it overpowers lighting); on
   * an UNLIT material (waypoint gates, sun disc) the value is treated as a
   * literal clamped emissive so bloom+tonemap don't blow it to white. No-op on
   * an unknown id. (The deliberate counterpart to {@link setMeshColor}, which
   * drives the flat diffuse path.)
   */
  setMeshEmissiveById(meshId: string, r: number, g: number, b: number, intensity: number): void;
  /**
   * Apply per-mesh draw-order / depth knobs (see {@link MeshRenderOptions}) so
   * the skybox, sun, decals and HUD layer correctly. No-op on an unknown handle.
   */
  setMeshRenderingOptions(h: MeshHandle, opts: MeshRenderOptions): void;

  // ─── Phase-3: camera-following sun + directional-light query ───
  /**
   * Create a camera-following sun (directional light + emissive disc, optional
   * shadow generator; see {@link SunSpec}) registered under `id`, returning the
   * {@link LightHandle} for the directional light. The disc parks at a fixed
   * offset from the active camera so it reads as infinitely distant. Adapters
   * without a sun concept create just the directional light.
   */
  createSun(id: string, spec: SunSpec): LightHandle;
  /**
   * World-space position of the sun disc (camera-relative — it moves every
   * frame), written into `out` and returned. Drives the HUD's off-screen sun
   * arrow via {@link worldToScreen}. Returns `null` (leaving `out` untouched) if
   * no sun has been created.
   */
  getSunWorldPosition(out: Vec3): Vec3 | null;

  startLoop(onFrame: (dtSeconds: number) => void): void;
  stopLoop(): void;
  resize(): void;
  dispose(): void;
}

/**
 * Full kinematic snapshot of a physics body, returned by
 * `physicsGetBodyState` and consumed by `physicsSetBodyState`. All vectors are
 * world-space; rotation is Euler radians. This is what a time-travel debugger
 * records per frame and writes back to rewind a physics-driven entity, since
 * the live pose + velocity live inside the physics engine, not in components.
 */
export interface PhysicsBodySnapshot {
  position: Vec3;
  /** Euler radians [x, y, z]. */
  rotation: Vec3;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
}

/**
 * Options accepted by `RendererAdapter.physicsCreateBody`. Kept in this file
 * rather than Physics.core.ts so adapters don't have to import a Component.
 */
export interface PhysicsBodyOpts {
  shapeType: 'sphere' | 'box' | 'capsule';
  motionType: 'dynamic' | 'static' | 'kinematic';
  mass: number;
  friction: number;
  restitution: number;
  lockRotation: boolean;
}

/**
 * Minimal interface describing a pure-JS physics integrator that a renderer
 * adapter without a native engine (e.g. ThreeAdapter) can drive. Implementations
 * live outside this package (e.g. Components/Physics/Physics.core); the adapter
 * receives a factory via its constructor so the package itself never imports
 * any physics implementation.
 */
export interface IPhysicsInstance {
  createBody(meshId: string, opts: PhysicsBodyOpts & { posX?: number; posY?: number; posZ?: number }): unknown;
  destroyBody(meshId: string): void;
  setBodyVelocity(meshId: string, vx: number, vy: number, vz: number): void;
  step(dt: number): void;
  bodies(): ReadonlyArray<{ readonly meshId: string; readonly posX: number; readonly posY: number; readonly posZ: number }>;
  reset(): void;
}

export type PhysicsFactory = () => IPhysicsInstance;
