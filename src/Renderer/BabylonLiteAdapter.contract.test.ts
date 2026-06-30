/**
 * BabylonLiteAdapter is backed by @babylonjs/lite — a WebGPU-EXCLUSIVE engine.
 * Engine creation (`createEngine`) acquires a GPU device via `navigator.gpu`,
 * which jsdom does not provide, so the full RendererAdapter contract (which
 * creates meshes/cameras/lights through a live scene) CANNOT run headlessly here
 * — there is no NullEngine equivalent for Lite. Full conformance is verified by
 * browser/integration smoke instead.
 *
 * What we CAN assert in jsdom is everything that doesn't touch the GPU device:
 * the adapter's identity, that it's safe to construct and tear down before
 * init(), and that the documented sync stubs (picking, physics) behave.
 */

import { describe, it, expect } from 'vitest';
import type { CameraHandle, Quaternion, Vec3 } from './types';

// @babylonjs/lite is a WebGPU-only preview engine: its bundle reads the
// `GPUShaderStage` family of globals at MODULE-INIT (not just at device
// acquisition), so a static `import … from './BabylonLiteAdapter'` would crash
// jsdom before any test runs. Define the inert constants here — BEFORE the
// dynamic import below — so the pre-device subset can LOAD headlessly. This is
// the WebGPU analog of the WebGL shim Three needs under jsdom; it does NOT
// fabricate a GPU device, so init()-driven conformance stays browser-only (see
// the file header) and the other adapters (which never read these) are unaffected.
const g = globalThis as Record<string, unknown>;
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
g.GPUBufferUsage ??= {};
g.GPUTextureUsage ??= {};
g.GPUMapMode ??= {};
g.GPUColorWrite ??= {};

const { BabylonLiteAdapter } = await import('./BabylonLiteAdapter');

describe('BabylonLiteAdapter (pre-device contract subset)', () => {
  it('reports the babylon-lite kind', () => {
    expect(new BabylonLiteAdapter().kind).toBe('babylon-lite');
  });

  it('getRenderingCanvas returns null before init', () => {
    expect(new BabylonLiteAdapter().getRenderingCanvas()).toBeNull();
  });

  it('dispose before init is idempotent — calling twice does not throw', () => {
    const adapter = new BabylonLiteAdapter();
    expect(() => {
      adapter.dispose();
      adapter.dispose();
    }).not.toThrow();
  });

  it('sync stubs are safe without a device', () => {
    const adapter = new BabylonLiteAdapter();
    expect(adapter.pickAtScreenPoint(0, 0)).toBeNull();
    expect(adapter.physicsGetBodyState('missing')).toBeNull();
    expect(() => adapter.physicsStep(1 / 60)).not.toThrow();
  });

  // ─── Phase-1 trio: the camera/projection/origin bookkeeping that does NOT
  // touch the GPU device, so it runs in the headless subset. (The perspective
  // camera CREATION + numeric projection need a live scene → browser-only.)

  it('floating-origin round-trips the recorded offset (Z-sign convention is self-consistent)', () => {
    const adapter = new BabylonLiteAdapter();
    const out: Vec3 = [0, 0, 0];
    // getOriginOffset writes into and returns the provided `out`.
    expect(adapter.getOriginOffset(out)).toBe(out);
    expect(out[0]).toBeCloseTo(0, 6); // default, dormant
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(0, 6);
    adapter.setOriginOffset(1000, -2000, 3000);
    adapter.getOriginOffset(out);
    expect(out[0]).toBeCloseTo(1000, 4);
    expect(out[1]).toBeCloseTo(-2000, 4);
    expect(out[2]).toBeCloseTo(3000, 4);
  });

  it('configureLargeWorld records config without throwing (no active rebase in Phase 1)', () => {
    const adapter = new BabylonLiteAdapter();
    expect(() => {
      adapter.configureLargeWorld({ enabled: true, farPlane: 200000 });
      adapter.configureLargeWorld({ enabled: false });
    }).not.toThrow();
  });

  it('worldToScreen returns false (no active perspective camera) without a device', () => {
    const adapter = new BabylonLiteAdapter();
    const out = { x: 123, y: 456 };
    expect(adapter.worldToScreen(0, 0, 10, out)).toBe(false);
    expect(out).toEqual({ x: 123, y: 456 }); // untouched on a miss
  });

  it('setCameraPose / getCameraPose are safe no-ops on an unknown handle', () => {
    const adapter = new BabylonLiteAdapter();
    const bogus = {} as unknown as CameraHandle;
    const q: Quaternion = { x: 0, y: 0.8660254, z: 0, w: 0.5 };
    const outPos: Vec3 = [9, 9, 9];
    const outQ: Quaternion = { x: 9, y: 9, z: 9, w: 9 };
    expect(() => {
      adapter.setCameraPose(bogus, [1, 2, 3], q);
      adapter.getCameraPose(bogus, outPos, outQ); // unknown handle → leaves outs untouched
    }).not.toThrow();
    expect(outPos).toEqual([9, 9, 9]);
  });
});
