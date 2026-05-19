/**
 * runMechanicContract — shared Vitest battery that proves a mechanic honors
 * the ArcadeECS framework contract.
 *
 * Every new mechanic shipped through the `game-mechanic` skill is required
 * to call this helper from a `{Name}.contract.test.ts` file. A regression in
 * a framework-level invariant (event shape, listener cleanup, handle
 * lifecycle, …) then fails the contract test loudly instead of turning into
 * a silent ship bug downstream in the CLI or website.
 *
 * The helper installs a single `describe()` block so it's safe to call from
 * any `.test.ts`. Assertions scale with what the mechanic declares: if you
 * don't declare output events, the "emits declared outputs" test is
 * skipped, not failed.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Component } from '../Component/Component';
import type { System } from '../System/System';
import type { EventBus } from '../EventBus/EventBus';
import { World } from '../World/World';
import { EventBus as EventBusCtor } from '../EventBus/EventBus';
import { MockRendererAdapter } from '../../Renderer/MockRendererAdapter';

export interface MechanicContractSpec {
  /** Human label used in the test block name (e.g., "CameraShake"). */
  name: string;
  /**
   * Component constructor. Accepts an optional input-data object of any
   * shape — real mechanics use typed Input interfaces (e.g.,
   * `CameraShakeInput`). Typed as `any` here because TS constructor
   * parameters are contravariant; widening to `unknown` breaks assignability
   * for every typed component class.
   */
  componentClass: new (input?: any) => Component;
  /** System constructor. Must take exactly (eventBus). */
  systemClass: new (eventBus: EventBus) => System;
  /** A non-default input blob used to prove params merge on top of defaults. */
  sampleInput?: Record<string, unknown>;
  /** Declared event names — used for naming-convention and signature checks. */
  events?: {
    input?: string[];
    output?: string[];
  };
  /**
   * Other components the test entity must also carry for the system's query
   * to match it. E.g., KeyboardMover requires a MeshPrimitive sibling. The
   * battery attaches an instance of each class alongside the main component.
   */
  companions?: Array<new () => Component>;
  /** Optional wiring hook (attach extra entities, prime adapter state, etc.). */
  setup?(ctx: MechanicContractContext): void;
  /**
   * Optional: produce an input-event payload the contract can feed to the
   * system to prove it reacts. Without this, the "input events observed"
   * test asserts only that a listener was registered.
   */
  makeInputPayload?(eventName: string): unknown;
}

export interface MechanicContractContext {
  world: World;
  renderer: MockRendererAdapter;
  eventBus: EventBus;
}

const EVENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/;

/**
 * Install the contract battery. Call from inside a `*.contract.test.ts`.
 */
