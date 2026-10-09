/**
 * Selective bloom for ThreeAdapter: Babylon's GlowLayer, which is
 * INCLUDE-ONLY, on Three.
 *
 * ThreeAdapter used to stand one UnrealBloomPass over the whole frame with a
 * luminance threshold. That blooms whatever happens to be bright — a point
 * light's specular hotspot on a wall (NeonSign's example), every star of a
 * procedural sky (SpaceGolf) — none of which Babylon glows, because Babylon's
 * GlowLayer draws only the meshes enrolled with it (`addGlowMesh`, or a plugin's
 * `addIncludedOnlyMesh`). The meshes it should glow were already marked, on
 * {@link GLOW_LAYER_INDEX}; nothing read the mark.
 *
 * This pass reads it. Each frame it draws a glow buffer, as Babylon's GlowLayer
 * does its own:
 *   - an enrolled mesh draws what Babylon's layer would take from it — the
 *     EMISSIVE of a lit material (Standard / Phong / Lambert: emissive ×
 *     intensity, and the emissive map), or the material itself when it is
 *     unlit or custom (Basic, a plugin's ShaderMaterial);
 *   - every other opaque mesh draws black, so it still hides what is behind it;
 *   - every other transparent object, line, point cloud or sprite is hidden, so
 *     it neither glows nor blacks out a hole.
 * It then blurs that buffer with three's UnrealBloomPass (threshold 0: the
 * layer glows what is enrolled, however dim) and ADDS the blur to the frame.
 * The enrolled mesh itself is drawn by the scene pass as usual.
 *
 * Plain object rather than a three `Pass` subclass: three is loaded through a
 * non-literal specifier (see ThreeAdapter.init), so nothing here may extend a
 * three class at module load. EffectComposer only needs the duck-typed fields.
 */

import type * as THREE from 'three';

/** The layer ThreeAdapter's addGlowMesh enables (and plugins enable by hand). */
export const GLOW_LAYER_INDEX = 1;

/** The UnrealBloomPass fields this pass drives (three/addons r184). */
export interface UnrealBloomLike {
  strength: number;
  radius: number;
  threshold: number;
  enabled: boolean;
  renderToScreen: boolean;
  renderTargetsHorizontal: THREE.WebGLRenderTarget[];
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget | null, readBuffer: THREE.WebGLRenderTarget, dt?: number, mask?: boolean): void;
  setSize(w: number, h: number): void;
  dispose(): void;
}
export type UnrealBloomCtor = new (res: THREE.Vector2, strength: number, radius: number, threshold: number) => UnrealBloomLike;

type LitWithEmissive = THREE.Material & {
  emissive: THREE.Color;
  emissiveIntensity?: number;
  emissiveMap?: THREE.Texture | null;
};
const hasEmissive = (m: THREE.Material): m is LitWithEmissive =>
  !!(m as Partial<LitWithEmissive>).emissive && (m as { isMeshBasicMaterial?: boolean }).isMeshBasicMaterial !== true;

/**
 * The pass. A plain class (it extends nothing of three's, which is loaded at
 * run time); EffectComposer duck-types it.
 */
export class SelectiveBloomPass {
  enabled = true;
  needsSwap = false;
  clear = false;
  renderToScreen = false;
  /** The camera the glow buffer is drawn through; ThreeAdapter re-points it every frame. */
  camera: THREE.Camera | null = null;

  private readonly glowRT: THREE.WebGLRenderTarget;
  private readonly bloom: UnrealBloomLike;
  private readonly layer: THREE.Layers;
  private readonly black: THREE.MeshBasicMaterial;
  /** One emissive-only stand-in per source material, refreshed each frame. */
  private readonly emissiveOnly = new WeakMap<THREE.Material, THREE.MeshBasicMaterial>();
  private readonly add: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly quadCam: THREE.OrthographicCamera;
  private readonly swapped: { o: THREE.Mesh; m: THREE.Material | THREE.Material[] }[] = [];
  private readonly hidden: THREE.Object3D[] = [];
  private readonly clearCol: THREE.Color;

