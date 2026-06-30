/**
 * proceduralRock — renderer-free seeded-asteroid surface math.
 *
 * Lifted (1:1) from the bespoke Wingman `game/data/asteroidShape.ts` so the
 * BabylonAdapter's `createProceduralMesh` (which displaces an icosphere) and its
 * `sampleProceduralSurface` (which collision/occlusion code calls) evaluate ONE
 * shared displacement function. That's what makes the contract's determinism
 * REAL rather than only Mock-real: the same `seed` (+ `cutAxis`/`cutDepth`)
 * yields byte-identical geometry AND byte-identical surface samples, because
 * both ask {@link asteroidSurfacePosition} the same question.
 *
 * Pure math only — ZERO engine imports. Safe to import from any adapter.
 */

/** Per-axis stretch factors in [0.45, 1.85], seeded so a rock reads as oblong. */
export function asteroidStretch(seed: number): [number, number, number] {
  return [
    0.45 + hash(seed, 12) * 1.4,
    0.45 + hash(seed, 13) * 1.4,
    0.45 + hash(seed, 14) * 1.4,
  ];
}

/** Total seconds a transient ripple lives before it's swapped out. */
export const ASTEROID_RIPPLE_DURATION = 1.2;

/**
 * Precomputed coefficients for a seeded asteroid's surface. The mesh builder
 * displaces the icosphere vertices through these; `sampleProceduralSurface`
 * maps a unit direction to the exact same surface point, so collision/occlusion
 * geometry and the rendered silhouette agree regardless of subdivision count.
 */
export interface AsteroidShape {
  // Noise phase offsets.
  sx: number; sy: number; sz: number;
  ax: number; ay: number; az: number;
  // Positive lobe (one long jagged protrusion).
  pvx: number; pvy: number; pvz: number;
  // Negative lobe (concave hollow opposite the protrusion).
  nvx: number; nvy: number; nvz: number;
  // Per-axis stretch.
  stretchX: number; stretchY: number; stretchZ: number;
  // Hemisphere-facing concave cut (asteroid halves after a split).
  cutAxis: [number, number, number] | null;
  cutDepth: number;
  // Per-instance active ripples (5 floats per ripple). Unused by Phase-3.
  ripples: Float32Array | null;
  rippleCount: number;
}

/** Build the seeded coefficient set for an asteroid silhouette. */
export function asteroidShape(
  seed: number,
  cutAxis?: readonly [number, number, number] | null,
  cutDepth?: number,
  ripples?: Float32Array | null,
  rippleCount?: number,
): AsteroidShape {
  const sx = hash(seed, 0) * 12.3 + 1.7;
  const sy = hash(seed, 1) * 12.3 + 2.1;
  const sz = hash(seed, 2) * 12.3 + 3.4;
  const ax = hash(seed, 3) * 7.1 + 0.8;
  const ay = hash(seed, 4) * 7.1 + 1.3;
  const az = hash(seed, 5) * 7.1 + 1.9;
  const lpX = hash(seed, 9) * 2 - 1;
  const lpY = hash(seed, 10) * 2 - 1;
  const lpZ = hash(seed, 11) * 2 - 1;
  const lpLen = Math.hypot(lpX, lpY, lpZ) || 1;
  const pvx = lpX / lpLen, pvy = lpY / lpLen, pvz = lpZ / lpLen;
  const lnX = hash(seed, 15) * 2 - 1;
  const lnY = hash(seed, 16) * 2 - 1;
  const lnZ = hash(seed, 17) * 2 - 1;
  const lnLen = Math.hypot(lnX, lnY, lnZ) || 1;
  const nvx = lnX / lnLen, nvy = lnY / lnLen, nvz = lnZ / lnLen;
  const [stretchX, stretchY, stretchZ] = asteroidStretch(seed);
  return {
    sx, sy, sz, ax, ay, az, pvx, pvy, pvz, nvx, nvy, nvz,
    stretchX, stretchY, stretchZ,
    cutAxis: cutAxis ? [cutAxis[0], cutAxis[1], cutAxis[2]] : null,
    cutDepth: cutDepth ?? 0,
    ripples: ripples ?? null,
    rippleCount: rippleCount ?? 0,
  };
}

