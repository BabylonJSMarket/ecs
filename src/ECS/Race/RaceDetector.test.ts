import { describe, it, expect, vi } from 'vitest';
import { RaceDetector, EXTERNAL_SOURCE } from './RaceDetector';

describe('RaceDetector', () => {
  const makeDetector = () => {
    const onWarn = vi.fn();
    const detector = new RaceDetector({ onWarn });
    return { detector, onWarn };
  };

  it('does not warn when a single system emits an event once', () => {
    const { detector, onWarn } = makeDetector();
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    detector.recordEvent('foo.bar', { entityId: 'e1' });
    expect(onWarn).not.toHaveBeenCalled();
    expect(detector.warnings).toHaveLength(0);
  });

  it('does not warn when the same system emits the same event twice', () => {
    const { detector, onWarn } = makeDetector();
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    detector.recordEvent('foo.bar', { entityId: 'e1' });
    detector.recordEvent('foo.bar', { entityId: 'e1' });
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('warns when two different systems emit the same (type, entityId) in one frame', () => {
    const { detector, onWarn } = makeDetector();
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    detector.recordEvent('foo.bar', { entityId: 'e1' });
    detector.setCurrentSystem('SystemB');
    detector.recordEvent('foo.bar', { entityId: 'e1' });
    expect(onWarn).toHaveBeenCalledTimes(1);
    const msg = onWarn.mock.calls[0][0] as string;
    expect(msg).toContain('SystemA');
    expect(msg).toContain('SystemB');
    expect(msg).toContain('foo.bar');
    expect(msg).toContain('e1');
    expect(detector.warnings).toHaveLength(1);
    expect(detector.warnings[0].kind).toBe('event');
  });

  it('does not warn about events without an entityId', () => {
    const { detector, onWarn } = makeDetector();
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    detector.recordEvent('tick', { dt: 0.016 });
    detector.setCurrentSystem('SystemB');
    detector.recordEvent('tick', { dt: 0.016 });
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('resets between frames so legit cross-frame emissions do not accumulate warnings', () => {
    const { detector, onWarn } = makeDetector();
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    detector.recordEvent('x.y', { entityId: 'e' });

    detector.beginFrame();
    detector.setCurrentSystem('SystemB');
    detector.recordEvent('x.y', { entityId: 'e' });

    expect(onWarn).not.toHaveBeenCalled();
  });

  it('only warns once per (key, frame) even if the clash repeats', () => {
    const { detector, onWarn } = makeDetector();
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    detector.recordEvent('a.b', { entityId: 'e' });
    detector.setCurrentSystem('SystemB');
    detector.recordEvent('a.b', { entityId: 'e' });
    detector.recordEvent('a.b', { entityId: 'e' });
    detector.recordEvent('a.b', { entityId: 'e' });
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it('warns on adapter races (two systems writing same handle+method)', () => {
    const { detector, onWarn } = makeDetector();
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    detector.recordHandleWrite('mesh:42', 'setMeshPosition');
    detector.setCurrentSystem('SystemB');
    detector.recordHandleWrite('mesh:42', 'setMeshPosition');
    expect(onWarn).toHaveBeenCalledTimes(1);
    const w = detector.warnings[0];
    expect(w.kind).toBe('adapter');
    expect(w.sources).toEqual(['SystemA', 'SystemB']);
  });

  it('does not treat the same handle written via different methods as a race', () => {
    const { detector, onWarn } = makeDetector();
    detector.beginFrame();
    detector.setCurrentSystem('SystemA');
    detector.recordHandleWrite('mesh:1', 'setMeshPosition');
    detector.setCurrentSystem('SystemB');
    detector.recordHandleWrite('mesh:1', 'setMeshRotation');
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('tags emissions outside any System.update context as <external>', () => {
    const { detector, onWarn } = makeDetector();
    detector.beginFrame();
    detector.setCurrentSystem(null);
    detector.recordEvent('p.q', { entityId: 'e' });
    detector.setCurrentSystem('SystemB');
    detector.recordEvent('p.q', { entityId: 'e' });
    const msg = onWarn.mock.calls[0][0] as string;
    expect(msg).toContain(EXTERNAL_SOURCE);
    expect(msg).toContain('SystemB');
  });

  it('reset() clears warnings + source sets', () => {
    const { detector, onWarn } = makeDetector();
    detector.beginFrame();
    detector.setCurrentSystem('A');
    detector.recordEvent('e', { entityId: '1' });
    detector.setCurrentSystem('B');
    detector.recordEvent('e', { entityId: '1' });
    expect(detector.warnings).toHaveLength(1);
    detector.reset();
    expect(detector.warnings).toHaveLength(0);
    expect(detector.getCurrentSystem()).toBeNull();
    // Fresh frame starts clean.
    detector.setCurrentSystem('A');
    detector.recordEvent('e', { entityId: '1' });
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  describe('component-field races', () => {
    // A minimal TrackableEntity whose one component's fields can be mutated.
    const makeEntity = (id: string, comps: Record<string, Record<string, unknown>>) => {
      const components = Object.entries(comps).map(([name, data]) => ({
        constructor: { name },
        data: { ...data },
        toJSON() {
          return this.data;
        },
      }));
      return {
        id,
        getComponents: () => components,
        set(name: string, field: string, value: unknown) {
          components.find((c) => c.constructor.name === name)!.data[field] = value;
        },
      };
    };

    it('snapshot is empty and diff is a no-op when componentTracking is off', () => {
      const { detector, onWarn } = makeDetector();
      detector.beginFrame();
      const e = makeEntity('e', { C: { x: 1 } });
      const snap = detector.snapshotComponents([e]);
      expect(snap.size).toBe(0);
      e.set('C', 'x', 2);
      detector.diffComponents([e], snap, 'S');
      expect(onWarn).not.toHaveBeenCalled();
    });

    it('warns when two systems write the same component field in one frame', () => {
      const { detector, onWarn } = makeDetector();
      detector.componentTracking = true;
      detector.beginFrame();
      const player = makeEntity('Player', { MeshPrimitive: { position: [0, 0, 0] } });
      const es = [player];

      detector.setCurrentSystem('KeyboardMoverSystem');
      const s1 = detector.snapshotComponents(es);
      player.set('MeshPrimitive', 'position', [1, 0, 0]);
      detector.diffComponents(es, s1, 'KeyboardMoverSystem');

      detector.setCurrentSystem('AnimateMeshySystem');
      const s2 = detector.snapshotComponents(es);
      player.set('MeshPrimitive', 'position', [2, 0, 0]);
      detector.diffComponents(es, s2, 'AnimateMeshySystem');

      expect(onWarn).toHaveBeenCalledTimes(1);
      const w = detector.warnings[0];
      expect(w.kind).toBe('component');
      expect(w.sources).toEqual(['KeyboardMoverSystem', 'AnimateMeshySystem']);
      expect(w.message).toContain('MeshPrimitive.position');
      expect(w.message).toContain('Player');
    });

    it('one system writing a field is not a race', () => {
      const { detector, onWarn } = makeDetector();
      detector.componentTracking = true;
      detector.beginFrame();
      const e = makeEntity('e', { C: { x: 1 } });
      detector.setCurrentSystem('A');
      const s = detector.snapshotComponents([e]);
      e.set('C', 'x', 2);
      detector.diffComponents([e], s, 'A');
      expect(onWarn).not.toHaveBeenCalled();
    });

    it('two systems writing different fields is not a race', () => {
      const { detector, onWarn } = makeDetector();
      detector.componentTracking = true;
      detector.beginFrame();
      const e = makeEntity('e', { C: { x: 1, y: 1 } });
      detector.setCurrentSystem('A');
      const s1 = detector.snapshotComponents([e]);
      e.set('C', 'x', 2);
      detector.diffComponents([e], s1, 'A');
      detector.setCurrentSystem('B');
      const s2 = detector.snapshotComponents([e]);
      e.set('C', 'y', 9);
      detector.diffComponents([e], s2, 'B');
      expect(onWarn).not.toHaveBeenCalled();
    });

    it('tolerates un-stringifiable and undefined component fields without throwing', () => {
      const { detector } = makeDetector();
      detector.componentTracking = true;
      detector.beginFrame();
      const circular: Record<string, unknown> = {};
      circular.self = circular; // JSON.stringify throws → stableField falls back
      const comp = {
        constructor: { name: 'Weird' },
        data: { loop: circular, u: undefined } as Record<string, unknown>,
        toJSON() {
          return this.data;
        },
      };
      const e = { id: 'w', getComponents: () => [comp] };
      expect(() => {
        const s = detector.snapshotComponents([e]);
        detector.diffComponents([e], s, 'S');
      }).not.toThrow();
    });

    it('resets between frames so a legit cross-frame handoff does not warn', () => {
      const { detector, onWarn } = makeDetector();
      detector.componentTracking = true;
      const e = makeEntity('e', { C: { x: 0 } });

      detector.beginFrame();
      detector.setCurrentSystem('A');
      const s1 = detector.snapshotComponents([e]);
      e.set('C', 'x', 1);
      detector.diffComponents([e], s1, 'A');

      detector.beginFrame();
      detector.setCurrentSystem('B');
      const s2 = detector.snapshotComponents([e]);
      e.set('C', 'x', 2);
      detector.diffComponents([e], s2, 'B');

      expect(onWarn).not.toHaveBeenCalled();
    });
  });
});
