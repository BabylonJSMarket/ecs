/**
 * Selective glow for BabylonLiteAdapter: Babylon's GlowLayer, which is
 * INCLUDE-ONLY, on Babylon Lite 1.8 (which has no glow layer of its own).
 *
 * The rules are Babylon's own (ThinGlowLayer / ThinEffectLayer, core 9):
 *   - only an ENROLLED mesh is drawn into the glow buffer; every other mesh is
 *     skipped (Babylon's `_shouldRenderMesh` early-out), so nothing occludes;
 *   - an enrolled Standard or PBR mesh draws its EMISSIVE (colour, and map);
 *     anything else — a plugin's ShaderMaterial — draws its own material, as
 *     does a mesh enrolled with `ownMaterial` (Babylon's
 *     `referenceMeshToUseItsOwnMaterial`);
 *   - the buffer is cleared to Babylon's neutral colour (0,0,0,1), blurred
 *     twice — once at its own size, once again at half that — and the two
 *     blurs are summed, times `intensity`, and drawn with ALPHA_ADD
 *     (src × srcAlpha + dst). The neutral alpha of 1 sums to 2, also times
 *     `intensity`, so the frame gains (blur1 + blur2) × 2 × intensity².
 *   - each blur is Babylon's kernel blur: `blurKernelSize / 2` taps across,
 *     Gaussian with σ a third of the half-width.
 * threeSelectiveBloom.ts is the Three twin.
 *
 * Built from Lite's frame-graph parts, on the END of the scene's frame graph:
 *   1. glow      a RenderTask into an rgba16float target at `textureRatio` × the
 *                canvas, with its own depth. Its renderables are not the
 *                scene's: each enrolled mesh is added with
 *                `addMesh(mesh, { material })` — an emissive-only Standard
 *                stand-in, or its own material.
 *   2-5. blur    H then V at the glow size (blur 1), H then V at half (blur 2).
 *   6. merge     over the swapchain, additively blended.
 *
 * The draw list follows the scene every frame (`sync`), so a mesh that comes,
 * goes, changes material or is enrolled late is right on the next frame. An
 * emissive stand-in copies its source's emissive each frame.
 *
 * Not matched: Lite's unlit Standard path clamps colour to 1, so an emissive
 * brighter than 1 glows as 1 (Babylon writes it unclamped into a float
 * buffer).
 *
 * Lite gaps this works around (index.d.ts, 1.8.0), each an internal field,
 * checked:
 *   - No way to take one mesh OUT of a RenderTask: the task's `_renderables`
 *     and binding lists are spliced, as Lite's own removeMeshFromTask does.
 *   - A material override still files its disposers under the MESH in
 *     `scene._meshDisposables`, replacing the scene pass's own; the scene
 *     pass's are put back and the stand-in's kept here.
 *   - No task removal (see the AmbientOcclusion plugin): each task sits behind
 *     a gate, and a resize or a new `textureRatio` retires the set and adds a
 *     fresh one. A few inert task objects stay in the graph per resize.
 *   - A task added after the scene registered is never recorded: the gate
 *     records on first use. A RenderTask recorded with NO meshes draws the
 *     whole scene, so the gates hold off until something is enrolled.
 */

