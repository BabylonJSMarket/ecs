import { describe, it, expect } from 'vitest';
import {
  rasterizeSunStarburst,
  sunStarburstRays,
  SUN_STARBURST_TEXELS,
} from './sunStarburst';

/** Alpha of the texel at (x, y) in a size×size RGBA8 buffer. */
function alphaAt(buf: Uint8ClampedArray, size: number, x: number, y: number): number {
  return buf[(y * size + x) * 4 + 3];
}

/** RGB of the texel at (x, y). */
function rgbAt(buf: Uint8ClampedArray, size: number, x: number, y: number): [number, number, number] {
  const i = (y * size + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2]];
}

describe('sunStarburst', () => {
  const SIZE = 128;

  it('fills an RGBA8 buffer of exactly width*height*4', () => {
    const buf = rasterizeSunStarburst(SIZE, 1);
    expect(buf).toBeInstanceOf(Uint8ClampedArray);
    expect(buf.length).toBe(SIZE * SIZE * 4);
  });

  it('is a pure function of the seed — the same seed rasterises byte-identical', () => {
    // The reference star drew its minor rays from Math.random(), so it dealt a
    // different star every reload and no two screenshots ever matched. This is
    // the property that replaced that.
    expect(rasterizeSunStarburst(SIZE, 7)).toEqual(rasterizeSunStarburst(SIZE, 7));
  });

  it('a different seed moves the minor rays', () => {
    expect(rasterizeSunStarburst(SIZE, 7)).not.toEqual(rasterizeSunStarburst(SIZE, 8));
  });

  it('is opaque and near-white at the centre', () => {
    // The core is what the disc's own glow sits behind; if it rasterises dim or
    // transparent the star reads as a smudge rather than a light source.
    const buf = rasterizeSunStarburst(SIZE, 1);
    const c = SIZE / 2;
    expect(alphaAt(buf, SIZE, c, c)).toBe(255);
    const [r, g, b] = rgbAt(buf, SIZE, c, c);
    expect(r).toBeGreaterThan(240);
    expect(g).toBeGreaterThan(230);
    expect(b).toBeGreaterThan(180);
  });

  it('falls to fully transparent in the corners', () => {
    // The quad is square and the star is not. Any alpha out here would render as
    // a visible box edge against space.
    const buf = rasterizeSunStarburst(SIZE, 1);
    for (const [x, y] of [[0, 0], [SIZE - 1, 0], [0, SIZE - 1], [SIZE - 1, SIZE - 1]]) {
      expect(alphaAt(buf, SIZE, x, y)).toBe(0);
    }
  });

  it('throws rays that stand out from the halo well outside the core', () => {
    // Sampled on a ring at 0.75 of the radius: past the core, still inside the
    // halo, and past every minor ray. So the ring is mostly flat halo with a few
    // spikes on it — which is the shape that reads as a camera artefact instead
    // of a drawn star. A uniform ring would mean the rays never made it out.
    const buf = rasterizeSunStarburst(SIZE, 1);
    const c = SIZE / 2;
    const d = c * 0.75;
    const ring: { angle: number; alpha: number }[] = [];
    for (let i = 0; i < 360; i++) {
      const angle = (i / 360) * Math.PI * 2;
      ring.push({
        angle,
        alpha: alphaAt(
          buf, SIZE,
          Math.round(c + Math.cos(angle) * d),
          Math.round(c + Math.sin(angle) * d),
        ),
      });
    }
    const sorted = [...ring].sort((a, b) => a.alpha - b.alpha);
    const median = sorted[180].alpha;
    const brightest = sorted[sorted.length - 1];
    // The halo alone is present all the way round…
    expect(median).toBeGreaterThan(0);
    // …and the rays sit well above it.
    expect(brightest.alpha).toBeGreaterThan(median * 1.5);
    // The peak is on a ray that actually reaches this far, not on a stray texel.
    const reaching = sunStarburstRays(1).filter((r) => r.length > 0.75);
    expect(reaching.length).toBeGreaterThan(0);
    const nearest = Math.min(
      ...reaching.map((r) => {
        const diff = Math.abs(((r.angle - brightest.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        return Math.PI - diff;
      }),
    );
    expect(nearest).toBeLessThan(0.1);
  });

  it('keeps colour un-premultiplied — a faint ray is amber, not black', () => {
    // Accumulation happens premultiplied; shipping it that way would dim every
    // low-alpha texel twice, once in RGB and again in A. A texel out on a ray
    // must still carry a bright hue behind its low alpha.
    const buf = rasterizeSunStarburst(SIZE, 1);
    const c = SIZE / 2;
    let checked = 0;
    for (let x = c + 20; x < SIZE - 2; x++) {
      const a = alphaAt(buf, SIZE, x, c);
      if (a === 0 || a > 200) continue;
      const [r, g] = rgbAt(buf, SIZE, x, c);
      expect(r).toBeGreaterThan(200);
      expect(g).toBeGreaterThan(120);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('lays out four dominant rays plus a scatter of minor ones', () => {
    const rays = sunStarburstRays(1);
    expect(rays.length).toBe(4 + 8 + 28);
    // The first four are the dominant pairs: longest, widest, brightest.
    const dominant = rays.slice(0, 4);
    const rest = rays.slice(4);
    const weakest = Math.min(...dominant.map((r) => r.alpha));
    const strongest = Math.max(...rest.map((r) => r.alpha));
    expect(weakest).toBeGreaterThan(strongest);
    expect(Math.min(...dominant.map((r) => r.length))).toBeGreaterThan(
      Math.max(...rest.map((r) => r.length)),
    );
  });

  it('defaults to the reference resolution', () => {
    expect(rasterizeSunStarburst().length).toBe(
      SUN_STARBURST_TEXELS * SUN_STARBURST_TEXELS * 4,
    );
  });
});
