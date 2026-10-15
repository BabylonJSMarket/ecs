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

/**
 * Box UVs laid out the way Three's BoxGeometry lays them, from each vertex's
 * position and face normal. Babylon's CreateBox maps every face with u and v
 * swapped (its top face runs u along z, Three's along x), so one texture drew
 * across a box in one engine and along it in the other: a skee-ball lane's
 * planks ran lengthwise on Three and crosswise on Babylon. Three's layout is
 * the reference; the face normal picks the formula.
 *
 *   ±x: u = ∓z/d + ½, v = y/h + ½      ±y: u = x/w + ½, v = ½ ∓ z/d
 *   ±z: u = ±x/w + ½, v = y/h + ½
 */
export function boxUvsLikeThree(
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  width: number,
  height: number,
  depth: number,
): Float32Array {
  const count = positions.length / 3;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = positions[3 * i]!;
    const y = positions[3 * i + 1]!;
    const z = positions[3 * i + 2]!;
    const nx = normals[3 * i]!;
    const ny = normals[3 * i + 1]!;
    const nz = normals[3 * i + 2]!;
    let u: number;
    let v: number;
    if (Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz)) {
      u = (nx > 0 ? -z : z) / depth + 0.5;
      v = y / height + 0.5;
    } else if (Math.abs(ny) >= Math.abs(nz)) {
      u = x / width + 0.5;
      v = 0.5 - (ny > 0 ? z : -z) / depth;
    } else {
      u = (nz > 0 ? x : -x) / width + 0.5;
      v = y / height + 0.5;
    }
    uv[2 * i] = u;
    uv[2 * i + 1] = v;
  }
  return uv;
}

/**
 * A whole box, vertex for vertex the one Three's BoxGeometry builds (one
 * segment per side): right-handed positions, face normals, Three's UV layout
 * and winding. For engines whose own box swaps u and v (Babylon Lite builds a
 * unit box and scales it); they hand this to their geometry path instead.
 */
export function boxGeometryLikeThree(width: number, height: number, depth: number): Required<MeshGeometry> {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  type Axis = 0 | 1 | 2;
  const plane = (u: Axis, v: Axis, w: Axis, udir: number, vdir: number, pw: number, ph: number, pd: number) => {
    const base = positions.length / 3;
    for (let iy = 0; iy < 2; iy++) {
      for (let ix = 0; ix < 2; ix++) {
        const p = [0, 0, 0];
        const n = [0, 0, 0];
        p[u] = (ix * pw - pw / 2) * udir;
        p[v] = (iy * ph - ph / 2) * vdir;
        p[w] = pd / 2;
        n[w] = pd > 0 ? 1 : -1;
        positions.push(p[0]!, p[1]!, p[2]!);
        normals.push(n[0]!, n[1]!, n[2]!);
        uvs.push(ix, 1 - iy);
      }
    }
    const a = base;
    const b = base + 2;
    const c = base + 3;
    const d = base + 1;
    indices.push(a, b, d, b, c, d);
  };
  plane(2, 1, 0, -1, -1, depth, height, width);
  plane(2, 1, 0, 1, -1, depth, height, -width);
  plane(0, 2, 1, 1, 1, width, depth, height);
  plane(0, 2, 1, 1, -1, width, depth, -height);
  plane(0, 1, 2, 1, -1, width, height, depth);
  plane(0, 1, 2, -1, -1, width, height, -depth);
  return { positions, normals, uvs, indices };
}