type Opaque = object;
/** The slice of @babylonjs/lite this layer calls (index.d.ts, 1.8.0). */
export interface LiteGlowTexture { texture: { destroy(): void } }
export interface LiteGlowTask {
  readonly name: string;
  readonly engine: Opaque;
  readonly scene?: Opaque;
  record(): void;
  execute?(): number;
  dispose(): void;
}
export interface LiteGlowRenderTask extends LiteGlowTask {
  addMesh(mesh: LiteGlowMesh, opts?: { material?: LiteGlowMaterial }): void;
  // Internal (Lite 1.8 render-task.js), spliced to take a mesh out.
  _renderables?: { mesh?: unknown }[];
  _opaqueBindings?: { renderable: { mesh?: unknown } }[];
  _directBindings?: { renderable: { mesh?: unknown } }[];
  _transparentBindings?: { renderable: { mesh?: unknown } }[];
  _opaqueBundles?: unknown[];
  _lastVersion?: number;
}
export interface LiteGlowMaterial {
  _buildGroup?: { _materialFamily?: string; _rebuildSingle?: unknown } | null;
  emissiveColor?: [number, number, number] | null;
  emissiveTexture?: unknown;
  disableLighting?: boolean;
  diffuseColor?: [number, number, number];
  specularColor?: [number, number, number];
}
export interface LiteGlowMesh {
  material?: LiteGlowMaterial | null;
  parent?: unknown;
}
export interface LiteGlowScene {
  meshes: ReadonlyArray<LiteGlowMesh>;
  surface: { canvas: { width: number; height: number }; scRT: Opaque };
  _meshDisposables?: Map<unknown, unknown>;
}
export interface LiteGlowModule {
  createRenderTargetTexture(engine: Opaque, d: {
    lbl?: string; format?: string; dFormat?: string; samples: number; size: { width: number; height: number };
  }): { rt: Opaque; texture: LiteGlowTexture };
  createRenderTask(config: {
    name: string; rt: Opaque; clr?: boolean; clrColor?: { r: number; g: number; b: number; a: number };
  }, engine: Opaque, scene: Opaque): LiteGlowRenderTask;
  createStandardMaterial(): LiteGlowMaterial;
  markMaterialUboDirty(material: LiteGlowMaterial): void;
  createEffectWrapper(engine: Opaque, options: {
    name?: string;
    fragmentWGSL: string;
    bindings?: { name?: string; binding: number; kind: 'uniform' | 'texture' | 'sampler'; uniformByteLength?: number; textureSampleType?: string; samplerType?: string; textureBinding?: string | number }[];
    blend?: object;
  }): Opaque;
  disposeEffectWrapper(wrapper: Opaque): void;
  setEffectTexture(wrapper: Opaque, binding: string | number, texture: LiteGlowTexture): void;
  setEffectUniforms(wrapper: Opaque, data: ArrayBufferView): void;
  createEffectRenderTask(config: { name: string; effect: Opaque; target: Opaque; clear?: boolean }, engine: Opaque, scene?: Opaque): LiteGlowTask;
  addTask(target: Opaque, task: LiteGlowTask): void;
}

/** What the layer is told, in the adapter's GlowSpec terms. */
export interface LiteGlowSettings {
  intensity: number;
  textureRatio?: number;
  blurKernelSize?: number;
}

/** Uniform block, bytes: dir, srcTexel, outSize, radius, gain. */
export const GLOW_UNIFORM_BYTES = 32;
/** Hard cap on the blur loop (taps each side). */
export const MAX_GLOW_TAPS = 32;

type Size = { width: number; height: number };

/** Pack the uniform block every effect reads. Pure, for tests. */
export function packGlowUniforms(
  dir: [number, number],
  src: Size,
  out: Size,
  radius: number,
  gain: number,
  into = new Float32Array(GLOW_UNIFORM_BYTES / 4),
): Float32Array {
  into[0] = dir[0];
  into[1] = dir[1];
  into[2] = 1 / src.width;
  into[3] = 1 / src.height;
  into[4] = out.width;
  into[5] = out.height;
  into[6] = Math.max(0, Math.min(MAX_GLOW_TAPS, radius));
  into[7] = gain;
  return into;
}

/** Babylon's glow half-width in texels for a `blurKernelSize`: kernel/2 taps across. */
export function glowBlurRadius(blurKernelSize: number): number {
  return Math.max(0, (blurKernelSize / 2 - 1) / 2);
}
/** What the merge multiplies the summed blurs by: ALPHA_ADD over the neutral alpha. */
export function glowGain(intensity: number): number {
  return 2 * intensity * intensity;
}

