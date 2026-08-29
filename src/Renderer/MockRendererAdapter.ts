/**
 * MockRendererAdapter — records every adapter call for Systems tests.
 *
 * Systems talk to the renderer through opaque handles; tests assert the
 * sequence of calls without needing a real 3D engine.
 */

import type {
  ArcCameraSpec,
  BillboardMode,
  CameraHandle,
  DirectionalLightSpec,
  HemisphericLightSpec,
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
  ProceduralMeshSpec,
  DynamicTextureSpec,
  ParticleBurstSpec,
  ParticleEmitterSpec,
  ParticleEmitterHandle,
  GlowSpec,
  BloomSpec,
  MeshRenderOptions,
  SunSpec,
} from './types';
import type { Color } from './types';

/**
 * Deterministic [0,1) hash of three integers — the Mock's reference noise
 * source for {@link MockRendererAdapter.sampleProceduralSurface}. Mirrors the
 * asteroid hash so seeded geometry is reproducible without an engine.
 */
function mockHash3(a: number, b: number, c: number): number {
  let n = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/**
 * Rotate a Vec3 by a unit quaternion: v' = v + 2·w·(q×v) + 2·(q×(q×v)).
 * Used by the Mock's deterministic pinhole projection so `worldToScreen`
 * resolves a real camera basis from the quaternion set via `setCameraPose`.
 */
function rotateByQuat(v: Vec3, q: Quaternion): Vec3 {
  const tx = 2 * (q.y * v[2] - q.z * v[1]);
  const ty = 2 * (q.z * v[0] - q.x * v[2]);
  const tz = 2 * (q.x * v[1] - q.y * v[0]);
  return [
    v[0] + q.w * tx + (q.y * tz - q.z * ty),
    v[1] + q.w * ty + (q.z * tx - q.x * tz),
    v[2] + q.w * tz + (q.x * ty - q.y * tx),
  ];
}

export interface MockCall {
  method: string;
  args: unknown[];
  result?: unknown;
}

function makeHandle<T>(kind: string, id: string): T {
  return { __mockHandle: `${kind}:${id}` } as unknown as T;
}

export class MockRendererAdapter implements RendererAdapter {
  readonly kind = 'babylon' as const;
  calls: MockCall[] = [];

  /** Per-mesh world position stub; tests can set this to drive camera-follow logic. */
  meshWorldPositions = new Map<MeshHandle, Vec3>();

  /** Per-mesh bounding-box extents stub; populated by `setMeshBoundingBoxExtents`. */
  meshBoundingExtents = new Map<MeshHandle, { min: Vec3; max: Vec3 }>();

  /** Per-camera angles / target stub; tests can preload values. */
  cameraAngles = new Map<CameraHandle, { alpha: number; beta: number; radius: number }>();
  cameraTargets = new Map<CameraHandle, Vec3>();
  /** Positions of positioned lights, so tests can assert where a lamp landed. */
  lightPositions = new Map<LightHandle, Vec3>();

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  /** The canvas passed to `init`, surfaced by `getRenderingCanvas`. */
  private canvas: HTMLCanvasElement | null = null;

  async init(canvas: HTMLCanvasElement, _opts?: RendererInitOptions): Promise<void> {
    this.canvas = canvas ?? null;
    this.record('init');
  }

  getRenderingCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  /** Last scene clear color applied (RGBA), surfaced for assertions. */
  clearColor: [number, number, number, number] = [0, 0, 0, 1];
  setClearColor(r: number, g: number, b: number, a = 1): void {
    this.clearColor = [r, g, b, a];
    this.record('setClearColor', r, g, b, a);
  }

  createMesh(id: string, prim: PrimitiveSpec, mat?: MaterialSpec): MeshHandle {
    const h = makeHandle<MeshHandle>('mesh', id);
    this.record('createMesh', id, prim, mat);
    return h;
  }
  createDebugBox(id: string, parent: MeshHandle, color: Color): MeshHandle | null {
    // No rendering — fabricate a handle the same way createMesh does so the
    // returned handle is accepted by subsequent setMeshScale/disposeMesh calls.
    const h = makeHandle<MeshHandle>('debugBox', id);
    this.record('createDebugBox', id, parent, color);
    return h;
  }
  setMeshPosition(h: MeshHandle, x: number, y: number, z: number): void {
    // Update the round-trip stub so getMeshWorldPosition returns what was
    // last set. Tests that want to preload a different value can still
    // overwrite meshWorldPositions directly after this call.
    this.meshWorldPositions.set(h, [x, y, z]);
    this.record('setMeshPosition', h, x, y, z);
  }
  setMeshRotation(h: MeshHandle, x: number, y: number, z: number): void {
    this.record('setMeshRotation', h, x, y, z);
  }
  /** Last quaternion applied per mesh, surfaced for assertions. */
  meshOrientations = new Map<MeshHandle, Quaternion>();
  setMeshOrientation(h: MeshHandle, orientation: Quaternion): void {
    this.meshOrientations.set(h, { ...orientation });
    this.record('setMeshOrientation', h, orientation);
  }
  setMeshColor(h: MeshHandle, r: number, g: number, b: number): void {
    this.record('setMeshColor', h, r, g, b);
  }
  setMeshVisible(h: MeshHandle, visible: boolean): void {
    this.record('setMeshVisible', h, visible);
  }
  setMeshScale(h: MeshHandle, sx: number, sy: number, sz: number): void {
    this.record('setMeshScale', h, sx, sy, sz);
  }
  replaceMeshGeometry(h: MeshHandle, geom: MeshGeometry): void {
    this.record('replaceMeshGeometry', h, geom);
  }
  setMeshBillboardMode(h: MeshHandle, mode: BillboardMode): void {
    this.record('setMeshBillboardMode', h, mode);
  }
  getMeshWorldPosition(h: MeshHandle, out: Vec3): Vec3 {
    const pos = this.meshWorldPositions.get(h) ?? [0, 0, 0];
    out[0] = pos[0];
    out[1] = pos[1];
    out[2] = pos[2];
    this.record('getMeshWorldPosition', h);
    return out;
  }
  setMeshBoundingBoxExtents(h: MeshHandle, min: Vec3, max: Vec3): void {
    this.meshBoundingExtents.set(h, { min: [...min] as Vec3, max: [...max] as Vec3 });
    this.record('setMeshBoundingBoxExtents', h, min, max);
  }
  getMeshBoundingBoxExtents(h: MeshHandle): { min: Vec3; max: Vec3 } | null {
    this.record('getMeshBoundingBoxExtents', h);
    return this.meshBoundingExtents.get(h) ?? null;
  }
  disposeMesh(h: MeshHandle): void {
    this.record('disposeMesh', h);
  }

  /** Per-line-system stub; tests can assert the last polylines + color drawn. */
  lineSystems = new Map<LineHandle, { lines: Vec3[][]; color?: Color; visible: boolean }>();

  createLineSystem(id: string, lines: Vec3[][], color?: Color): LineHandle {
    const h = makeHandle<LineHandle>('lineSystem', id);
    this.lineSystems.set(h, { lines, color, visible: true });
    this.record('createLineSystem', id, lines, color);
    return h;
  }
  updateLineSystem(h: LineHandle, lines: Vec3[][], color?: Color): void {
    const rec = this.lineSystems.get(h);
    if (rec) {
      rec.lines = lines;
      if (color) rec.color = color;
    }
    this.record('updateLineSystem', h, lines, color);
  }
  setLineSystemVisible(h: LineHandle, visible: boolean): void {
    const rec = this.lineSystems.get(h);
    if (rec) rec.visible = visible;
    this.record('setLineSystemVisible', h, visible);
  }
  disposeLineSystem(h: LineHandle): void {
    this.lineSystems.delete(h);
    this.record('disposeLineSystem', h);
  }

  /** Per-thin-field stub; tests can assert the last packed buffer + draw count. */
  thinFields = new Map<ThinFieldHandle, { spec: ThinFieldSpec; count: number }>();

  async loadThinField(spec: ThinFieldSpec): Promise<ThinFieldHandle | null> {
    const h = makeHandle<ThinFieldHandle>('thinField', spec.nodeName);
    this.thinFields.set(h, { spec, count: 0 });
    this.record('loadThinField', spec);
    return h;
  }
  setThinFieldInstances(handle: ThinFieldHandle, packed: Float32Array, count: number): void {
    const rec = this.thinFields.get(handle);
    if (rec) rec.count = count;
    this.record('setThinFieldInstances', handle, packed, count);
  }
  disposeThinField(handle: ThinFieldHandle): void {
    this.thinFields.delete(handle);
    this.record('disposeThinField', handle);
  }
  screenToWorldPoint(camera: CameraHandle, nx: number, ny: number, distance: number, out: Vec3): Vec3 {
    // Project along the camera forward direction a fixed distance from the
    // target — enough for tests to get a finite, written-into-out Vec3.
    const fwd: Vec3 = [0, 0, 0];
    this.getCameraForward(camera, fwd);
    const t = this.cameraTargets.get(camera) ?? [0, 0, 0];
    out[0] = t[0] + fwd[0] * distance;
    out[1] = t[1] + fwd[1] * distance;
    out[2] = t[2] + fwd[2] * distance;
    this.record('screenToWorldPoint', camera, nx, ny, distance);
    return out;
  }

  // ─── Textures & cards ───
  /**
   * Texture dedupe cache keyed by the caller's `key`, mirroring the engine
   * adapters: a repeat `loadTexture(key, …)` returns the same handle. Tests can
   * assert the cache size + the per-card-mesh face assignments.
   */
  textures = new Map<string, TextureHandle>();
  /** Per-card-mesh recorded face textures, so tests can assert flips. */
  cardFaces = new Map<MeshHandle, { front?: TextureHandle; back?: TextureHandle }>();
  /** Albedo tints recorded by setMeshAlbedoColor. */
  meshAlbedoColors = new Map<MeshHandle, Color>();
  /** Aspect ratio surfaced by getAspectRatio; tests can override. */
  aspectRatio = 16 / 9;

  loadTexture(key: string, url: string, opts?: TextureLoadOpts): TextureHandle {
    this.record('loadTexture', key, url, opts);
    // Dedupe by key: a second call with the same key returns the same handle
    // (and ignores opts), matching the engine adapters' cache semantics.
    const existing = this.textures.get(key);
    if (existing) return existing;
    const h = makeHandle<TextureHandle>('texture', key);
    this.textures.set(key, h);
    return h;
  }
  async preloadTexture(url: string): Promise<void> {
    // No real I/O in the mock — record the request and resolve immediately.
    this.record('preloadTexture', url);
  }
  createCardMesh(id: string, spec: CardMeshSpec): MeshHandle {
    const h = makeHandle<MeshHandle>('card', id);
    this.cardFaces.set(h, { front: spec.front, back: spec.back });
    this.record('createCardMesh', id, spec);
    return h;
  }
  setMeshFaceTexture(h: MeshHandle, side: 'front' | 'back', tex: TextureHandle): void {
    this.record('setMeshFaceTexture', h, side, tex);
    const faces = this.cardFaces.get(h);
    if (!faces) return;
    if (side === 'front') faces.front = tex;
    else faces.back = tex;
  }
  setMeshAlbedoColor(h: MeshHandle, r: number, g: number, b: number): void {
    this.meshAlbedoColors.set(h, [r, g, b]);
    this.record('setMeshAlbedoColor', h, r, g, b);
  }
  disposeTexture(h: TextureHandle): void {
    this.record('disposeTexture', h);
    // Idempotent: drop whichever cache entry minted this handle (if any still does).
    for (const [key, handle] of this.textures) {
      if (handle === h) {
        this.textures.delete(key);
        break;
      }
    }
  }
  getAspectRatio(): number {
    this.record('getAspectRatio');
    return this.aspectRatio;
  }

  async loadMesh(id: string, spec: MeshLoadSpec): Promise<MeshLoadResult> {
    // Tests don't touch the filesystem; the mock just records the call and
    // synthesizes a handle so the System sees a "loaded" mesh it can address
    // by `id` for subsequent animation or position calls.
    const h = makeHandle<MeshHandle>('loadedMesh', id);
    this.record('loadMesh', id, spec);
    return { meshId: id, handle: h, animationNames: [] };
  }

  createDirectionalLight(id: string, spec: DirectionalLightSpec): LightHandle {
    const h = makeHandle<LightHandle>('dirLight', id);
    this.record('createDirectionalLight', id, spec);
    return h;
  }
  createHemisphericLight(id: string, spec: HemisphericLightSpec): LightHandle {
    const h = makeHandle<LightHandle>('hemLight', id);
    this.record('createHemisphericLight', id, spec);
    return h;
  }
  createPointLight(id: string, spec: PointLightSpec): LightHandle {
    const h = makeHandle<LightHandle>('pointLight', id);
    this.lightPositions.set(h, [...spec.position] as Vec3);
    this.record('createPointLight', id, spec);
    return h;
  }
  setLightPosition(h: LightHandle, x: number, y: number, z: number): void {
    this.lightPositions.set(h, [x, y, z]);
    this.record('setLightPosition', h, x, y, z);
  }
  /** Last position recorded for a light, so tests can assert placement. */
  getLightPosition(h: LightHandle): Vec3 | undefined {
    return this.lightPositions.get(h);
  }
  updateLightIntensity(h: LightHandle, intensity: number): void {
    this.record('updateLightIntensity', h, intensity);
  }
  disposeLight(h: LightHandle): void {
    this.record('disposeLight', h);
  }

  createArcCamera(id: string, spec: ArcCameraSpec): CameraHandle {
    const h = makeHandle<CameraHandle>('arcCamera', id);
    this.cameraAngles.set(h, { alpha: spec.alpha, beta: spec.beta, radius: spec.radius });
    this.cameraTargets.set(h, [...spec.target] as Vec3);
    this.record('createArcCamera', id, spec);
    return h;
  }
  setCameraTarget(h: CameraHandle, x: number, y: number, z: number): void {
    this.cameraTargets.set(h, [x, y, z]);
    this.record('setCameraTarget', h, x, y, z);
  }
  getCameraTarget(h: CameraHandle, out: Vec3): Vec3 {
    const t = this.cameraTargets.get(h) ?? [0, 0, 0];
    out[0] = t[0];
    out[1] = t[1];
    out[2] = t[2];
    return out;
  }
  getCameraAngles(h: CameraHandle): { alpha: number; beta: number; radius: number } {
    return this.cameraAngles.get(h) ?? { alpha: 0, beta: 0, radius: 0 };
  }
  getCameraForward(h: CameraHandle, out: Vec3): Vec3 {
    // A free 6-DOF perspective camera carries a full orientation quaternion, so
    // its forward is `q · (+Z)` — the canonical convention (identity → +Z) the
    // contract locks across every adapter. Resolve it FIRST; fall through to the
    // arc-camera alpha derivation (and the alpha=0 unknown-handle default).
    const persp = this.perspectiveCameras.get(h);
    if (persp) {
      const f = rotateByQuat([0, 0, 1], persp.orientation);
      out[0] = f[0]; out[1] = f[1]; out[2] = f[2];
      return out;
    }
    const a = this.cameraAngles.get(h);
    const alpha = a?.alpha ?? 0;
    out[0] = -Math.cos(alpha);
    out[1] = 0;
    out[2] = -Math.sin(alpha);
    return out;
  }
  getCameraRight(h: CameraHandle, out: Vec3): Vec3 {
    // Right-handed convention (matches ThreeAdapter). Tests pick Babylon or
    // Three by setting cameraAngles; basis direction follows RH cross.
    const a = this.cameraAngles.get(h);
    const alpha = a?.alpha ?? 0;
    out[0] = Math.sin(alpha);
    out[1] = 0;
    out[2] = -Math.cos(alpha);
    return out;
  }
  nudgeCameraAlpha(h: CameraHandle, delta: number): void {
    const a = this.cameraAngles.get(h);
    if (a) a.alpha += delta;
    this.record('nudgeCameraAlpha', h, delta);
  }
  nudgeCameraTarget(h: CameraHandle, dx: number, dy: number, dz: number): void {
    const t = this.cameraTargets.get(h) ?? [0, 0, 0];
    t[0] += dx;
    t[1] += dy;
    t[2] += dz;
    this.cameraTargets.set(h, t);
    this.record('nudgeCameraTarget', h, dx, dy, dz);
  }
  nudgeCameraRadius(h: CameraHandle, delta: number): void {
    const a = this.cameraAngles.get(h);
    if (a) a.radius = Math.max(0.01, a.radius + delta);
    this.record('nudgeCameraRadius', h, delta);
  }
  nudgeCameraBeta(h: CameraHandle, delta: number): void {
    const a = this.cameraAngles.get(h);
    if (a) a.beta = Math.max(0.01, Math.min(Math.PI - 0.01, a.beta + delta));
    this.record('nudgeCameraBeta', h, delta);
  }
  setCameraRadius(h: CameraHandle, radius: number): void {
    const a = this.cameraAngles.get(h);
    if (a) a.radius = radius;
    this.record('setCameraRadius', h, radius);
  }
  setCameraRadiusLimits(h: CameraHandle, min: number, max: number): void {
    this.record('setCameraRadiusLimits', h, min, max);
  }
  setCameraFov(h: CameraHandle, fov: number): void {
    this.record('setCameraFov', h, fov);
  }
  setCameraControlsEnabled(h: CameraHandle, enabled: boolean): void {
    this.record('setCameraControlsEnabled', h, enabled);
  }

  // ─── Free 6-DOF perspective camera + projection ───
  /** Per-perspective-camera pose + spec stub; `worldToScreen` projects against the active one. */
  perspectiveCameras = new Map<CameraHandle, { spec: PerspectiveCameraSpec; position: Vec3; orientation: Quaternion }>();
  /** The most-recently-created perspective camera — the one `worldToScreen` projects against. */
  private activePerspectiveCamera: CameraHandle | null = null;
  /** Render dims used by the deterministic pinhole projection. Tests can override. */
  renderWidth = 1280;
  renderHeight = 720;

  createPerspectiveCamera(id: string, spec: PerspectiveCameraSpec): CameraHandle {
    const h = makeHandle<CameraHandle>('perspCamera', id);
    this.perspectiveCameras.set(h, {
      spec,
      position: spec.position ? [spec.position[0], spec.position[1], spec.position[2]] : [0, 0, 0],
      orientation: spec.orientation ? { ...spec.orientation } : { x: 0, y: 0, z: 0, w: 1 },
    });
    this.activePerspectiveCamera = h;
    this.record('createPerspectiveCamera', id, spec);
    return h;
  }
  setCameraPose(h: CameraHandle, position: Vec3, orientation: Quaternion): void {
    const rec = this.perspectiveCameras.get(h);
    if (rec) {
      rec.position = [position[0], position[1], position[2]];
      rec.orientation = { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w };
    }
    this.record('setCameraPose', h, position, orientation);
  }
  getCameraPose(h: CameraHandle, outPosition: Vec3, outOrientation: Quaternion): void {
    const rec = this.perspectiveCameras.get(h);
    if (!rec) return;
    outPosition[0] = rec.position[0];
    outPosition[1] = rec.position[1];
    outPosition[2] = rec.position[2];
    outOrientation.x = rec.orientation.x;
    outOrientation.y = rec.orientation.y;
    outOrientation.z = rec.orientation.z;
    outOrientation.w = rec.orientation.w;
  }
  worldToScreen(x: number, y: number, z: number, out: ScreenPoint): boolean {
    this.record('worldToScreen', x, y, z);
    const cam = this.activePerspectiveCamera
      ? this.perspectiveCameras.get(this.activePerspectiveCamera)
      : undefined;
    if (!cam) return false;
    // Camera basis from the quaternion. Babylon LH convention: an identity
    // orientation looks down +Z, +X is right, +Y is up.
    const fwd = rotateByQuat([0, 0, 1], cam.orientation);
    const right = rotateByQuat([1, 0, 0], cam.orientation);
    const up = rotateByQuat([0, 1, 0], cam.orientation);
    const rx = x - cam.position[0];
    const ry = y - cam.position[1];
    const rz = z - cam.position[2];
    const depth = rx * fwd[0] + ry * fwd[1] + rz * fwd[2];
    if (depth <= 0) return false; // behind the camera — leave `out` untouched
    const vx = rx * right[0] + ry * right[1] + rz * right[2];
    const vy = rx * up[0] + ry * up[1] + rz * up[2];
    const aspect = this.renderWidth / this.renderHeight;
    const tanHalf = Math.tan(cam.spec.fov / 2);
    const ndcX = vx / depth / (tanHalf * aspect);
    const ndcY = vy / depth / tanHalf;
    out.x = (ndcX * 0.5 + 0.5) * this.renderWidth;
    out.y = (0.5 - ndcY * 0.5) * this.renderHeight;
    return true;
  }

  // ─── Floating origin (Phase-1: contract-only, dormant) ───
  /** Tracked floating-origin offset; round-trips via get/setOriginOffset. No active rebase. */
  originOffset: Vec3 = [0, 0, 0];
  /** Recorded large-world config (Phase-1 records only; no rebase). */
  largeWorld: { enabled: boolean; farPlane?: number } = { enabled: false };

  getOriginOffset(out: Vec3): Vec3 {
    out[0] = this.originOffset[0];
    out[1] = this.originOffset[1];
    out[2] = this.originOffset[2];
    this.record('getOriginOffset');
    return out;
  }
  setOriginOffset(x: number, y: number, z: number): void {
    this.originOffset = [x, y, z];
    this.record('setOriginOffset', x, y, z);
  }
  configureLargeWorld(spec: LargeWorldSpec): void {
    this.largeWorld = { enabled: spec.enabled, farPlane: spec.farPlane };
    this.record('configureLargeWorld', spec);
  }

  pickAtScreenPoint(x: number, y: number, opts?: PickOptions): PickResult | null {
    this.record('pickAtScreenPoint', x, y, opts);
    return null;
  }

  attachShadowCaster(light: LightHandle, mesh: MeshHandle): ShadowCasterHandle {
    const h = makeHandle<ShadowCasterHandle>('shadow', `${String((light as any).__mockHandle)}+${String((mesh as any).__mockHandle)}`);
    this.record('attachShadowCaster', light, mesh);
    return h;
  }
  detachShadowCaster(h: ShadowCasterHandle): void {
    this.record('detachShadowCaster', h);
  }
  setMeshReceiveShadows(h: MeshHandle, receive: boolean): void {
    this.record('setMeshReceiveShadows', h, receive);
  }

  playAnimation(meshId: string, clipName: string, loop?: boolean): void {
    this.record('playAnimation', meshId, clipName, loop);
  }
  stopAnimation(meshId: string, clipName: string): void {
    this.record('stopAnimation', meshId, clipName);
  }
  setAnimationWeight(meshId: string, clipName: string, weight: number): void {
    this.record('setAnimationWeight', meshId, clipName, weight);
  }
  setAnimationSpeed(meshId: string, clipName: string, speed: number): void {
    this.record('setAnimationSpeed', meshId, clipName, speed);
  }

  /**
   * Skeleton stub. Tests seed a fake rig with `setMockBones(meshId, bones)`;
   * `listBones`/`getBoneWorldPose` then answer from it exactly like a real
   * adapter would from a loaded GLB. Unseeded meshes report no skeleton.
   */
  mockBones = new Map<string, Map<string, { position: Vec3; orientation: Quaternion }>>();
  setMockBones(
    meshId: string,
    bones: Array<{ name: string; position?: Vec3; orientation?: Quaternion }>,
  ): void {
    const byName = new Map<string, { position: Vec3; orientation: Quaternion }>();
    for (const b of bones) {
      byName.set(b.name, {
        position: b.position ? ([...b.position] as Vec3) : [0, 0, 0],
        orientation: b.orientation ? { ...b.orientation } : { x: 0, y: 0, z: 0, w: 1 },
      });
    }
    this.mockBones.set(meshId, byName);
  }
  listBones(meshId: string): string[] {
    this.record('listBones', meshId);
    const bones = this.mockBones.get(meshId);
    return bones ? Array.from(bones.keys()) : [];
  }
  getBoneWorldPose(
    meshId: string,
    boneName: string,
    outPosition: Vec3,
    outOrientation: Quaternion,
  ): boolean {
    this.record('getBoneWorldPose', meshId, boneName);
    const bone = this.mockBones.get(meshId)?.get(boneName);
    if (!bone) return false;
    outPosition[0] = bone.position[0];
    outPosition[1] = bone.position[1];
    outPosition[2] = bone.position[2];
    outOrientation.x = bone.orientation.x;
    outOrientation.y = bone.orientation.y;
    outOrientation.z = bone.orientation.z;
    outOrientation.w = bone.orientation.w;
    return true;
  }

  /** Tests can preload the clip names `loadModelTemplate` resolves with. */
  modelTemplateAnimationNames: string[] = [];

  // ── Extension seam ─────────────────────────────────────────────────────────
  private extensions = new Map<string, object>();
  registerExtension(name: string, impl: object): void {
    this.record('registerExtension', name);
    this.extensions.set(name, impl);
  }
  extension<T = object>(name: string): T | undefined {
    return this.extensions.get(name) as T | undefined;
  }
  /**
   * Duration `playAnimationOnce` reports back (seconds). Default 0 so consumers
   * fall back to their own configured one-shot durations in unit tests.
   */
  animationOnceDuration = 0;

  async loadModelTemplate(
    url: string,
    opts?: LoadModelTemplateOptions,
  ): Promise<{ animationNames: string[] }> {
    this.record('loadModelTemplate', url, opts);
    return { animationNames: [...this.modelTemplateAnimationNames] };
  }
  instantiateModel(id: string, url: string, spec?: ModelInstantiateSpec): MeshHandle {
    const h = makeHandle<MeshHandle>('model', id);
    this.record('instantiateModel', id, url, spec);
    return h;
  }
  setModelVisible(h: MeshHandle, visible: boolean): void {
    this.record('setModelVisible', h, visible);
  }
  setModelAlpha(id: string, alpha: number): void {
    this.record('setModelAlpha', id, alpha);
  }
  disposeModel(id: string, h: MeshHandle): void {
    this.record('disposeModel', id, h);
  }
  playAnimationOnce(meshId: string, clipName: string): number {
    this.record('playAnimationOnce', meshId, clipName);
    return this.animationOnceDuration;
  }

  createLabel(id: string, spec: LabelSpec): LabelHandle {
    const h = makeHandle<LabelHandle>('label', id);
    this.record('createLabel', id, spec);
    return h;
  }
  setLabelText(h: LabelHandle, text: string): void {
    this.record('setLabelText', h, text);
  }
  setLabelPosition(h: LabelHandle, x: number, y: number, z: number): void {
    this.record('setLabelPosition', h, x, y, z);
  }
  setLabelColor(h: LabelHandle, r: number, g: number, b: number): void {
    this.record('setLabelColor', h, r, g, b);
  }
  setLabelAlpha(h: LabelHandle, alpha: number): void {
    this.record('setLabelAlpha', h, alpha);
  }
  setLabelScale(h: LabelHandle, scale: number): void {
    this.record('setLabelScale', h, scale);
  }
  setLabelVisible(h: LabelHandle, visible: boolean): void {
    this.record('setLabelVisible', h, visible);
  }
  disposeLabel(h: LabelHandle): void {
    this.record('disposeLabel', h);
  }

  createSkybox(id: string, spec: SkyboxSpec): SkyboxHandle {
    const h = makeHandle<SkyboxHandle>('skybox', id);
    this.record('createSkybox', id, spec);
    return h;
  }
  updateSkyboxSun(h: SkyboxHandle, sunDirection: Vec3, sunColor?: Color): void {
    this.record('updateSkyboxSun', h, sunDirection, sunColor);
  }
  disposeSkybox(h: SkyboxHandle): void {
    this.record('disposeSkybox', h);
  }

  setEnvironmentTexture(url: string, opts?: EnvironmentTextureOpts): void {
    this.record('setEnvironmentTexture', url, opts);
  }
  clearEnvironmentTexture(): void {
    this.record('clearEnvironmentTexture');
  }
  applyPbrMaterial(handle: MeshHandle, spec: PbrMaterialSpec): void {
    this.record('applyPbrMaterial', handle, spec);
  }
  setMeshSkin(handle: MeshHandle, spec: MeshSkinSpec): void {
    this.record('setMeshSkin', handle, spec);
  }

  /**
   * In-memory body kinematics, so `physicsGetBodyState`/`physicsSetBodyState`
   * round-trip in tests without a real engine. Tests can preload/mutate this to
   * simulate physics motion between frames.
   */
  physicsBodies = new Map<string, PhysicsBodySnapshot>();
  physicsPaused = false;

  physicsCreateBody(meshId: string, opts: PhysicsBodyOpts): void {
    this.record('physicsCreateBody', meshId, opts);
    if (!this.physicsBodies.has(meshId)) {
      this.physicsBodies.set(meshId, {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        linearVelocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
      });
    }
  }
  physicsSetPaused(paused: boolean): void {
    this.record('physicsSetPaused', paused);
    this.physicsPaused = paused;
  }
  physicsGetBodyState(meshId: string): PhysicsBodySnapshot | null {
    this.record('physicsGetBodyState', meshId);
    const s = this.physicsBodies.get(meshId);
    if (!s) return null;
    return {
      position: [...s.position],
      rotation: [...s.rotation],
      linearVelocity: [...s.linearVelocity],
      angularVelocity: [...s.angularVelocity],
    };
  }
  physicsSetBodyState(meshId: string, state: PhysicsBodySnapshot): void {
    this.record('physicsSetBodyState', meshId, state);
    this.physicsBodies.set(meshId, {
      position: [...state.position],
      rotation: [...state.rotation],
      linearVelocity: [...state.linearVelocity],
      angularVelocity: [...state.angularVelocity],
    });
  }
  physicsDestroyBody(meshId: string): void {
    this.record('physicsDestroyBody', meshId);
  }
  physicsSetBodyVelocity(meshId: string, vx: number, vy: number, vz: number): void {
    this.record('physicsSetBodyVelocity', meshId, vx, vy, vz);
  }
  physicsSetBodyAngularVelocity(meshId: string, vx: number, vy: number, vz: number): void {
    this.record('physicsSetBodyAngularVelocity', meshId, vx, vy, vz);
  }
  physicsSetBodyDrivenByMesh(meshId: string, drivenByMesh: boolean): void {
    this.record('physicsSetBodyDrivenByMesh', meshId, drivenByMesh);
  }
  physicsSetGravity(x: number, y: number, z: number): void {
    this.record('physicsSetGravity', x, y, z);
  }

  physicsResizeBoxBody(meshId: string, halfExtents: Vec3): void {
    this.record('physicsResizeBoxBody', meshId, halfExtents);
  }
  physicsSetTimeStep(hz: number): void {
    this.record('physicsSetTimeStep', hz);
  }
  physicsSetRestitution(meshId: string, restitution: number): void {
    this.record('physicsSetRestitution', meshId, restitution);
  }
  setCollidersVisible(visible: boolean): void {
    this.record('setCollidersVisible', visible);
  }
  physicsStep(dt: number): void {
    this.record('physicsStep', dt);
  }

  // ─── Phase-3: procedural seeded geometry ───
  /** Per-procedural-mesh recorded spec, so tests can assert seed/shape/cut. */
  proceduralMeshes = new Map<MeshHandle, ProceduralMeshSpec>();

  createProceduralMesh(id: string, spec: ProceduralMeshSpec, mat?: MaterialSpec): MeshHandle {
    const h = makeHandle<MeshHandle>('proc', id);
    this.proceduralMeshes.set(h, spec);
    this.record('createProceduralMesh', id, spec, mat);
    return h;
  }
  sampleProceduralSurface(spec: ProceduralMeshSpec, dirX: number, dirY: number, dirZ: number, out: Vec3): Vec3 {
    const isRock = spec.shape === 'asteroid' || spec.shape === 'oil-blob' || spec.shape === 'asteroid-drop';
    if (!isRock) return out; // ship/missile/waypoint have no radial surface field
    const seed = spec.seed ?? 1;
    const radius = spec.size[0];
    // Normalize the input direction (callers pass icosphere vertex dirs).
    const len = Math.hypot(dirX, dirY, dirZ) || 1;
    const nx = dirX / len, ny = dirY / len, nz = dirZ / len;
    // Deterministic multi-octave displacement keyed by seed + quantized dir.
    // Quantizing makes the same vertex direction map to the same offset on
    // every adapter/run; identical (seed,dir) ⇒ identical radius.
    let amp = 0.5;
    let freq = 2;
    let disp = 0;
    for (let o = 0; o < 4; o++) {
      const qx = Math.round(nx * freq * 8);
      const qy = Math.round(ny * freq * 8);
      const qz = Math.round(nz * freq * 8);
      disp += (mockHash3(qx + seed, qy + seed * 31, qz + seed * 131) - 0.5) * amp;
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

  // ─── Phase-3: runtime dynamic textures ───
  /** Dynamic textures deduped by key (mirrors the engine adapters' cache). */
  dynamicTextures = new Map<string, TextureHandle>();

  createDynamicTexture(key: string, spec: DynamicTextureSpec): TextureHandle {
    this.record('createDynamicTexture', key, spec);
    const existing = this.dynamicTextures.get(key);
    if (existing) return existing;
    const h = makeHandle<TextureHandle>('dynTex', key);
    this.dynamicTextures.set(key, h);
    return h;
  }
  updateDynamicTexture(h: TextureHandle, pixels: Uint8ClampedArray | Uint8Array): void {
    this.record('updateDynamicTexture', h, pixels);
  }

  // ─── Phase-3: particle systems ───
  /** Live continuous emitters, so create/setPosition/dispose round-trips. */
  particleEmitters = new Map<ParticleEmitterHandle, { spec: ParticleEmitterSpec; position: Vec3 }>();

  createParticleBurst(spec: ParticleBurstSpec): void {
    this.record('createParticleBurst', spec);
  }
  createParticleEmitter(id: string, spec: ParticleEmitterSpec): ParticleEmitterHandle {
    const h = makeHandle<ParticleEmitterHandle>('emitter', id);
    this.particleEmitters.set(h, {
      spec,
      position: spec.position ? [...spec.position] as Vec3 : [0, 0, 0],
    });
    this.record('createParticleEmitter', id, spec);
    return h;
  }
  setParticleEmitterPosition(h: ParticleEmitterHandle, x: number, y: number, z: number): void {
    const rec = this.particleEmitters.get(h);
    if (rec) rec.position = [x, y, z];
    this.record('setParticleEmitterPosition', h, x, y, z);
  }
  disposeParticleEmitter(h: ParticleEmitterHandle): void {
    this.particleEmitters.delete(h);
    this.record('disposeParticleEmitter', h);
  }

  // ─── Phase-3: glow / bloom / emissive / render ordering ───
  /** Last glow / bloom config + glow whitelist, surfaced for assertions. */
  glow: GlowSpec | null = null;
  bloom: BloomSpec | null = null;
  glowMeshes = new Set<MeshHandle>();
  meshRenderOptions = new Map<MeshHandle, MeshRenderOptions>();

  setGlowLayer(spec: GlowSpec | null): void {
    this.glow = spec;
    if (!spec) this.glowMeshes.clear();
    this.record('setGlowLayer', spec);
  }
  addGlowMesh(h: MeshHandle): void {
    this.glowMeshes.add(h);
    this.record('addGlowMesh', h);
  }
  removeGlowMesh(h: MeshHandle): void {
    this.glowMeshes.delete(h);
    this.record('removeGlowMesh', h);
  }
  setBloom(spec: BloomSpec | null): void {
    this.bloom = spec;
    this.record('setBloom', spec);
  }
  setMeshEmissiveById(meshId: string, r: number, g: number, b: number, intensity: number): void {
    this.record('setMeshEmissiveById', meshId, r, g, b, intensity);
  }
  setMeshRenderingOptions(h: MeshHandle, opts: MeshRenderOptions): void {
    this.meshRenderOptions.set(h, { ...(this.meshRenderOptions.get(h) ?? {}), ...opts });
    this.record('setMeshRenderingOptions', h, opts);
  }

  // ─── Phase-3: camera-following sun ───
  /** Recorded sun world position; null until createSun. Tests can override. */
  sunWorldPosition: Vec3 | null = null;

  createSun(id: string, spec: SunSpec): LightHandle {
    const h = makeHandle<LightHandle>('sun', id);
    // Disc parks at `-direction * distance` from the (origin) camera by default;
    // gives a finite, deterministic readback for getSunWorldPosition.
    const d = spec.direction;
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    this.sunWorldPosition = [
      -(d[0] / dl) * spec.distance,
      -(d[1] / dl) * spec.distance,
      -(d[2] / dl) * spec.distance,
    ];
    this.record('createSun', id, spec);
    return h;
  }
  getSunWorldPosition(out: Vec3): Vec3 | null {
    this.record('getSunWorldPosition');
    if (!this.sunWorldPosition) return null;
    out[0] = this.sunWorldPosition[0];
    out[1] = this.sunWorldPosition[1];
    out[2] = this.sunWorldPosition[2];
    return out;
  }

  startLoop(onFrame: (dtSeconds: number) => void): void {
    this.record('startLoop');
    void onFrame;
  }
  stopLoop(): void {
    this.record('stopLoop');
  }
  resize(): void {
    this.record('resize');
  }
  dispose(): void {
    this.record('dispose');
  }
}
