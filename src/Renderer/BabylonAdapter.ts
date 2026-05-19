/**
 * BabylonAdapter — RendererAdapter backed by @babylonjs/core.
 *
 * This file is the ONLY place in the codebase that imports BabylonJS.
 * Systems never touch Babylon types directly; they go through the adapter.
 *
 * Migration status: scaffolding only. Methods throw NotImplemented until the
 * per-component migration steps land them.
 */

import {
  Engine,
  Scene,
  SceneLoader,
  Vector3,
  Color3,
  Color4,
  MeshBuilder,
  StandardMaterial,
  HemisphericLight as BabylonHemisphericLight,
  DirectionalLight as BabylonDirectionalLight,
  ArcRotateCamera,
  ShadowGenerator,
  Mesh,
  DynamicTexture,
  AnimationGroup,
  PhysicsAggregate,
  PhysicsShapeType,
  PhysicsMotionType,
  HavokPlugin,
} from '@babylonjs/core';
import '@babylonjs/loaders';
import HavokPhysics from '@babylonjs/havok';
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

function notImplemented(method: string): never {
  throw new Error(`BabylonAdapter.${method}: not implemented yet`);
}

export class BabylonAdapter implements RendererAdapter {
  readonly kind = 'babylon' as const;

  engine?: Engine;
  scene?: Scene;

  private meshes = new Map<MeshHandle, Mesh>();
  /**
   * Parallel lookup so `physicsCreateBody(meshId, ...)` and related physics
   * methods can find the mesh by the same id used at `createMesh(id, ...)`
   * without iterating the handle map.
   */
  private meshesByMeshId = new Map<string, Mesh>();
  /**
   * Animation groups scoped per loaded meshId. Populated by `loadMesh`. The
   * outer Map's key is the string id the caller passed (matches `meshId`
   * used by `playAnimation` etc.), the inner Map's key is the clip name.
   */
  private loadedAnimationGroups = new Map<string, Map<string, AnimationGroup>>();
  /** Havok physics state — lazily initialized the first time physicsCreateBody runs. */
  private physicsAggregates = new Map<string, PhysicsAggregate>();
  private havokPlugin: HavokPlugin | null = null;
  private havokReady = false;
  private havokInitPromise: Promise<void> | null = null;
  /** Pending create requests queued while Havok is still initializing. */
  private pendingPhysicsCreates: Array<{ meshId: string; opts: PhysicsBodyOpts }> = [];
  private lights = new Map<LightHandle, BabylonHemisphericLight | BabylonDirectionalLight>();
  private cameras = new Map<CameraHandle, ArcRotateCamera>();
  private shadowGenerators = new Map<LightHandle, ShadowGenerator>();
  private shadowCasters = new Map<ShadowCasterHandle, { light: LightHandle; mesh: MeshHandle }>();
  private labels = new Map<LabelHandle, {
    plane: Mesh;
    material: StandardMaterial;
    texture: DynamicTexture;
    baseScale: number;
    fontSize: number;
    fontWeight: 'normal' | 'bold';
    aspect: number; // width / height of the underlying canvas
  }>();
  private onFrame?: (dt: number) => void;
  private lastTime = 0;

  async init(canvas: HTMLCanvasElement, opts: RendererInitOptions = {}): Promise<void> {
    this.engine = new Engine(canvas, opts.antialias ?? true, {
      deterministicLockstep: true,
      lockstepMaxSteps: 4,
    });
    this.scene = new Scene(this.engine);
    // Match glTF / Three.js so imported assets and coordinate math agree.
    // Without this, a scene authored in RH would be Z-mirrored under Babylon.
    this.scene.useRightHandedSystem = true;
    this.scene.collisionsEnabled = true;
    this.scene.setRenderingAutoClearDepthStencil(1, false, false);
    this.scene.setRenderingAutoClearDepthStencil(2, false, false);
    if (opts.clearColor) {
      this.scene.clearColor = new Color4(...opts.clearColor);
    }

    window.addEventListener('resize', () => this.resize());
  }

