/**
 * sunStarburst — renderer-free rasteriser for the sun's camera-glare star.
 *
 * A star this size cannot come out of the lens-flare post-process. That pass
 * derives everything from a 512² picture of the disc, so its finest feature is
 * one texel wide on a sun a few dozen texels across — enough for ghosts, a halo
 * and a streak, nowhere near enough for thin rays that stay sharp while running
 * most of the way across the frame. The rays are geometry instead: this buffer
 * painted on a camera-facing quad, sitting in the glow layer with the disc.
 *
 * Straight alpha, origin top-left, RGBA8 — the layout {@link DynamicTextureSpec}
 * asks for, so an adapter only uploads it. Every contribution ACCUMULATES the
 * way an additive canvas composite does (`globalCompositeOperation='lighter'`):
 * colour premultiplied by its own coverage into RGB, coverage into A. That is
 * what makes crossing rays brighten each other instead of the last one drawn
 * winning, and it is why the core reads as white while its edges stay amber.
 *
 * The layout is SEEDED rather than random. The original drew its minor rays from
 * `Math.random()`, so every reload dealt a different star and no screenshot ever
 * matched the last one. Same seed, same star, forever.
 *
 * Pure math only — ZERO engine imports. Safe to import from any adapter.
 */

/** Reference texture resolution. The star is all soft gradients, so this buys
 *  ray sharpness rather than detail. */
export const SUN_STARBURST_TEXELS = 512;

/** One gradient stop: position along the ramp, colour, and alpha at that point. */
interface Stop {
  t: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Hot core — white at the centre falling through amber to nothing. */
const CORE: Stop[] = [
  { t: 0.0, r: 255, g: 252, b: 235, a: 1.0 },
  { t: 0.25, r: 255, g: 235, b: 170, a: 0.95 },
  { t: 0.6, r: 255, g: 200, b: 100, a: 0.45 },
  { t: 1.0, r: 255, g: 170, b: 60, a: 0.0 },
];

/** Wide, weak falloff that gives the star a body to sit in. */
const HALO: Stop[] = [
  { t: 0.0, r: 255, g: 210, b: 130, a: 0.45 },
  { t: 0.5, r: 255, g: 180, b: 80, a: 0.16 },
  { t: 1.0, r: 255, g: 150, b: 50, a: 0.0 },
];

/** Along-ray ramp, scaled by each ray's own alpha. */
const RAY: Stop[] = [
  { t: 0.0, r: 255, g: 240, b: 200, a: 1.0 },
  { t: 0.3, r: 255, g: 210, b: 130, a: 0.7 },
  { t: 0.7, r: 255, g: 180, b: 80, a: 0.28 },
  { t: 1.0, r: 255, g: 150, b: 50, a: 0.0 },
];

/** One ray: angle in radians, length and half-width as fractions of the radius. */
interface Ray {
  angle: number;
  length: number;
  width: number;
  alpha: number;
}

/**
 * Deterministic [0,1) stream. Mulberry32 — small, well-distributed, and it makes
 * the whole star a pure function of `seed`.
 */
function rng(seed: number): () => number {
  let a = (seed >>> 0) + 0x6d2b79f5;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The ray layout: two dominant near-horizontal pairs, eight mid-length rays
 * spread around the clock, then a scatter of thin ones to fill the gaps.
 *
 * The dominant pair is what makes it read as a CAMERA artefact rather than a
 * cartoon star — a real aperture throws a few long spikes and a crowd of short
 * ones, never an even ring of equal spokes.
 */
export function sunStarburstRays(seed: number): Ray[] {
  const rand = rng(seed);
  const rays: Ray[] = [
    { angle: 0.05, length: 1.05, width: 5, alpha: 0.9 },
    { angle: 0.05 + Math.PI, length: 1.05, width: 5, alpha: 0.9 },
    { angle: -0.45, length: 0.95, width: 4, alpha: 0.85 },
    { angle: -0.45 + Math.PI, length: 0.95, width: 4, alpha: 0.85 },
  ];
  for (const angle of [0.8, 1.4, 2.1, 2.7, 3.5, 4.0, 4.7, 5.4]) {
    rays.push({ angle, length: 0.55 + rand() * 0.25, width: 3, alpha: 0.55 });
  }
  for (let i = 0; i < 28; i++) {
    rays.push({
      angle: rand() * Math.PI * 2,
      length: 0.35 + rand() * 0.35,
      width: 1.5 + rand() * 1.5,
      alpha: 0.3,
    });
  }
  return rays;
}

/** Sample a stop list at `t`, returning colour already scaled by its alpha. */
function ramp(stops: Stop[], t: number, out: [number, number, number, number]): void {
  if (t <= 0) {
    const s = stops[0];
    out[0] = s.r; out[1] = s.g; out[2] = s.b; out[3] = s.a;
    return;
  }
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (t > b.t && i < stops.length - 1) continue;
    const a = stops[i - 1];
    const span = b.t - a.t || 1;
    const k = Math.min(1, Math.max(0, (t - a.t) / span));
    out[0] = a.r + (b.r - a.r) * k;
    out[1] = a.g + (b.g - a.g) * k;
    out[2] = a.b + (b.b - a.b) * k;
    out[3] = a.a + (b.a - a.a) * k;
    return;
  }
}

/**
 * Rasterise the starburst into a `size`×`size` RGBA8 buffer.
 *
 * @param size   Square resolution in texels.
 * @param seed   Chooses the minor-ray layout. Same seed → identical bytes.
 */
export function rasterizeSunStarburst(
  size = SUN_STARBURST_TEXELS,
  seed = 1,
): Uint8ClampedArray {
  const c = size / 2;
  // Accumulate in floats. Clamping per contribution would cap the crossings at
  // white before the rays that make them had all been added.
  const acc = new Float32Array(size * size * 4);
  const s: [number, number, number, number] = [0, 0, 0, 0];

  // Core + halo in one sweep — both are radial, so the per-pixel distance is
  // paid once.
  const coreR = size * 0.22;
  const haloIn = size * 0.1;
  const haloOut = size * 0.48;
  for (let y = 0; y < size; y++) {
    const dy = y + 0.5 - c;
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const d = Math.hypot(dx, dy);
      const i = (y * size + x) * 4;
      if (d < coreR) {
        ramp(CORE, d / coreR, s);
        acc[i] += s[0] * s[3];
        acc[i + 1] += s[1] * s[3];
        acc[i + 2] += s[2] * s[3];
        acc[i + 3] += s[3];
      }
      if (d > haloIn && d < haloOut) {
        ramp(HALO, (d - haloIn) / (haloOut - haloIn), s);
        acc[i] += s[0] * s[3];
        acc[i + 1] += s[1] * s[3];
        acc[i + 2] += s[2] * s[3];
        acc[i + 3] += s[3];
      }
    }
  }