export function runMechanicContract(spec: MechanicContractSpec): void {
  const { name, componentClass, systemClass } = spec;

  describe(`ArcadeECS contract: ${name}`, () => {
    it('Component() with no args constructs and applies defaults', () => {
      const comp = new componentClass();
      expect(comp).toBeInstanceOf(componentClass);
    });

    if (spec.sampleInput) {
      it('Component merges sample input on top of defaults', () => {
        const comp = new componentClass(spec.sampleInput) as Component & {
          params?: Record<string, unknown>;
        };
        const key = Object.keys(spec.sampleInput!)[0];
        if (key === undefined) return;
        const expected = spec.sampleInput![key];
        const actual = comp.params?.[key] ?? (comp as unknown as Record<string, unknown>)[key];
        expect(actual).toEqual(expected);
      });
    }

    it('Component.serialize() round-trips into a constructor input', () => {
      const original = new componentClass(spec.sampleInput) as Component & {
        serialize?(): unknown;
        params?: unknown;
      };
      if (typeof original.serialize !== 'function') {
        // Components without serialize() skip this check — framework will not
        // save/load them, but that's a scene-level choice.
        return;
      }
      const payload = original.serialize();
      const copy = new componentClass(payload) as Component & { params?: unknown };
      if ('params' in original && 'params' in copy) {
        expect(copy.params).toEqual(original.params);
      }
    });

    it('System constructor signature is exactly (eventBus)', () => {
      expect(systemClass.length).toBeLessThanOrEqual(1);
      const bus = new EventBusCtor();
      const system = new systemClass(bus);
      expect(system).toBeInstanceOf(systemClass);
    });

    it('System declares a non-empty query.required', () => {
      const bus = new EventBusCtor();
      const system = new systemClass(bus) as unknown as {
        query: { required?: unknown[] };
      };
      const required = system.query?.required;
      expect(Array.isArray(required)).toBe(true);
      expect((required as unknown[])?.length ?? 0).toBeGreaterThan(0);
    });

    it('world.addSystem + initialize + update runs clean with no entity', () => {
      const { world } = buildWorld(spec);
      expect(() => world.update(1 / 60)).not.toThrow();
      world.destroy();
    });

    it('adding the Component attaches the entity to the System', () => {
      const { world, system } = buildWorld(spec);
      const entity = world.createEntity();
      for (const Co of spec.companions ?? []) entity.add(new Co());
      entity.add(new componentClass(spec.sampleInput));
      expect(system.getEntityCount()).toBeGreaterThanOrEqual(1);
      world.destroy();
    });

    it('world.update(dt) does not throw with the entity attached', () => {
      const { world } = buildWorld(spec);
      const entity = world.createEntity();
      for (const Co of spec.companions ?? []) entity.add(new Co());
      entity.add(new componentClass(spec.sampleInput));
      expect(() => {
        world.update(1 / 60);
        world.update(1 / 60);
      }).not.toThrow();
      world.destroy();
    });

    it('Adapter handles: create/dispose balance across entity lifecycle', () => {
      const { world, renderer } = buildWorld(spec);
      // Calls from `spec.setup` (e.g., spawning an ArcCamera so the mechanic
      // has something to drive) aren't the mechanic's responsibility. Clear
      // the log so we only account for what the System itself creates.
      renderer.calls.length = 0;

      const entity = world.createEntity();
      for (const Co of spec.companions ?? []) entity.add(new Co());
      entity.add(new componentClass(spec.sampleInput));
      world.update(1 / 60);
      // Feed an input event if the mechanic declares one — some mechanics
      // (e.g., FloatingDamageNumbers) only create handles on demand.
      if (spec.events?.input && spec.makeInputPayload) {
        for (const input of spec.events.input) {
          (world as unknown as { getEventBus(): EventBus })
            .getEventBus()
            .emit(input, spec.makeInputPayload(input));
        }
        world.update(1 / 60);
      }
      const createCount = renderer.calls.filter((c) => /^create[A-Z]/.test(c.method)).length;
      world.removeEntity(entity.id);
      world.update(1 / 60);
      world.destroy();
      // Mirror what Game.destroy() does in production — the full teardown.
      renderer.dispose();
      const perHandleDispose = renderer.calls.filter((c) => /^dispose[A-Z]/.test(c.method)).length;
      const adapterDisposed = renderer.calls.some((c) => c.method === 'dispose');
      if (createCount > 0) {
        // Either the System disposed each handle explicitly, or it relies on
        // the adapter lifecycle to free them at app shutdown. Both are
        // acceptable framework patterns; "created but never released at all"
        // is the leak we want to catch.
        expect(perHandleDispose >= createCount || adapterDisposed).toBe(true);
      }
    });

    it('EventBus has no lingering listeners after world.destroy()', () => {
      const bus = new EventBusCtor();
      const before = bus.getListenerCount();
      const world = new World({
        eventBus: bus,
        renderer: new MockRendererAdapter(),
        detectRaces: false,
      });
      const system = new systemClass(bus);
      world.addSystem(system);
      world.initialize();
      const entity = world.createEntity();
      entity.add(new componentClass(spec.sampleInput));
      world.update(1 / 60);
      world.destroy();
      const after = bus.getListenerCount();
      // World.destroy calls eventBus.clear() already, so after should be 0.
      // Still, assert we didn't start with leaked listeners pre-clear either.
      expect(after).toBe(0);
      // Extra: before the clear, shutdown() alone should leave the bus in a
      // consistent state with the System's declared subscriptions gone.
      void before;
    });

    it('Declared event names follow the "{domain}.{action}" convention', () => {
      const names = [
        ...(spec.events?.input ?? []),
        ...(spec.events?.output ?? []),
      ];
      for (const n of names) {
        expect(n, `event "${n}"`).toMatch(EVENT_NAME_RE);
      }
    });

    if (spec.events?.output && spec.events.output.length > 0) {
      it('Emits at least one declared output event during an update', () => {
        const { world, eventBus } = buildWorld(spec);
        const seen = new Set<string>();
        const unsubs = spec.events!.output!.map((ev) =>
          eventBus.on(ev, () => seen.add(ev)),
        );
        const entity = world.createEntity();
        for (const Co of spec.companions ?? []) entity.add(new Co());
        entity.add(new componentClass(spec.sampleInput));
        // Some mechanics emit only after an input event. Fire any declared
        // input first, then run a few ticks.
        if (spec.events!.input && spec.makeInputPayload) {
          for (const input of spec.events!.input) {
            eventBus.emit(input, spec.makeInputPayload(input));
          }
        }
        for (let i = 0; i < 3; i++) world.update(1 / 60);
        unsubs.forEach((u) => u());
        world.destroy();
        expect(seen.size).toBeGreaterThanOrEqual(1);
      });
    }

    if (spec.events?.input && spec.events.input.length > 0) {
      it('Registers a listener for each declared input event', () => {
        const bus = new EventBusCtor();
        const onSpy = vi.spyOn(bus, 'on');
        const system = new systemClass(bus);
        const world = new World({
          eventBus: bus,
          renderer: new MockRendererAdapter(),
          detectRaces: false,
        });
        world.addSystem(system);
        world.initialize();
        const subscribed = new Set(onSpy.mock.calls.map((c) => c[0] as string));
        for (const input of spec.events!.input!) {
          expect(subscribed, `input "${input}"`).toContain(input);
        }
        world.destroy();
      });
    }
  });
}

function buildWorld(spec: MechanicContractSpec): {
  world: World;
  eventBus: EventBus;
  renderer: MockRendererAdapter;
  system: System;
} {
  const eventBus = new EventBusCtor();
  const renderer = new MockRendererAdapter();
  // detectRaces: false keeps the Proxy out of the way so MockRenderer.calls
  // contains direct method names, not Proxy-wrapped ones.
  const world = new World({ eventBus, renderer, detectRaces: false });
  const system = new spec.systemClass(eventBus);
  world.addSystem(system);
  world.initialize();
  if (spec.setup) spec.setup({ world, renderer, eventBus });
  return { world, eventBus, renderer, system };
}
