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
  LoadAssetContainerAsync,
  Vector3,
  Quaternion,
  Color3,
  Color4,
  CubeTexture,
  Texture,
  MeshBuilder,
  StandardMaterial,
  PBRMaterial,
  ShaderMaterial,
  HemisphericLight as BabylonHemisphericLight,
  DirectionalLight as BabylonDirectionalLight,
  ArcRotateCamera,
  UniversalCamera,
  ShadowGenerator,
  AnimationPropertiesOverride,
  Mesh,
  LinesMesh,
  DynamicTexture,
  AnimationGroup,
  PhysicsAggregate,
  PhysicsShapeType,
  PhysicsShapeBox,
  PhysicsMotionType,
  PhysicsViewer,
  HavokPlugin,
  BoundingInfo,
  VertexData,
} from '@babylonjs/core';
import type { AssetContainer, InstantiatedEntries, TransformNode } from '@babylonjs/core';
import '@babylonjs/loaders';
import HavokPhysics from '@babylonjs/havok';
import type {
  ArcCameraSpec,
  BillboardMode,
  CameraHandle,
  PerspectiveCameraSpec,
  Quaternion as QuaternionSpec,
  LargeWorldSpec,
  ScreenPoint,
  DirectionalLightSpec,
  HemisphericLightSpec,
  LabelHandle,
  LineHandle,
  LabelSpec,
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
  PbrMaterialSpec,
  RendererInitOptions,
  ShadowCasterHandle,
  SkyboxHandle,
  SkyboxSpec,
  EnvironmentTextureOpts,
  ThinFieldHandle,
  ThinFieldSpec,
  TextureHandle,
  TextureLoadOpts,
  CardMeshSpec,
  Vec3,
} from './types';
import type { Color } from './types';
import { Matrix, Ray, Viewport } from '@babylonjs/core';

function notImplemented(method: string): never {
  throw new Error(`BabylonAdapter.${method}: not implemented yet`);
}

/**
 * Babylon's "hardware scaling level" is the inverse of the device pixel ratio:
 * the backing render buffer is `cssPixels / level` on each axis, so a value of
 * `1 / dpr` makes a 2× (retina) display render at its full physical resolution
 * instead of being upscaled from 1× CSS pixels (which is what makes card art
 * and text look soft). Clamp the ratio to a sane window: floor at 1 so a
 * fractional/sub-1 DPR never *upscales* the buffer past native, and cap at 3 so
 * a freak DPR can't blow the render target up to a perf-killing size. A missing
 * / zero DPR (headless, some test envs) collapses to level 1 (no scaling).
 */
export function hardwareScalingLevelForDpr(dpr: number | undefined): number {
  if (!dpr || !Number.isFinite(dpr) || dpr <= 0) return 1;
  const clamped = Math.min(3, Math.max(1, dpr));
  return 1 / clamped;
}