  createMesh(id: string, prim: PrimitiveSpec, mat?: MaterialSpec): MeshHandle {
    if (!this.scene) throw new Error('BabylonAdapter.createMesh: call init() first');
    const scene = this.scene;
    let mesh: Mesh;

    switch (prim.kind) {
      case 'box':
        mesh = MeshBuilder.CreateBox(`${id}_box`, {
          width: prim.width ?? 1,
          height: prim.height ?? 1,
          depth: prim.depth ?? 1,
        }, scene);
        if (prim.pivotAtBottom) this.applyPivotAtBottom(mesh, (prim.height ?? 1) / 2);
        break;
      case 'sphere':
        mesh = MeshBuilder.CreateSphere(`${id}_sphere`, {
          diameter: prim.diameter ?? 1,
          segments: prim.segments ?? 32,
        }, scene);
        if (prim.pivotAtBottom) this.applyPivotAtBottom(mesh, (prim.diameter ?? 1) / 2);
        break;
      case 'cylinder':
        mesh = MeshBuilder.CreateCylinder(`${id}_cylinder`, {
          height: prim.height ?? 1,
          diameterTop: prim.diameterTop ?? prim.diameter ?? 1,
          diameterBottom: prim.diameterBottom ?? prim.diameter ?? 1,
          tessellation: prim.tessellation ?? 24,
        }, scene);
        if (prim.pivotAtBottom) this.applyPivotAtBottom(mesh, (prim.height ?? 1) / 2);
        break;
      case 'capsule':
        mesh = MeshBuilder.CreateCapsule(`${id}_capsule`, {
          height: prim.height ?? 1,
          radius: prim.radius ?? 0.5,
        }, scene);
        if (prim.pivotAtBottom) this.applyPivotAtBottom(mesh, (prim.height ?? 1) / 2);
        break;
      case 'plane':
        mesh = MeshBuilder.CreatePlane(`${id}_plane`, {
          size: prim.width ?? 10,
          sideOrientation: Mesh.DOUBLESIDE,
        }, scene);
        break;
      case 'ground':
        mesh = MeshBuilder.CreateGround(`${id}_ground`, {
          width: prim.width ?? 10,
          height: prim.depth ?? 10,
          subdivisions: prim.subdivisions ?? 1,
        }, scene);
        break;
      case 'torus':
        mesh = MeshBuilder.CreateTorus(`${id}_torus`, {
          diameter: prim.diameter ?? 1,
          thickness: prim.thickness ?? 0.3,
          tessellation: prim.tessellation ?? 24,
        }, scene);
        break;
      case 'disc':
        mesh = MeshBuilder.CreateDisc(`${id}_disc`, {
          radius: prim.radius ?? 0.5,
          tessellation: prim.tessellation ?? 24,
        }, scene);
        mesh.rotation.x = Math.PI / 2;
        mesh.bakeCurrentTransformIntoVertices();
        mesh.rotation.x = 0;
        break;
      default:
        throw new Error(`BabylonAdapter.createMesh: unknown primitive kind "${prim.kind}"`);
    }

    if (mat) {
      const material = new StandardMaterial(`${id}_material`, scene);
      if (mat.diffuse) material.diffuseColor = Color3.FromArray(mat.diffuse);
      if (mat.specular) material.specularColor = Color3.FromArray(mat.specular);
      if (mat.emissive) material.emissiveColor = Color3.FromArray(mat.emissive);
      if (mat.alpha !== undefined) material.alpha = mat.alpha;
      mesh.material = material;
    }

    const handle = this.makeHandle<MeshHandle>('mesh', id);
    this.meshes.set(handle, mesh);
    this.meshesByMeshId.set(id, mesh);
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
    const mesh = this.meshes.get(h);
    const material = mesh?.material as StandardMaterial | null;
    if (material) material.diffuseColor = new Color3(r, g, b);
  }
  setMeshVisible(h: MeshHandle, visible: boolean): void {
    const mesh = this.meshes.get(h);
    if (mesh) mesh.isVisible = visible;
  }
  getMeshWorldPosition(h: MeshHandle, out: Vec3): Vec3 {
    const mesh = this.meshes.get(h);
    if (mesh) {
      // World matrix is only refreshed during a render tick. Tests and any
      // caller that reads position between frames will see stale data
      // unless we recompute it on demand.
      mesh.computeWorldMatrix(true);
      const p = mesh.getAbsolutePosition();
      out[0] = p.x;
      out[1] = p.y;
      out[2] = p.z;
    } else {
      out[0] = out[1] = out[2] = 0;
    }
    return out;
  }
  disposeMesh(h: MeshHandle): void {
    const mesh = this.meshes.get(h);
    if (mesh) {
      // Drop any associated physics body so the aggregate doesn't reference a
      // disposed mesh on the next render tick.
      for (const [id, m] of this.meshesByMeshId) {
        if (m === mesh) {
          this.physicsDestroyBody(id);
          this.meshesByMeshId.delete(id);
        }
      }
      mesh.material?.dispose();
      mesh.dispose();
      this.meshes.delete(h);
    }
  }

