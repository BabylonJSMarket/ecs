/**
 * ThreeAdapter — RendererAdapter backed by three.js.
 *
 * Three is loaded at runtime from a CDN (not from node_modules). Types come
 * from @types/three (a dev-only dependency). The HTML that hosts this adapter
 * must declare an `<script type="importmap">` mapping "three" and "three/addons/".
 *
 * Migration status: scaffolding only. Methods throw NotImplemented until the
 * per-component migration steps land them.
 */

import type * as THREE from 'three';
import type {
  ArcCameraSpec,
  CameraHandle,
  DirectionalLightSpec,
  HemisphericLightSpec,
  IPhysicsInstance,
  LabelHandle,
  LabelSpec,
  LightHandle,
  MaterialSpec,
  MeshHandle,
  MeshLoadResult,
  MeshLoadSpec,
  PhysicsBodyOpts,
  PhysicsFactory,
  PrimitiveSpec,
  RendererAdapter,
  RendererInitOptions,
  ShadowCasterHandle,
  Vec3,
} from './types';

export interface ThreeAdapterOptions {
  /**
   * Pure-JS physics integrator factory. Three.js has no native physics engine,
   * so adapters that need rigid-body simulation must inject one. Omit to
   * silently no-op all physics methods.
   */
  physicsFactory?: PhysicsFactory;
}

