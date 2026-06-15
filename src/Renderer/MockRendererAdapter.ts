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
  ThinFieldHandle,
  ThinFieldSpec,
  Vec3,
} from './types';
import type { Color } from './types';

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

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  async init(_canvas: HTMLCanvasElement, _opts?: RendererInitOptions): Promise<void> {
    this.record('init');
  }

  createMesh(id: string, prim: PrimitiveSpec, mat?: MaterialSpec): MeshHandle {
    const h = makeHandle<MeshHandle>('mesh', id);
    this.record('createMesh', id, prim, mat);
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

  /** Tests can preload the clip names `loadModelTemplate` resolves with. */
  modelTemplateAnimationNames: string[] = [];
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