  async loadMesh(id: string, spec: MeshLoadSpec): Promise<MeshLoadResult> {
    if (!this.scene) throw new Error('BabylonAdapter.loadMesh: call init() first');
    const scene = this.scene;
    // Parse rootUrl + sceneFilename out of the full URL. ImportMeshAsync takes
    // the two halves separately so it can resolve sibling assets (bin/textures).
    const lastSlash = spec.url.lastIndexOf('/');
    const rootUrl = lastSlash >= 0 ? spec.url.slice(0, lastSlash + 1) : '';
    const fileName = lastSlash >= 0 ? spec.url.slice(lastSlash + 1) : spec.url;

    const result = await SceneLoader.ImportMeshAsync('', rootUrl, fileName, scene);
    const root = (result.meshes[0] ?? result.meshes.find((m) => m.parent === null)) as Mesh;
    if (!root) throw new Error(`BabylonAdapter.loadMesh: no root mesh in ${spec.url}`);

    // GLTF importers set rotationQuaternion which nullifies Euler rotation.
    // Clear it on the root so setMeshRotation works predictably.
    root.rotationQuaternion = null;
    if (spec.position) root.position.set(spec.position[0], spec.position[1], spec.position[2]);
    if (spec.rotation) root.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
    if (spec.scale !== undefined) root.scaling.setAll(spec.scale);

    const handle = this.makeHandle<MeshHandle>('loadedMesh', id);
    this.meshes.set(handle, root);

    // Register animation groups under this meshId so `playAnimation(meshId, clip)`
    // can find them. Stop them at rest — the Animation system will start them.
    const byName = new Map<string, AnimationGroup>();
    for (const group of result.animationGroups) {
      group.stop();
      byName.set(group.name, group);
    }
    this.loadedAnimationGroups.set(id, byName);

    return {
      meshId: id,
      handle,
      animationNames: Array.from(byName.keys()),
    };
  }

  /** Back-compat accessor used by not-yet-migrated Systems (ArcCamera, Shadow). */
  getMeshObject(h: MeshHandle): Mesh | undefined {
    return this.meshes.get(h);
  }

  private applyPivotAtBottom(mesh: Mesh, offset: number): void {
    mesh.position.y = offset;
    mesh.bakeCurrentTransformIntoVertices();
    mesh.position.y = 0;
  }

  private makeHandle<T>(kind: string, id: string): T {
    return { __handle: `${kind}:${id}:${this.handleCounter++}` } as unknown as T;
  }

  private handleCounter = 0;

  /** Wrap an already-constructed Engine + Scene (used during migration while Game.ts still creates them). */
  static fromExisting(engine: Engine, scene: Scene): BabylonAdapter {
    const a = new BabylonAdapter();
    a.engine = engine;
    a.scene = scene;
    return a;
  }

