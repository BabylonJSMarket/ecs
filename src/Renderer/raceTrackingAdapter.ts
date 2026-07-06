/**
 * withRaceTracking — wraps a RendererAdapter in a Proxy that reports handle
 * mutations to the World's RaceDetector. Method calls are forwarded
 * unchanged; only a bookkeeping side-effect is added.
 *
 * Only mutating methods are tracked (names starting with `set`, `update`,
 * `nudge`, `attach`, `detach`, `dispose`, `replace`). Constructors (`create*`)
 * and readers (`get*`) never race with each other in a meaningful way.
 *
 * Handles are opaque objects, but every real adapter tags them with a stable
 * `__handle` string internally (see BabylonAdapter.makeHandle,
 * ThreeAdapter.makeHandle, MockRendererAdapter.makeHandle). We use a
 * WeakMap to assign a sequential id as a fallback if the tag is missing.
 */

import type { RaceDetector } from '../ECS/Race/RaceDetector';
import type { RendererAdapter } from './types';

const MUTATOR_PREFIXES = ['set', 'update', 'nudge', 'attach', 'detach', 'dispose', 'replace'];

function isMutator(method: string): boolean {
  return MUTATOR_PREFIXES.some((p) => method.startsWith(p));
}

function handleIdOf(obj: unknown, fallback: WeakMap<object, string>, counter: { n: number }): string {
  if (obj && typeof obj === 'object') {
    const tag = (obj as { __handle?: unknown; __mockHandle?: unknown }).__handle
      ?? (obj as { __mockHandle?: unknown }).__mockHandle;
    if (typeof tag === 'string') return tag;
    const existing = fallback.get(obj as object);
    if (existing) return existing;
    const id = `anon:${++counter.n}`;
    fallback.set(obj as object, id);
    return id;
  }
  // Primitive argument — stringify as-is. (Some adapter mutators take a
  // handle + coordinates; the first arg is the handle.)
  return `prim:${String(obj)}`;
}

export function withRaceTracking(
  adapter: RendererAdapter,
  detector: RaceDetector,
): RendererAdapter {
  const fallbackIds = new WeakMap<object, string>();
  const counter = { n: 0 };

  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') {
        return value;
      }
      if (!isMutator(prop)) {
        // Bind so inner `this` still points at the real adapter.
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        const handleId = handleIdOf(args[0], fallbackIds, counter);
        detector.recordHandleWrite(handleId, prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
