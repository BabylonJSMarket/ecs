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
  ThinFieldHandle,
  ThinFieldSpec,
  Vec3,
} from './types';
import type { Color } from './types';

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
  // Debug line systems (ray-cast helpers etc.) — polylines flattened to segments.
  private lines = new Map<LineHandle, THREE.LineSegments>();
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
    background?: string; // optional opaque sign plate, persisted across setLabelText
    borderColor?: string; // optional border stroked inside the plate
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
  private physicsPaused = false;

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

    const material = new T.MeshPhongMaterial({
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
      side: prim.kind === 'tube' ? T.DoubleSide : T.FrontSide,
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
  setMeshScale(h: MeshHandle, sx: number, sy: number, sz: number): void {
    const m = this.meshes.get(h);
    if (m) m.scale.set(sx, sy, sz);
  }
  replaceMeshGeometry(_h: MeshHandle, _geom: MeshGeometry): void {
    // Mutating geometry requires constructing a new BufferGeometry; deferred
    // until a Three-side System needs it (the migration is scaffolding-only).
    void _h; void _geom;
  }
  setMeshBillboardMode(_h: MeshHandle, _mode: BillboardMode): void {
    // Three has no built-in billboard mode; would need a per-frame lookAt.
    // Deferred — Systems that need this should use a Sprite via createLabel.
    void _h; void _mode;
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
  setMeshBoundingBoxExtents(_h: MeshHandle, _min: Vec3, _max: Vec3): void {
    // Three.js + the pure-core physics integrator don't fit a BOX shape to a
    // mesh's bounding box (sphere/box dimensions are passed explicitly in
    // PhysicsBodyOpts), so there is nothing to override here.
    void _h; void _min; void _max;
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

  physicsSetBodyAngularVelocity(_meshId: string, _vx: number, _vy: number, _vz: number): void {
    // Pure-core integrator doesn't track angular velocity yet.
    void _meshId; void _vx; void _vy; void _vz;
  }

  physicsSetBodyDrivenByMesh(_meshId: string, _drivenByMesh: boolean): void {
    // Pure-core integrator is body-authoritative; no mesh-driven mode to toggle.
    void _meshId; void _drivenByMesh;
  }

  physicsSetGravity(_x: number, _y: number, _z: number): void {
    // Pure-core integrator has no global gravity hook yet.
    void _x; void _y; void _z;
  }

  physicsResizeBoxBody(_meshId: string, _halfExtents: Vec3): void {
    // No box collider concept in the pure-core integrator yet.
    void _meshId; void _halfExtents;
  }

  physicsSetTimeStep(_hz: number): void {
    // Pure-core integrator steps with whatever dt the loop hands it; no
    // fixed timestep configuration to twist. Babylon override is where the
    // Hz slider has bite.
    void _hz;
  }

  physicsSetRestitution(_meshId: string, _restitution: number): void {
    // Pure-core integrator has no material model yet.
    void _meshId; void _restitution;
  }

  setCollidersVisible(_visible: boolean): void {
    // No collider debug rendering in the pure-core path.
    void _visible;
  }

  physicsSetPaused(paused: boolean): void {
    // The pure-core integrator only advances when `physicsStep` runs, so a
    // flag that gates the step fully freezes it.
    this.physicsPaused = paused;
  }

  physicsGetBodyState(meshId: string): PhysicsBodySnapshot | null {
    if (!this.physicsCore) return null;
    const body = this.physicsCore.bodies().find((b) => b.meshId === meshId);
    if (!body) return null;
    // The pure-core integrator exposes position only; rotation/angular velocity
    // (and a readable linear velocity) aren't in its public surface yet, so
    // they snapshot as zero. Position rewind is exact; the rest is best-effort
    // until Rapier.js lands.
    return {
      position: [body.posX, body.posY, body.posZ],
      rotation: [0, 0, 0],
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
    };
  }

  physicsSetBodyState(meshId: string, state: PhysicsBodySnapshot): void {
    // Restore the linear velocity (the one setter the pure-core exposes) and
    // sync the mesh so the pose is visible while paused. The integrator has no
    // position setter, so on resume it will drive from its own stored pose.
    this.physicsCore?.setBodyVelocity(
      meshId,
      state.linearVelocity[0],
      state.linearVelocity[1],
      state.linearVelocity[2],
    );
    const mesh = this.meshesByMeshId.get(meshId);
    if (mesh) mesh.position.set(state.position[0], state.position[1], state.position[2]);
  }

  physicsStep(dt: number): void {
    if (!this.physicsCore || this.physicsPaused) return;
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
    if (spec?.position) root.position.set(spec.position[0], spec.position[1], spec.position[2]);
    if (spec?.rotation) root.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
    if (spec?.scale !== undefined) root.scale.setScalar(spec.scale);
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

  pickAtScreenPoint(_x: number, _y: number, _opts?: PickOptions): PickResult | null {
    // Raycasting against the active scene + meshes lookup is doable but not
    // yet wired into any Three-side System; defer until needed.
    void _x; void _y; void _opts;
    return null;
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
    for (const field of this.thinFields.values()) {
      field.mesh.geometry.dispose();
      field.mesh.dispose();
    }
    this.thinFields.clear();
    this.lines.clear();
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