  createDirectionalLight(id: string, spec: DirectionalLightSpec): LightHandle {
    if (!this.scene) throw new Error('BabylonAdapter.createDirectionalLight: call init() first');
    const light = new BabylonDirectionalLight(
      `DirectionalLight_${id}`,
      new Vector3(spec.direction[0], spec.direction[1], spec.direction[2]),
      this.scene,
    );
    if (spec.position) {
      light.position.set(spec.position[0], spec.position[1], spec.position[2]);
    }
    light.intensity = spec.intensity;
    light.diffuse = Color3.FromArray(spec.diffuse);
    light.specular = Color3.FromArray(spec.specular);

    const handle = this.makeHandle<LightHandle>('dirLight', id);
    this.lights.set(handle, light);

    if (spec.shadow?.enabled) {
      light.shadowMinZ = spec.shadow.minZ;
      light.shadowMaxZ = spec.shadow.maxZ;
      // Babylon's default autoUpdateExtends sizes the ortho frustum to the
      // caster bounding box + 10% — fine with many casters, but for a lone
      // capsule the frustum is only a few units across and the shadow on the
      // ground is clipped to a tiny square. Disable auto and set explicit
      // bounds big enough for a ~40-unit demo scene.
      light.autoUpdateExtends = false;
      light.orthoLeft = -25;
      light.orthoRight = 25;
      light.orthoTop = 25;
      light.orthoBottom = -25;
      const gen = new ShadowGenerator(spec.shadow.mapSize, light);
      gen.usePercentageCloserFiltering = true;
      gen.filteringQuality = ShadowGenerator.QUALITY_HIGH;
      gen.darkness = 0.4;
      gen.bias = 0.001;
      this.shadowGenerators.set(handle, gen);
    }
    return handle;
  }
  createHemisphericLight(id: string, spec: HemisphericLightSpec): LightHandle {
    if (!this.scene) throw new Error('BabylonAdapter.createHemisphericLight: call init() first');
    const light = new BabylonHemisphericLight(
      `HemisphericLight_${id}`,
      new Vector3(spec.direction[0], spec.direction[1], spec.direction[2]),
      this.scene,
    );
    light.intensity = spec.intensity;
    light.diffuse = Color3.FromArray(spec.diffuse);
    light.groundColor = Color3.FromArray(spec.groundColor);
    light.specular = Color3.FromArray(spec.specular);

    const handle = this.makeHandle<LightHandle>('hemLight', id);
    this.lights.set(handle, light);
    return handle;
  }
  updateLightIntensity(h: LightHandle, intensity: number): void {
    const light = this.lights.get(h);
    if (light) light.intensity = intensity;
  }
  disposeLight(h: LightHandle): void {
    const light = this.lights.get(h);
    if (light) {
      light.dispose();
      this.lights.delete(h);
    }
  }

