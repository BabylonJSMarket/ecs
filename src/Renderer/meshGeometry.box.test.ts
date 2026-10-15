import { describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three';
import { boxUvsLikeThree } from './meshGeometry';

describe('boxUvsLikeThree', () => {
  it("reproduces Three's BoxGeometry UVs for every vertex of every face", () => {
    const [w, h, d] = [0.78, 0.03, 2.7];
    const g = new BoxGeometry(w, h, d);
    const pos = g.getAttribute('position').array;
    const nor = g.getAttribute('normal').array;
    const want = g.getAttribute('uv').array;
    const got = boxUvsLikeThree(pos, nor, w, h, d);
    expect(got.length).toBe(want.length);
    for (let i = 0; i < got.length; i++) expect(got[i]).toBeCloseTo(want[i]!, 6);
  });

  it('runs a long slab top face along its length in v (a lane repeats down the lane)', () => {
    // Top face corners at z = -d/2 and +d/2: v spans the whole 0..1.
    const uv = boxUvsLikeThree([0, 0.5, -1.35, 0, 0.5, 1.35], [0, 1, 0, 0, 1, 0], 0.78, 1, 2.7);
    expect(Math.abs(uv[1]! - uv[3]!)).toBeCloseTo(1, 9);
    expect(uv[0]).toBeCloseTo(uv[2]!, 9);
  });
});