function notImplemented(method: string): never {
  throw new Error(`ThreeAdapter.${method}: not implemented yet`);
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

export class ThreeAdapter implements RendererAdapter {
  readonly kind = 'three' as const;

  THREE?: typeof THREE;
  renderer?: THREE.WebGLRenderer;
  scene?: THREE.Scene;

  private meshes = new Map<MeshHandle, THREE.Mesh>();
  /** Parallel meshId → mesh lookup used by the physics adapter methods. */
  private meshesByMeshId = new Map<string, THREE.Mesh>();
  private lights = new Map<LightHandle, THREE.Light>();
  private cameras = new Map<CameraHandle, { camera: THREE.PerspectiveCamera; controls?: unknown }>();
  private shadowCasters = new Map<ShadowCasterHandle, { light: LightHandle; mesh: MeshHandle }>();
  private labels = new Map<LabelHandle, {
    sprite: THREE.Sprite;
    material: THREE.SpriteMaterial;
    texture: THREE.CanvasTexture;
    canvas: HTMLCanvasElement;
    baseScale: number;
    fontSize: number;
    fontWeight: 'normal' | 'bold';
    aspect: number;
  }>();
  private shadowMapEnabled = false;
  private onFrame?: (dt: number) => void;
  private lastTime = 0;
  private rafId: number | null = null;
  /**
   * Pure-core physics integrator used in place of a native engine (Rapier.js
   * is a future upgrade path). Bodies are lazy — an empty sim is free.
   */
  private physicsCore: IPhysicsInstance | null = null;
  private physicsFactory?: PhysicsFactory;

  constructor(options: ThreeAdapterOptions = {}) {
    this.physicsFactory = options.physicsFactory;
  }

  /**
   * Per-meshId animation state. Three's AnimationMixer is created on demand
   * the first time a clip is played for a mesh. Primitive meshes (capsules,
   * boxes) have no mixer and every animation call is a no-op on them — same
   * semantics as BabylonAdapter.
   */
  private animationMixers = new Map<string, THREE.AnimationMixer>();
  private animationActions = new Map<string, THREE.AnimationAction>();

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
      window.innerWidth / window.innerHeight,
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
        geometry = new T.PlaneGeometry(
          prim.width ?? 10,
          prim.depth ?? 10,
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
      default:
        throw new Error(`ThreeAdapter.createMesh: unknown primitive kind "${prim.kind}"`);
    }

    if (prim.pivotAtBottom) {
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

    const material = new T.MeshPhongMaterial({
      color: mat?.diffuse ? toColor(mat.diffuse) : new T.Color().setRGB(1, 1, 1, T.SRGBColorSpace),
      specular: mat?.specular
        ? toColor(mat.specular)
        : new T.Color().setRGB(1, 1, 1, T.SRGBColorSpace),
      emissive: mat?.emissive ? toColor(mat.emissive) : new T.Color(0, 0, 0),
      shininess: 64,
      transparent: (mat?.alpha ?? 1) < 1,
      opacity: mat?.alpha ?? 1,
    });

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
  }

  physicsCreateBody(meshId: string, opts: PhysicsBodyOpts): void {
    const mesh = this.meshesByMeshId.get(meshId);
    if (!mesh) return;
    if (!this.physicsCore) {
      if (!this.physicsFactory) return;
      this.physicsCore = this.physicsFactory();
    }
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
  }

  physicsDestroyBody(meshId: string): void {
    this.physicsCore?.destroyBody(meshId);
  }

  physicsSetBodyVelocity(meshId: string, vx: number, vy: number, vz: number): void {
    this.physicsCore?.setBodyVelocity(meshId, vx, vy, vz);
  }

  physicsStep(dt: number): void {
    if (!this.physicsCore) return;
    this.physicsCore.step(dt);
    // Push integrated positions back to the meshes so the render loop picks
    // them up. Static bodies still get written; it's a no-op at the mesh level.
    for (const body of this.physicsCore.bodies()) {
      const mesh = this.meshesByMeshId.get(body.meshId);
      if (!mesh) continue;
      mesh.position.set(body.posX, body.posY, body.posZ);
    }
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
    const camera = new T.PerspectiveCamera(fovDeg, window.innerWidth / window.innerHeight, 0.1, 1000);
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
    // Three.js is right-handed: right = forward × up, with up = (0,1,0).
    this.getCameraForward(h, out);
    const fx = out[0], fy = out[1], fz = out[2];
    // cross((fx,fy,fz), (0,1,0)) = (fy·0 - fz·1, fz·0 - fx·0, fx·1 - fy·0) = (-fz, 0, fx)
    out[0] = -fz;
    out[1] = 0;
    out[2] = fx;
    void fy;
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

  createLabel(id: string, spec: LabelSpec): LabelHandle {
    const T = this.requireThree();
    const fontSize = spec.fontSize ?? 64;
    const fontWeight = spec.fontWeight ?? 'bold';
    const texW = 512;
    const texH = 256;
    const canvas = document.createElement('canvas');
    canvas.width = texW;
    canvas.height = texH;
    this.drawLabelText(canvas, spec.text, fontSize, fontWeight);

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

    const sprite = new T.Sprite(material);
    sprite.name = `Label_${id}`;
    const aspect = texW / texH;
    const scale = spec.scale ?? 1;
    sprite.scale.set(scale * aspect, scale, 1);
    // Draw sprites after meshes so the label doesn't get occluded in-plane.
    sprite.renderOrder = 999;
    this.scene!.add(sprite);

    const handle = this.makeHandle<LabelHandle>('label', id);
    this.labels.set(handle, {
      sprite,
      material,
      texture,
      canvas,
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
    this.drawLabelText(entry.canvas, text, entry.fontSize, entry.fontWeight);
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
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
      this.onFrame?.(dt);
      // Advance any registered animation mixers so playing clips actually
      // move. Mixers are lazily created the first time a mesh's clip is
      // played; primitive meshes have none.
      for (const mixer of this.animationMixers.values()) mixer.update(dt);
      // Use first registered arc camera, or fall back to the default camera.
      const firstCam = this.cameras.values().next().value;
      const camera = firstCam?.camera ?? this.defaultCamera;
      if (camera) {
        this.renderer!.render(this.scene!, camera);
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
      const firstCam = this.cameras.values().next().value;
      const camera = firstCam?.camera ?? this.defaultCamera;
      if (camera) this.renderer.render(this.scene, camera);
    }
  }

  dispose(): void {
    this.stopLoop();
    this.physicsCore?.reset();
    this.physicsCore = null;
    this.renderer?.dispose();
    this.renderer = undefined;
    this.scene = undefined;
    this.meshes.clear();
    this.meshesByMeshId.clear();
    this.lights.clear();
    this.cameras.clear();
    this.labels.clear();
    this.animationMixers.clear();
    this.animationActions.clear();
  }

  /** Lazily enables shadow map on the WebGLRenderer the first time a shadow-casting light is added. */
  enableShadowMap(): void {
    if (this.shadowMapEnabled || !this.renderer || !this.THREE) return;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = this.THREE.PCFSoftShadowMap;
    this.shadowMapEnabled = true;
  }
}