const PARAMS_WGSL = /* wgsl */ `
struct GlowParams { dir: vec2<f32>, srcTexel: vec2<f32>, outSize: vec2<f32>, radius: f32, gain: f32 };
@group(0) @binding(0) var<uniform> P: GlowParams;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var srcSampler: sampler;
`;

/** One direction of Babylon's kernel blur. */
export const GLOW_BLUR_WGSL = PARAMS_WGSL + /* wgsl */ `
@fragment fn effectFragment(input: EffectVertexOutput) -> @location(0) vec4<f32> {
  let uv = input.position.xy / P.outSize;
  let r = P.radius;
  let sigma = max(r / 3.0, 0.25);
  var sum = textureSampleLevel(srcTex, srcSampler, uv, 0.0).rgb;
  var wsum = 1.0;
  for (var i = 1; i <= ${MAX_GLOW_TAPS}; i = i + 1) {
    let fi = f32(i);
    if (fi > r) { break; }
    let w = exp(-fi * fi / (2.0 * sigma * sigma));
    let o = P.dir * P.srcTexel * fi;
    sum = sum + (textureSampleLevel(srcTex, srcSampler, uv + o, 0.0).rgb + textureSampleLevel(srcTex, srcSampler, uv - o, 0.0).rgb) * w;
    wsum = wsum + 2.0 * w;
  }
  return vec4<f32>(sum / wsum, 1.0);
}
`;

/** Both blurs, summed, times the gain; the additive blend adds it to the frame. */
export const GLOW_MERGE_WGSL = PARAMS_WGSL + /* wgsl */ `
@group(0) @binding(3) var src2Tex: texture_2d<f32>;
@group(0) @binding(4) var src2Sampler: sampler;
@fragment fn effectFragment(input: EffectVertexOutput) -> @location(0) vec4<f32> {
  let uv = input.position.xy / P.outSize;
  let c = textureSampleLevel(srcTex, srcSampler, uv, 0.0).rgb + textureSampleLevel(src2Tex, src2Sampler, uv, 0.0).rgb;
  return vec4<f32>(max(c, vec3<f32>(0.0)) * P.gain, 0.0);
}
`;

/** dst + src, alpha left alone. */
const ADD_BLEND = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

type Kind = 'emissive' | 'own';
interface Entry {
  kind: Kind;
  /** The mesh's material when it was added (an 'own' entry draws it). */
  source: LiteGlowMaterial;
  /** The emissive stand-in. */
  stand?: LiteGlowMaterial;
  /** The emissive map the stand-in was built with (part of its pipeline). */
  map?: unknown;
  /** The stand-in renderable's disposers, run when it leaves. */
  disposers?: unknown;
}

interface Gate extends LiteGlowTask {
  on: boolean;
  retired: boolean;
  _passes: unknown[];
}
function gate(inner: LiteGlowTask, ready: () => boolean): Gate {
  let recorded = false;
  const g: Gate = {
    name: `${inner.name}-gate`,
    engine: inner.engine,
    scene: inner.scene,
    on: false,
    retired: false,
    _passes: [],
    record(): void {
      // A frame-graph rebuild re-records every task; ours record on first use.
      recorded = false;
    },
    execute(): number {
      if (!g.on || g.retired || !ready()) return 0;
      if (!recorded) {
        inner.record();
        recorded = true;
      }
      return inner.execute ? inner.execute() : 0;
    },
    dispose(): void {
      inner.dispose();
    },
  };
  return g;
}

interface Pass {
  wrapper: Opaque;
  uniforms: Float32Array<ArrayBuffer>;
  dir: [number, number];
  src: Size;
  out: Size;
}
interface GlowSet {
  size: Size;
  ratio: number;
  task: LiteGlowRenderTask;
  gates: Gate[];
  textures: LiteGlowTexture[];
  blurs: Pass[];
  merge: Pass;
  entries: Map<LiteGlowMesh, Entry>;
}

