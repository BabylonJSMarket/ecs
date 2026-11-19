import { describe, it, expect, vi } from 'vitest';
import {
  LiteGlowLayer,
  packGlowUniforms,
  glowBlurRadius,
  glowGain,
  GLOW_BLUR_WGSL,
  GLOW_MERGE_WGSL,
  MAX_GLOW_TAPS,
  type LiteGlowMaterial,
  type LiteGlowMesh,
  type LiteGlowRenderTask,
  type LiteGlowModule,
  type LiteGlowScene,
  type LiteGlowTask,
} from './liteGlowLayer';

const STD = { _materialFamily: 'standard', _rebuildSingle: () => ({}) };
const PBR = { _materialFamily: 'pbr', _rebuildSingle: () => ({}) };
/** A PBR source: Lite 1.34+ keeps its emissive off the public fields. */
type PbrGlowMaterial = LiteGlowMaterial & { _emissiveColor?: [number, number, number] };
const SHADER = { _materialFamily: 'shader', _rebuildSingle: () => ({}) };

/** A recording stand-in for the slice of Lite the layer drives. */
function harness() {
  const tasks: LiteGlowTask[] = [];
  const renderTasks: (LiteGlowRenderTask & { added: { mesh: LiteGlowMesh; material?: LiteGlowMaterial }[] })[] = [];
  const destroyed: string[] = [];
  const disposed: object[] = [];
  const uniforms: { wrapper: object; data: Float32Array }[] = [];
  const dirty: LiteGlowMaterial[] = [];
  const records: string[] = [];
  const scene: LiteGlowScene & { meshes: LiteGlowMesh[] } = {
    meshes: [],
    surface: { canvas: { width: 960, height: 540 }, scRT: { swap: true } },
    _meshDisposables: new Map(),
  };
  const task = (name: string): LiteGlowTask => ({
    name,
    engine: {},
    scene,
    record: () => void records.push(name),
    execute: () => 1,
    dispose: vi.fn(),
  });
  const L: LiteGlowModule = {
    createRenderTargetTexture: (_e, d) => ({ rt: { lbl: d.lbl }, texture: { texture: { destroy: () => void destroyed.push(d.lbl!) } } }),
    createRenderTask: (config) => {
      const t = {
        ...task(config.name),
        added: [] as { mesh: LiteGlowMesh; material?: LiteGlowMaterial }[],
        _renderables: [] as { mesh?: unknown }[],
        _opaqueBindings: [] as { renderable: { mesh?: unknown } }[],
        _directBindings: [] as { renderable: { mesh?: unknown } }[],
        _transparentBindings: [] as { renderable: { mesh?: unknown } }[],
        _opaqueBundles: [{}] as unknown[],
        _lastVersion: 3,
        addMesh(mesh: LiteGlowMesh, opts?: { material?: LiteGlowMaterial }) {
          t.added.push({ mesh, material: opts?.material });
          t._renderables?.push({ mesh });
          t._opaqueBindings?.push({ renderable: { mesh } });
          // Lite files the override's disposers under the mesh.
          scene._meshDisposables?.set(mesh, [vi.fn()]);
        },
      };
      renderTasks.push(t);
      return t;
    },
    createStandardMaterial: () => ({ _buildGroup: STD, emissiveColor: [0, 0, 0] }),
    addMeshToTask: (task: LiteGlowRenderTask, mesh: LiteGlowMesh, opts?: { material?: LiteGlowMaterial }) => task.addMesh!(mesh, opts),
    // As Lite does it: a PBR material's emissive lives on a private field.
    getPbrEmissiveColor: (m) => (m as PbrGlowMaterial)._emissiveColor,
    markMaterialUboDirty: (m) => void dirty.push(m),
    createEffectWrapper: (_e, o) => ({ fx: o.name, blend: o.blend }),
    disposeEffectWrapper: (w) => void disposed.push(w),
    setEffectTexture: () => {},
    setEffectUniforms: (wrapper, data) => void uniforms.push({ wrapper, data: data as Float32Array }),
    createEffectRenderTask: (config) => task(config.name),
    addTask: (_s, t) => void tasks.push(t),
  };
  const layer = new LiteGlowLayer(L, {}, scene);
  const run = () => tasks.reduce((n, t) => n + (t.execute?.() ?? 0), 0);
  return { L, scene, layer, tasks, renderTasks, destroyed, disposed, uniforms, dirty, records, run };
}

describe('liteGlowLayer pure parts', () => {
  it('packs the uniform block and caps the radius', () => {
    const u = packGlowUniforms([1, 0], { width: 200, height: 100 }, { width: 50, height: 25 }, 999, 0.5);
    [1, 0, 1 / 200, 1 / 100, 50, 25, MAX_GLOW_TAPS, 0.5].forEach((v, i) => expect(u[i]).toBeCloseTo(v, 6));
    expect(packGlowUniforms([0, 1], { width: 1, height: 1 }, { width: 1, height: 1 }, -3, 1)[6]).toBe(0);
  });

  it("matches Babylon's kernel and ALPHA_ADD gain", () => {
    expect(glowBlurRadius(32)).toBe(7.5);
    expect(glowBlurRadius(0)).toBe(0);
    expect(glowGain(0.5)).toBe(0.5);
    expect(GLOW_BLUR_WGSL).toContain('effectFragment');
    expect(GLOW_MERGE_WGSL).toContain('src2Tex');
  });
});

