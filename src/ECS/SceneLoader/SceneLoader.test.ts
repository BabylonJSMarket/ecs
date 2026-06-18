import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SceneLoader,
  SceneData,
  SceneLoaderEvents,
  Component,
  System,
  World,
  EventBus,
} from '..';

// Test components
class PositionComponent extends Component {
  x: number = 0;
  y: number = 0;
  z: number = 0;

  constructor(data: { x?: number; y?: number; z?: number } = {}) {
    super();
    this.x = data.x ?? 0;
    this.y = data.y ?? 0;
    this.z = data.z ?? 0;
  }

  toJSON() {
    return { x: this.x, y: this.y, z: this.z };
  }
}

class VelocityComponent extends Component {
  vx: number = 0;
  vy: number = 0;
  vz: number = 0;

  constructor(data: { vx?: number; vy?: number; vz?: number } = {}) {
    super();
    this.vx = data.vx ?? 0;
    this.vy = data.vy ?? 0;
    this.vz = data.vz ?? 0;
  }

  toJSON() {
    return { vx: this.vx, vy: this.vy, vz: this.vz };
  }
}

class HealthComponent extends Component {
  current: number = 100;
  max: number = 100;

  constructor(data: { current?: number; max?: number } = {}) {
    super();
    this.current = data.current ?? 100;
    this.max = data.max ?? 100;
  }
}

// Component WITHOUT toJSON method - for testing fallback serialization
class SimpleComponent extends Component {
  value: number = 0;
  name: string = '';
  _privateField: string = 'should not serialize';

  constructor(data: { value?: number; name?: string } = {}) {
    super();
    this.value = data.value ?? 0;
    this.name = data.name ?? '';
  }

  // A method that should not be serialized
  doSomething(): void {
    // no-op
  }
}

// Component with complex data types for testing processComponentData
class ComplexDataComponent extends Component {
  items: number[] = [];
  nested: { x: number; y: number } = { x: 0, y: 0 };
  primitiveValue: number = 0;

  constructor(data: { items?: number[]; nested?: { x: number; y: number }; primitiveValue?: number } = {}) {
    super();
    this.items = data.items ?? [];
    this.nested = data.nested ?? { x: 0, y: 0 };
    this.primitiveValue = data.primitiveValue ?? 0;
  }
}

// Component that accepts raw array data
class ArrayDataComponent extends Component {
  data: number[] = [];

  constructor(data: number[] | { data?: number[] } = []) {
    super();
    if (Array.isArray(data)) {
      this.data = data;
    } else {
      this.data = data.data ?? [];
    }
  }
}

// Component that accepts primitive data
class PrimitiveDataComponent extends Component {
  value: number = 0;

  constructor(data: number | { value?: number } = 0) {
    super();
    if (typeof data === 'number') {
      this.value = data;
    } else {
      this.value = data.value ?? 0;
    }
  }
}

// Component that handles null/undefined data
class NullableDataComponent extends Component {
  initialized: boolean = false;

  constructor(data: any = null) {
    super();
    // If data is null/undefined, component uses defaults
    this.initialized = data === null || data === undefined ? false : true;
  }
}

class MovementSystem extends System {
  constructor(eventBus: EventBus) {
    super(eventBus);
    this.query = { required: [PositionComponent, VelocityComponent] };
  }

  protected onUpdate(deltaTime: number): void {
    for (const entity of this.entities) {
      const pos = entity.get(PositionComponent)!;
      const vel = entity.get(VelocityComponent)!;
      pos.x += vel.vx * deltaTime;
      pos.y += vel.vy * deltaTime;
      pos.z += vel.vz * deltaTime;
    }
  }
}