const half = (s: Size): Size => ({ width: Math.max(1, Math.floor(s.width / 2)), height: Math.max(1, Math.floor(s.height / 2)) });
const lit = (m: LiteGlowMaterial): boolean => {
  const f = m._buildGroup?._materialFamily;
  return f === 'standard' || f === 'pbr';
};

/**
 * The layer. One per adapter; `sync()` once a frame, before the frame graph
 * runs (the adapter's onBeforeRender hook).
 */
export class LiteGlowLayer {
  private settings: LiteGlowSettings | null = null;
  private set: GlowSet | null = null;
  /** Enrolled nodes; a node stands for its subtree. Value: draw its own material. */
  private readonly enrolled = new Map<unknown, boolean>();

  constructor(
    private readonly L: LiteGlowModule,
    private readonly engine: Opaque,
    private readonly scene: LiteGlowScene,
  ) {}

  /** Turn the layer on with these settings, or off (null), which also clears the enrolment. */
  setSettings(s: LiteGlowSettings | null): void {
    this.settings = s ? { ...s } : null;
    if (!s) {
      this.enrolled.clear();
      if (this.set) this.retire(this.set);
      this.set = null;
    }
  }

  /** Enrol a node (and its subtree). `ownMaterial` draws its own material, not its emissive. */
  include(node: unknown, ownMaterial = false): void {
    if (this.settings) this.enrolled.set(node, ownMaterial);
  }
  exclude(node: unknown): void {
    this.enrolled.delete(node);
  }
  /** True when `node` is enrolled, directly or through a parent. */
  isIncluded(node: unknown): boolean {
    return this.enrolment(node as LiteGlowMesh) !== undefined;
  }

  /** Once a frame: follow the canvas, the settings and the scene's meshes. */
  sync(): void {
    const s = this.settings;
    if (!s) return;
    const ratio = s.textureRatio ?? 0.5;
    const canvas = this.scene.surface.canvas;
    const size = {
      width: Math.max(1, Math.round(canvas.width * ratio)),
      height: Math.max(1, Math.round(canvas.height * ratio)),
    };
    if (this.set && (this.set.ratio !== ratio || this.set.size.width !== size.width || this.set.size.height !== size.height)) {
      this.retire(this.set);
      this.set = null;
    }
    this.set ??= this.build(size, ratio);
    const set = this.set;
    this.syncMeshes(set);
    const radius = glowBlurRadius(s.blurKernelSize ?? 32);
    for (const p of set.blurs) this.write(p, radius, 0);
    this.write(set.merge, 0, glowGain(s.intensity));
    for (const g of set.gates) g.on = true;
  }

  /** Put the layer down for good (the adapter's dispose). */
  dispose(): void {
    this.setSettings(null);
  }

  private write(p: Pass, radius: number, gain: number): void {
    packGlowUniforms(p.dir, p.src, p.out, radius, gain, p.uniforms);
    this.L.setEffectUniforms(p.wrapper, p.uniforms);
  }

  private enrolment(mesh: LiteGlowMesh): boolean | undefined {
    let n: unknown = mesh;
    for (let depth = 0; n && depth < 64; depth++) {
      const own = this.enrolled.get(n);
      if (own !== undefined) return own;
      n = (n as LiteGlowMesh).parent;
    }
    return undefined;
  }

