# Testing

The biggest practical win of an ECS: **your game logic runs in vitest**. No headless browser, no WebGL stub, no Puppeteer. Game code that runs in vitest is game code that runs anywhere.

## The setup

The framework's `MockRendererAdapter` is a `RendererAdapter` that records every call. Construct it, hand it to a World, drive the game, assert against the recorded calls.

```ts
// my-game.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { World, MockRendererAdapter } from '@babylonjsmarket/ecs';
import { Velocity, MoveSystem } from './my-game';

describe('MoveSystem', () => {
  let world: World;
  let renderer: MockRendererAdapter;

  beforeEach(() => {
    renderer = new MockRendererAdapter();
    world = new World({ renderer });
    world.addSystem(new MoveSystem(world.getEventBus()));
  });

  it('integrates velocity into position', () => {
    const e = world.createEntity('test');
    const v = new Velocity();
    v.x = 5;
    e.add(v);

    world.update(1);  // 1 second

    // assert position changed, renderer was told to draw, events fired, etc.
  });
});
```

No mocks, no spies on renderer methods — `MockRendererAdapter` already records everything in `renderer.calls`:

```ts
expect(renderer.calls.createMesh).toHaveLength(1);
expect(renderer.calls.setMeshPosition).toHaveLength(1);
expect(renderer.calls.setMeshPosition[0]).toEqual([handle, 5, 0, 0]);
```

## Vitest config

The package's own tests run with jsdom — same config works for your game:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['**/*.test.ts'],
  },
});
```

You don't need Solid plugin or anything else for plain ECS tests. If you're testing viz panels (Solid.js debug UI), add `vite-plugin-solid`.

## Asserting events

Systems coordinate via events. Test that the right events fire with the right payloads:

```ts
it('emits damage.dealt when bullet hits enemy', () => {
  const events: Array<[string, unknown]> = [];
  world.getEventBus().on('damage.dealt', (data) => events.push(['damage.dealt', data]));

  // ...set up bullet + enemy, tick

  expect(events).toContainEqual(['damage.dealt', { targetId: enemyId, amount: 10 }]);
});
```

## Time-based tests

Pass arbitrary `dt` values to `world.update`:

```ts
world.update(0.016);  // one frame at 60fps
world.update(1);       // one second of simulation
world.update(0.000001); // edge case: tiny tick
```

The simulation is deterministic — same starting state, same `dt`s, same outcome. Use this to reproduce bugs that take a long real-time replay:

```ts
// Reproduce 10 seconds of gameplay in 10ms of test time
for (let i = 0; i < 600; i++) world.update(1 / 60);
```

## Loading scenes in tests

The `SceneLoader` works in tests just like in production:

```ts
import scene from './fixtures/level1.json' assert { type: 'json' };

beforeEach(() => {
  world.sceneLoader.registerComponent('Velocity', Velocity, MoveSystem);
  world.sceneLoader.loadSceneFromData(scene);
  const { systems } = world.sceneLoader.instantiateScene('Level1', world);
  for (const s of systems) world.addSystem(s);
});
```

This is how you test that a scene file parses correctly, that all the components register, that the right entities materialize.

## The contract test

The `@babylonjsmarket/ecs/testing` subpath exports `runMechanicContract` — a shared vitest battery that proves a mechanic obeys the framework contract.

```ts
import { describe } from 'vitest';
import { runMechanicContract } from '@babylonjsmarket/ecs/testing';
import { Velocity, MoveSystem, VelocityEvents, VelocityInputEvents } from './my-game';

describe('Velocity contract', () => {
  runMechanicContract({
    name: 'Velocity',
    ComponentClass: Velocity,
    SystemClass: MoveSystem,
    events: VelocityEvents,
    inputEvents: VelocityInputEvents,
  });
});
```

What it asserts:
- The Component class instantiates with no arguments
- The System's query is well-formed
- Lifecycle hooks (`onEntityAdded`, `onEntityRemoved`, `onUpdate`) don't throw on edge cases
- Events listed in `VelocityEvents` actually emit during normal operation
- The component round-trips through `serialize()` correctly

It's a fast way to catch regressions when refactoring a component. Add it for every component you write — it pays for itself the first time you accidentally break the contract.

## Test patterns to copy

Run the package's own tests for reference:

```bash
cd packages/ecs
npm test
```

390+ tests across 10 files. Patterns to lift:
- `World.test.ts` — entity lifecycle, system mgmt
- `World.query.test.ts` — query matching edge cases
- `EventBus.test.ts` — pub/sub corner cases
- `SaveLoad.test.ts` — serialization round trips
- `RaceDetector.integration.test.ts` — multi-system race tests with the Proxy

## What you don't need to test

- The framework itself — the package's own tests cover World, Component, Entity, System, EventBus, SceneLoader, RaceDetector.
- Renderer internals — Babylon's correctness is Babylon's problem. Use `MockRendererAdapter` to assert your Systems called the right adapter methods; that's enough.
- Rendering output — pixel-level rendering tests belong in integration / e2e, not vitest. Use Cypress or Playwright when you need them.

What you **do** need to test: the per-game Systems and Components you wrote. Those are what break.