/** Read the current display's device pixel ratio, guarding for headless. */
function currentDevicePixelRatio(): number {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

export class BabylonAdapter implements RendererAdapter {
  readonly kind = 'babylon' as const;

  engine?: Engine;
  scene?: Scene;

  private meshes = new Map<MeshHandle, Mesh>();
  // Debug line systems (ray-cast helpers etc.). `shape` is the per-polyline
  // point count at last build — lets updateLineSystem reuse the mesh in place
  // (Babylon's `instance`) when the topology is unchanged, else rebuild.
  private lines = new Map<LineHandle, { mesh: LinesMesh; shape: number[] }>();
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
  /**
   * Off-scene asset containers for instanced models, keyed by url. Loaded once
   * via `loadModelTemplate`; `instantiateModel` clones from them. The in-flight
   * promise map dedupes concurrent loads so N enemies share one 9 MB parse.
   */
  private modelTemplates = new Map<string, AssetContainer>();
  private modelTemplatePromises = new Map<string, Promise<AssetContainer>>();
  /** Per-entity instantiated clones, keyed by the id passed to `instantiateModel`. */
  private instantiatedModels = new Map<string, InstantiatedEntries>();
  /** Havok physics state — lazily initialized the first time physicsCreateBody runs. */
  private physicsAggregates = new Map<string, PhysicsAggregate>();
  private physicsViewer: PhysicsViewer | null = null;
  private havokPlugin: HavokPlugin | null = null;
  /** Timestep saved while physics is paused via `physicsSetPaused`. */
  private savedTimeStep: number | null = null;
  private havokReady = false;
  private havokInitPromise: Promise<void> | null = null;
  /** Pending create requests queued while Havok is still initializing. */
  private pendingPhysicsCreates: Array<{ meshId: string; opts: PhysicsBodyOpts }> = [];
  private lights = new Map<LightHandle, BabylonHemisphericLight | BabylonDirectionalLight>();
  private cameras = new Map<CameraHandle, ArcRotateCamera>();
  /**
   * Free 6-DOF perspective cameras (the chase / flight camera), kept in their
   * own map because a `UniversalCamera` has no alpha/beta/radius/target — the
   * arc-camera surface (`getCameraAngles`, `nudgeCameraAlpha`, …) doesn't apply.
   * Methods that legitimately span both kinds (`screenToWorldPoint`,
   * `setCameraFov`) resolve through {@link resolveCamera}.
   */
  private perspectiveCameras = new Map<CameraHandle, UniversalCamera>();
  /**
   * The CANONICAL orientation last handed to {@link createPerspectiveCamera} /
   * {@link setCameraPose}, stored verbatim per handle so {@link getCameraPose}
   * round-trips it losslessly. The quaternion baked onto the Babylon camera is
   * `q ⊗ PERSP_LOOK_FLIP` (see below), so we cannot recover the input `q` from
   * `camera.rotationQuaternion` alone.
   */
  private perspectiveOrientations = new Map<CameraHandle, Quaternion>();
  /**
   * 180° rotation about +Y, post-multiplied onto a free perspective camera's
   * orientation. The CANONICAL convention is "identity orientation → camera
   * looks down +Z" (Mock / Babylon-LH; locked by the contract). But this scene
   * is RIGHT-HANDED (`useRightHandedSystem = true`, for glTF agreement), and a
   * Babylon free camera there looks down its LOCAL −Z — so an identity
   * `rotationQuaternion` aims −Z, AWAY from a ship at +Z (the chase-camera bug).
   * Post-multiplying this flip makes the rendered forward = `q · (+Z)` and the
   * rendered up = `q · (+Y)` for ANY orientation, so the camera looks where the
   * canonical quaternion says (verified for roll/pitch/yaw), and BabylonLite /
   * Three / Mock all agree.
   */
  private readonly perspLookFlip = new Quaternion(0, 1, 0, 0);
  /** Canonical +Z axis (never mutated) + scratch, for deriving camera forward. */
  private readonly _zAxisCanon = new Vector3(0, 0, 1);
  private readonly _fwdScratch = new Vector3();
  /**
   * Tracked floating-origin offset (Phase-1: contract-only / dormant). Babylon
   * has no built-in floating-origin field, so we store the value `setOriginOffset`
   * records and hand it back from `getOriginOffset`. No active per-frame rebase
   * happens — the pure game keeps passing real world coordinates; a zero offset
   * is the camera-relative "no rebase applied" default.
   */
  private originOffset: Vec3 = [0, 0, 0];
  /** Large-world / floating-origin enable flag recorded by `configureLargeWorld`. */
  private largeWorldEnabled = false;
  private shadowGenerators = new Map<LightHandle, ShadowGenerator>();
  private shadowCasters = new Map<ShadowCasterHandle, { light: LightHandle; mesh: MeshHandle }>();
  private skyboxes = new Map<SkyboxHandle, {
    mesh: Mesh;
    material: ShaderMaterial;
  }>();
  private labels = new Map<LabelHandle, {
    plane: Mesh;
    material: StandardMaterial;
    texture: DynamicTexture;
    baseScale: number;
    fontSize: number;
    fontWeight: 'normal' | 'bold';
    aspect: number; // width / height of the underlying canvas
    background?: string; // optional opaque sign plate, persisted across setLabelText
    borderColor?: string; // optional border stroked inside the plate
  }>();
  /**
   * Thin-instance fields (coin piles, debris). Each holds the merged master
   * mesh, its matrix buffer, and the stored normalization scale applied per
   * instance in setThinFieldInstances.
   */
  private thinFields = new Map<ThinFieldHandle, { master: Mesh; buffer: Float32Array; baseScale: number }>();
  /**
   * Loaded 2D textures, deduped by the caller's key so a card deck reuses one
   * Texture per card id / back design (see loadTexture). The handle map lets
   * disposeTexture release by handle.
   */
  private textures = new Map<TextureHandle, Texture>();
  private texturesByKey = new Map<string, TextureHandle>();
  /**
   * Card meshes built by createCardMesh: the PBR material, its rounded-rect
   * alpha mask, and the front/back face textures. setMeshFaceTexture swaps the
   * albedo (the flip) while keeping the corner mask as the opacity texture.
   */
  private cards = new Map<MeshHandle, {
    material: PBRMaterial;
    cornerMask: DynamicTexture;
    front?: Texture;
    back?: Texture;
  }>();
  // Reused per instance-matrix compose so a sweep over thousands of slots never
  // allocates. Shared across all fields — setThinFieldInstances is synchronous.
  private readonly _tfScale = new Vector3();
  private readonly _tfPos = new Vector3();
  private readonly _tfQuat = new Quaternion();
  private readonly _tfMat = Matrix.Identity();
  // Reused by screenToWorldPoint so per-frame projection never allocates.
  private readonly _tfRay = new Ray(Vector3.Zero(), Vector3.Up());
  private readonly _tfIdentity = Matrix.Identity();
  // Reused by worldToScreen — the HUD re-projects hundreds of points per frame
  // (brackets, crosshair, lead diamond, arrows, sun), so none of this allocates.
  private readonly _projWorld = new Vector3();
  private readonly _projView = new Vector3();
  private readonly _projOut = new Vector3();
  private readonly _projViewport = new Viewport(0, 0, 0, 0);
  private onFrame?: (dt: number) => void;
  private lastTime = 0;

  async init(canvas: HTMLCanvasElement, opts: RendererInitOptions = {}): Promise<void> {
    // `adaptToDeviceRatio: true` (both the options flag and the 4th ctor arg)
    // tells Babylon to size the WebGL backing buffer to the device's physical
    // pixels. Without it the buffer stays at 1× CSS pixels and a 2×/retina
    // display upscales every texture and glyph — the "soft cards" symptom.
    this.engine = new Engine(canvas, opts.antialias ?? true, {
      deterministicLockstep: true,
      lockstepMaxSteps: 4,
      adaptToDeviceRatio: true,
    }, true);
    // Be explicit as well as relying on the flag: pin the hardware-scaling
    // level to 1/dpr so the backing store matches physical pixels exactly, and
    // re-apply it on every resize (DPR can change when a window moves between a
    // retina and a non-retina monitor).
    this.applyDeviceScaling();
    this.scene = new Scene(this.engine);
    // Match glTF / Three.js so imported assets and coordinate math agree.
    // Without this, a scene authored in RH would be Z-mirrored under Babylon.
    this.scene.useRightHandedSystem = true;
    this.scene.collisionsEnabled = true;
    // Crossfade between character clips (walk↔punch↔death) instead of snapping:
    // when an AnimationGroup starts, it eases from the skeleton's current pose
    // over ~blendingSpeed. Scene-global is safe here — only skinned character
    // clips use Babylon Animations; bullets, muzzle flashes and cameras are
    // driven by direct transforms, not Animation objects.
    const blend = new AnimationPropertiesOverride();
    blend.enableBlending = true;
    blend.blendingSpeed = 0.08;
    this.scene.animationPropertiesOverride = blend;
    this.scene.setRenderingAutoClearDepthStencil(1, false, false);
    this.scene.setRenderingAutoClearDepthStencil(2, false, false);
    if (opts.clearColor) {
      this.scene.clearColor = new Color4(...opts.clearColor);
    }

    window.addEventListener('resize', () => this.resize());
  }

  getRenderingCanvas(): HTMLCanvasElement | null {
    return this.engine?.getRenderingCanvas() ?? null;
  }

  setClearColor(r: number, g: number, b: number, a = 1): void {
    if (this.scene) this.scene.clearColor = new Color4(r, g, b, a);
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
        // A ground is a horizontal XZ plane: width→X, depth (or height as a
        // fallback) →Z. Authors write either `depth` or `height` for the second
        // dimension; depth wins when both are given (Babylon names this Z axis
        // `height` in CreateGround, hence the field name on the right).
        mesh = MeshBuilder.CreateGround(`${id}_ground`, {
          width: prim.width ?? 10,
          height: prim.depth ?? prim.height ?? 10,
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
      case 'tube': {
        // Open-ended (uncapped) cylinder shell along +Y, base-pivoted: the
        // tube grows from y=0 up to y=height. The silo wall uses a single
        // zero-thickness double-sided surface; an optional `thickness`
        // extrudes an inner wall via the CreateTube `thickness` option.
        const radius = (prim.diameter ?? 1) / 2;
        const height = prim.height ?? 1;
        const opts: {
          path: Vector3[];
          radius: number;
          tessellation: number;
          cap: number;
          sideOrientation: number;
          thickness?: number;
        } = {
          path: [new Vector3(0, 0, 0), new Vector3(0, height, 0)],
          radius,
          tessellation: prim.tessellation ?? 32,
          cap: Mesh.NO_CAP,
          sideOrientation: Mesh.DOUBLESIDE,
        };
        if (prim.thickness && prim.thickness > 0) opts.thickness = prim.thickness;
        mesh = MeshBuilder.CreateTube(`${id}_tube`, opts, scene);
        break;
      }
      default:
        throw new Error(`BabylonAdapter.createMesh: unknown primitive kind "${prim.kind}"`);
    }

    if (mat) {
      const hasTextures =
        !!mat.albedoTexture || !!mat.normalTexture || !!mat.roughnessTexture || !!mat.ambientTexture;
      if (hasTextures) {
        mesh.material = this.buildTexturedPbrMaterial(`${id}_material`, mat, scene);
      } else {
        const material = new StandardMaterial(`${id}_material`, scene);
        if (mat.diffuse) material.diffuseColor = Color3.FromArray(mat.diffuse);
        if (mat.specular) material.specularColor = Color3.FromArray(mat.specular);
        if (mat.emissive) material.emissiveColor = Color3.FromArray(mat.emissive);
        if (mat.alpha !== undefined) material.alpha = mat.alpha;
        mesh.material = material;
      }
    }

    const handle = this.makeHandle<MeshHandle>('mesh', id);
    this.meshes.set(handle, mesh);
    this.meshesByMeshId.set(id, mesh);
    return handle;
  }

  createDebugBox(id: string, parent: MeshHandle, color: Color): MeshHandle | null {
    if (!this.scene) return null;
    const parentMesh = this.meshes.get(parent);
    if (!parentMesh) return null;

    const box = MeshBuilder.CreateBox(id, { width: 1, height: 1, depth: 1 }, this.scene);
    box.parent = parentMesh;
    box.isPickable = false;
    const material = new StandardMaterial(`${id}_material`, this.scene);
    material.wireframe = true;
    material.disableLighting = true;
    material.emissiveColor = new Color3(color[0], color[1], color[2]);
    box.material = material;

    // Registered like any other mesh, so setMeshPosition/setMeshScale/
    // setMeshVisible/disposeMesh work on the returned handle — and since the
    // box is parented, those transforms apply in the parent's LOCAL space.
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
    if (!mesh) return;
    // PhysicsAggregate assigns rotationQuaternion to drive Havok; once that's
    // set, Babylon ignores mesh.rotation. Write into the quaternion so
    // kinematic bodies (flippers, doors, paddles) actually move.
    if (mesh.rotationQuaternion) {
      Quaternion.FromEulerAnglesToRef(x, y, z, mesh.rotationQuaternion);
    } else {
      mesh.rotation.set(x, y, z);
    }
  }
  setMeshScale(h: MeshHandle, sx: number, sy: number, sz: number): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    mesh.scaling.x = sx;
    mesh.scaling.y = sy;
    mesh.scaling.z = sz;
  }
  replaceMeshGeometry(h: MeshHandle, geom: MeshGeometry): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    // `updatable = true` so subsequent calls can rewrite the same buffer.
    mesh.setVerticesData('position', geom.positions, true);
    mesh.setIndices(geom.indices);
    if (geom.normals) {
      mesh.setVerticesData('normal', geom.normals, true);
    } else {
      // No normals supplied — recompute from positions so lighting works.
      mesh.createNormals(true);
    }
    if (geom.uvs) mesh.setVerticesData('uv', geom.uvs, true);
    mesh.refreshBoundingInfo();
  }
  setMeshBillboardMode(h: MeshHandle, mode: BillboardMode): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    // Babylon constants: BILLBOARDMODE_NONE=0, BILLBOARDMODE_Y=2, BILLBOARDMODE_ALL=7.
    mesh.billboardMode = mode === 'all' ? 7 : mode === 'y' ? 2 : 0;
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
  setMeshBoundingBoxExtents(h: MeshHandle, min: Vec3, max: Vec3): void {
    const mesh = this.meshes.get(h);
    if (!mesh) return;
    mesh.setBoundingInfo(
      new BoundingInfo(
        new Vector3(min[0], min[1], min[2]),
        new Vector3(max[0], max[1], max[2]),
      ),
    );
  }
  getMeshBoundingBoxExtents(h: MeshHandle): { min: Vec3; max: Vec3 } | null {
    const mesh = this.meshes.get(h);
    if (!mesh) return null;
    const info = mesh.getBoundingInfo();
    const min = info.boundingBox.minimum;
    const max = info.boundingBox.maximum;
    return { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] };
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

  createLineSystem(id: string, lines: Vec3[][], color?: Color): LineHandle {
    const scene = this.scene;
    if (!scene) throw new Error('BabylonAdapter.createLineSystem: call init() first');
    const mesh = MeshBuilder.CreateLineSystem(
      `${id}_lines`,
      { lines: toV3Lines(lines), updatable: true },
      scene,
    );
    mesh.isPickable = false;
    if (color) mesh.color = new Color3(color[0], color[1], color[2]);
    const handle = this.makeHandle<LineHandle>('lineSystem', id);
    this.lines.set(handle, { mesh, shape: lines.map((l) => l.length) });
    return handle;
  }

  updateLineSystem(h: LineHandle, lines: Vec3[][], color?: Color): void {
    const rec = this.lines.get(h);
    if (!rec || !this.scene) return;
    const shape = lines.map((l) => l.length);
    const sameShape = shape.length === rec.shape.length && shape.every((n, i) => n === rec.shape[i]);
    if (sameShape) {
      // Reuse the GPU buffers in place — no per-frame allocation.
      MeshBuilder.CreateLineSystem(rec.mesh.name, { lines: toV3Lines(lines), instance: rec.mesh }, this.scene);
    } else {
      const visible = rec.mesh.isVisible;
      const name = rec.mesh.name;
      rec.mesh.dispose();
      rec.mesh = MeshBuilder.CreateLineSystem(name, { lines: toV3Lines(lines), updatable: true }, this.scene);
      rec.mesh.isPickable = false;
      rec.mesh.isVisible = visible;
      rec.shape = shape;
    }
    if (color) rec.mesh.color = new Color3(color[0], color[1], color[2]);
  }

  setLineSystemVisible(h: LineHandle, visible: boolean): void {
    const rec = this.lines.get(h);
    if (rec) rec.mesh.isVisible = visible;
  }

  disposeLineSystem(h: LineHandle): void {
    const rec = this.lines.get(h);
    if (rec) {
      rec.mesh.dispose();
      this.lines.delete(h);
    }
  }

  // ─── Thin-instance fields ───
  async loadThinField(spec: ThinFieldSpec): Promise<ThinFieldHandle | null> {
    if (!this.scene) throw new Error('BabylonAdapter.loadThinField: call init() first');
    const scene = this.scene;
    let container: AssetContainer;
    try {
      container = await LoadAssetContainerAsync(spec.src, scene);
    } catch (err) {
      console.error('[BabylonAdapter] loadThinField failed to load', spec.src, err);
      return null;
    }

    // Find the named node and merge all its geometry into ONE master mesh at the
    // origin (transforms baked into the verts). The originals stay in the
    // container (never added to the scene) and are reclaimed on container
    // dispose below.
    const all = [...container.transformNodes, ...container.meshes];
    const node = all.find((n) => n.name === spec.nodeName);
    if (!node) {
      console.warn('[BabylonAdapter] loadThinField: node', spec.nodeName, 'missing in', spec.src);
      container.dispose();
      return null;
    }

    const sources: Mesh[] = [];
    const pushIfGeo = (m: unknown): void => {
      const mesh = m as Mesh;
      if (mesh && typeof mesh.getTotalVertices === 'function' && mesh.getTotalVertices() > 0) {
        sources.push(mesh);
      }
    };
    pushIfGeo(node);
    for (const child of (node as TransformNode).getChildMeshes(false)) pushIfGeo(child);
    if (!sources.length) {
      container.dispose();
      return null;
    }

    // disposeSource=false: the GLB nodes may share geometry, so never dispose a
    // source — the untouched originals are reclaimed by container.dispose().
    const merged = Mesh.MergeMeshes(sources, false, true, undefined, false, true);
    if (!merged) {
      container.dispose();
      return null;
    }
    merged.name = `thinField_${spec.nodeName}`;
    merged.rotationQuaternion = null;
    merged.rotation.set(0, 0, 0);
    merged.scaling.set(1, 1, 1);
    merged.position.set(0, 0, 0);
    merged.computeWorldMatrix(true);
    merged.refreshBoundingInfo();

    // Recenter on its OWN bounding-box center: MergeMeshes bakes any GLB world
    // offset into the verts, so without this the geometry would render at its
    // authored offset rather than at the instance positions we give it.
    const c = merged.getBoundingInfo().boundingBox.center;
    merged.position.set(-c.x, -c.y, -c.z);
    merged.bakeCurrentTransformIntoVertices();
    merged.refreshBoundingInfo();

    merged.isPickable = false;
    merged.receiveShadows = false;
    // Field spans the arena; skip per-instance frustum culling so it never pops
    // out when the master's (origin) bbox leaves view.
    merged.alwaysSelectAsActiveMesh = true;

    const ext = merged.getBoundingInfo().boundingBox.extendSize;
    const maxDim = 2 * Math.max(ext.x, ext.y, ext.z);
    const baseScale = maxDim > 1e-5 ? spec.desiredSize / maxDim : 1;

    const buffer = new Float32Array(spec.capacity * 16);
    merged.thinInstanceSetBuffer('matrix', buffer, 16, false);
    merged.thinInstanceCount = 0; // grows to the drawn count in setThinFieldInstances

    // The container only held the source geometry, now merged + baked into
    // `merged`; drop it so its off-scene originals don't linger.
    container.dispose();

    const handle = this.makeHandle<ThinFieldHandle>('thinField', spec.nodeName);
    this.thinFields.set(handle, { master: merged, buffer, baseScale });
    return handle;
  }

  setThinFieldInstances(handle: ThinFieldHandle, packed: Float32Array, count: number): void {
    const field = this.thinFields.get(handle);
    if (!field) return;
    const { master, buffer, baseScale } = field;
    for (let i = 0; i < count; i++) {
      const o = i * 5;
      const s = baseScale * packed[o + 4]!;
      this._tfScale.set(s, s, s);
      this._tfPos.set(packed[o]!, packed[o + 1]!, packed[o + 2]!);
      Quaternion.RotationYawPitchRollToRef(packed[o + 3]!, 0, 0, this._tfQuat);
      Matrix.ComposeToRef(this._tfScale, this._tfQuat, this._tfPos, this._tfMat);
      this._tfMat.copyToArray(buffer, i * 16);
    }
    master.thinInstanceCount = count;
    if (count > 0) master.thinInstanceBufferUpdated('matrix');
  }

  disposeThinField(handle: ThinFieldHandle): void {
    const field = this.thinFields.get(handle);
    if (!field) return;
    field.master.dispose();
    this.thinFields.delete(handle);
  }

  screenToWorldPoint(camera: CameraHandle, nx: number, ny: number, distance: number, out: Vec3): Vec3 {
    const cam = this.resolveCamera(camera);
    if (!cam || !this.scene || !this.engine) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    const sx = this.engine.getRenderWidth() * nx;
    const sy = this.engine.getRenderHeight() * ny;
    this.scene.createPickingRayToRef(sx, sy, this._tfIdentity, this._tfRay, cam);
    out[0] = this._tfRay.origin.x + this._tfRay.direction.x * distance;
    out[1] = this._tfRay.origin.y + this._tfRay.direction.y * distance;
    out[2] = this._tfRay.origin.z + this._tfRay.direction.z * distance;
    return out;
  }

  // ─── Textures & cards ───
  loadTexture(key: string, url: string, opts?: TextureLoadOpts): TextureHandle {
    if (!this.scene) throw new Error('BabylonAdapter.loadTexture: call init() first');
    // Dedupe by key — a repeat call returns the same handle (and ignores opts).
    const cached = this.texturesByKey.get(key);
    if (cached) return cached;
    const tex = new Texture(url, this.scene);
    // Cards lie nearly flat on the table, so their faces are sampled at a steep
    // grazing angle — exactly where isotropic mip sampling goes blurry.
    // Trilinear (Babylon's default) + anisotropic filtering keeps the pips and
    // art crisp at this oblique view; 4 is a sane quality/perf default.
    tex.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
    tex.anisotropicFilteringLevel = 4;
    if (opts?.flipU) tex.uScale = -1; // mirror horizontally
    if (opts?.rotate) tex.wAng = opts.rotate; // rotate about center
    // Babylon textures are srgb-gamma by default; honor an explicit linear ask
    // by clearing the gamma flag (srgb=true is the default, so it's a no-op).
    if (opts?.srgb === false) tex.gammaSpace = false;
    const handle = this.makeHandle<TextureHandle>('texture', key);
    this.textures.set(handle, tex);
    this.texturesByKey.set(key, handle);
    return handle;
  }

  preloadTexture(url: string): Promise<void> {
    if (!this.scene) return Promise.resolve();
    const tex = new Texture(url, this.scene);
    if (tex.isReady()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      tex.onLoadObservable.addOnce(() => resolve());
    });
  }

  createCardMesh(id: string, spec: CardMeshSpec): MeshHandle {
    if (!this.scene) throw new Error('BabylonAdapter.createCardMesh: call init() first');
    const scene = this.scene;
    const w = spec.width;
    const h = spec.height;
    const subs = spec.subdivisions ?? 16;

    // A ground is a horizontal quad; we bow it along its width (X) into a
    // shallow parabola so flipped cards curl. Bow=0 leaves it flat.
    const mesh = MeshBuilder.CreateGround(`${id}_card`, {
      width: w, height: h, subdivisions: subs, updatable: true,
    }, scene);

    const bow = spec.bow ?? 0;
    if (bow !== 0) {
      const pos = mesh.getVerticesData('position');
      if (pos) {
        const p = Array.from(pos);
        for (let k = 0; k < p.length; k += 3) {
          const nx = p[k]! / (w * 0.5);
          p[k + 1] = bow * (1 - nx * nx);
        }
        mesh.updateVerticesData('position', p);
        const idx = mesh.getIndices()!;
        const nrm = new Array(p.length).fill(0);
        VertexData.ComputeNormals(p, idx, nrm);
        mesh.updateVerticesData('normal', nrm);
        mesh.refreshBoundingInfo();
      }
    }

    // Rounded-corner alpha mask generated INSIDE the adapter (reusing the
    // DynamicTexture getContext canvas pattern from drawLabelText) so no canvas
    // escapes the component.
    const cornerMask = this.buildCardCornerMask(`${id}_cardMask`, w, h, spec.cornerRadius, scene);

    const material = new PBRMaterial(`${id}_cardMat`, scene);
    material.opacityTexture = cornerMask;
    material.transparencyMode = 1; // ALPHA_TEST
    material.alphaCutOff = 0.5;
    material.roughness = 0.85;
    material.metallic = 0;
    material.backFaceCulling = false;
    material.twoSidedLighting = true;
    mesh.material = material;
    mesh.isPickable = true;

    const handle = this.makeHandle<MeshHandle>('card', id);
    this.meshes.set(handle, mesh);
    this.meshesByMeshId.set(id, mesh);

    const front = spec.front ? this.textures.get(spec.front) : undefined;
    const back = spec.back ? this.textures.get(spec.back) : undefined;
    this.cards.set(handle, { material, cornerMask, front, back });
    // Show the front face by default if supplied.
    if (front) material.albedoTexture = front;
    return handle;
  }

  /** Build a rounded-rect alpha mask as a DynamicTexture (canvas stays inside). */
  private buildCardCornerMask(
    name: string,
    w: number,
    h: number,
    cornerRadius: number | undefined,
    scene: Scene,
  ): DynamicTexture {
    const tw = 256;
    const th = Math.round((tw * h) / w);
    const dt = new DynamicTexture(name, { width: tw, height: th }, scene, false);
    dt.hasAlpha = true;
    const ctx = dt.getContext() as CanvasRenderingContext2D;
    // cornerRadius is a fraction of the shorter side; default ~8%.
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
    dt.update();
    return dt;
  }

  setMeshFaceTexture(h: MeshHandle, side: 'front' | 'back', tex: TextureHandle): void {
    const card = this.cards.get(h);
    const texture = this.textures.get(tex);
    if (!card || !texture) return;
    if (side === 'front') card.front = texture;
    else card.back = texture;
    // Apply as the visible albedo; the corner mask stays the opacity texture.
    card.material.albedoTexture = texture;
    card.material.useAlphaFromAlbedoTexture = false;
    card.material.opacityTexture = card.cornerMask;
  }

  setMeshAlbedoColor(h: MeshHandle, r: number, g: number, b: number): void {
    const mesh = this.meshes.get(h);
    const mat = mesh?.material;
    if (mat instanceof PBRMaterial) mat.albedoColor = new Color3(r, g, b);
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
    if (!this.engine) return 1;
    const h = this.engine.getRenderHeight();
    return h > 0 ? this.engine.getRenderWidth() / h : 1;
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

    // Cast a shadow from the loaded meshes (mirrors instantiateModel). A GLB
    // player model otherwise floats shadow-less while its invisible collision
    // proxy has its own caster disabled.
    const gen = this.shadowGenerators.values().next().value as ShadowGenerator | undefined;
    if (gen) {
      for (const child of root.getChildMeshes(false)) gen.addShadowCaster(child, false);
    }

    return {
      meshId: id,
      handle,
      animationNames: Array.from(byName.keys()),
    };
  }

  async loadModelTemplate(
    url: string,
    opts?: LoadModelTemplateOptions,
  ): Promise<{ animationNames: string[] }> {
    if (!this.scene) throw new Error('BabylonAdapter.loadModelTemplate: call init() first');
    const cached = this.modelTemplates.get(url);
    if (cached) return { animationNames: cached.animationGroups.map((g) => g.name) };
    // Dedupe concurrent loads: 24-32 pooled enemies built in one tick must
    // trigger ONE network fetch + glTF parse, not one each.
    let pending = this.modelTemplatePromises.get(url);
    if (!pending) {
      // LoadAssetContainerAsync keeps the result OFF the scene — it's a template
      // we clone from. Passing the full url string lets the glTF loader resolve
      // any sibling .bin / textures itself.
      pending = LoadAssetContainerAsync(url, this.scene);
      this.modelTemplatePromises.set(url, pending);
    }
    const container = await pending;
    const firstLoad = !this.modelTemplates.has(url);
    this.modelTemplates.set(url, container);
    // Strip baked horizontal root motion once, on the shared template (clones
    // inherit it). Keeps clips playing in place at the gameplay position.
    if (firstLoad && opts?.lockRootMotion) this.lockRootMotion(container);
    return { animationNames: container.animationGroups.map((g) => g.name) };
  }

  /**
   * Pin the rig's ROOT bone to the centre horizontally so every clip plays "in
   * place" over the entity's position. Two cases both need handling:
   *   • baked root MOTION (a death clip slides the hips across X/Z), and
   *   • a constant root OFFSET (e.g. the punch clip keeps the hips off-centre) —
   *     which, once the model yaws to face a target, orbits the proxy and traces
   *     a "J" instead of spinning in place.
   * So we force the root bone's X/Z to 0 on every keyframe (keeping Y, so
   * vertical bob/crouch/fall survive). Other bones keep their structural offsets.
   *
   * The root is identified from the skeleton (the parent-less bone) rather than
   * by motion, so a constant offset is caught too. A variance fallback also
   * catches a translating track if the name lookup ever misses. Mutates the
   * template's animations before any clone is made.
   */
  private lockRootMotion(container: AssetContainer): void {
    // Names that identify the skeleton root bone (and its linked node).
    const rootNames = new Set<string>();
    for (const skel of container.skeletons) {
      const root = skel.bones.find((b) => !b.getParent()) ?? skel.bones[0];
      if (!root) continue;
      rootNames.add(root.name);
      const tn = (root as { getTransformNode?: () => { name?: string } | null }).getTransformNode?.();
      if (tn?.name) rootNames.add(tn.name);
    }

    for (const group of container.animationGroups) {
      for (const ta of group.targetedAnimations) {
        const anim = ta.animation;
        if (!anim.targetProperty || !anim.targetProperty.toLowerCase().includes('position')) continue;
        const keys = anim.getKeys();
        if (keys.length === 0) continue;
        const targetName = (ta.target as { name?: string } | null)?.name ?? '';

        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const k of keys) {
          const v = k.value as Vector3;
          if (v.x < minX) minX = v.x;
          if (v.x > maxX) maxX = v.x;
          if (v.z < minZ) minZ = v.z;
          if (v.z > maxZ) maxZ = v.z;
        }
        const varies = maxX - minX + (maxZ - minZ) > 1e-3;

        // Only the root bone: matched by name (catches a constant offset) or, as
        // a fallback, any position track that actually translates (only the root
        // does in a normal humanoid rig — other bones keep a fixed local offset).
        if (!rootNames.has(targetName) && !varies) continue;

        for (const k of keys) {
          const v = k.value as Vector3;
          k.value = new Vector3(0, v.y, 0);
        }
        anim.setKeys(keys);
      }
    }
  }

  instantiateModel(id: string, url: string, spec?: ModelInstantiateSpec): MeshHandle {
    const container = this.modelTemplates.get(url);
    if (!container) {
      throw new Error(
        `BabylonAdapter.instantiateModel: template not loaded for "${url}" — await loadModelTemplate first`,
      );
    }
    // Skinned meshes can't share a skeleton, so Babylon CLONES (not GPU-
    // instances) the rig here — each clone gets its own skeleton and its own
    // animation groups retargeted to it, which is exactly the per-enemy
    // isolation we need. `cloneMaterials=false` shares the one material.
    const entries = container.instantiateModelsToScene((n) => `${id}_${n}`, false);
    this.instantiatedModels.set(id, entries);

    const root = entries.rootNodes[0] as TransformNode | undefined;
    if (!root) throw new Error(`BabylonAdapter.instantiateModel: no root node for "${url}"`);
    // glTF sets rotationQuaternion which nullifies Euler `.rotation`; clear it so
    // setMeshRotation's Euler-yaw path applies (same fix as loadMesh).
    root.rotationQuaternion = null;
    if (spec?.position) root.position.set(spec.position[0], spec.position[1], spec.position[2]);
    if (spec?.rotation) root.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
    if (spec?.scale !== undefined) root.scaling.setAll(spec.scale);
    // Start parked/hidden — the model System reveals it when the entity is live.
    root.setEnabled(false);

    // Store the clone root under a handle so setMeshPosition/setMeshRotation
    // (which touch .position/.rotation — present on TransformNode) drive it.
    const handle = this.makeHandle<MeshHandle>('model', id);
    this.meshes.set(handle, root as unknown as Mesh);

    // Register THIS clone's groups under `id` so playAnimation(id, clip) resolves
    // to its own groups and never grabs another enemy's. Stop them at rest.
    //
    // IMPORTANT: instantiateModelsToScene RENAMES each cloned group via our
    // nameFunction (so the clone's `.name` is `${id}_Walking`, not `Walking`).
    // Callers ask for the ORIGINAL clip name (`Walking`), so key each clone by
    // its source group's name — `entries.animationGroups[i]` corresponds to
    // `container.animationGroups[i]` (cloned in order).
    const byName = new Map<string, AnimationGroup>();
    entries.animationGroups.forEach((group, i) => {
      group.stop();
      const sourceName = container.animationGroups[i]?.name ?? group.name;
      byName.set(sourceName, group);
    });
    this.loadedAnimationGroups.set(id, byName);

    // Route shadows to the clone's skinned meshes (the invisible sphere proxy
    // has its caster disabled, so the humanoid casts the shadow, not a sphere).
    const gen = this.shadowGenerators.values().next().value as ShadowGenerator | undefined;
    if (gen) {
      for (const child of root.getChildMeshes(false)) gen.addShadowCaster(child, false);
    }

    return handle;
  }

  setModelVisible(h: MeshHandle, visible: boolean): void {
    const node = this.meshes.get(h);
    // Clone roots are TransformNodes — toggle the whole subtree with setEnabled
    // (isVisible only affects a single Mesh, not its children).
    if (node) node.setEnabled(visible);
  }

  setModelAlpha(id: string, alpha: number): void {
    const entries = this.instantiatedModels.get(id);
    if (!entries) return;
    // `visibility` is a 0..1 fade multiplier honored by Standard/PBR materials;
    // apply it to every skinned mesh under the clone root.
    for (const root of entries.rootNodes) {
      for (const mesh of (root as TransformNode).getChildMeshes(false)) {
        mesh.visibility = alpha;
      }
    }
  }

  disposeModel(id: string, h: MeshHandle): void {
    const entries = this.instantiatedModels.get(id);
    if (entries) {
      entries.dispose();
      this.instantiatedModels.delete(id);
    }
    this.meshes.delete(h);
    this.loadedAnimationGroups.delete(id);
  }

  playAnimationOnce(meshId: string, clipName: string): number {
    const group = this.findAnimationGroup(meshId, clipName);
    if (!group) return 0;
    // Restart from frame 0 even if already running — playAnimation no-ops while
    // a clip plays, which would block re-triggering a one-shot (hit/death).
    group.stop();
    group.start(false, 1, group.from, group.to, false);
    const fps = group.targetedAnimations[0]?.animation?.framePerSecond ?? 60;
    return fps > 0 ? (group.to - group.from) / fps : 0;
  }

  /** Back-compat accessor used by not-yet-migrated Systems (ArcCamera, Shadow). */
  getMeshObject(h: MeshHandle): Mesh | undefined {
    return this.meshes.get(h);
  }

  applyPbrMaterial(handle: MeshHandle, spec: PbrMaterialSpec): void {
    const mesh = this.meshes.get(handle);
    if (!mesh || !this.scene) return;
    const mat = new PBRMaterial(spec.name ?? 'pbrMaterial', this.scene);
    if (spec.metallic !== undefined) mat.metallic = spec.metallic;
    if (spec.roughness !== undefined) mat.roughness = spec.roughness;
    if (spec.albedoColor) {
      mat.albedoColor = new Color3(spec.albedoColor[0], spec.albedoColor[1], spec.albedoColor[2]);
    }
    if (spec.environmentIntensity !== undefined) mat.environmentIntensity = spec.environmentIntensity;
    mesh.material = mat;
  }

  /**
   * Build a `PBRMaterial` from a textured {@link MaterialSpec}. Mirrors how the
   * raw-Babylon arcade room wires its carpet floor: albedo + normal (bump) +
   * roughness (as the green channel of the metallic texture) + AO (ambient),
   * each tiled by `uScale`/`vScale`. Called only when at least one texture URL
   * is present; the flat-color path stays on `StandardMaterial`.
   */
  private buildTexturedPbrMaterial(name: string, mat: MaterialSpec, scene: Scene): PBRMaterial {
    const pbr = new PBRMaterial(name, scene);
    const uScale = mat.uScale ?? 1;
    const vScale = mat.vScale ?? 1;
    const tex = (url: string): Texture => {
      const t = new Texture(url, scene);
      t.uScale = uScale;
      t.vScale = vScale;
      // Tiled surfaces (floors, walls) are also viewed at grazing angles;
      // anisotropic filtering stops the tiling from smearing into the distance.
      t.anisotropicFilteringLevel = 4;
      return t;
    };
    if (mat.albedoTexture) pbr.albedoTexture = tex(mat.albedoTexture);
    if (mat.normalTexture) pbr.bumpTexture = tex(mat.normalTexture);
    if (mat.roughnessTexture) {
      // Babylon reads roughness from the green channel of the metallic texture.
      pbr.metallicTexture = tex(mat.roughnessTexture);
      pbr.useRoughnessFromMetallicTextureGreen = true;
      pbr.useRoughnessFromMetallicTextureAlpha = false;
    }
    if (mat.ambientTexture) pbr.ambientTexture = tex(mat.ambientTexture);
    if (mat.diffuse) pbr.albedoColor = Color3.FromArray(mat.diffuse);
    if (mat.emissive) pbr.emissiveColor = Color3.FromArray(mat.emissive);
    if (mat.metallic !== undefined) pbr.metallic = mat.metallic;
    else pbr.metallic = 0;
    if (mat.roughness !== undefined) pbr.roughness = mat.roughness;
    if (mat.alpha !== undefined) pbr.alpha = mat.alpha;
    return pbr;
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
      this.scene.activeCamera = camera;
    }
    // controlsEnabled defaults to true to preserve historical behavior; the
    // detach branch lets fixed-camera scenes (top-down shooter, pinball)
    // ignore mouse input without per-game ceremony in the host file.
    if (spec.controlsEnabled === false) {
      camera.detachControl();
    } else {
      camera.attachControl(this.engine.getRenderingCanvas(), true);
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
    // Free 6-DOF perspective camera: forward = `q · (+Z)` from the CANONICAL
    // orientation we stored (the +Y look-flip baked onto rotationQuaternion makes
    // the RENDER look exactly this way — proven for roll/pitch/yaw). Derive it
    // straight from the quaternion so the result is correct even before the first
    // view-matrix recompute (getTarget() is stale until then), and so identity →
    // +Z, the convention the contract locks.
    const stored = this.perspectiveOrientations.get(h);
    if (stored) {
      this._zAxisCanon.rotateByQuaternionToRef(stored, this._fwdScratch);
      out[0] = this._fwdScratch.x; out[1] = this._fwdScratch.y; out[2] = this._fwdScratch.z;
      return out;
    }
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
  setCameraRadius(h: CameraHandle, radius: number): void {
    const cam = this.cameras.get(h);
    if (cam) cam.radius = radius;
  }
  setCameraRadiusLimits(h: CameraHandle, min: number, max: number): void {
    const cam = this.cameras.get(h);
    if (!cam) return;
    cam.lowerRadiusLimit = min;
    cam.upperRadiusLimit = max;
  }
  setCameraFov(h: CameraHandle, fov: number): void {
    const cam = this.resolveCamera(h);
    if (cam) cam.fov = fov;
  }
  setCameraControlsEnabled(h: CameraHandle, enabled: boolean): void {
    const cam = this.cameras.get(h);
    if (!cam) return;
    if (enabled) {
      cam.attachControl(this.engine?.getRenderingCanvas(), true);
    } else {
      cam.detachControl();
    }
  }

  /**
   * Resolve a camera handle to whichever kind it minted — an `ArcRotateCamera`
   * (orbit) or a `UniversalCamera` (free 6-DOF). Used by the methods that
   * legitimately apply to both kinds (`screenToWorldPoint`, `setCameraFov`).
   */
  private resolveCamera(h: CameraHandle): ArcRotateCamera | UniversalCamera | undefined {
    return this.cameras.get(h) ?? this.perspectiveCameras.get(h);
  }

  // ─── Free 6-DOF perspective camera (chase / flight) ───
  createPerspectiveCamera(id: string, spec: PerspectiveCameraSpec): CameraHandle {
    if (!this.scene) throw new Error('BabylonAdapter.createPerspectiveCamera: call init() first');
    const pos = spec.position ?? [0, 0, 0];
    const camera = new UniversalCamera(`PerspCamera_${id}`, new Vector3(pos[0], pos[1], pos[2]), this.scene);
    // Babylon's fov is RADIANS natively (unlike Three's degrees), so spec.fov
    // passes straight through. minZ/maxZ are the near/far clip planes.
    camera.fov = spec.fov;
    camera.minZ = spec.near;
    camera.maxZ = spec.far;
    // The chase camera is posed directly every frame via setCameraPose; kill the
    // built-in inertial smoothing so the pose isn't lagged/lerped behind input.
    camera.inertia = 0;
    // Orientation lives on the quaternion — never Euler — so loops and rolls
    // reach the renderer without a gimbal-flipping quat→Euler round-trip. The
    // canonical orientation `q` is post-flipped 180° about +Y so the camera
    // renders looking down +Z at identity (see {@link perspLookFlip}); the
    // verbatim `q` is remembered for the lossless getCameraPose round-trip.
    const q = spec.orientation ?? { x: 0, y: 0, z: 0, w: 1 };
    const handle = this.makeHandle<CameraHandle>('perspCamera', id);
    const stored = new Quaternion(q.x, q.y, q.z, q.w);
    this.perspectiveOrientations.set(handle, stored);
    camera.rotationQuaternion = stored.multiply(this.perspLookFlip);
    // Make it the active camera (same as createArcCamera) so worldToScreen and
    // scene.render target it.
    this.scene.activeCamera = camera;
    this.perspectiveCameras.set(handle, camera);
    return handle;
  }

  setCameraPose(h: CameraHandle, position: Vec3, orientation: QuaternionSpec): void {
    const camera = this.perspectiveCameras.get(h);
    if (!camera) return;
    camera.position.set(position[0], position[1], position[2]);
    // Remember the canonical orientation verbatim (for getCameraPose), then bake
    // `q ⊗ PERSP_LOOK_FLIP` onto the Babylon camera so the rendered forward is
    // `q · (+Z)` — looking +Z at identity, toward a ship the camera trails. No
    // Euler conversion, so a rolling chase cam never gimbal-flips.
    let stored = this.perspectiveOrientations.get(h);
    if (!stored) { stored = new Quaternion(); this.perspectiveOrientations.set(h, stored); }
    stored.copyFromFloats(orientation.x, orientation.y, orientation.z, orientation.w);
    stored.multiplyToRef(this.perspLookFlip, (camera.rotationQuaternion ??= new Quaternion()));
  }

  getCameraPose(h: CameraHandle, outPosition: Vec3, outOrientation: QuaternionSpec): void {
    const camera = this.perspectiveCameras.get(h);
    if (!camera) return;
    const p = camera.position;
    outPosition[0] = p.x;
    outPosition[1] = p.y;
    outPosition[2] = p.z;
    // Hand back the CANONICAL orientation we stored verbatim — NOT the baked
    // `rotationQuaternion` (which carries the +Y look-flip). Falls back to the
    // baked/Euler form only for a camera posed before this map existed.
    const q = this.perspectiveOrientations.get(h)
      ?? camera.rotationQuaternion
      ?? Quaternion.FromEulerVector(camera.rotation);
    outOrientation.x = q.x;
    outOrientation.y = q.y;
    outOrientation.z = q.z;
    outOrientation.w = q.w;
  }

  worldToScreen(x: number, y: number, z: number, out: ScreenPoint): boolean {
    const scene = this.scene;
    const engine = this.engine;
    const camera = scene?.activeCamera;
    if (!scene || !engine || !camera) return false;
    this._projWorld.set(x, y, z);
    // Behind-camera reject FIRST, in VIEW space, BEFORE touching `out`: in this
    // right-handed scene an identity-orientation camera looks down +Z, so a
    // point whose view-space z is <= 0 sits behind the lens. Returning false
    // (and leaving `out` untouched) lets the HUD draw an off-screen arrow
    // instead of a mirrored phantom bracket where perspective division would
    // fling the point.
    Vector3.TransformCoordinatesToRef(this._projWorld, camera.getViewMatrix(), this._projView);
    if (this._projView.z <= 0) return false;
    // In front — project to pixels. Viewport is scaled to the live render
    // buffer; the world matrix is identity since we pass an absolute point.
    camera.viewport.toGlobalToRef(engine.getRenderWidth(), engine.getRenderHeight(), this._projViewport);
    Vector3.ProjectToRef(
      this._projWorld,
      this._tfIdentity,
      scene.getTransformMatrix(),
      this._projViewport,
      this._projOut,
    );
    out.x = this._projOut.x;
    out.y = this._projOut.y;
    return true;
  }

  // ─── Floating origin / large world (Phase-1: contract-only, dormant) ───
  getOriginOffset(out: Vec3): Vec3 {
    out[0] = this.originOffset[0];
    out[1] = this.originOffset[1];
    out[2] = this.originOffset[2];
    return out;
  }

  setOriginOffset(x: number, y: number, z: number): void {
    // Record only — Phase-1 performs no active per-frame scene-graph rebase.
    this.originOffset[0] = x;
    this.originOffset[1] = y;
    this.originOffset[2] = z;
  }

  configureLargeWorld(spec: LargeWorldSpec): void {
    this.largeWorldEnabled = spec.enabled;
    // We may widen the far plane on the active camera, but do NOT rebase.
    if (spec.farPlane !== undefined && this.scene?.activeCamera) {
      this.scene.activeCamera.maxZ = spec.farPlane;
    }
  }

  pickAtScreenPoint(x: number, y: number, opts?: PickOptions): PickResult | null {
    if (!this.scene) return null;
    const predicate = opts?.meshPredicate;
    const pick = this.scene.pick(
      x,
      y,
      predicate ? (m) => predicate(m.name) : undefined,
    );
    if (!pick?.hit || !pick.pickedPoint) return null;
    return {
      x: pick.pickedPoint.x,
      y: pick.pickedPoint.y,
      z: pick.pickedPoint.z,
      meshId: pick.pickedMesh?.name ?? '',
    };
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

  createSkybox(id: string, spec: SkyboxSpec): SkyboxHandle {
    if (!this.scene) throw new Error('BabylonAdapter.createSkybox: call init() first');
    const scene = this.scene;
    const size = spec.size ?? 800;

    const mesh = MeshBuilder.CreateSphere(`Skybox_${id}`, {
      diameter: size,
      segments: 24,
      // Invert via sideOrientation so we render the inside faces.
      sideOrientation: Mesh.BACKSIDE,
    }, scene);
    mesh.infiniteDistance = true;
    mesh.applyFog = false;
    mesh.isPickable = false;
    // Skybox is the background — it should NEVER occlude scene geometry via
    // depth. Without this, distant meshes z-fight the sky at the far plane.
    mesh.renderingGroupId = 0;

    const material = new ShaderMaterial(
      `Skybox_${id}_mat`,
      scene,
      {
        vertexSource: SKYBOX_VERTEX_SHADER,
        fragmentSource: SKYBOX_FRAGMENT_SHADER,
      },
      {
        attributes: ['position'],
        uniforms: [
          'worldViewProjection',
          'sunDir',
          'sunColor',
          'zenithColor',
          'horizonColor',
          'groundColor',
          'sunSize',
          'sunGlowSize',
        ],
        needAlphaBlending: false,
        needAlphaTesting: false,
      },
    );
    material.backFaceCulling = false;
    material.disableDepthWrite = true;

    const sunDir = normalizeVec3(spec.sunDirection);
    material.setVector3('sunDir', new Vector3(sunDir[0], sunDir[1], sunDir[2]));
    material.setColor3('sunColor', Color3.FromArray(spec.sunColor));
    material.setColor3('zenithColor', Color3.FromArray(spec.zenithColor));
    material.setColor3('horizonColor', Color3.FromArray(spec.horizonColor));
    material.setColor3('groundColor', Color3.FromArray(spec.groundColor));
    material.setFloat('sunSize', spec.sunSize ?? 0.9995);
    material.setFloat('sunGlowSize', spec.sunGlowSize ?? 60);

    mesh.material = material;

    const handle = this.makeHandle<SkyboxHandle>('skybox', id);
    this.skyboxes.set(handle, { mesh, material });
    return handle;
  }

  updateSkyboxSun(h: SkyboxHandle, sunDirection: Vec3, sunColor?: Color): void {
    const entry = this.skyboxes.get(h);
    if (!entry) return;
    const n = normalizeVec3(sunDirection);
    entry.material.setVector3('sunDir', new Vector3(n[0], n[1], n[2]));
    if (sunColor) entry.material.setColor3('sunColor', Color3.FromArray(sunColor));
  }

  disposeSkybox(h: SkyboxHandle): void {
    const entry = this.skyboxes.get(h);
    if (!entry) return;
    entry.material.dispose();
    entry.mesh.dispose();
    this.skyboxes.delete(h);
  }

  setEnvironmentTexture(url: string, opts?: EnvironmentTextureOpts): void {
    if (!this.scene) throw new Error('BabylonAdapter.setEnvironmentTexture: call init() first');
    // `.env` cubemaps are Babylon's prefiltered IBL format. Other formats
    // would need `CubeTexture.CreateFromImages` or `HDRCubeTexture`; callers
    // generally ship a renderer-specific URL anyway.
    const env = CubeTexture.CreateFromPrefilteredData(url, this.scene);
    env.level = opts?.level ?? 1.0;
    // Cast lifts the duplicate-@babylonjs/core type tangle (this repo can pull
    // two copies — packages/ + games/). At runtime they're the same API.
    (this.scene as unknown as { environmentTexture: unknown }).environmentTexture = env;
  }

  clearEnvironmentTexture(): void {
    if (!this.scene) return;
    const s = this.scene as unknown as {
      environmentTexture?: { dispose?: () => void } | null;
    };
    s.environmentTexture?.dispose?.();
    s.environmentTexture = null;
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
    this.drawLabelText(
      texture, spec.text, fontSize, fontWeight, padding,
      spec.background, spec.borderColor,
    );
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
      background: spec.background,
      borderColor: spec.borderColor,
    });
    return handle;
  }

  setLabelText(h: LabelHandle, text: string): void {
    const entry = this.labels.get(h);
    if (!entry) return;
    this.drawLabelText(
      entry.texture, text, entry.fontSize, entry.fontWeight, 12,
      entry.background, entry.borderColor,
    );
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
    background?: string,
    borderColor?: string,
  ): void {
    const size = texture.getSize();
    const ctx = texture.getContext() as CanvasRenderingContext2D;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    // Optional sign plate: a filled background rect over the whole texture,
    // with an optional border stroked just inside its edge. Drawn before the
    // text so the glyphs sit on top. Mirrors Buildings.createSignMeshes.
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, size.width, size.height);
      if (borderColor) {
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, size.width - 2, size.height - 2);
      }
    }
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
      // Lock X/Z tumbling (so an upright capsule character can't be knocked over
      // by a collision) while leaving Y-axis turning free. Havok treats a ZERO
      // inertia component as a fully locked axis; a small non-zero value (the
      // old 0.001) is the opposite — near-zero rotational inertia, i.e. it tips
      // over from the slightest contact. Y stays at 1 so faceMotion yaw works.
      aggregate.body.setMassProperties({ inertia: new Vector3(0, 1, 0) });
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

  physicsSetBodyAngularVelocity(meshId: string, vx: number, vy: number, vz: number): void {
    const aggregate = this.physicsAggregates.get(meshId);
    if (!aggregate) return;
    aggregate.body.setAngularVelocity(new Vector3(vx, vy, vz));
  }

  physicsSetBodyDrivenByMesh(meshId: string, drivenByMesh: boolean): void {
    const aggregate = this.physicsAggregates.get(meshId);
    if (!aggregate) return;
    // drivenByMesh=true → Babylon reads the mesh transform each step
    // (disablePreStep = false). drivenByMesh=false → physics owns the
    // transform; useful for teleports that shouldn't be overwritten.
    aggregate.body.disablePreStep = !drivenByMesh;
  }

  physicsSetGravity(x: number, y: number, z: number): void {
    this.scene?.getPhysicsEngine()?.setGravity(new Vector3(x, y, z));
  }

  physicsResizeBoxBody(meshId: string, halfExtents: Vec3): void {
    if (!this.scene) return;
    const aggregate = this.physicsAggregates.get(meshId);
    if (!aggregate) return;
    // Build a new BOX shape at the requested dimensions, hot-swap it onto
    // the body, then dispose the old shape. The body keeps motion type,
    // mass, restitution, friction, pose, and velocity.
    const dims = new Vector3(halfExtents[0] * 2, halfExtents[1] * 2, halfExtents[2] * 2);
    const newShape = new PhysicsShapeBox(
      new Vector3(0, 0, 0),
      new Quaternion(0, 0, 0, 1),
      dims,
      this.scene,
    );
    const oldShape = aggregate.body.shape;
    aggregate.body.shape = newShape;
    oldShape?.dispose();
  }

  physicsSetRestitution(meshId: string, restitution: number): void {
    const aggregate = this.physicsAggregates.get(meshId);
    const shape = aggregate?.body.shape;
    if (!shape) return;
    shape.material = { ...shape.material, restitution };
  }

  setCollidersVisible(visible: boolean): void {
    if (!this.scene) return;
    if (visible) {
      if (!this.physicsViewer) this.physicsViewer = new PhysicsViewer(this.scene);
      for (const agg of this.physicsAggregates.values()) {
        this.physicsViewer.showBody(agg.body);
      }
    } else if (this.physicsViewer) {
      for (const agg of this.physicsAggregates.values()) {
        this.physicsViewer.hideBody(agg.body);
      }
      this.physicsViewer.dispose();
      this.physicsViewer = null;
    }
  }

  physicsStep(_dt: number): void {
    // Havok advances during `scene.render`. Exposed as a no-op so the System
    // can call it uniformly across adapters.
    void _dt;
  }

  physicsSetPaused(paused: boolean): void {
    if (!this.havokPlugin) return;
    if (paused) {
      // Save the live rate once and freeze the sim. `scene.render` still runs
      // (we don't control the render loop here), but a 0 timestep means Havok
      // performs no integration, so bodies hold still while we step.
      if (this.savedTimeStep === null) {
        this.savedTimeStep = this.havokPlugin.getTimeStep();
        this.havokPlugin.setTimeStep(0);
      }
    } else if (this.savedTimeStep !== null) {
      this.havokPlugin.setTimeStep(this.savedTimeStep);
      this.savedTimeStep = null;
    }
  }

  physicsGetBodyState(meshId: string): PhysicsBodySnapshot | null {
    const aggregate = this.physicsAggregates.get(meshId);
    const mesh = this.meshesByMeshId.get(meshId);
    if (!aggregate || !mesh) return null;

    const lin = aggregate.body.getLinearVelocity();
    const ang = aggregate.body.getAngularVelocity();

    let rx = mesh.rotation.x;
    let ry = mesh.rotation.y;
    let rz = mesh.rotation.z;
    if (mesh.rotationQuaternion) {
      // PhysicsAggregate drives rotationQuaternion; convert to Euler for the
      // renderer-agnostic snapshot.
      const e = mesh.rotationQuaternion.toEulerAngles();
      rx = e.x;
      ry = e.y;
      rz = e.z;
    }

    return {
      position: [mesh.position.x, mesh.position.y, mesh.position.z],
      rotation: [rx, ry, rz],
      linearVelocity: [lin.x, lin.y, lin.z],
      angularVelocity: [ang.x, ang.y, ang.z],
    };
  }

  physicsSetBodyState(meshId: string, state: PhysicsBodySnapshot): void {
    const aggregate = this.physicsAggregates.get(meshId);
    const mesh = this.meshesByMeshId.get(meshId);
    if (!aggregate || !mesh) return;

    const [px, py, pz] = state.position;
    const [rx, ry, rz] = state.rotation;

    // Sync the mesh first so the restore is visible immediately even while
    // physics is paused (no step will copy the body pose back this frame).
    mesh.position.set(px, py, pz);
    let q: Quaternion;
    if (mesh.rotationQuaternion) {
      Quaternion.FromEulerAnglesToRef(rx, ry, rz, mesh.rotationQuaternion);
      q = mesh.rotationQuaternion;
    } else {
      mesh.rotation.set(rx, ry, rz);
      q = Quaternion.FromEulerAngles(rx, ry, rz);
    }

    // Teleport the body so the solver adopts the restored pose, then restore
    // both velocities so resuming continues with the recorded momentum.
    aggregate.body.setTargetTransform(new Vector3(px, py, pz), q);
    aggregate.body.setLinearVelocity(
      new Vector3(state.linearVelocity[0], state.linearVelocity[1], state.linearVelocity[2]),
    );
    aggregate.body.setAngularVelocity(
      new Vector3(state.angularVelocity[0], state.angularVelocity[1], state.angularVelocity[2]),
    );
  }

  physicsSetTimeStep(hz: number): void {
    if (!Number.isFinite(hz) || hz <= 0) return;
    // Buffer the rate if Havok hasn't booted yet; ensureHavok drains
    // pending creates but not arbitrary callbacks, so we just retry once
    // the plugin is live.
    if (!this.havokPlugin) {
      void this.ensureHavok().then(() => this.physicsSetTimeStep(hz));
      return;
    }
    this.havokPlugin.setTimeStep(1 / hz);
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

  /**
   * Pin the engine's hardware-scaling level to `1 / devicePixelRatio` so the
   * WebGL backing buffer renders at the display's physical resolution. Called
   * at init and after every resize, since a window dragged between a retina and
   * a standard monitor changes `devicePixelRatio` live.
   */
  private applyDeviceScaling(): void {
    if (!this.engine) return;
    this.engine.setHardwareScalingLevel(hardwareScalingLevelForDpr(currentDevicePixelRatio()));
  }

  resize(): void {
    if (!this.engine) return;
    this.applyDeviceScaling();
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
    for (const field of this.thinFields.values()) field.master.dispose();
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
    this.perspectiveCameras.clear();
    this.perspectiveOrientations.clear();
    this.originOffset[0] = this.originOffset[1] = this.originOffset[2] = 0;
    this.largeWorldEnabled = false;
    this.shadowGenerators.clear();
    this.shadowCasters.clear();
    this.labels.clear();
    this.skyboxes.clear();
    this.loadedAnimationGroups.clear();
  }
}