  private build(size: Size, ratio: number): GlowSet {
    const L = this.L;
    const engine = this.engine;
    const scene = this.scene;
    const small = half(size);
    const target = (lbl: string, s: Size, depth = false) =>
      L.createRenderTargetTexture(engine, { lbl, format: 'rgba16float', ...(depth ? { dFormat: 'depth24plus' } : {}), samples: 1, size: s });
    const glow = target('glow', size, true);
    const t1h = target('glow-blur1-h', size);
    const t1 = target('glow-blur1', size);
    const t2h = target('glow-blur2-h', small);
    const t2 = target('glow-blur2', small);
    // Babylon's neutral colour: black, alpha 1 (the alpha is in the gain).
    const task = L.createRenderTask({ name: 'glow', rt: glow.rt, clr: true, clrColor: { r: 0, g: 0, b: 0, a: 1 } }, engine, scene);
    const one = [
      { name: 'params', binding: 0, kind: 'uniform' as const, uniformByteLength: GLOW_UNIFORM_BYTES },
      { name: 'src', binding: 1, kind: 'texture' as const, textureSampleType: 'float' },
      { name: 'srcSampler', binding: 2, kind: 'sampler' as const, samplerType: 'filtering', textureBinding: 'src' },
    ];
    const two = [
      ...one,
      { name: 'src2', binding: 3, kind: 'texture' as const, textureSampleType: 'float' },
      { name: 'src2Sampler', binding: 4, kind: 'sampler' as const, samplerType: 'filtering', textureBinding: 'src2' },
    ];
    const pass = (name: string, from: { texture: LiteGlowTexture }, src: Size, to: { rt: Opaque }, out: Size, dir: [number, number]) => {
      const wrapper = L.createEffectWrapper(engine, { name, fragmentWGSL: GLOW_BLUR_WGSL, bindings: one });
      L.setEffectTexture(wrapper, 'src', from.texture);
      const fx = L.createEffectRenderTask({ name, effect: wrapper, target: to.rt, clear: true }, engine, scene);
      return { p: { wrapper, uniforms: new Float32Array(GLOW_UNIFORM_BYTES / 4), dir, src, out }, fx };
    };
    // Blur 2 reads blur 1, at half its size, with the same kernel — as Babylon chains them.
    const b = [
      pass('glow-blur1-h', glow, size, t1h, size, [1, 0]),
      pass('glow-blur1-v', t1h, size, t1, size, [0, 1]),
      pass('glow-blur2-h', t1, size, t2h, small, [1, 0]),
      pass('glow-blur2-v', t2h, small, t2, small, [0, 1]),
    ];
    const mergeFx = L.createEffectWrapper(engine, { name: 'glow-merge', fragmentWGSL: GLOW_MERGE_WGSL, bindings: two, blend: ADD_BLEND });
    L.setEffectTexture(mergeFx, 'src', t1.texture);
    L.setEffectTexture(mergeFx, 'src2', t2.texture);
    const mergeTask = L.createEffectRenderTask({ name: 'glow-merge', effect: mergeFx, target: scene.surface.scRT, clear: false }, engine, scene);
    const next: GlowSet = {
      size,
      ratio,
      task,
      gates: [],
      textures: [glow.texture, t1h.texture, t1.texture, t2h.texture, t2.texture],
      blurs: b.map((x) => x.p),
      merge: { wrapper: mergeFx, uniforms: new Float32Array(GLOW_UNIFORM_BYTES / 4), dir: [0, 0], src: size, out: scene.surface.canvas },
      entries: new Map(),
    };
    const ready = (): boolean => next.entries.size > 0;
    next.gates = [task, ...b.map((x) => x.fx), mergeTask].map((t) => gate(t, ready));
    for (const g of next.gates) L.addTask(scene, g);
    return next;
  }

  private retire(s: GlowSet): void {
    for (const g of s.gates) {
      g.on = false;
      g.retired = true;
    }
    for (const [mesh, e] of s.entries) this.drop(s, mesh, e);
    s.entries.clear();
    for (const t of s.textures) t.texture.destroy();
    for (const p of [...s.blurs, s.merge]) this.L.disposeEffectWrapper(p.wrapper);
  }