  createArcCamera(id: string, spec: ArcCameraSpec): CameraHandle {
    if (!this.scene || !this.engine) throw new Error('BabylonAdapter.createArcCamera: call init() first');

    // Reuse existing active camera if it's an ArcRotateCamera — that's the
    // previous behavior and it avoids duplicated cameras across scene reloads.
    let camera = this.scene.activeCamera as ArcRotateCamera | null;
    if (!camera || camera.getClassName() !== 'ArcRotateCamera') {
      camera = new ArcRotateCamera(
        `ArcCamera_${id}`,
        spec.alpha,
        spec.beta,
        spec.radius,
        new Vector3(spec.target[0], spec.target[1], spec.target[2]),
        this.scene,
      );
      camera.attachControl(this.engine.getRenderingCanvas(), true);
      this.scene.activeCamera = camera;
    }

    camera.alpha = spec.alpha;
    camera.beta = spec.beta;
    camera.radius = spec.radius;
    camera.setTarget(new Vector3(spec.target[0], spec.target[1], spec.target[2]));
    camera.lowerRadiusLimit = spec.minRadius;
    camera.upperRadiusLimit = spec.maxRadius;
    camera.lowerBetaLimit = spec.minBeta;
    camera.upperBetaLimit = spec.maxBeta;
    camera.inertia = spec.inertia;
    camera.wheelPrecision = spec.wheelPrecision;
    camera.angularSensibilityX = spec.angularSensibility;
    camera.angularSensibilityY = spec.angularSensibility;

    const handle = this.makeHandle<CameraHandle>('arcCamera', id);
    this.cameras.set(handle, camera);
    return handle;
  }
  setCameraTarget(h: CameraHandle, x: number, y: number, z: number): void {
    const cam = this.cameras.get(h);
    if (cam) cam.setTarget(new Vector3(x, y, z));
  }
  getCameraTarget(h: CameraHandle, out: Vec3): Vec3 {
    const cam = this.cameras.get(h);
    if (cam) {
      const t = cam.getTarget();
      out[0] = t.x;
      out[1] = t.y;
      out[2] = t.z;
    } else {
      out[0] = out[1] = out[2] = 0;
    }
    return out;
  }
  getCameraAngles(h: CameraHandle): { alpha: number; beta: number; radius: number } {
    const cam = this.cameras.get(h);
    if (!cam) return { alpha: 0, beta: 0, radius: 0 };
    return { alpha: cam.alpha, beta: cam.beta, radius: cam.radius };
  }
  getCameraForward(h: CameraHandle, out: Vec3): Vec3 {
    const cam = this.cameras.get(h);
    if (!cam) {
      out[0] = 0; out[1] = 0; out[2] = -1;
      return out;
    }
    const t = cam.getTarget();
    const p = cam.position;
    const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    out[0] = dx / len; out[1] = dy / len; out[2] = dz / len;
    return out;
  }
  getCameraRight(h: CameraHandle, out: Vec3): Vec3 {
    // With scene.useRightHandedSystem = true, Babylon uses the same cross
    // convention as Three: right = forward × up. The cross of two unit
    // vectors only yields a unit vector when they're perpendicular —
    // when the camera tilts up/down, forward has a Y component so we
    // must normalize the horizontal projection.
    this.getCameraForward(h, out);
    const fx = out[0], fz = out[2];
    // cross((fx,fy,fz), (0,1,0)) = (-fz, 0, fx); horizontal length = √(fx²+fz²)
    const len = Math.hypot(fx, fz) || 1;
    out[0] = -fz / len;
    out[1] = 0;
    out[2] = fx / len;
    return out;
  }
  nudgeCameraAlpha(h: CameraHandle, delta: number): void {
    const cam = this.cameras.get(h);
    if (cam) cam.alpha += delta;
  }
  nudgeCameraBeta(h: CameraHandle, delta: number): void {
    const cam = this.cameras.get(h);
    if (!cam) return;
    const next = cam.beta + delta;
    // ArcRotateCamera clamps to lowerBetaLimit/upperBetaLimit when set, but
    // defaults leave them `null`. Clamp defensively to [0.01, PI - 0.01].
    const lo = cam.lowerBetaLimit ?? 0.01;
    const hi = cam.upperBetaLimit ?? Math.PI - 0.01;
    cam.beta = Number.isFinite(next) ? Math.max(lo, Math.min(hi, next)) : cam.beta;
  }
  nudgeCameraTarget(h: CameraHandle, dx: number, dy: number, dz: number): void {
    const cam = this.cameras.get(h);
    if (cam) {
      const t = cam.getTarget();
      cam.setTarget(new Vector3(t.x + dx, t.y + dy, t.z + dz));
    }
  }
  nudgeCameraRadius(h: CameraHandle, delta: number): void {
    const cam = this.cameras.get(h);
    if (!cam) return;
    const next = cam.radius + delta;
    // ArcRotateCamera clamps by itself once lowerRadiusLimit/upperRadiusLimit
    // are set, but not all scenes do. Guard against NaN/negative here.
    cam.radius = Number.isFinite(next) ? Math.max(0.01, next) : cam.radius;
  }

  /** Back-compat accessor used by not-yet-migrated Systems. */
  getBabylonCamera(h: CameraHandle): ArcRotateCamera | undefined {
    return this.cameras.get(h);
  }

  attachShadowCaster(light: LightHandle, mesh: MeshHandle): ShadowCasterHandle {
    const gen = this.shadowGenerators.get(light);
    const m = this.meshes.get(mesh);
    if (gen && m) {
      gen.addShadowCaster(m);
    }
    const handle = this.makeHandle<ShadowCasterHandle>('shadow', `${String(light)}+${String(mesh)}`);
    this.shadowCasters.set(handle, { light, mesh });
    return handle;
  }
  detachShadowCaster(h: ShadowCasterHandle): void {
    const pair = this.shadowCasters.get(h);
    if (!pair) return;
    const gen = this.shadowGenerators.get(pair.light);
    const m = this.meshes.get(pair.mesh);
    if (gen && m) gen.removeShadowCaster(m);
    this.shadowCasters.delete(h);
  }
  setMeshReceiveShadows(h: MeshHandle, receive: boolean): void {
    const m = this.meshes.get(h);
    if (m) m.receiveShadows = receive;
  }

