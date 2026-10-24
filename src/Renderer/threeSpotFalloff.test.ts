import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { matchBabylonSpotFalloff } from './ThreeAdapter';

describe("Three's spot falloff matches Babylon's PBR spot", () => {
  it("swaps the smoothstep for Babylon's Gaussian, once", () => {
    const T = { ShaderChunk: { lights_pars_begin: (THREE.ShaderChunk as unknown as Record<string, string>).lights_pars_begin } };
    expect(T.ShaderChunk.lights_pars_begin).toContain('return smoothstep( coneCosine, penumbraCosine, angleCosine );');
    expect(matchBabylonSpotFalloff(T)).toBe(true);
    const once = T.ShaderChunk.lights_pars_begin;
    expect(once).toContain('exp2( 6.64385618977');
    expect(once).not.toContain('return smoothstep( coneCosine');
    expect(matchBabylonSpotFalloff(T)).toBe(true);
    expect(T.ShaderChunk.lights_pars_begin).toBe(once);
  });

  it('says so when the chunk is not there', () => {
    expect(matchBabylonSpotFalloff({})).toBe(false);
    expect(matchBabylonSpotFalloff({ ShaderChunk: { lights_pars_begin: 'something else' } })).toBe(false);
  });

  it('the curve is full on the axis and 1% at the edge', () => {
    const cosHalf = Math.cos(0.8);
    const f = (cos: number) => 2 ** ((6.64385618977 / (1 - cosHalf)) * (cos - 1));
    expect(f(1)).toBe(1);
    expect(f(cosHalf)).toBeCloseTo(0.01, 6);
  });
});
