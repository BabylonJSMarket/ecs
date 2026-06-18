/**
 * Side-by-side comparison of the three RendererAdapters — driven by the REAL ECS.
 *
 * Each pane runs an actual `World` (from this package) whose Systems talk to the
 * engine ONLY through `this.world.renderer` (the adapter). That's the genuine
 * integration test for the adapters: the full World.update → System →
 * RendererAdapter chain, in a real browser with real WebGL / WebGPU / WASM.
 * (The ecs package can't depend on @babylonjsmarket/arcade — arcade depends on
 * ecs — so we define small demo Systems/Components here instead.)
 *
 * Run: `npm run examples` → http://localhost:8080/examples/compare.html
 */
import { World, System } from '../src/index';
import { Component } from '../src/index';
import type { Entity } from '../src/index';
import { BabylonAdapter } from '../src/babylon';
import { ThreeAdapter } from '../src/three';
import { BabylonLiteAdapter } from '../src/babylon-lite';
import type {
  ArcCameraSpec, DirectionalLightSpec, HemisphericLightSpec,
  PrimitiveSpec, MaterialSpec, PhysicsBodyOpts, Vec3, MeshHandle, LightHandle, RendererAdapter,
} from '../src/Renderer/types';

// A classic public glТF (Khronos sample, CORS-enabled on raw.githubusercontent).
const DUCK_GLB = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Duck/glTF-Binary/Duck.glb';

/** Shared per-world handle to the directional light, so meshes can register as shadow casters. */
class DemoContext {
  dirLight: LightHandle | null = null;
}

// ─────────────────────────── Components (pure data) ───────────────────────────

class ArcCameraComp extends Component {
  constructor(public spec: ArcCameraSpec) { super(); }
  serialize() { return { ...this.spec }; }
}
class LightComp extends Component {
  constructor(
    public kind: 'hemi' | 'dir',
    public spec: HemisphericLightSpec | DirectionalLightSpec,
  ) { super(); }
  serialize() { return { kind: this.kind, ...this.spec }; }
}
class PrimitiveComp extends Component {
  constructor(
    public prim: PrimitiveSpec,
    public material: MaterialSpec,
    public position: Vec3,
    public opts: { castShadow?: boolean; receiveShadows?: boolean; spin?: boolean } = {},
  ) { super(); }
  serialize() { return { prim: this.prim, material: this.material, position: this.position, opts: this.opts }; }
}
class GlbComp extends Component {
  constructor(
    public url: string,
    public position: Vec3,
    public scale: number,
    public castShadow = true,
  ) { super(); }
  serialize() { return { url: this.url, position: this.position, scale: this.scale, castShadow: this.castShadow }; }
}
class PhysicsComp extends Component {
  constructor(public opts: PhysicsBodyOpts) { super(); }
  serialize() { return { ...this.opts }; }
}

// ─────────────────────────────── Systems ─────────────────────────────────────

class CameraSystem extends System {
  constructor() { super(); this.query = { required: [ArcCameraComp] }; }
  protected onEntityAdded(e: Entity): void {
    this.world!.renderer!.createArcCamera(e.id, e.get(ArcCameraComp)!.spec);
  }
  protected onUpdate(): void {}
}

class LightSystem extends System {
  constructor(private ctx: DemoContext) { super(); this.query = { required: [LightComp] }; }
  protected onEntityAdded(e: Entity): void {
    const r = this.world!.renderer!;
    const c = e.get(LightComp)!;
    if (c.kind === 'hemi') {
      r.createHemisphericLight(e.id, c.spec as HemisphericLightSpec);
    } else {
      this.ctx.dirLight = r.createDirectionalLight(e.id, c.spec as DirectionalLightSpec);
    }
  }
  protected onUpdate(): void {}
}