  constructor(
    private readonly T: typeof THREE,
    Bloom: UnrealBloomCtor,
    private readonly scene: THREE.Scene,
    size: { x: number; y: number },
    strength: number,
    radius: number,
  ) {
    const w = Math.max(1, size.x);
    const h = Math.max(1, size.y);
    this.glowRT = new T.WebGLRenderTarget(w, h, { type: T.HalfFloatType });
    this.bloom = new Bloom(new T.Vector2(w, h), strength, radius, 0);
    this.layer = new T.Layers();
    this.layer.set(GLOW_LAYER_INDEX);
    this.black = new T.MeshBasicMaterial({ color: 0x000000 });
    // Additive copy of the blur onto the frame.
    this.add = new T.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }',
      blending: T.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new T.Mesh(new T.PlaneGeometry(2, 2), this.add);
    this.quad.frustumCulled = false;
    this.clearCol = new T.Color();
  }

  get strength(): number {
    return this.bloom.strength;
  }
  set strength(v: number) {
    this.bloom.strength = v;
  }
  get radius(): number {
    return this.bloom.radius;
  }
  set radius(v: number) {
    this.bloom.radius = v;
  }
  get threshold(): number {
    return this.bloom.threshold;
  }
  set threshold(v: number) {
    this.bloom.threshold = v;
  }

  private standInFor(m: LitWithEmissive): THREE.MeshBasicMaterial {
    let s = this.emissiveOnly.get(m);
    if (!s) {
      s = new this.T.MeshBasicMaterial();
      this.emissiveOnly.set(m, s);
    }
    s.color.copy(m.emissive).multiplyScalar(m.emissiveIntensity ?? 1);
    if (s.map !== (m.emissiveMap ?? null)) {
      s.map = m.emissiveMap ?? null;
      s.needsUpdate = true;
    }
    s.side = m.side;
    s.transparent = m.transparent;
    s.opacity = m.opacity;
    s.depthWrite = m.depthWrite;
    return s;
  }

  /**
   * Dress the scene for the glow buffer (see the header); {@link restoreScene}
   * undoes it. Public for its test: it is the whole include-only rule.
   */
  prepareScene(): void {
    this.scene.traverseVisible((o) => {
      const enrolled = o.layers.test(this.layer);
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const mats = mesh.material;
        const one = Array.isArray(mats) ? mats[0] : mats;
        if (!one) return;
        if (enrolled) {
          if (Array.isArray(mats)) return; // multi-material: draw as it is
          if (hasEmissive(one)) {
            this.swapped.push({ o: mesh, m: mats });
            mesh.material = this.standInFor(one);
          }
          return;
        }
        // Transparent, depth-less or custom-shaded (a billboard's shader places
        // its own vertices; black Basic would draw the quad somewhere else).
        if (one.transparent || one.depthWrite === false || (one as THREE.ShaderMaterial).isShaderMaterial) {
          this.hidden.push(o);
          return;
        }
        this.swapped.push({ o: mesh, m: mats });
        mesh.material = this.black;
        return;
      }
      const drawable = o as { isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
      if (!enrolled && (drawable.isLine || drawable.isPoints || drawable.isSprite)) this.hidden.push(o);
    });
    for (const o of this.hidden) o.visible = false;
  }

  restoreScene(): void {
    for (const { o, m } of this.swapped) o.material = m;
    for (const o of this.hidden) o.visible = true;
    this.swapped.length = 0;
    this.hidden.length = 0;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const camera = this.camera;
    if (!camera) return;
    const scene = this.scene;
    const background = scene.background;
    const autoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(this.clearCol);
    const clearAlpha = renderer.getClearAlpha();
    this.prepareScene();
    try {
      scene.background = null;
      renderer.shadowMap.autoUpdate = false; // the scene pass already drew them this frame
      renderer.autoClear = false;
      renderer.setRenderTarget(this.glowRT);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
    } finally {
      this.restoreScene();
      scene.background = background;
      renderer.shadowMap.autoUpdate = shadowAuto;
    }
    // The blur. UnrealBloomPass also adds it back onto glowRT, which is
    // scratch; the composite it leaves in renderTargetsHorizontal[0] is the
    // glow, and that is what goes on the frame.
    this.bloom.render(renderer, writeBuffer, this.glowRT);
    this.add.uniforms.tDiffuse!.value = this.bloom.renderTargetsHorizontal[0]!.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.render(this.quad, this.quadCam);
    // Put the clear back with a linear target current (see ThreeAdapter.renderComposer).
    renderer.setRenderTarget(readBuffer);
    renderer.setClearColor(this.clearCol, clearAlpha);
    renderer.autoClear = autoClear;
  }

  setSize(width: number, height: number): void {
    this.glowRT.setSize(Math.max(1, width), Math.max(1, height));
    this.bloom.setSize(width, height);
  }

  dispose(): void {
    this.glowRT.dispose();
    this.bloom.dispose();
    this.black.dispose();
    this.add.dispose();
    this.quad.geometry.dispose();
  }
}

export function createSelectiveBloomPass(
  T: typeof THREE,
  Bloom: UnrealBloomCtor,
  scene: THREE.Scene,
  size: { x: number; y: number },
  strength: number,
  radius: number,
): SelectiveBloomPass {
  return new SelectiveBloomPass(T, Bloom, scene, size, strength, radius);
}
