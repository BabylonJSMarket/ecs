export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Color {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export type EntityId = string;
export type ComponentType<T = any> = new (...args: any[]) => T;

export interface IDisposable {
  dispose(): void;
}