  // Rays, each rasterised inside its own bounding box. Sweeping the whole
  // texture per ray would be forty full-image passes for shapes that cover a
  // sliver of it.
  for (const ray of sunStarburstRays(seed)) {
    const len = ray.length * c;
    const cos = Math.cos(ray.angle);
    const sin = Math.sin(ray.angle);
    const tipX = c + cos * len;
    const tipY = c + sin * len;
    const pad = ray.width + 2;
    const x0 = Math.max(0, Math.floor(Math.min(c, tipX) - pad));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(c, tipX) + pad));
    const y0 = Math.max(0, Math.floor(Math.min(c, tipY) - pad));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(c, tipY) + pad));

    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - c;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - c;
        // Distance along the ray, and perpendicular offset from its spine.
        const along = dx * cos + dy * sin;
        if (along < 0 || along > len) continue;
        const t = along / len;
        // The triangle tapers to a point, so the half-width closes with t.
        const halfWidth = ray.width * (1 - t);
        const perp = Math.abs(-dx * sin + dy * cos);
        // One-texel feather, or the thin rays crawl with stair-steps.
        const cover = Math.min(1, Math.max(0, halfWidth - perp + 0.5));
        if (cover <= 0) continue;
        ramp(RAY, t, s);
        const a = s[3] * ray.alpha * cover;
        const i = (y * size + x) * 4;
        acc[i] += s[0] * a;
        acc[i + 1] += s[1] * a;
        acc[i + 2] += s[2] * a;
        acc[i + 3] += a;
      }
    }
  }

  // Un-premultiply on the way out. The buffer accumulated colour×coverage, but
  // the material reads RGB and A separately — emissive from one, opacity from
  // the other — so leaving it premultiplied would dim every faint ray twice,
  // once in its colour and again in its alpha. Dividing back out is also what
  // canvas `getImageData` does, which keeps this byte-comparable to the
  // reference star it was ported from.
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = acc[i + 3];
    if (a > 0) {
      out[i] = acc[i] / a;
      out[i + 1] = acc[i + 1] / a;
      out[i + 2] = acc[i + 2] / a;
      out[i + 3] = Math.min(1, a) * 255;
    }
  }
  return out;
}