  /** What an enrolled `mesh` draws in the glow buffer, or null for nothing. */
  private want(mesh: LiteGlowMesh): { kind: Kind; source: LiteGlowMaterial } | null {
    const source = mesh.material;
    if (!source) return null;
    const own = this.enrolment(mesh);
    if (own === undefined) return null;
    if (!own && lit(source)) return { kind: 'emissive', source };
    return typeof source._buildGroup?._rebuildSingle === 'function' ? { kind: 'own', source } : null;
  }

  private syncMeshes(set: GlowSet): void {
    const seen = new Set<LiteGlowMesh>();
    for (const mesh of this.scene.meshes) {
      seen.add(mesh);
      const want = this.want(mesh);
      const have = set.entries.get(mesh);
      const remap = have?.kind === 'emissive' && have.map !== (have.source.emissiveTexture ?? null);
      if (have && (remap || !want || want.kind !== have.kind || want.source !== have.source)) {
        this.drop(set, mesh, have);
        set.entries.delete(mesh);
      }
      if (!want) continue;
      const entry = set.entries.get(mesh) ?? this.add(set, mesh, want.kind, want.source);
      if (entry?.stand) this.copyEmissive(entry);
    }
    for (const [mesh, e] of set.entries) {
      if (seen.has(mesh)) continue;
      this.drop(set, mesh, e);
      set.entries.delete(mesh);
    }
  }

  private add(set: GlowSet, mesh: LiteGlowMesh, kind: Kind, source: LiteGlowMaterial): Entry | undefined {
    const map = source.emissiveTexture ?? null;
    const stand = kind === 'emissive' ? this.emissiveStandIn(map) : undefined;
    const material = stand ?? source;
    // The family's builder must exist (Lite makes it with the first mesh of a family).
    if (typeof material._buildGroup?._rebuildSingle !== 'function') return undefined;
    const entry: Entry = { kind, source, stand, map };
    if (stand) this.copyEmissive(entry);
    const store = this.scene._meshDisposables;
    const had = store?.has(mesh) ?? false;
    const theirs = store?.get(mesh);
    set.task.addMesh(mesh, { material });
    if (store) {
      const mine = store.get(mesh);
      if (mine !== theirs) entry.disposers = mine;
      if (had) store.set(mesh, theirs);
      else store.delete(mesh);
    }
    set.entries.set(mesh, entry);
    return entry;
  }

  private drop(set: GlowSet, mesh: LiteGlowMesh, e: Entry): void {
    const t = set.task;
    if (Array.isArray(t._renderables)) {
      for (let i = t._renderables.length - 1; i >= 0; i--) if (t._renderables[i]!.mesh === mesh) t._renderables.splice(i, 1);
    }
    for (const arr of [t._opaqueBindings, t._directBindings, t._transparentBindings]) {
      if (!Array.isArray(arr)) continue;
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i]!.renderable.mesh === mesh) arr.splice(i, 1);
    }
    if (Array.isArray(t._opaqueBundles)) t._opaqueBundles.length = 0;
    t._lastVersion = -1;
    if (Array.isArray(e.disposers)) for (const fn of e.disposers) if (typeof fn === 'function') (fn as () => void)();
  }

  /** A fresh unlit Standard material whose colour is only the emissive (and its map). */
  private emissiveStandIn(map: unknown): LiteGlowMaterial {
    const m = this.L.createStandardMaterial();
    m.disableLighting = true;
    m.diffuseColor = [1, 1, 1];
    m.specularColor = [0, 0, 0];
    m.emissiveColor = [0, 0, 0];
    m.emissiveTexture = map;
    return m;
  }

  /** Follow the source's emissive colour on its stand-in (a new map is a new stand-in). */
  private copyEmissive(e: Entry): void {
    const stand = e.stand!;
    const src = e.source.emissiveColor ?? [0, 0, 0];
    const cur = stand.emissiveColor!;
    if (cur[0] === src[0] && cur[1] === src[1] && cur[2] === src[2]) return;
    stand.emissiveColor = [src[0], src[1], src[2]];
    this.L.markMaterialUboDirty(stand);
  }
}