  createLabel(id: string, spec: LabelSpec): LabelHandle {
    if (!this.scene) throw new Error('BabylonAdapter.createLabel: call init() first');
    const fontSize = spec.fontSize ?? 64;
    const fontWeight = spec.fontWeight ?? 'bold';
    const padding = 12;
    const texW = 512;
    const texH = 256;
    const texture = new DynamicTexture(
      `Label_${id}_tex`,
      { width: texW, height: texH },
      this.scene,
      true,
    );
    texture.hasAlpha = true;
    this.drawLabelText(texture, spec.text, fontSize, fontWeight, padding);
    const aspect = texW / texH;

    const baseHeight = 1;
    const plane = MeshBuilder.CreatePlane(
      `Label_${id}`,
      { width: baseHeight * aspect, height: baseHeight },
      this.scene,
    );
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    // Labels should not occlude each other or z-fight with world geometry; draw
    // in a later rendering group and skip the depth write.
    plane.renderingGroupId = 1;

    const material = new StandardMaterial(`Label_${id}_mat`, this.scene);
    material.diffuseTexture = texture;
    material.opacityTexture = texture;
    material.emissiveColor = spec.color
      ? Color3.FromArray(spec.color)
      : new Color3(1, 1, 1);
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.useAlphaFromDiffuseTexture = true;
    material.alpha = 1;
    plane.material = material;

    const scale = spec.scale ?? 1;
    plane.scaling.set(scale, scale, scale);

    const handle = this.makeHandle<LabelHandle>('label', id);
    this.labels.set(handle, {
      plane,
      material,
      texture,
      baseScale: scale,
      fontSize,
      fontWeight,
      aspect,
    });
    return handle;
  }

  setLabelText(h: LabelHandle, text: string): void {
    const entry = this.labels.get(h);
    if (!entry) return;
    this.drawLabelText(entry.texture, text, entry.fontSize, entry.fontWeight, 12);
  }

  setLabelPosition(h: LabelHandle, x: number, y: number, z: number): void {
    const entry = this.labels.get(h);
    if (entry) entry.plane.position.set(x, y, z);
  }

  setLabelColor(h: LabelHandle, r: number, g: number, b: number): void {
    const entry = this.labels.get(h);
    if (entry) entry.material.emissiveColor = new Color3(r, g, b);
  }

  setLabelAlpha(h: LabelHandle, alpha: number): void {
    const entry = this.labels.get(h);
    if (entry) entry.material.alpha = alpha;
  }

  setLabelScale(h: LabelHandle, scale: number): void {
    const entry = this.labels.get(h);
    if (entry) entry.plane.scaling.set(scale, scale, scale);
  }

  setLabelVisible(h: LabelHandle, visible: boolean): void {
    const entry = this.labels.get(h);
    if (entry) entry.plane.isVisible = visible;
  }

  disposeLabel(h: LabelHandle): void {
    const entry = this.labels.get(h);
    if (!entry) return;
    entry.material.dispose();
    entry.texture.dispose();
    entry.plane.dispose();
    this.labels.delete(h);
  }

