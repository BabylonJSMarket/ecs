/**
 * Unit tests for the renderer-free seeded-asteroid surface math. The engine
 * adapters (Babylon) exercise {@link asteroidShape} / {@link asteroidSurfacePosition}
 * when they tessellate a rock, but they NEVER feed the optional per-instance
 * ripple field (it's dormant in Phase-3), and the Mock adapter ships its own
 * displacement. So the ripple branch — and the pure clamp/hash helpers — are
 * only reachable by calling this module directly, which is what these do.
 */
import { describe, it, expect } from 'vitest';
import {
  asteroidShape,
  asteroidStretch,
  asteroidSurfacePosition,
  ASTEROID_RIPPLE_DURATION,
  asteroidMaxReach,
  asteroidReachExtents,
  clamp01,
  hash,
} from './proceduralRock';

describe('proceduralRock — seeded surface math', () => {
  describe('hash', () => {
    it('is deterministic and lands in [0, 1)', () => {
      for (let seed = 0; seed < 50; seed++) {
        for (let salt = 0; salt < 4; salt++) {
          const v = hash(seed, salt);
          expect(v).toBe(hash(seed, salt)); // same inputs → same output
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(1);
        }
      }
    });
  });

  describe('asteroidStretch', () => {
    it('returns three per-axis factors within [0.45, 1.85]', () => {
      const [sx, sy, sz] = asteroidStretch(7);
      for (const s of [sx, sy, sz]) {
        expect(s).toBeGreaterThanOrEqual(0.45);
        expect(s).toBeLessThanOrEqual(1.85);
      }
    });
  });

  describe('clamp01', () => {
    it('clamps below 0, above 1, and passes the in-range value through', () => {
      expect(clamp01(-2)).toBe(0); // v < 0 branch
      expect(clamp01(2)).toBe(1); // v > 1 branch
      expect(clamp01(0.3)).toBe(0.3); // in-range branch
      expect(clamp01(0)).toBe(0);
      expect(clamp01(1)).toBe(1);
    });
  });

  describe('asteroidShape', () => {
    it('copies an explicit cutAxis + cutDepth and stores the ripple buffer', () => {
      const ripples = new Float32Array([0, 0, 1, 0.5, 0.1]);
      const s = asteroidShape(3, [0, 1, 0], 0.4, ripples, 1);
      expect(s.cutAxis).toEqual([0, 1, 0]);
      expect(s.cutDepth).toBe(0.4);
      expect(s.ripples).toBe(ripples);
      expect(s.rippleCount).toBe(1);
    });

    it('defaults cutAxis to null and ripple fields to empty when omitted', () => {
      const s = asteroidShape(3);
      expect(s.cutAxis).toBeNull();
      expect(s.cutDepth).toBe(0);
      expect(s.ripples).toBeNull();
      expect(s.rippleCount).toBe(0);
    });
  });

  describe('asteroidSurfacePosition', () => {
    it('writes into and returns `out`, displacing onto a real radius', () => {
      const s = asteroidShape(9);
      const out: [number, number, number] = [0, 0, 0];
      const ret = asteroidSurfacePosition(s, 0.3, 0.5, 0.81, 100, out);
      expect(ret).toBe(out);
      expect(out.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...out)).toBeGreaterThan(0);
    });

    it('is byte-identical for the same seed + direction and diverges with the seed', () => {
      const a: [number, number, number] = [0, 0, 0];
      const b: [number, number, number] = [0, 0, 0];
      const c: [number, number, number] = [0, 0, 0];
      asteroidSurfacePosition(asteroidShape(9), 0.3, 0.5, 0.81, 100, a);
      asteroidSurfacePosition(asteroidShape(9), 0.3, 0.5, 0.81, 100, b);
      asteroidSurfacePosition(asteroidShape(99), 0.3, 0.5, 0.81, 100, c);
      expect(a).toEqual(b);
      expect(c).not.toEqual(a);
    });

    it('flattens the surface on the near side of a cut plane', () => {
      const dir: [number, number, number] = [0, 1, 0]; // straight along the cut axis
      const uncut: [number, number, number] = [0, 0, 0];
      const cut: [number, number, number] = [0, 0, 0];
      asteroidSurfacePosition(asteroidShape(5), dir[0], dir[1], dir[2], 100, uncut);
      asteroidSurfacePosition(asteroidShape(5, [0, 1, 0], 0.6), dir[0], dir[1], dir[2], 100, cut);
      // The cut pulls displacement toward `1 - cutDepth`, so the carved surface
      // sits nearer the core along the cut axis than the un-carved one.
      expect(Math.abs(cut[1])).toBeLessThan(Math.abs(uncut[1]));
    });

    it('applies active ripples — exercising skip/keep, the cos clamp, and the age decay window', () => {
      // Sample direction is +Z. Ripples (5 floats each: dirX,dirY,dirZ,age,amp):
      //   A aligned, young   → processed, age < duration → decay applied
      //   B aligned, expired → processed, age >= duration → decay stays 0
      //   C anti-aligned     → cosA < -0.2 → skipped (continue)
      //   D over-aligned     → cosA > 1  → cos clamp to 1
      const ripples = new Float32Array([
        0, 0, 1, 0.5, 0.1,
        0, 0, 1, ASTEROID_RIPPLE_DURATION + 0.8, 0.1,
        0, 0, -1, 0.5, 0.1,
        0, 0, 2, 0.3, 0.05,
      ]);
      const withRipples = asteroidShape(12, null, 0, ripples, 4);
      const noRipples = asteroidShape(12);

      const rippled: [number, number, number] = [0, 0, 0];
      const plain: [number, number, number] = [0, 0, 0];
      asteroidSurfacePosition(withRipples, 0, 0, 1, 100, rippled);
      asteroidSurfacePosition(noRipples, 0, 0, 1, 100, plain);

      expect(rippled.every(Number.isFinite)).toBe(true);
      // The ripple offset shifts the +Z surface point off the un-rippled one.
      expect(rippled[2]).not.toBe(plain[2]);
    });

    it('ignores a ripple buffer when rippleCount is 0', () => {
      const ripples = new Float32Array([0, 0, 1, 0.5, 0.1]);
      const withCount0 = asteroidShape(12, null, 0, ripples, 0);
      const noRipples = asteroidShape(12);
      const a: [number, number, number] = [0, 0, 0];
      const b: [number, number, number] = [0, 0, 0];
      asteroidSurfacePosition(withCount0, 0, 0, 1, 100, a);
      asteroidSurfacePosition(noRipples, 0, 0, 1, 100, b);
      expect(a).toEqual(b); // rippleCount 0 → the loop never runs
    });
  });

  describe('reach — how far the surface really goes', () => {
    /** Brute-force the same question the memoised sweep answers. */
    function sweep(seed: number) {
      const shape = asteroidShape(seed);
      const out: [number, number, number] = [0, 0, 0];
      let max = 0;
      let ex = 0, ey = 0, ez = 0;
      const RINGS = 64;
      for (let i = 0; i <= RINGS; i++) {
        const phi = (i / RINGS) * Math.PI;
        const sinPhi = Math.sin(phi);
        const ny = Math.cos(phi);
        for (let j = 0; j < RINGS * 2; j++) {
          const theta = (j / (RINGS * 2)) * Math.PI * 2;
          asteroidSurfacePosition(shape, sinPhi * Math.cos(theta), ny, sinPhi * Math.sin(theta), 1, out);
          max = Math.max(max, Math.hypot(out[0], out[1], out[2]));
          ex = Math.max(ex, Math.abs(out[0]));
          ey = Math.max(ey, Math.abs(out[1]));
          ez = Math.max(ez, Math.abs(out[2]));
        }
      }
      return { max, extents: [ex, ey, ez] as [number, number, number] };
    }

    it('reports the farthest surface point for a seed', () => {
      for (const seed of [1, 42, 1337]) {
        expect(asteroidMaxReach(seed)).toBeCloseTo(sweep(seed).max, 10);
      }
    });

    it('always reaches well past the nominal radius — a rock is not its sphere', () => {
      // This is the whole reason the function exists: code that bounds or spaces
      // rocks by `radius` is out by this factor, and it is never close to 1.
      for (const seed of [1, 7, 42, 1337, 2027, 9999]) {
        expect(asteroidMaxReach(seed)).toBeGreaterThan(1.5);
        expect(asteroidMaxReach(seed)).toBeLessThan(3.5);
      }
    });

    it('reports per-axis extents that bound the same surface', () => {
      for (const seed of [7, 2027]) {
        const { extents } = sweep(seed);
        const got = asteroidReachExtents(seed);
        expect(got[0]).toBeCloseTo(extents[0], 10);
        expect(got[1]).toBeCloseTo(extents[1], 10);
        expect(got[2]).toBeCloseTo(extents[2], 10);
      }
    });

    it('no axis extent exceeds the scalar reach', () => {
      for (const seed of [3, 88, 5150]) {
        const max = asteroidMaxReach(seed);
        for (const e of asteroidReachExtents(seed)) expect(e).toBeLessThanOrEqual(max + 1e-9);
      }
    });

    it('memoises: the second answer is the identical object, not a re-sweep', () => {
      const first = asteroidReachExtents(4242);
      expect(asteroidReachExtents(4242)).toBe(first);
      // The scalar shares that cache entry, so it costs nothing after the first ask.
      expect(asteroidMaxReach(4242)).toBe(asteroidMaxReach(4242));
    });

    it('is a property of the seed — different seeds, different rocks', () => {
      expect(asteroidMaxReach(11)).not.toBeCloseTo(asteroidMaxReach(12), 3);
    });
  });
});
