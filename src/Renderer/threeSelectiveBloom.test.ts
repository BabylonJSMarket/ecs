import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createSelectiveBloomPass, GLOW_LAYER_INDEX, type UnrealBloomLike } from './threeSelectiveBloom';
import { LITE_ENVIRONMENT_BRDF_URL } from './liteEnvironmentBrdf';

class FakeBloom implements UnrealBloomLike {
  enabled = true;
  renderToScreen = false;
  renderTargetsHorizontal = [new THREE.WebGLRenderTarget(1, 1)];
  render = vi.fn();
  setSize = vi.fn();
  dispose = vi.fn();
  constructor(_res: THREE.Vector2, public strength: number, public radius: number, public threshold: number) {}
}

function fakeRenderer() {
  const calls: string[] = [];
  const state = { autoClear: true, shadowAuto: true };
  const r = {
    get autoClear() { return state.autoClear; },
    set autoClear(v: boolean) { state.autoClear = v; },
    shadowMap: { autoUpdate: true },
    getClearColor: (c: THREE.Color) => c.setRGB(0.2, 0.2, 0.3),
    getClearAlpha: () => 1,
    setClearColor: vi.fn(),
    setRenderTarget: vi.fn((t: unknown) => calls.push(t === null ? 'screen' : 'target')),
    clear: vi.fn(),
    render: vi.fn((s: THREE.Object3D): void => void calls.push(s.type)),
  };
  return { r, calls };
}

const make = () => {
  const scene = new THREE.Scene();
  const pass = createSelectiveBloomPass(THREE, FakeBloom, scene, { x: 0, y: 4 }, 0.4, 0);
  return { scene, pass };
};

describe('SelectiveBloomPass', () => {
  it('forwards strength, radius and threshold to the blur', () => {
    const { pass } = make();
    expect([pass.strength, pass.radius, pass.threshold]).toEqual([0.4, 0, 0]);
    pass.strength = 1;
    pass.radius = 0.5;
    pass.threshold = 0.2;
    expect([pass.strength, pass.radius, pass.threshold]).toEqual([1, 0.5, 0.2]);
  });

  it('draws nothing without a camera', () => {
    const { pass } = make();
    const { r } = fakeRenderer();
    pass.render(r as never, new THREE.WebGLRenderTarget(1, 1), new THREE.WebGLRenderTarget(1, 1));
    expect(r.render).not.toHaveBeenCalled();
  });

  it('renders the glow buffer, then adds the blur, and puts the renderer state back', () => {
    const { scene, pass } = make();
    const bg = new THREE.Color(1, 0, 0);
    scene.background = bg;
    const wallMat = new THREE.MeshPhongMaterial();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(), wallMat);
    scene.add(wall);
    pass.camera = new THREE.PerspectiveCamera();
    const { r, calls } = fakeRenderer();
    let bgDuring: unknown = 'unset';
    r.render.mockImplementationOnce((s: THREE.Object3D) => {
      bgDuring = (s as THREE.Scene).background;
      calls.push(s.type);
    });
    pass.render(r as never, new THREE.WebGLRenderTarget(1, 1), new THREE.WebGLRenderTarget(1, 1));
    expect(bgDuring).toBeNull();
    expect(scene.background).toBe(bg);
    expect(wall.material).toBe(wallMat);
    expect(r.shadowMap.autoUpdate).toBe(true);
    expect(r.autoClear).toBe(true);
    expect(calls).toEqual(['target', 'Scene', 'target', 'Mesh', 'target']);

    pass.renderToScreen = true;
    calls.length = 0;
    pass.render(r as never, new THREE.WebGLRenderTarget(1, 1), new THREE.WebGLRenderTarget(1, 1));
    expect(calls).toContain('screen');
  });

  it('carries an emissive map and skips empty or multi-material enrolled meshes', () => {
    const { scene, pass } = make();
    const map = new THREE.Texture();
    const lit = new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveMap: map });
    const glowing = new THREE.Mesh(new THREE.BoxGeometry(), lit);
    const multi = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
    const empty = new THREE.Mesh(new THREE.BoxGeometry(), [] as unknown as THREE.Material);
    for (const m of [glowing, multi, empty]) m.layers.enable(GLOW_LAYER_INDEX);
    scene.add(glowing, multi, empty);
    pass.prepareScene();
    expect((glowing.material as unknown as THREE.MeshBasicMaterial).map).toBe(map);
    expect(Array.isArray(multi.material)).toBe(true);
    pass.restoreScene();
    // Second frame reuses the same stand-in.
    lit.emissiveIntensity = undefined as unknown as number;
    pass.prepareScene();
    expect((glowing.material as unknown as THREE.MeshBasicMaterial).map).toBe(map);
    pass.restoreScene();
    expect(glowing.material).toBe(lit);
  });

  it('resizes and disposes the blur', () => {
    const { pass } = make();
    pass.setSize(0, 10);
    pass.dispose();
    const bloom = (pass as unknown as { bloom: FakeBloom }).bloom;
    expect(bloom.setSize).toHaveBeenCalledWith(0, 10);
    expect(bloom.dispose).toHaveBeenCalled();
  });
});

describe('LITE_ENVIRONMENT_BRDF_URL', () => {
  it('is a PNG data URL', () => {
    expect(LITE_ENVIRONMENT_BRDF_URL.startsWith('data:image/png;base64,')).toBe(true);
  });
});