describe('LiteGlowLayer', () => {
  it('does nothing until it has settings; include is ignored while off', () => {
    const h = harness();
    const m: LiteGlowMesh = { material: { _buildGroup: STD } };
    h.layer.include(m);
    h.layer.sync();
    expect(h.tasks).toHaveLength(0);
    expect(h.layer.isIncluded(m)).toBe(false);
  });

  it('builds six gated tasks; they stay idle with nothing enrolled', () => {
    const h = harness();
    h.layer.setSettings({ intensity: 0.5 });
    h.scene.meshes.push({ material: { _buildGroup: STD } });
    h.layer.sync();
    expect(h.tasks.map((t) => t.name)).toEqual([
      'glow-gate', 'glow-blur1-h-gate', 'glow-blur1-v-gate', 'glow-blur2-h-gate', 'glow-blur2-v-gate', 'glow-merge-gate',
    ]);
    // Not enrolled → not drawn (Babylon's include-only early-out), no occluders.
    expect(h.renderTasks[0]!.added).toHaveLength(0);
    expect(h.run()).toBe(0);
    expect(h.records).toHaveLength(0);
  });

  it('enrols through task.addMesh on a Lite without addMeshToTask', () => {
    const h = harness();
    delete (h.L as Partial<LiteGlowModule>).addMeshToTask;
    h.layer.setSettings({ intensity: 0.5, blurKernelSize: 16 });
    const mesh: LiteGlowMesh = { material: { _buildGroup: PBR, _emissiveColor: [1, 1, 1] } as PbrGlowMaterial };
    h.scene.meshes.push(mesh);
    h.layer.include(mesh);
    h.layer.sync();
    expect(h.renderTasks[0]!.added).toHaveLength(1);
  });

  it('an enrolled lit mesh draws an emissive stand-in that follows its source', () => {
    const h = harness();
    h.layer.setSettings({ intensity: 0.5, blurKernelSize: 16 });
    const src: PbrGlowMaterial = { _buildGroup: PBR, _emissiveColor: [2, 0.5, 0] };
    const mesh: LiteGlowMesh = { material: src };
    const theirs = [vi.fn()];
    h.scene._meshDisposables!.set(mesh, theirs);
    h.scene.meshes.push(mesh, { material: null });
    h.layer.include(mesh);
    h.layer.sync();
    const rt = h.renderTasks[0]!;
    expect(rt.added).toHaveLength(1);
    const stand = rt.added[0]!.material!;
    expect(stand).not.toBe(src);
    expect(stand).toMatchObject({ disableLighting: true, emissiveColor: [2, 0.5, 0], emissiveTexture: null });
    // The scene pass keeps its own disposers.
    expect(h.scene._meshDisposables!.get(mesh)).toBe(theirs);
    // Runs, recording each task once.
    expect(h.run()).toBe(6);
    h.run();
    expect(h.records).toHaveLength(6);
    // Blur radius and merge gain land in the uniforms.
    const last = h.uniforms.slice(-5);
    expect(last[0]!.data[6]).toBe(glowBlurRadius(16));
    expect(last[4]!.data[7]).toBe(glowGain(0.5));
    // The source's emissive changes → the stand-in follows, once.
    src._emissiveColor = [1, 1, 1];
    h.layer.sync();
    h.layer.sync();
    expect(stand.emissiveColor).toEqual([1, 1, 1]);
    expect(h.dirty.filter((m) => m === stand)).toHaveLength(2);
    expect(rt.added).toHaveLength(1);
  });

  it('a subtree joins through its root; own material when asked, or when it is not lit', () => {
    const h = harness();
    h.layer.setSettings({ intensity: 1 });
    const root = {};
    const child: LiteGlowMesh = { material: { _buildGroup: STD }, parent: root };
    const shader: LiteGlowMesh = { material: { _buildGroup: SHADER } };
    const ownPbr: LiteGlowMesh = { material: { _buildGroup: PBR } };
    const noBuild: LiteGlowMesh = { material: { _buildGroup: { _materialFamily: 'shader' } } };
    h.scene.meshes.push(child, shader, ownPbr, noBuild);
    h.layer.include(root);
    h.layer.include(shader);
    h.layer.include(ownPbr, true);
    h.layer.include(noBuild);
    h.layer.sync();
    const added = h.renderTasks[0]!.added;
    expect(added.map((a) => a.mesh)).toEqual([child, shader, ownPbr]);
    expect(added[1]!.material).toBe(shader.material);
    expect(added[2]!.material).toBe(ownPbr.material);
    expect(h.layer.isIncluded(child)).toBe(true);
  });

  it('a mesh that leaves, is excluded, changes material or map is taken out (and put back)', () => {
    const h = harness();
    h.layer.setSettings({ intensity: 1 });
    const a: LiteGlowMesh = { material: { _buildGroup: STD, emissiveColor: [1, 0, 0] } };
    const b: LiteGlowMesh = { material: { _buildGroup: STD } };
    h.scene.meshes.push(a, b);
    h.layer.include(a);
    h.layer.include(b);
    h.layer.sync();
    const rt = h.renderTasks[0]!;
    expect(rt._renderables).toHaveLength(2);
    // b leaves the scene: its renderable and bindings go, its disposers run.
    const bDisposers = h.scene._meshDisposables!.get(b);
    expect(bDisposers).toBeUndefined(); // it had none of its own: the override's were lifted
    h.scene.meshes.splice(1, 1);
    h.layer.sync();
    expect(rt._renderables!.map((r) => r.mesh)).toEqual([a]);
    expect(rt._opaqueBindings!.map((r) => r.renderable.mesh)).toEqual([a]);
    expect(rt._opaqueBundles).toHaveLength(0);
    expect(rt._lastVersion).toBe(-1);
    // a's map changes → a new stand-in.
    a.material!.emissiveTexture = { tex: 1 };
    h.layer.sync();
    expect(rt.added).toHaveLength(3);
    expect(rt.added[2]!.material!.emissiveTexture).toEqual({ tex: 1 });
    // a's material changes → re-added.
    a.material = { _buildGroup: STD };
    h.layer.sync();
    expect(rt.added).toHaveLength(4);
    // excluded → gone.
    h.layer.exclude(a);
    h.layer.sync();
    expect(rt._renderables).toHaveLength(0);
    expect(h.run()).toBe(0);
  });

  it('waits a frame when the stand-in family has no builder yet', () => {
    const h = harness();
    h.L.createStandardMaterial = () => ({ _buildGroup: { _materialFamily: 'standard' }, emissiveColor: [0, 0, 0] });
    h.layer.setSettings({ intensity: 1 });
    const m: LiteGlowMesh = { material: { _buildGroup: PBR } };
    h.scene.meshes.push(m);
    h.layer.include(m);
    h.layer.sync();
    expect(h.renderTasks[0]!.added).toHaveLength(0);
  });

  it('a resize or a new ratio retires the set and builds another; off retires and clears', () => {
    const h = harness();
    h.layer.setSettings({ intensity: 1 });
    const m: LiteGlowMesh = { material: { _buildGroup: STD } };
    h.scene.meshes.push(m);
    h.layer.include(m);
    h.layer.sync();
    h.run();
    h.scene.surface.canvas.width = 800;
    h.layer.sync();
    expect(h.tasks).toHaveLength(12);
    expect(h.destroyed).toHaveLength(5);
    expect(h.disposed).toHaveLength(5);
    expect(h.tasks[0]!.execute!()).toBe(0); // retired
    h.layer.setSettings({ intensity: 1, textureRatio: 0.25 });
    h.layer.sync();
    expect(h.tasks).toHaveLength(18);
    // A frame-graph rebuild re-records on next use.
    const g = h.tasks[12]!;
    g.record();
    g.execute!();
    expect(h.records.filter((r) => r === 'glow').length).toBeGreaterThanOrEqual(2);
    h.layer.dispose();
    expect(h.layer.isIncluded(m)).toBe(false);
    expect(h.run()).toBe(0);
    g.dispose();
    expect(h.tasks.length).toBe(18);
    h.layer.sync(); // off: nothing
    expect(h.tasks.length).toBe(18);
  });

  it('tolerates a task without the internal lists, a task without execute, and no disposables map', () => {
    const h = harness();
    delete h.scene._meshDisposables;
    const make = h.L.createRenderTask;
    h.L.createRenderTask = (c, e, s) => {
      const t = make(c, e, s);
      delete t._renderables;
      delete t._opaqueBindings;
      delete t._opaqueBundles;
      delete (t as { execute?: unknown }).execute;
      return t;
    };
    h.layer.setSettings({ intensity: 1 });
    const m: LiteGlowMesh = { material: { _buildGroup: STD } };
    h.scene.meshes.push(m);
    h.layer.include(m);
    h.layer.sync();
    expect(h.tasks[0]!.execute!()).toBe(0);
    h.layer.exclude(m);
    expect(() => h.layer.sync()).not.toThrow();
  });

  it('lifts the stand-in disposers off the mesh and runs them when it leaves', () => {
    const h = harness();
    h.layer.setSettings({ intensity: 1 });
    const m: LiteGlowMesh = { material: { _buildGroup: STD } };
    h.scene.meshes.push(m);
    h.layer.include(m);
    let mine: (() => void)[] | undefined;
    const set = h.scene._meshDisposables!.set.bind(h.scene._meshDisposables!);
    h.scene._meshDisposables!.set = (k, v) => {
      mine ??= v as (() => void)[];
      return set(k, v);
    };
    h.layer.sync();
    // The fake filed [vi.fn()] under the mesh; the layer lifted it off.
    expect(h.scene._meshDisposables!.has(m)).toBe(false);
    h.layer.exclude(m);
    h.layer.sync();
    expect(h.renderTasks[0]!._renderables).toHaveLength(0);
    expect(mine![0]).toHaveBeenCalledTimes(1);
  });
});
