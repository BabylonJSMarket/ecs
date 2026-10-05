import { describe, expect, it } from 'vitest';
import { computeNormals, mirrorZ } from './meshGeometry';

// One triangle in the XZ plane, counter-clockwise seen from +Y.
const TRI = { positions: [0, 0, 0, 0, 0, 1, 1, 0, 0], indices: [0, 1, 2] };

describe('computeNormals', () => {
  it('a counter-clockwise triangle seen from +Y faces +Y', () => {
    const n = computeNormals(TRI.positions, TRI.indices);
    for (let k = 0; k < 9; k += 3) expect([n[k], n[k + 1], n[k + 2]]).toEqual([0, 1, 0]);
  });

  it('a shared vertex is smoothed across both faces', () => {
    // Two equal faces meeting at a 90° ridge along z: one facing +Y, one +X.
    const positions = [0, 0, 0, 0, 0, 1, -1, 0, 0, 0, -1, 0];
    const indices = [0, 1, 2, 0, 3, 1].reverse();
    const n = computeNormals(positions, indices);
    expect(n[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(n[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(n[2]).toBeCloseTo(0, 5);
  });
});

describe('mirrorZ', () => {
  it('negates z and keeps the indices: the mirror already makes them clockwise', () => {
    const m = mirrorZ(TRI);
    expect(Array.from(m.positions)).toEqual([0, 0, -0, 0, 0, -1, 1, 0, -0]);
    expect(Array.from(m.indices)).toEqual([0, 1, 2]);
    expect(m.normals[1]).toBe(1);
  });
});
