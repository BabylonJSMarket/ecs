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

// Opaque handles. The `__brand` fields are phantom and exist only to make
// handle types distinct to TypeScript.
export type MeshHandle = { readonly __mesh: unique symbol };
export type LightHandle = { readonly __light: unique symbol };
export type CameraHandle = { readonly __camera: unique symbol };
export type ShadowCasterHandle = { readonly __shadow: unique symbol };
export type LabelHandle = { readonly __label: unique symbol };
export type SkyboxHandle = { readonly __skybox: unique symbol };
export type LineHandle = { readonly __line: unique symbol };

export interface PrimitiveSpec {
  kind: 'box' | 'sphere' | 'cylinder' | 'capsule' | 'ground' | 'torus' | 'disc' | 'plane';
  width?: number;
  height?: number;
  depth?: number;
  diameter?: number;
  diameterTop?: number;
  diameterBottom?: number;
  segments?: number;
  tessellation?: number;
  radius?: number;
  thickness?: number;
  subdivisions?: number;
  pivotAtBottom?: boolean;
}

export interface MaterialSpec {
  diffuse?: Color;
  specular?: Color;
  emissive?: Color;
  alpha?: number;
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

export interface RendererAdapter {
  readonly kind: 'babylon' | 'three';

  init(canvas: HTMLCanvasElement, opts?: RendererInitOptions): Promise<void>;

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