/**
 * Displaced surface position for a unit direction on a seeded asteroid of the
 * given radius. Writes into `out` and returns it. This is the single source of
 * truth the mesh builder and the collision/occlusion sampler both call.
 */
export function asteroidSurfacePosition(
  s: AsteroidShape,
  nx: number, ny: number, nz: number,
  radius: number,
  out: [number, number, number],
): [number, number, number] {
  const pDot = nx * s.pvx + ny * s.pvy + nz * s.pvz;
  const posLobe = pDot > 0 ? pDot * pDot : 0;
  const nDot = nx * s.nvx + ny * s.nvy + nz * s.nvz;
  const negLobe = nDot > 0 ? nDot * nDot * nDot : 0;
  const coarse =
    Math.sin(nx * 1.6 + s.sx) * Math.sin(ny * 1.6 + s.sy) +
    0.8 * Math.sin(ny * 2.1 + s.sz) * Math.sin(nz * 2.1 + s.sx) +
    0.6 * Math.sin(nx * 2.7 + s.ay) * Math.cos(nz * 2.7 + s.az) +
    0.4 * Math.sin(nz * 3.3 + s.ax) * Math.sin(ny * 3.3 + s.sy);
  const fine =
    0.45 * Math.sin(nx * 4.8 + s.ax) * Math.sin(nz * 4.8 + s.ay) +
    0.3 * Math.sin(ny * 6.4 + s.az) * Math.cos(nx * 6.4 + s.sx);
  let displ = Math.max(
    0.15,
    1 + 0.7 * posLobe - 0.55 * negLobe + 0.42 * coarse + 0.22 * fine,
  );
  if (s.cutAxis && s.cutDepth > 0) {
    const cd = nx * s.cutAxis[0] + ny * s.cutAxis[1] + nz * s.cutAxis[2];
    if (cd > 0) {
      const t = cd * cd * (3 - 2 * cd);
      const concaveDispl = 1 - s.cutDepth;
      displ = displ * (1 - t) + concaveDispl * t;
    }
  }
  if (s.ripples && s.rippleCount > 0) {
    let rippleOffset = 0;
    for (let i = 0; i < s.rippleCount; i++) {
      const o = i * 5;
      const dirX = s.ripples[o];
      const dirY = s.ripples[o + 1];
      const dirZ = s.ripples[o + 2];
      const age = s.ripples[o + 3];
      const amplitude = s.ripples[o + 4];
      const cosA = nx * dirX + ny * dirY + nz * dirZ;
      if (cosA < -0.2) continue;
      const clamped = cosA < -1 ? -1 : cosA > 1 ? 1 : cosA;
      const arc = Math.acos(clamped);
      const wave = Math.sin(arc * 16 - age * 18) * Math.exp(-arc * 2.5);
      let decay = 0;
      if (age < ASTEROID_RIPPLE_DURATION) {
        const k = 1 - age / ASTEROID_RIPPLE_DURATION;
        decay = k * k;
      }
      rippleOffset += amplitude * wave * decay;
    }
    displ += rippleOffset;
  }
  out[0] = nx * displ * s.stretchX * radius;
  out[1] = ny * displ * s.stretchY * radius;
  out[2] = nz * displ * s.stretchZ * radius;
  return out;
}

/** Cheap deterministic [0, 1) hash for seed-driven generation. */
export function hash(seed: number, salt: number): number {
  // Mulberry32-ish — good enough for vertex offsets, no allocation. Kept
  // bit-for-bit identical to the Wingman original so geometry reproduces.
  let n = (seed | 0) * 374761393 + (salt | 0) * 668265263;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return ((n >>> 0) % 100000) / 100000;
}

/** Clamp to the unit interval. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
