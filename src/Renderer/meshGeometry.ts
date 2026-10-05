/**
 * meshGeometry — pure helpers for `setMeshGeometry` vertex data.
 *
 * No engine imports: the adapters that need these (Babylon Lite wants normals
 * handed to it; it also runs left-handed) call them, and they are tested
 * without a GPU.
 */
import type { MeshGeometry } from './types';

/**
 * Smooth per-vertex normals: each triangle adds its face normal, weighted by
 * its area, to its three corners, then every corner is normalised. A vertex
 * shared by two faces is smoothed across them; give a hard edge its own
 * vertices on each side and it stays hard.
 */
export function computeNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const n = new Float32Array(positions.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]! * 3;
    const b = indices[i + 1]! * 3;
    const c = indices[i + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    // u × v: counter-clockwise triangles face out (right-handed).
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      n[k] += nx;
      n[k + 1] += ny;
      n[k + 2] += nz;
    }
  }
  for (let k = 0; k < n.length; k += 3) {
    const len = Math.hypot(n[k]!, n[k + 1]!, n[k + 2]!);
    if (len > 0) {
      n[k] /= len;
      n[k + 1] /= len;
      n[k + 2] /= len;
    }
  }
  return n;
}

/**
 * The same shape for Babylon Lite, which runs left-handed: z negated on every
 * position and normal. The indices are untouched on purpose. Mirroring turns a
 * counter-clockwise triangle clockwise, and clockwise-from-outside is the
 * front face Babylon engines draw.
 */
export function mirrorZ(geom: MeshGeometry): {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  uvs?: Float32Array;
} {
  const positions = Float32Array.from(geom.positions);
  const normals = Float32Array.from(geom.normals ?? computeNormals(geom.positions, geom.indices));
  for (let k = 2; k < positions.length; k += 3) {
    positions[k] = -positions[k]!;
    normals[k] = -normals[k]!;
  }
  const indices = Uint32Array.from(geom.indices);
  return { positions, normals, indices, uvs: geom.uvs ? Float32Array.from(geom.uvs) : undefined };
}
