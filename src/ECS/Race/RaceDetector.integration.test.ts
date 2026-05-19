/**
 * End-to-end integration test for the race detector. Wires up a World with
 * two Systems that knowingly step on each other, then asserts the detector
 * surfaces both the event race and the adapter race.
 */

import { describe, it, expect, vi } from 'vitest';
import { World } from '../World/World';
import { EventBus } from '../EventBus/EventBus';
import { System } from '../System/System';
import { Component } from '../Component/Component';
import { MockRendererAdapter } from '../../Renderer/MockRendererAdapter';
import type { MeshHandle } from '../../Renderer/types';

class MarkerComponent extends Component {}

function makeSystem(
  name: string,
  onUpdateFn: (this: System, dt: number, ctx: { world: World }) => void,
): new (bus: EventBus) => System {
  class NamedSystem extends System {
    constructor(bus: EventBus) {
      super(bus);
      this.query = { required: [MarkerComponent] };
    }
    protected onUpdate(dt: number): void {
      onUpdateFn.call(this, dt, { world: this.world! });
    }
  }
  Object.defineProperty(NamedSystem, 'name', { value: name });
  return NamedSystem;
}

describe('RaceDetector integration', () => {
  it('warns when two systems emit the same (eventType, entityId) in one frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bus = new EventBus();
    const renderer = new MockRendererAdapter();
    const world = new World({ eventBus: bus, renderer, detectRaces: true });

    const SysA = makeSystem('SysA', function () {
      this['eventBus'].emit('health.changed', { entityId: 'hero', value: 50 });
    });
    const SysB = makeSystem('SysB', function () {
      this['eventBus'].emit('health.changed', { entityId: 'hero', value: 30 });
    });
    world.addSystem(new SysA(bus));
    world.addSystem(new SysB(bus));
    world.initialize();

    const e = world.createEntity();
    e.add(new MarkerComponent());
    world.update(1 / 60);

    const warnings = world.raceDetector!.warnings;
    expect(warnings.some((w) => w.kind === 'event' && w.key.startsWith('health.changed:hero'))).toBe(
      true,
    );
    const race = warnings.find((w) => w.kind === 'event')!;
    expect(race.sources).toEqual(expect.arrayContaining(['SysA', 'SysB']));
    warn.mockRestore();
  });

  it('warns when two systems write to the same handle+method in one frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bus = new EventBus();
    const renderer = new MockRendererAdapter();
    // Create the shared handle via the bare renderer (outside any system
    // context), so recordHandleWrite's first call is tagged <external>.
    const sharedHandle: MeshHandle = renderer.createMesh('shared', { kind: 'box' });

    const world = new World({ eventBus: bus, renderer, detectRaces: true });

    const MoverA = makeSystem('MoverA', function () {
      this.world!.renderer!.setMeshPosition(sharedHandle, 1, 0, 0);
    });
    const MoverB = makeSystem('MoverB', function () {
      this.world!.renderer!.setMeshPosition(sharedHandle, 2, 0, 0);
    });
    world.addSystem(new MoverA(bus));
    world.addSystem(new MoverB(bus));
    world.initialize();
    const e = world.createEntity();
    e.add(new MarkerComponent());
    world.update(1 / 60);

    const warnings = world.raceDetector!.warnings;
    const adapterRace = warnings.find((w) => w.kind === 'adapter');
    expect(adapterRace).toBeDefined();
    expect(adapterRace!.key).toContain('setMeshPosition');
    expect(adapterRace!.sources).toEqual(expect.arrayContaining(['MoverA', 'MoverB']));
    warn.mockRestore();
  });

  it('does not warn when one system alone mutates a handle many times per frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bus = new EventBus();
    const renderer = new MockRendererAdapter();
    const world = new World({ eventBus: bus, renderer, detectRaces: true });
    const handle = renderer.createMesh('solo', { kind: 'box' });

    const Mover = makeSystem('SoleMover', function () {
      this.world!.renderer!.setMeshPosition(handle, 1, 2, 3);
      this.world!.renderer!.setMeshPosition(handle, 4, 5, 6);
      this.world!.renderer!.setMeshPosition(handle, 7, 8, 9);
    });
    world.addSystem(new Mover(bus));
    world.initialize();
    const e = world.createEntity();
    e.add(new MarkerComponent());
    world.update(1 / 60);
    expect(world.raceDetector!.warnings).toHaveLength(0);
    warn.mockRestore();
  });

  it('prod-mode world (detectRaces: false) leaves raceDetector undefined', () => {
    const bus = new EventBus();
    const renderer = new MockRendererAdapter();
    const world = new World({ eventBus: bus, renderer, detectRaces: false });
    expect(world.raceDetector).toBeUndefined();
    // And the renderer is the raw adapter, not the Proxy.
    expect(world.renderer).toBe(renderer);
  });
});
