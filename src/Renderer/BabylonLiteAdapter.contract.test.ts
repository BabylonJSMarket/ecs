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
import { BabylonLiteAdapter } from './BabylonLiteAdapter';

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
});
