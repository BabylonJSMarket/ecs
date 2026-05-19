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

export interface RendererInitOptions {
  clearColor?: [number, number, number, number];
  antialias?: boolean;
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
  setMeshColor(h: MeshHandle, r: number, g: number, b: number): void;
  setMeshVisible(h: MeshHandle, visible: boolean): void;
  getMeshWorldPosition(h: MeshHandle, out: Vec3): Vec3;
  disposeMesh(h: MeshHandle): void;

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

  attachShadowCaster(light: LightHandle, mesh: MeshHandle): ShadowCasterHandle;
  detachShadowCaster(h: ShadowCasterHandle): void;
  setMeshReceiveShadows(h: MeshHandle, receive: boolean): void;

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
  physicsStep(dt: number): void;

  startLoop(onFrame: (dtSeconds: number) => void): void;
  stopLoop(): void;
  resize(): void;
  dispose(): void;
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
