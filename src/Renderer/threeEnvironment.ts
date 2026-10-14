/**
 * threeEnvironment.ts — read Babylon's `.env` image-based-lighting file for Three.
 *
 * A `.env` is Babylon's prefiltered cubemap: 8 magic bytes, a NUL-terminated
 * JSON manifest, then one PNG (or WebP) per face per mip level. Each image
 * holds RGBD: colour in gamma space times a divisor kept in alpha, so an
 * 8-bit file can carry HDR light. Three cannot load it, so every scene that
 * named a `.env` used to get no environment light at all on ThreeAdapter.
 *
 * Only the top mip is read: Three's PMREMGenerator builds its own blur chain
 * from it. The parsing and the RGBD maths are pure (tested without a GPU);
 * the adapter does the image decoding and the PMREM pass.
 */

/** The first 8 bytes of every Babylon `.env` file. */
export const ENV_MAGIC = [0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36] as const;

export interface EnvFaceImages {
  /** Edge length of the top mip, px. */
  width: number;
  /** MIME type of the face images, e.g. `image/png`. */
  imageType: string;
  /** The six top-mip faces, in cubemap order +X, -X, +Y, -Y, +Z, -Z. */
  faces: Uint8Array[];
}

interface EnvManifest {
  width: number;
  imageType?: string;
  specular?: { mipmaps?: { position: number; length: number }[] };
}

export function isEnvFile(url: string): boolean {
  return /\.env($|[?#])/i.test(url);
}

/** Split a `.env` file into its manifest and its six top-mip face images. Throws on a bad file. */
export function parseEnvFile(buffer: ArrayBuffer): EnvFaceImages {
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < ENV_MAGIC.length; i++) {
    if (bytes[i] !== ENV_MAGIC[i]) throw new Error('not a Babylon .env file (bad magic bytes)');
  }
  let end = ENV_MAGIC.length;
  while (end < bytes.length && bytes[end] !== 0) end++;
  if (end >= bytes.length) throw new Error('.env manifest is not terminated');
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(ENV_MAGIC.length, end))) as EnvManifest;
  const data = end + 1;
  const mips = manifest.specular?.mipmaps;
  if (!manifest.width || !mips || mips.length < 6) throw new Error('.env manifest has no specular faces');
  const faces = mips.slice(0, 6).map((m) => bytes.subarray(data + m.position, data + m.position + m.length));
  return { width: manifest.width, imageType: manifest.imageType ?? 'image/png', faces };
}

/**
 * Decode RGBA8 RGBD pixels into linear RGBA floats, in place into `out`
 * (`out.length === rgba.length`). Babylon's `fromRGBD`: linear(rgb) / d.
 */
export function decodeRgbd(rgba: Uint8ClampedArray | Uint8Array, out: Float32Array): Float32Array {
  for (let i = 0; i < rgba.length; i += 4) {
    const d = Math.max(rgba[i + 3] / 255, 1 / 255);
    out[i] = Math.pow(rgba[i] / 255, 2.2) / d;
    out[i + 1] = Math.pow(rgba[i + 1] / 255, 2.2) / d;
    out[i + 2] = Math.pow(rgba[i + 2] / 255, 2.2) / d;
    out[i + 3] = 1;
  }
  return out;
}