describe('SceneLoader', () => {
  let eventBus: EventBus;
  let sceneLoader: SceneLoader;
  let world: World;

  beforeEach(() => {
    eventBus = new EventBus();
    sceneLoader = new SceneLoader(eventBus);
    world = new World({ eventBus });

    // Register test components
    sceneLoader.registerComponent('Position', PositionComponent);
    sceneLoader.registerComponent('Velocity', VelocityComponent, MovementSystem);
    sceneLoader.registerComponent('Health', HealthComponent);
    sceneLoader.registerComponent('ComplexData', ComplexDataComponent);
    sceneLoader.registerComponent('ArrayData', ArrayDataComponent);
    sceneLoader.registerComponent('PrimitiveData', PrimitiveDataComponent);
    sceneLoader.registerComponent('NullableData', NullableDataComponent);
  });

  describe('component registration', () => {
    it('should register a component', () => {
      expect(sceneLoader.getComponentClass('Position')).toBe(PositionComponent);
    });

    it('should register a component with system', () => {
      expect(sceneLoader.getSystemClass('Velocity')).toBe(MovementSystem);
    });

    it('should return undefined for unregistered component', () => {
      expect(sceneLoader.getComponentClass('Unknown')).toBeUndefined();
    });

    it('should register multiple components', () => {
      const loader = new SceneLoader(eventBus);
      loader.registerComponents({
        Position: { component: PositionComponent },
        Velocity: { component: VelocityComponent, system: MovementSystem },
      });

      expect(loader.getComponentClass('Position')).toBe(PositionComponent);
      expect(loader.getSystemClass('Velocity')).toBe(MovementSystem);
    });
  });

  describe('loadSceneFromData', () => {
    it('should load scene data', () => {
      const sceneData: SceneData = {
        name: 'TestScene',
        entities: {
          player: {
            components: {
              Position: { x: 10, y: 20, z: 30 },
            },
          },
        },
      };

      const loaded = sceneLoader.loadSceneFromData(sceneData);
      expect(loaded.name).toBe('TestScene');
      expect(sceneLoader.isSceneLoaded('TestScene')).toBe(true);
    });

    it('should emit LOADED event', () => {
      const handler = vi.fn();
      eventBus.on(SceneLoaderEvents.LOADED, handler);

      sceneLoader.loadSceneFromData({
        name: 'TestScene',
        entities: { player: { components: {} } },
      });

      expect(handler).toHaveBeenCalledWith({
        name: 'TestScene',
        entityCount: 1,
      });
    });
  });

  describe('instantiateScene', () => {
    const testScene: SceneData = {
      name: 'GameScene',
      worldEntity: 'world',
      entities: {
        world: {
          components: {},
          tags: ['global'],
        },
        player: {
          components: {
            Position: { x: 0, y: 0, z: 0 },
            Velocity: { vx: 1, vy: 0, vz: 0 },
            Health: { current: 100, max: 100 },
          },
          tags: ['player', 'controllable'],
        },
        enemy: {
          components: {
            Position: { x: 50, y: 0, z: 50 },
            Health: { current: 50, max: 50 },
          },
          tags: ['enemy'],
        },
      },
    };

    beforeEach(() => {
      sceneLoader.loadSceneFromData(testScene);
    });

    it('should create entities', () => {
      const result = sceneLoader.instantiateScene('GameScene', world);
      expect(result.entities.size).toBe(3);
      expect(result.entities.has('player')).toBe(true);
      expect(result.entities.has('enemy')).toBe(true);
      expect(result.entities.has('world')).toBe(true);
    });

    it('should add components to entities', () => {
      const result = sceneLoader.instantiateScene('GameScene', world);
      const player = result.entities.get('player')!;

      expect(player.has(PositionComponent)).toBe(true);
      expect(player.has(VelocityComponent)).toBe(true);
      expect(player.has(HealthComponent)).toBe(true);
    });

    it('should set component data correctly', () => {
      const result = sceneLoader.instantiateScene('GameScene', world);
      const enemy = result.entities.get('enemy')!;
      const pos = enemy.get(PositionComponent)!;
      const health = enemy.get(HealthComponent)!;

      expect(pos.x).toBe(50);
      expect(pos.z).toBe(50);
      expect(health.current).toBe(50);
      expect(health.max).toBe(50);
    });

    it('should add tags to entities', () => {
      const result = sceneLoader.instantiateScene('GameScene', world);
      const player = result.entities.get('player')!;

      expect(player.hasTag('player')).toBe(true);
      expect(player.hasTag('controllable')).toBe(true);
      expect(player.hasTag('enemy')).toBe(false);
    });

    it('should identify world entity', () => {
      const result = sceneLoader.instantiateScene('GameScene', world);
      expect(result.worldEntity).toBeDefined();
      expect(result.worldEntity!.id).toBe('world');
    });

    it('should create systems', () => {
      const result = sceneLoader.instantiateScene('GameScene', world);
      expect(result.systems.length).toBeGreaterThan(0);
      expect(result.systems.some(s => s instanceof MovementSystem)).toBe(true);
    });

    it('should not create systems when disabled', () => {
      const result = sceneLoader.instantiateScene('GameScene', world, {
        createSystems: false,
      });
      expect(result.systems.length).toBe(0);
    });

    it('should emit ENTITY_CREATED events', () => {
      const handler = vi.fn();
      eventBus.on(SceneLoaderEvents.ENTITY_CREATED, handler);

      sceneLoader.instantiateScene('GameScene', world);
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('should emit COMPONENT_LOADED events', () => {
      const handler = vi.fn();
      eventBus.on(SceneLoaderEvents.COMPONENT_LOADED, handler);

      sceneLoader.instantiateScene('GameScene', world);
      // player: 3 components, enemy: 2 components, world: 0 = 5 total
      expect(handler).toHaveBeenCalledTimes(5);
    });

    it('should emit SYSTEM_CREATED events', () => {
      const handler = vi.fn();
      eventBus.on(SceneLoaderEvents.SYSTEM_CREATED, handler);

      sceneLoader.instantiateScene('GameScene', world);
      expect(handler).toHaveBeenCalled();
    });

    it('should throw for unloaded scene', () => {
      expect(() => {
        sceneLoader.instantiateScene('NonExistent', world);
      }).toThrow('Scene not loaded: NonExistent');
    });

    it('should warn for unregistered components', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const sceneWithUnknown: SceneData = {
        name: 'UnknownScene',
        entities: {
          entity1: {
            components: {
              UnknownComponent: { value: 1 },
            },
          },
        },
      };

      sceneLoader.loadSceneFromData(sceneWithUnknown);
      sceneLoader.instantiateScene('UnknownScene', world);

      expect(warnSpy).toHaveBeenCalledWith('Component not registered: UnknownComponent');
      warnSpy.mockRestore();
    });

    it('should process component data with arrays and nested objects', () => {
      const sceneWithComplexData: SceneData = {
        name: 'ComplexScene',
        entities: {
          entity1: {
            components: {
              ComplexData: {
                items: [1, 2, 3],
                nested: { x: 10, y: 20 },
                primitiveValue: 42,
              },
            },
          },
        },
      };

      sceneLoader.loadSceneFromData(sceneWithComplexData);
      const result = sceneLoader.instantiateScene('ComplexScene', world);
      const entity = result.entities.get('entity1')!;
      const component = entity.get(ComplexDataComponent)!;

      expect(component.items).toEqual([1, 2, 3]);
      expect(component.nested).toEqual({ x: 10, y: 20 });
      expect(component.primitiveValue).toBe(42);
    });

    it('should override world entity name via options', () => {
      const sceneData: SceneData = {
        name: 'TestScene',
        worldEntity: 'defaultWorld',
        entities: {
          defaultWorld: { components: {}, tags: ['default'] },
          customWorld: { components: {}, tags: ['custom'] },
        },
      };

      sceneLoader.loadSceneFromData(sceneData);
      const result = sceneLoader.instantiateScene('TestScene', world, {
        worldEntityName: 'customWorld',
      });

      expect(result.worldEntity).toBeDefined();
      expect(result.worldEntity!.id).toBe('customWorld');
      expect(result.worldEntity!.hasTag('custom')).toBe(true);
    });

    it('should handle component data that is a raw array', () => {
      const sceneWithArrayData: SceneData = {
        name: 'ArrayScene',
        entities: {
          entity1: {
            components: {
              ArrayData: [1, 2, 3, 4, 5],
            },
          },
        },
      };

      sceneLoader.loadSceneFromData(sceneWithArrayData);
      const result = sceneLoader.instantiateScene('ArrayScene', world);
      const entity = result.entities.get('entity1')!;
      const component = entity.get(ArrayDataComponent)!;

      expect(component.data).toEqual([1, 2, 3, 4, 5]);
    });

    it('should handle component data that is a primitive', () => {
      const sceneWithPrimitiveData: SceneData = {
        name: 'PrimitiveScene',
        entities: {
          entity1: {
            components: {
              PrimitiveData: 42,
            },
          },
        },
      };

      sceneLoader.loadSceneFromData(sceneWithPrimitiveData);
      const result = sceneLoader.instantiateScene('PrimitiveScene', world);
      const entity = result.entities.get('entity1')!;
      const component = entity.get(PrimitiveDataComponent)!;

      expect(component.value).toBe(42);
    });

    it('should handle component data that is null', () => {
      const sceneWithNullData: SceneData = {
        name: 'NullScene',
        entities: {
          entity1: {
            components: {
              NullableData: null,
            },
          },
        },
      };

      sceneLoader.loadSceneFromData(sceneWithNullData);
      const result = sceneLoader.instantiateScene('NullScene', world);
      const entity = result.entities.get('entity1')!;
      const component = entity.get(NullableDataComponent)!;

      expect(component.initialized).toBe(false);
    });
  });

  describe('scene management', () => {
    it('should get loaded scene data', () => {
      const sceneData: SceneData = {
        name: 'TestScene',
        entities: {},
      };

      sceneLoader.loadSceneFromData(sceneData);
      expect(sceneLoader.getSceneData('TestScene')).toEqual(sceneData);
    });

    it('should get entity data from loaded scenes', () => {
      const sceneData: SceneData = {
        name: 'TestScene',
        entities: {
          player: {
            components: {
              Position: { x: 10, y: 20, z: 30 },
            },
            tags: ['player'],
          },
          enemy: {
            components: {
              Health: { current: 50, max: 100 },
            },
          },
        },
      };

      sceneLoader.loadSceneFromData(sceneData);

      const playerData = sceneLoader.getEntityData('player');
      expect(playerData).toBeDefined();
      expect(playerData!.components['Position']).toEqual({ x: 10, y: 20, z: 30 });
      expect(playerData!.tags).toContain('player');

      const enemyData = sceneLoader.getEntityData('enemy');
      expect(enemyData).toBeDefined();
      expect(enemyData!.components['Health']).toEqual({ current: 50, max: 100 });
    });

    it('should return undefined for non-existent entity data', () => {
      sceneLoader.loadSceneFromData({
        name: 'TestScene',
        entities: {
          player: { components: {} },
        },
      });

      expect(sceneLoader.getEntityData('nonexistent')).toBeUndefined();
    });

    it('should search across multiple loaded scenes for entity data', () => {
      sceneLoader.loadSceneFromData({
        name: 'Scene1',
        entities: {
          player: { components: { Position: { x: 1 } } },
        },
      });

      sceneLoader.loadSceneFromData({
        name: 'Scene2',
        entities: {
          enemy: { components: { Health: { current: 100 } } },
        },
      });

      expect(sceneLoader.getEntityData('player')).toBeDefined();
      expect(sceneLoader.getEntityData('enemy')).toBeDefined();
      expect(sceneLoader.getEntityData('notfound')).toBeUndefined();
    });

    it('should check if scene is loaded', () => {
      expect(sceneLoader.isSceneLoaded('TestScene')).toBe(false);

      sceneLoader.loadSceneFromData({ name: 'TestScene', entities: {} });
      expect(sceneLoader.isSceneLoaded('TestScene')).toBe(true);
    });

    it('should unload scene', () => {
      sceneLoader.loadSceneFromData({ name: 'TestScene', entities: {} });
      expect(sceneLoader.unloadScene('TestScene')).toBe(true);
      expect(sceneLoader.isSceneLoaded('TestScene')).toBe(false);
    });

    it('should return false when unloading non-existent scene', () => {
      expect(sceneLoader.unloadScene('NonExistent')).toBe(false);
    });

    it('should get loaded scene names', () => {
      sceneLoader.loadSceneFromData({ name: 'Scene1', entities: {} });
      sceneLoader.loadSceneFromData({ name: 'Scene2', entities: {} });

      const names = sceneLoader.getLoadedSceneNames();
      expect(names).toContain('Scene1');
      expect(names).toContain('Scene2');
      expect(names.length).toBe(2);
    });
  });

  describe('serializeWorld', () => {
    it('should serialize world entities', () => {
      // Create entities in world
      const player = world.createEntity('player');
      player.add(new PositionComponent({ x: 10, y: 20, z: 30 }));
      player.addTag('player');

      const enemy = world.createEntity('enemy');
      enemy.add(new PositionComponent({ x: 50, y: 0, z: 50 }));
      enemy.add(new HealthComponent({ current: 75, max: 100 }));

      const sceneData = sceneLoader.serializeWorld(world, 'SerializedScene');

      expect(sceneData.name).toBe('SerializedScene');
      expect(sceneData.entities['player']).toBeDefined();
      expect(sceneData.entities['enemy']).toBeDefined();
    });

    it('should serialize component data', () => {
      const entity = world.createEntity('test');
      entity.add(new PositionComponent({ x: 1, y: 2, z: 3 }));

      const sceneData = sceneLoader.serializeWorld(world, 'Test');
      const posData = sceneData.entities['test'].components['Position'];

      expect(posData).toEqual({ x: 1, y: 2, z: 3 });
    });

    it('should serialize tags', () => {
      const entity = world.createEntity('test');
      entity.addTag('tag1');
      entity.addTag('tag2');

      const sceneData = sceneLoader.serializeWorld(world, 'Test');
      expect(sceneData.entities['test'].tags).toContain('tag1');
      expect(sceneData.entities['test'].tags).toContain('tag2');
    });

    it('should use fallback serialization for components without toJSON', () => {
      const entity = world.createEntity('test');
      const component = new SimpleComponent({ value: 42, name: 'test-component' });
      // Delete toJSON to force fallback serialization path
      (component as any).toJSON = undefined;
      // Assign a function as an *own enumerable* property — Object.entries()
      // sees this (unlike a prototype method), exercising the function-skip
      // branch in the default serializer.
      (component as any).callback = () => 'live behaviour, not data';
      entity.add(component);

      const sceneData = sceneLoader.serializeWorld(world, 'Test');
      const componentData = sceneData.entities['test'].components['Simple'];

      // Should include public properties
      expect(componentData.value).toBe(42);
      expect(componentData.name).toBe('test-component');

      // Should NOT include private properties (starting with _)
      expect(componentData._privateField).toBeUndefined();

      // Should NOT include methods — neither prototype methods nor an
      // own-enumerable function property survive serialization.
      expect(componentData.doSomething).toBeUndefined();
      expect(componentData.callback).toBeUndefined();
    });
  });

  describe('loadSceneFromUrl', () => {
    it('should emit LOADING event', async () => {
      const handler = vi.fn();
      eventBus.on(SceneLoaderEvents.LOADING, handler);

      // Mock fetch to fail (we just want to test the event)
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      try {
        await sceneLoader.loadSceneFromUrl('/test.json');
      } catch {
        // Expected to fail
      }

      expect(handler).toHaveBeenCalledWith({ url: '/test.json' });
    });

    it('should emit ERROR event on failure', async () => {
      const handler = vi.fn();
      eventBus.on(SceneLoaderEvents.ERROR, handler);

      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      await expect(sceneLoader.loadSceneFromUrl('/test.json')).rejects.toThrow();

      expect(handler).toHaveBeenCalledWith({
        url: '/test.json',
        error: 'Network error',
      });
    });

    it('stringifies a non-Error rejection in the ERROR event', async () => {
      const handler = vi.fn();
      eventBus.on(SceneLoaderEvents.ERROR, handler);

      // A thrown non-Error (e.g. a bare string) must still produce a usable
      // error string rather than "[object Object]"/undefined.
      global.fetch = vi.fn().mockRejectedValue('plain string failure');

      await expect(sceneLoader.loadSceneFromUrl('/test.json')).rejects.toBe(
        'plain string failure'
      );

      expect(handler).toHaveBeenCalledWith({
        url: '/test.json',
        error: 'plain string failure',
      });
    });

    it('should load scene from successful fetch', async () => {
      const mockScene: SceneData = {
        name: 'RemoteScene',
        entities: {
          player: {
            components: {
              Position: { x: 1, y: 2, z: 3 },
            },
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockScene),
      });

      const result = await sceneLoader.loadSceneFromUrl('/scenes/test.json');

      expect(result.name).toBe('RemoteScene');
      expect(sceneLoader.isSceneLoaded('RemoteScene')).toBe(true);
    });

    it('should throw on HTTP error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      await expect(sceneLoader.loadSceneFromUrl('/missing.json')).rejects.toThrow(
        'Failed to load scene: /missing.json (404)'
      );
    });
  });
});

describe('SceneLoaderEvents', () => {
  it('should have correct event names', () => {
    expect(SceneLoaderEvents.LOADING).toBe('sceneloader.loading');
    expect(SceneLoaderEvents.LOADED).toBe('sceneloader.loaded');
    expect(SceneLoaderEvents.ERROR).toBe('sceneloader.error');
    expect(SceneLoaderEvents.ENTITY_CREATED).toBe('sceneloader.entity.created');
    expect(SceneLoaderEvents.COMPONENT_LOADED).toBe('sceneloader.component.loaded');
    expect(SceneLoaderEvents.SYSTEM_CREATED).toBe('sceneloader.system.created');
  });
});