class MeshSystem extends System {
  private handles = new WeakMap<PrimitiveComp, MeshHandle>();
  constructor(private ctx: DemoContext) { super(); this.query = { required: [PrimitiveComp] }; }
  protected onEntityAdded(e: Entity): void {
    const r = this.world!.renderer!;
    const c = e.get(PrimitiveComp)!;
    const h = r.createMesh(e.id, c.prim, c.material);
    this.handles.set(c, h);
    r.setMeshPosition(h, c.position[0], c.position[1], c.position[2]);
    if (c.opts.receiveShadows) r.setMeshReceiveShadows(h, true);
    if (c.opts.castShadow && this.ctx.dirLight) r.attachShadowCaster(this.ctx.dirLight, h);
  }
  protected onUpdate(): void {
    const r = this.world!.renderer!;
    const angle = (performance.now() / 1000) * 0.8;
    // Torus primitive orientation differs by engine (Three's is upright in XY,
    // Babylon/Lite's lies flat in XZ); tilt the flat ones upright so the spin
    // reads the same. `kind` is part of the adapter interface — not an engine import.
    const tiltX = r.kind === 'three' ? 0 : Math.PI / 2;
    for (const e of this.entities) {
      const c = e.get(PrimitiveComp)!;
      if (!c.opts.spin) continue;
      const h = this.handles.get(c);
      if (h) r.setMeshRotation(h, tiltX, angle, 0);
    }
  }
}

class GlbSystem extends System {
  constructor(private ctx: DemoContext) { super(); this.query = { required: [GlbComp] }; }
  protected onEntityAdded(e: Entity): void {
    const r = this.world!.renderer!;
    const c = e.get(GlbComp)!;
    // loadMesh is async (fetch + parse); fire it and wire shadows on completion.
    void r.loadMesh(e.id, { url: c.url, position: c.position, scale: c.scale })
      .then((res) => {
        if (c.castShadow && this.ctx.dirLight) r.attachShadowCaster(this.ctx.dirLight, res.handle);
      })
      .catch((err: unknown) => console.error(`[glb ${r.kind}]`, err));
  }
  protected onUpdate(): void {}
}

class PhysicsSystem extends System {
  constructor() { super(); this.query = { required: [PhysicsComp] }; }
  protected onEntityAdded(e: Entity): void {
    // The mesh must exist first — MeshSystem is added before this one, so its
    // backfill has already created the body's mesh by id.
    this.world!.renderer!.physicsCreateBody(e.id, e.get(PhysicsComp)!.opts);
  }
  protected onUpdate(dt: number): void {
    this.world!.renderer!.physicsStep(dt);
  }
}

// ─────────────────────────── Scene (entities) ────────────────────────────────