  private drawLabelText(
    texture: DynamicTexture,
    text: string,
    fontSize: number,
    fontWeight: 'normal' | 'bold',
    padding: number,
  ): void {
    const size = texture.getSize();
    const ctx = texture.getContext() as CanvasRenderingContext2D;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.restore();

    // DynamicTexture.drawText respects the texture's invertY flag, which
    // Babylon sets correctly for useRightHandedSystem. Using it directly
    // avoids the orientation issues that manual ctx manipulation caused.
    const font = `${fontWeight} ${fontSize}px system-ui, sans-serif`;
    // Measure manually so we can center (drawText places text at x,y).
    const measureCtx = texture.getContext() as CanvasRenderingContext2D;
    measureCtx.font = font;
    const metrics = measureCtx.measureText(text);
    const textWidth = metrics.width;
    const x = (size.width - textWidth) / 2;
    const y = size.height / 2 + fontSize / 3;

    // First pass: dark outline, painted via repeated offset strokes.
    const outline = Math.max(3, Math.round(fontSize * 0.1));
    for (let dx = -outline; dx <= outline; dx += outline) {
      for (let dy = -outline; dy <= outline; dy += outline) {
        if (dx === 0 && dy === 0) continue;
        texture.drawText(text, x + dx, y + dy, font, 'rgba(0,0,0,0.85)', null, true, false);
      }
    }
    // Fill pass (color is white; tint comes from material.emissiveColor).
    texture.drawText(text, x, y, font, '#ffffff', null, true, true);
    void padding;
  }

  /**
   * Look up a Babylon AnimationGroup by name, scoped to this scene. Scenes
   * loaded from glTF publish their clips under `scene.animationGroups`; we
   * do a linear find (clip counts are low enough that a Map would be
   * overkill). Mesh is not actually used for lookup because Babylon scenes
   * share groups across meshes — we still take `meshId` so the interface
   * reads identically under Three where scoping is needed.
   */
  private findAnimationGroup(meshId: string, clipName: string) {
    // Prefer a group registered under the meshId by loadMesh — keeps two
    // entities that loaded the same glb from stepping on each other's clips.
    const scoped = this.loadedAnimationGroups.get(meshId);
    if (scoped) {
      const g = scoped.get(clipName);
      if (g) return g;
    }
    if (!this.scene) return undefined;
    return this.scene.animationGroups.find((g) => g.name === clipName);
  }

  playAnimation(meshId: string, clipName: string, loop = true): void {
    const group = this.findAnimationGroup(meshId, clipName);
    if (!group) return;
    // `isPlaying` is true as soon as `start` has been called and the group
    // has animatables — check so repeated plays don't rewind to frame 0.
    if (group.isPlaying) return;
    group.start(loop, 1, group.from, group.to, false);
  }
  stopAnimation(meshId: string, clipName: string): void {
    const group = this.findAnimationGroup(meshId, clipName);
    group?.stop();
  }
  setAnimationWeight(meshId: string, clipName: string, weight: number): void {
    const group = this.findAnimationGroup(meshId, clipName);
    // `setWeightForAllAnimatables` no-ops gracefully if no animatables exist yet.
    group?.setWeightForAllAnimatables(weight);
  }
  setAnimationSpeed(meshId: string, clipName: string, speed: number): void {
    const group = this.findAnimationGroup(meshId, clipName);
    if (group) group.speedRatio = speed;
  }

  /**
   * Lazily boot Havok the first time a Physics body is requested. Subsequent
   * callers receive the same promise so we only WASM-load once per session.
   */
  private ensureHavok(): Promise<void> {
    if (this.havokReady) return Promise.resolve();
    if (this.havokInitPromise) return this.havokInitPromise;
    if (!this.scene) {
      return Promise.reject(new Error('BabylonAdapter.physicsCreateBody: call init() first'));
    }
    const scene = this.scene;
    this.havokInitPromise = HavokPhysics()
      .then((havokInstance) => {
        this.havokPlugin = new HavokPlugin(true, havokInstance);
        // Gravity comes from the world-level params on the Physics core —
        // adapters only simulate rigid-body contacts. Start Havok with a
        // standard downward gravity; pure-core side overrides per scene.
        scene.enablePhysics(new Vector3(0, -30, 0), this.havokPlugin);
        this.havokReady = true;
        // Drain queued creates now that the engine is live.
        const pending = this.pendingPhysicsCreates;
        this.pendingPhysicsCreates = [];
        for (const p of pending) this.physicsCreateBody(p.meshId, p.opts);
      })
      .catch((err) => {
        console.error('[BabylonAdapter] Havok failed to initialize:', err);
      });
    return this.havokInitPromise;
  }