function normalizeVec3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function toV3Lines(lines: Vec3[][]): Vector3[][] {
  return lines.map((poly) => poly.map((p) => new Vector3(p[0], p[1], p[2])));
}

// Vertex: pass model-space position as the "view ray" — the skybox sphere is
// centered on the camera (infiniteDistance), so the unnormalized vertex
// position is the direction we want to shade.
const SKYBOX_VERTEX_SHADER = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

// Fragment: horizon→zenith→ground gradient + sun disc + halo + horizon haze
// toward the sun. All emissive (skybox is not lit by scene lights).
const SKYBOX_FRAGMENT_SHADER = `
precision highp float;
varying vec3 vDir;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 zenithColor;
uniform vec3 horizonColor;
uniform vec3 groundColor;
uniform float sunSize;
uniform float sunGlowSize;

void main() {
  vec3 dir = normalize(vDir);
  vec3 sun = normalize(sunDir);
  float vy = dir.y;

  vec3 sky;
  if (vy > 0.0) {
    float t = smoothstep(0.0, 0.6, vy);
    sky = mix(horizonColor, zenithColor, t);
  } else {
    float t = smoothstep(0.0, 0.4, -vy);
    sky = mix(horizonColor, groundColor, t);
  }

  float sunDot = max(0.0, dot(dir, sun));
  float disc = smoothstep(sunSize, 1.0, sunDot);
  float halo = pow(sunDot, sunGlowSize);
  float horizon = smoothstep(0.25, 0.0, abs(vy));
  float haze = pow(sunDot, 6.0) * horizon * 0.55;

  vec3 col = sky + sunColor * (disc * 1.6 + halo * 0.55 + haze);
  gl_FragColor = vec4(col, 1.0);
}
`;