function buildWorld(adapter: RendererAdapter): World {
  const world = new World({ renderer: adapter, detectRaces: false });
  const ctx = new DemoContext();

  world.createEntity('cam').add(new ArcCameraComp({
    alpha: -Math.PI / 2.2, beta: Math.PI / 3, radius: 16,
    minRadius: 4, maxRadius: 60, minBeta: 0.05, maxBeta: Math.PI / 2.05,
    target: [0, 1.5, 0], inertia: 0.7, wheelPrecision: 30,
    angularSensibility: 800, controlsEnabled: true,
  }));

  world.createEntity('hemi').add(new LightComp('hemi', {
    direction: [0, 1, 0], intensity: 0.75,
    diffuse: [1, 1, 1], groundColor: [0.3, 0.32, 0.4], specular: [0, 0, 0],
  }));
  world.createEntity('sun').add(new LightComp('dir', {
    direction: [-0.5, -1, -0.6], position: [12, 18, 10], intensity: 1.4,
    diffuse: [1, 0.96, 0.88], specular: [0.2, 0.2, 0.2],
    shadow: { enabled: true, mapSize: 2048, minZ: 1, maxZ: 80 },
  }));

  world.createEntity('ground')
    .add(new PrimitiveComp({ kind: 'ground', width: 24, depth: 24 }, { diffuse: [0.16, 0.18, 0.24] },
      [0, 0, 0], { receiveShadows: true }))
    .add(new PhysicsComp({ shapeType: 'box', motionType: 'static', mass: 0, friction: 0.8, restitution: 0.3, lockRotation: true }));

  const palette: Array<[number, number, number]> = [
    [0.9, 0.3, 0.35], [0.3, 0.7, 0.95], [0.95, 0.8, 0.3], [0.5, 0.9, 0.5],
  ];
  (['box', 'sphere', 'cylinder', 'capsule'] as const).forEach((kind, i) => {
    world.createEntity(`prim_${kind}`).add(new PrimitiveComp(
      { kind, width: 1.4, height: 1.6, depth: 1.4, diameter: 1.4, radius: 0.7, pivotAtBottom: true },
      { diffuse: palette[i] }, [-4.5 + i * 3, 0.01, -5], { castShadow: true },
    ));
  });

  world.createEntity('spinner').add(new PrimitiveComp(
    { kind: 'torus', diameter: 2.6, thickness: 0.5 },
    { diffuse: [0.8, 0.5, 0.95], emissive: [0.15, 0.05, 0.25] }, [0, 4, 4],
    { castShadow: true, spin: true },
  ));

  for (let i = 0; i < 4; i++) {
    world.createEntity(`drop_${i}`)
      .add(new PrimitiveComp({ kind: 'sphere', diameter: 1 }, { diffuse: [0.95, 0.55, 0.2] },
        [-3 + i * 2, 6 + i * 1.5, 0], { castShadow: true }))
      .add(new PhysicsComp({ shapeType: 'sphere', motionType: 'dynamic', mass: 1, friction: 0.4, restitution: 0.65, lockRotation: false }));
  }

  // GLB import — exercises loadMesh on every adapter.
  world.createEntity('duck').add(new GlbComp(DUCK_GLB, [5, 0, -1], 1.6, true));

  // Order matters: Light first (sets ctx.dirLight for shadow casters), Mesh before
  // Physics (body needs its mesh). addSystem backfills onEntityAdded immediately.
  world.addSystem(new LightSystem(ctx));
  world.addSystem(new CameraSystem());
  world.addSystem(new MeshSystem(ctx));
  world.addSystem(new GlbSystem(ctx));
  world.addSystem(new PhysicsSystem());
  return world;
}

// ──────────────────────────────── Boot ───────────────────────────────────────

async function run(
  AdapterCtor: new () => RendererAdapter,
  canvasId: string, statusId: string, fpsId: string,
): Promise<void> {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
  const status = document.getElementById(statusId) as HTMLElement;
  const fpsEl = document.getElementById(fpsId);
  const adapter = new AdapterCtor();
  try {
    await adapter.init(canvas);
    const world = buildWorld(adapter);
    let frames = 0;
    let fpsLast = performance.now();
    adapter.startLoop((dt) => {
      world.update(dt);
      frames++;
      const now = performance.now();
      if (now - fpsLast >= 500) {
        if (fpsEl) fpsEl.textContent = `${Math.round((frames * 1000) / (now - fpsLast))} fps`;
        frames = 0;
        fpsLast = now;
      }
    });
    window.addEventListener('resize', () => adapter.resize());
    status.textContent = `${adapter.kind} · running`;
    setTimeout(() => { status.style.display = 'none'; }, 4000);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    status.classList.add('error');
    status.style.display = 'block';
    status.textContent = adapter.kind === 'babylon-lite'
      ? `Babylon Lite needs a WebGPU browser — ${msg}`
      : `init failed: ${msg}`;
    console.error(`[${canvasId}]`, err);
  }
}

run(BabylonAdapter, 'cv-babylon', 'st-babylon', 'fps-babylon');
run(ThreeAdapter, 'cv-three', 'st-three', 'fps-three');
run(BabylonLiteAdapter, 'cv-lite', 'st-lite', 'fps-lite');
