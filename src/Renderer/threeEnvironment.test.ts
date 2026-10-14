import { describe, expect, it } from 'vitest';
import { decodeRgbd, ENV_MAGIC, isEnvFile, parseEnvFile } from './threeEnvironment';

/** A tiny .env: magic, manifest, NUL, then six 2-byte "images". */
function fakeEnv(width = 4): ArrayBuffer {
  const mipmaps = Array.from({ length: 12 }, (_, i) => ({ position: i * 2, length: 2 }));
  const manifest = new TextEncoder().encode(JSON.stringify({ version: 1, width, imageType: 'image/png', specular: { mipmaps } }));
  const out = new Uint8Array(ENV_MAGIC.length + manifest.length + 1 + 24);
  out.set(ENV_MAGIC, 0);
  out.set(manifest, ENV_MAGIC.length);
  const data = ENV_MAGIC.length + manifest.length + 1;
  for (let i = 0; i < 24; i++) out[data + i] = i;
  return out.buffer;
}

describe('threeEnvironment', () => {
  it('knows a .env url, with or without a query', () => {
    expect(isEnvFile('https://x/room.env')).toBe(true);
    expect(isEnvFile('/a/room.env?v=2')).toBe(true);
    expect(isEnvFile('/a/sky.hdr')).toBe(false);
  });

  it('reads the manifest and slices the six top-mip faces', () => {
    const env = parseEnvFile(fakeEnv(4));
    expect(env.width).toBe(4);
    expect(env.imageType).toBe('image/png');
    expect(env.faces).toHaveLength(6);
    expect([...env.faces[0]]).toEqual([0, 1]);
    expect([...env.faces[5]]).toEqual([10, 11]);
  });

  it('refuses a file without the magic bytes', () => {
    expect(() => parseEnvFile(new Uint8Array(16).buffer)).toThrow(/magic/);
  });

  it('decodes RGBD: full alpha is plain gamma colour, low alpha is bright HDR', () => {
    const out = decodeRgbd(new Uint8Array([255, 0, 128, 255, 255, 255, 255, 51]), new Float32Array(8));
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(Math.pow(128 / 255, 2.2), 5);
    // alpha 51/255 = 0.2 → the stored white was a light 5× brighter.
    expect(out[4]).toBeCloseTo(5, 4);
    expect(out[7]).toBe(1);
  });
});
