/**
 * MockRendererAdapter — records every adapter call for Systems tests.
 *
 * Systems talk to the renderer through opaque handles; tests assert the
 * sequence of calls without needing a real 3D engine.
 */

import type {
  ArcCameraSpec,
  CameraHandle,
  DirectionalLightSpec,
  HemisphericLightSpec,
  LabelHandle,
  LabelSpec,
  LightHandle,
  MaterialSpec,
  MeshHandle,
  MeshLoadResult,
  MeshLoadSpec,
  PhysicsBodyOpts,
  PrimitiveSpec,
  RendererAdapter,
  RendererInitOptions,
  ShadowCasterHandle,
  Vec3,
} from './types';

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
  getMeshWorldPosition(h: MeshHandle, out: Vec3): Vec3 {
    const pos = this.meshWorldPositions.get(h) ?? [0, 0, 0];
    out[0] = pos[0];
    out[1] = pos[1];
    out[2] = pos[2];
    this.record('getMeshWorldPosition', h);
    return out;
  }
  disposeMesh(h: MeshHandle): void {
    this.record('disposeMesh', h);
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

  physicsCreateBody(meshId: string, opts: PhysicsBodyOpts): void {
    this.record('physicsCreateBody', meshId, opts);
  }
  physicsDestroyBody(meshId: string): void {
    this.record('physicsDestroyBody', meshId);
  }
  physicsSetBodyVelocity(meshId: string, vx: number, vy: number, vz: number): void {
    this.record('physicsSetBodyVelocity', meshId, vx, vy, vz);
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