  physicsCreateBody(meshId: string, opts: PhysicsBodyOpts): void {
    if (!this.scene) return;
    const mesh = this.meshesByMeshId.get(meshId);
    if (!mesh) return;
    if (this.physicsAggregates.has(meshId)) return;

    if (!this.havokReady) {
      this.pendingPhysicsCreates.push({ meshId, opts });
      void this.ensureHavok();
      return;
    }

    let shape: PhysicsShapeType;
    switch (opts.shapeType) {
      case 'sphere':
        shape = PhysicsShapeType.SPHERE;
        break;
      case 'capsule':
        shape = PhysicsShapeType.CAPSULE;
        break;
      case 'box':
      default:
        shape = PhysicsShapeType.BOX;
        break;
    }

    const aggregate = new PhysicsAggregate(
      mesh,
      shape,
      {
        mass: opts.motionType === 'static' ? 0 : opts.mass,
        friction: opts.friction,
        restitution: opts.restitution,
      },
      this.scene,
    );

    if (opts.motionType === 'kinematic') {
      aggregate.body.setMotionType(PhysicsMotionType.ANIMATED);
      aggregate.body.disablePreStep = false;
    }

    if (opts.lockRotation) {
      // Clamp X/Z inertia so tumbling is suppressed but Y-axis turns still work.
      aggregate.body.setMassProperties({ inertia: new Vector3(0.001, 1, 0.001) });
      aggregate.body.setAngularDamping(10);
    }

    aggregate.body.setCollisionCallbackEnabled(true);
    this.physicsAggregates.set(meshId, aggregate);
  }

  physicsDestroyBody(meshId: string): void {
    const aggregate = this.physicsAggregates.get(meshId);
    if (!aggregate) return;
    aggregate.dispose();
    this.physicsAggregates.delete(meshId);
  }

  physicsSetBodyVelocity(meshId: string, vx: number, vy: number, vz: number): void {
    const aggregate = this.physicsAggregates.get(meshId);
    if (!aggregate) return;
    aggregate.body.setLinearVelocity(new Vector3(vx, vy, vz));
  }

  physicsStep(_dt: number): void {
    // Havok advances during `scene.render`. Exposed as a no-op so the System
    // can call it uniformly across adapters.
    void _dt;
  }

  startLoop(onFrame: (dtSeconds: number) => void): void {
    if (!this.engine || !this.scene) {
      throw new Error('BabylonAdapter.startLoop: call init() first');
    }
    this.onFrame = onFrame;
    this.lastTime = performance.now();
    this.engine.runRenderLoop(() => {
      if (!this.scene?.isReady()) return;
      const now = performance.now();
      const dt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      this.onFrame?.(dt);
      // Babylon's scene.render() throws "No camera defined" when no camera
      // has been registered yet. Headless contract tests and the brief
      // window before a Camera component spawns both hit this — skip the
      // frame instead of crashing the loop.
      if (this.scene!.activeCamera) this.scene!.render();
    });
  }

  stopLoop(): void {
    this.engine?.stopRenderLoop();
    this.onFrame = undefined;
  }

  resize(): void {
    if (!this.engine) return;
    this.engine.resize();
    // Resizing the WebGL drawing buffer clears it. Paint a fresh frame
    // synchronously so the compositor never picks up the cleared buffer
    // between the resize and the next rAF tick. Skip the sync render
    // when no camera is registered (same guard as the main loop).
    if (this.scene?.isReady() && this.scene.activeCamera) this.scene.render();
  }

  getFPS(): number {
    return this.engine?.getFps() ?? 0;
  }

  dispose(): void {
    this.stopLoop();
    for (const aggregate of this.physicsAggregates.values()) aggregate.dispose();
    this.physicsAggregates.clear();
    this.pendingPhysicsCreates = [];
    this.havokPlugin = null;
    this.havokReady = false;
    this.havokInitPromise = null;
    this.scene?.dispose();
    this.engine?.dispose();
    this.scene = undefined;
    this.engine = undefined;
    this.meshes.clear();
    this.meshesByMeshId.clear();
    this.lights.clear();
    this.cameras.clear();
    this.shadowGenerators.clear();
    this.shadowCasters.clear();
    this.labels.clear();
    this.loadedAnimationGroups.clear();
  }
}

// Silence unused-import warnings for symbols that will be used in later steps.
void Vector3;
