import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  SaveLoadComponent,
  SaveLoadSystem,
  SaveLoadEvents,
  SaveSlot,
} from './SaveLoad';
import { Component, EventBus, World, SceneLoader, Entity } from '..';

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

class HealthComponent extends Component {
  current: number = 100;
  max: number = 100;

  constructor(data: { current?: number; max?: number } = {}) {
    super();
    this.current = data.current ?? 100;
    this.max = data.max ?? 100;
  }

  toJSON() {
    return { current: this.current, max: this.max };
  }
}

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(global, 'localStorage', { value: localStorageMock });

describe('SaveLoadComponent', () => {
  let component: SaveLoadComponent;

  beforeEach(() => {
    component = new SaveLoadComponent();
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      expect(component.autoSaveEnabled).toBe(false);
      expect(component.autoSaveInterval).toBe(60);
      expect(component.maxSlots).toBe(10);
      expect(component.storageKey).toBe('saveload');
      expect(component.autoSaveSlot).toBe('autosave');
      expect(component.lastSaveTime).toBe(0);
      expect(component.currentSlot).toBeNull();
      expect(component.slots.size).toBe(0);
    });

    it('should initialize with custom values', () => {
      const customComponent = new SaveLoadComponent({
        autoSaveEnabled: true,
        autoSaveInterval: 120,
        maxSlots: 5,
        storageKey: 'myGame',
        autoSaveSlot: 'quicksave',
      });

      expect(customComponent.autoSaveEnabled).toBe(true);
      expect(customComponent.autoSaveInterval).toBe(120);
      expect(customComponent.maxSlots).toBe(5);
      expect(customComponent.storageKey).toBe('myGame');
      expect(customComponent.autoSaveSlot).toBe('quicksave');
    });

    it('should load initial slots from data', () => {
      const slots: Record<string, SaveSlot> = {
        slot1: {
          name: 'slot1',
          timestamp: 1000,
          sceneData: { name: 'slot1', entities: {} },
        },
        slot2: {
          name: 'slot2',
          timestamp: 2000,
          sceneData: { name: 'slot2', entities: {} },
        },
      };

      const componentWithSlots = new SaveLoadComponent({ slots });

      expect(componentWithSlots.slots.size).toBe(2);
      expect(componentWithSlots.hasSlot('slot1')).toBe(true);
      expect(componentWithSlots.hasSlot('slot2')).toBe(true);
    });
  });

  describe('slot management', () => {
    beforeEach(() => {
      component.slots.set('slot1', {
        name: 'slot1',
        timestamp: 1000,
        sceneData: { name: 'slot1', entities: {} },
      });
      component.slots.set('slot2', {
        name: 'slot2',
        timestamp: 3000,
        sceneData: { name: 'slot2', entities: {} },
      });
      component.slots.set('slot3', {
        name: 'slot3',
        timestamp: 2000,
        sceneData: { name: 'slot3', entities: {} },
      });
    });

    it('should check if slot exists', () => {
      expect(component.hasSlot('slot1')).toBe(true);
      expect(component.hasSlot('nonexistent')).toBe(false);
    });

    it('should get slot by name', () => {
      const slot = component.getSlot('slot1');
      expect(slot).toBeDefined();
      expect(slot?.name).toBe('slot1');
      expect(slot?.timestamp).toBe(1000);
    });

    it('should return slot names sorted by timestamp (most recent first)', () => {
      const names = component.getSlotNames();
      expect(names).toEqual(['slot2', 'slot3', 'slot1']);
    });
  });

  describe('serialization', () => {
    it('should serialize configuration', () => {
      component.autoSaveEnabled = true;
      component.autoSaveInterval = 90;
      component.maxSlots = 8;

      const serialized = component.serialize();

      expect(serialized.autoSaveEnabled).toBe(true);
      expect(serialized.autoSaveInterval).toBe(90);
      expect(serialized.maxSlots).toBe(8);
      expect(serialized.storageKey).toBe('saveload');
    });

    it('should be reconstructable from serialized data', () => {
      component.autoSaveEnabled = true;
      component.autoSaveInterval = 90;

      const serialized = component.serialize();
      const reconstructed = new SaveLoadComponent(serialized);

      expect(reconstructed.autoSaveEnabled).toBe(component.autoSaveEnabled);
      expect(reconstructed.autoSaveInterval).toBe(component.autoSaveInterval);
    });

    it('should convert slots map to object in toJSON', () => {
      component.slots.set('test', {
        name: 'test',
        timestamp: 1234,
        sceneData: { name: 'test', entities: {} },
      });

      const json = component.toJSON();

      expect(json.slots).toBeDefined();
      expect(json.slots.test).toBeDefined();
      expect(json.slots.test.name).toBe('test');
    });
  });
});

describe('SaveLoadSystem', () => {
  let eventBus: EventBus;
  let world: World;
  let sceneLoader: SceneLoader;
  let system: SaveLoadSystem;
  let saveManager: Entity;

  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();

    eventBus = new EventBus();
    sceneLoader = new SceneLoader(eventBus);
    world = new World({ eventBus, sceneLoader });

    // Register test components
    sceneLoader.registerComponent('Position', PositionComponent);
    sceneLoader.registerComponent('Health', HealthComponent);
    sceneLoader.registerComponent('SaveLoad', SaveLoadComponent);

    // Create save manager entity
    saveManager = world.createEntity('saveManager');
    saveManager.add(new SaveLoadComponent({ storageKey: 'test' }));

    // Create and add system
    system = new SaveLoadSystem(eventBus);
    world.addSystem(system);

    // Initialize world
    world.initialize();
  });

  afterEach(() => {
    world.destroy();
  });

  describe('initialization', () => {
    it('should find SaveLoadComponent', () => {
      expect((system as any).component).toBeDefined();
      expect((system as any).component).toBeInstanceOf(SaveLoadComponent);
    });

    it('should not be pauseable', () => {
      expect(system.pauseable).toBe(false);
    });
  });

  describe('saveToSlot', () => {
    beforeEach(() => {
      // Create some entities to save
      const player = world.createEntity('player');
      player.add(new PositionComponent({ x: 10, y: 20, z: 30 }));
      player.add(new HealthComponent({ current: 75, max: 100 }));
      player.addTag('player');

      const enemy = world.createEntity('enemy');
      enemy.add(new PositionComponent({ x: 50, y: 0, z: 50 }));
    });

    it('should save world state to a slot', () => {
      const result = system.saveToSlot('slot1');

      expect(result).toBe(true);

      const slot = system.getSlot('slot1');
      expect(slot).toBeDefined();
      expect(slot?.sceneData.entities['player']).toBeDefined();
      expect(slot?.sceneData.entities['enemy']).toBeDefined();
    });

    it('should save component data correctly', () => {
      system.saveToSlot('slot1');

      const slot = system.getSlot('slot1');
      const playerData = slot?.sceneData.entities['player'];

      expect(playerData?.components['Position']).toEqual({ x: 10, y: 20, z: 30 });
      expect(playerData?.components['Health']).toEqual({ current: 75, max: 100 });
    });

    it('should save tags', () => {
      system.saveToSlot('slot1');

      const slot = system.getSlot('slot1');
      expect(slot?.sceneData.entities['player'].tags).toContain('player');
    });

    it('should save metadata', () => {
      system.saveToSlot('slot1', { level: 5, playtime: 3600 });

      const slot = system.getSlot('slot1');
      expect(slot?.metadata?.level).toBe(5);
      expect(slot?.metadata?.playtime).toBe(3600);
    });

    it('should update lastSaveTime', () => {
      const component = (system as any).component as SaveLoadComponent;
      const before = component.lastSaveTime;

      system.saveToSlot('slot1');

      expect(component.lastSaveTime).toBeGreaterThan(before);
    });

    it('should update currentSlot', () => {
      const component = (system as any).component as SaveLoadComponent;

      system.saveToSlot('slot1');

      expect(component.currentSlot).toBe('slot1');
    });

    it('should emit SAVING event', () => {
      const handler = vi.fn();
      eventBus.on(SaveLoadEvents.SAVING, handler);

      system.saveToSlot('slot1');

      expect(handler).toHaveBeenCalledWith({ slotName: 'slot1' });
    });

    it('should emit SAVED event', () => {
      const handler = vi.fn();
      eventBus.on(SaveLoadEvents.SAVED, handler);

      system.saveToSlot('slot1');

      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].slotName).toBe('slot1');
      expect(handler.mock.calls[0][0].timestamp).toBeDefined();
    });

    it('should emit SLOT_CREATED for new slots', () => {
      const handler = vi.fn();
      eventBus.on(SaveLoadEvents.SLOT_CREATED, handler);

      system.saveToSlot('newSlot');

      expect(handler).toHaveBeenCalledWith({ slotName: 'newSlot' });
    });

    it('should not emit SLOT_CREATED when overwriting', () => {
      system.saveToSlot('slot1');

      const handler = vi.fn();
      eventBus.on(SaveLoadEvents.SLOT_CREATED, handler);

      system.saveToSlot('slot1'); // Overwrite

      expect(handler).not.toHaveBeenCalled();
    });

    it('should fail when max slots reached', () => {
      const component = (system as any).component as SaveLoadComponent;
      component.maxSlots = 2;

      system.saveToSlot('slot1');
      system.saveToSlot('slot2');

      const errorHandler = vi.fn();
      eventBus.on(SaveLoadEvents.ERROR, errorHandler);

      const result = system.saveToSlot('slot3');

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should allow overwriting existing slot even at max', () => {
      const component = (system as any).component as SaveLoadComponent;
      component.maxSlots = 2;

      system.saveToSlot('slot1');
      system.saveToSlot('slot2');

      const result = system.saveToSlot('slot1'); // Overwrite existing

      expect(result).toBe(true);
    });

    it('should emit error when save operation throws', () => {
      // Mock sceneLoader.serializeWorld to throw an error
      const originalSerializeWorld = sceneLoader.serializeWorld.bind(sceneLoader);
      sceneLoader.serializeWorld = vi.fn(() => {
        throw new Error('Serialization failed');
      });

      const errorHandler = vi.fn();
      eventBus.on(SaveLoadEvents.ERROR, errorHandler);

      const result = system.saveToSlot('slot1');

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalledWith({
        error: 'Failed to save: Serialization failed',
      });

      // Restore original
      sceneLoader.serializeWorld = originalSerializeWorld;
    });

    it('should fail when system has no component', () => {
      // Create a system without a component
      const eventBus2 = new EventBus();
      const system2 = new SaveLoadSystem(eventBus2);
      // Don't add to world or initialize - component will be null

      const errorHandler = vi.fn();
      eventBus2.on(SaveLoadEvents.ERROR, errorHandler);

      const result = system2.saveToSlot('slot1');

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalledWith({
        error: 'No SaveLoadComponent or World available',
      });
    });

    it('should fail when world has no sceneLoader for save', () => {
      // Create a world without a sceneLoader
      const eventBus2 = new EventBus();
      const world2 = new World({ eventBus: eventBus2 });

      const saveManager2 = world2.createEntity('saveManager2');
      saveManager2.add(new SaveLoadComponent({ storageKey: 'test2' }));

      const system2 = new SaveLoadSystem(eventBus2);
      world2.addSystem(system2);
      world2.initialize();

      const errorHandler = vi.fn();
      eventBus2.on(SaveLoadEvents.ERROR, errorHandler);

      const result = system2.saveToSlot('slot1');

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalledWith({
        error: 'World does not have a SceneLoader configured',
      });

      world2.destroy();
    });
  });

  describe('loadFromSlot', () => {
    beforeEach(() => {
      // Create initial entities
      const player = world.createEntity('player');
      player.add(new PositionComponent({ x: 10, y: 20, z: 30 }));

      // Save the state
      system.saveToSlot('slot1');

      // Modify the player
      const modifiedPlayer = world.getEntity('player');
      const pos = modifiedPlayer?.get(PositionComponent);
      if (pos) pos.x = 999;
    });

    it('should load saved state', () => {
      const result = system.loadFromSlot('slot1');

      expect(result).toBe(true);
    });

    it('should emit LOADING event', () => {
      const handler = vi.fn();
      eventBus.on(SaveLoadEvents.LOADING, handler);

      system.loadFromSlot('slot1');

      expect(handler).toHaveBeenCalledWith({ slotName: 'slot1' });
    });

    it('should emit LOADED event', () => {
      const handler = vi.fn();
      eventBus.on(SaveLoadEvents.LOADED, handler);

      system.loadFromSlot('slot1');

      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].slotName).toBe('slot1');
    });

    it('should fail for non-existent slot', () => {
      const errorHandler = vi.fn();
      eventBus.on(SaveLoadEvents.ERROR, errorHandler);

      const result = system.loadFromSlot('nonexistent');

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should fail when world has no sceneLoader', () => {
      // Create a world without a sceneLoader
      const eventBus2 = new EventBus();
      const world2 = new World({ eventBus: eventBus2 });

      const saveManager2 = world2.createEntity('saveManager2');
      const component2 = new SaveLoadComponent({ storageKey: 'test2' });
      // Pre-populate a slot to load from
      component2.slots.set('slot1', {
        name: 'slot1',
        timestamp: 1000,
        sceneData: { name: 'slot1', entities: {} },
      });
      saveManager2.add(component2);

      const system2 = new SaveLoadSystem(eventBus2);
      world2.addSystem(system2);
      world2.initialize();

      const errorHandler = vi.fn();
      eventBus2.on(SaveLoadEvents.ERROR, errorHandler);

      const result = system2.loadFromSlot('slot1');

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalledWith({
        error: 'World does not have a SceneLoader configured',
      });

      world2.destroy();
    });

    it('should emit error when load operation throws', () => {
      // Mock sceneLoader.loadSceneFromData to throw an error
      const originalLoadSceneFromData = sceneLoader.loadSceneFromData.bind(sceneLoader);
      sceneLoader.loadSceneFromData = vi.fn(() => {
        throw new Error('Scene data is corrupted');
      });

      const errorHandler = vi.fn();
      eventBus.on(SaveLoadEvents.ERROR, errorHandler);

      const result = system.loadFromSlot('slot1');

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalledWith({
        error: 'Failed to load: Scene data is corrupted',
      });

      // Restore original
      sceneLoader.loadSceneFromData = originalLoadSceneFromData;
    });
  });

  describe('deleteSlot', () => {
    beforeEach(() => {
      system.saveToSlot('slot1');
      system.saveToSlot('slot2');
    });

    it('should delete a slot', () => {
      const result = system.deleteSlot('slot1');

      expect(result).toBe(true);
      expect(system.getSlot('slot1')).toBeUndefined();
    });

    it('should return false for non-existent slot', () => {
      const result = system.deleteSlot('nonexistent');

      expect(result).toBe(false);
    });

    it('should emit SLOT_DELETED event', () => {
      const handler = vi.fn();
      eventBus.on(SaveLoadEvents.SLOT_DELETED, handler);

      system.deleteSlot('slot1');

      expect(handler).toHaveBeenCalledWith({ slotName: 'slot1' });
    });

    it('should clear currentSlot if deleted', () => {
      const component = (system as any).component as SaveLoadComponent;
      component.currentSlot = 'slot1';

      system.deleteSlot('slot1');

      expect(component.currentSlot).toBeNull();
    });
  });

  describe('getSlotNames', () => {
    it('should return all slot names', () => {
      system.saveToSlot('slot1');
      system.saveToSlot('slot2');
      system.saveToSlot('slot3');

      const names = system.getSlotNames();

      expect(names).toContain('slot1');
      expect(names).toContain('slot2');
      expect(names).toContain('slot3');
    });

    it('should return empty array when no slots', () => {
      const names = system.getSlotNames();

      expect(names).toEqual([]);
    });
  });

  describe('exportToJSON', () => {
    beforeEach(() => {
      world.createEntity('test').add(new PositionComponent({ x: 1, y: 2, z: 3 }));
      system.saveToSlot('slot1');
    });

    it('should export slot as JSON string', () => {
      const json = system.exportToJSON('slot1');

      expect(json).toBeDefined();
      expect(typeof json).toBe('string');

      const parsed = JSON.parse(json!);
      expect(parsed.name).toBe('slot1');
      expect(parsed.sceneData).toBeDefined();
    });

    it('should return null for non-existent slot', () => {
      const json = system.exportToJSON('nonexistent');

      expect(json).toBeNull();
    });
  });

  describe('importFromJSON', () => {
    it('should import slot from JSON', () => {
      const slot: SaveSlot = {
        name: 'imported',
        timestamp: 1234567890,
        sceneData: {
          name: 'imported',
          entities: {
            test: {
              components: {
                Position: { x: 100, y: 200, z: 300 },
              },
            },
          },
        },
      };

      const result = system.importFromJSON(JSON.stringify(slot));

      expect(result).toBe(true);
      expect(system.getSlot('imported')).toBeDefined();
    });

    it('should allow overriding slot name', () => {
      const slot: SaveSlot = {
        name: 'original',
        timestamp: 1234567890,
        sceneData: { name: 'original', entities: {} },
      };

      system.importFromJSON(JSON.stringify(slot), 'overridden');

      expect(system.getSlot('overridden')).toBeDefined();
      expect(system.getSlot('overridden')?.name).toBe('overridden');
    });

    it('should fail on invalid JSON', () => {
      const errorHandler = vi.fn();
      eventBus.on(SaveLoadEvents.ERROR, errorHandler);

      const result = system.importFromJSON('invalid json');

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should emit SLOT_CREATED', () => {
      const handler = vi.fn();
      eventBus.on(SaveLoadEvents.SLOT_CREATED, handler);

      const slot: SaveSlot = {
        name: 'newSlot',
        timestamp: 1234567890,
        sceneData: { name: 'newSlot', entities: {} },
      };

      system.importFromJSON(JSON.stringify(slot));

      expect(handler).toHaveBeenCalledWith({ slotName: 'newSlot' });
    });

    it('should fail when no slot name provided and none in JSON', () => {
      const errorHandler = vi.fn();
      eventBus.on(SaveLoadEvents.ERROR, errorHandler);

      const slotWithoutName = {
        timestamp: 1234567890,
        sceneData: { entities: {} },
      };

      const result = system.importFromJSON(JSON.stringify(slotWithoutName));

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should fail when max slots reached on import', () => {
      const component = (system as any).component as SaveLoadComponent;
      component.maxSlots = 1;

      // Fill up the slot
      system.saveToSlot('existing');

      const errorHandler = vi.fn();
      eventBus.on(SaveLoadEvents.ERROR, errorHandler);

      const slot: SaveSlot = {
        name: 'newSlot',
        timestamp: 1234567890,
        sceneData: { name: 'newSlot', entities: {} },
      };

      const result = system.importFromJSON(JSON.stringify(slot));

      expect(result).toBe(false);
      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('localStorage', () => {
    beforeEach(() => {
      world.createEntity('test').add(new PositionComponent({ x: 1, y: 2, z: 3 }));
      system.saveToSlot('slot1');
      system.saveToSlot('slot2');
    });

    it('should save slots to localStorage', () => {
      expect(localStorageMock.setItem).toHaveBeenCalled();
    });

    it('should save slot index', () => {
      // Check that slot index was saved
      const indexKey = 'test.slots';
      const indexCall = localStorageMock.setItem.mock.calls.find(
        (call: string[]) => call[0] === indexKey
      );
      expect(indexCall).toBeDefined();
    });

    it('should save individual slots', () => {
      const slotKey = 'test.slot.slot1';
      const slotCall = localStorageMock.setItem.mock.calls.find(
        (call: string[]) => call[0] === slotKey
      );
      expect(slotCall).toBeDefined();
    });

    it('should remove slot from localStorage on delete', () => {
      system.deleteSlot('slot1');

      expect(localStorageMock.removeItem).toHaveBeenCalledWith('test.slot.slot1');
    });

    it('should explicitly save all slots to localStorage', () => {
      vi.clearAllMocks();
      system.saveToLocalStorage();

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'test.slots',
        expect.any(String)
      );
    });

    it('should load slots from localStorage on initialization', () => {
      // Setup localStorage with pre-existing data
      const slot: SaveSlot = {
        name: 'preexisting',
        timestamp: 9999,
        sceneData: { name: 'preexisting', entities: {} },
      };
      localStorageMock.getItem.mockImplementation((key: string) => {
        if (key === 'test2.slots') return JSON.stringify(['preexisting']);
        if (key === 'test2.slot.preexisting') return JSON.stringify(slot);
        return null;
      });

      // Create new world with different storage key
      const eventBus2 = new EventBus();
      const sceneLoader2 = new SceneLoader(eventBus2);
      const world2 = new World({ eventBus: eventBus2, sceneLoader: sceneLoader2 });
      sceneLoader2.registerComponent('SaveLoad', SaveLoadComponent);

      const saveManager2 = world2.createEntity('saveManager2');
      saveManager2.add(new SaveLoadComponent({ storageKey: 'test2' }));

      const system2 = new SaveLoadSystem(eventBus2);
      world2.addSystem(system2);
      world2.initialize();

      expect(system2.getSlot('preexisting')).toBeDefined();
      expect(system2.getSlot('preexisting')?.timestamp).toBe(9999);

      world2.destroy();
    });

    it('should clear all localStorage data', () => {
      system.clearLocalStorage();

      expect(localStorageMock.removeItem).toHaveBeenCalledWith('test.slot.slot1');
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('test.slot.slot2');
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('test.slots');
      expect(system.getSlotNames()).toEqual([]);
    });

    it('should handle localStorage errors when saving slot index', () => {
      localStorageMock.setItem.mockImplementationOnce(() => {
        throw new Error('QuotaExceeded');
      });

      const errorHandler = vi.fn();
      eventBus.on(SaveLoadEvents.ERROR, errorHandler);

      system.saveToLocalStorage();

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should handle localStorage errors when loading', () => {
      localStorageMock.getItem.mockImplementationOnce(() => {
        throw new Error('SecurityError');
      });

      const errorHandler = vi.fn();
      eventBus.on(SaveLoadEvents.ERROR, errorHandler);

      system.loadFromLocalStorage();

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should handle localStorage errors when saving individual slot', () => {
      // First call succeeds (slot index), second throws
      let callCount = 0;
      localStorageMock.setItem.mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error('QuotaExceeded');
      });

      const errorHandler = vi.fn();
      eventBus.on(SaveLoadEvents.ERROR, errorHandler);

      system.saveToLocalStorage();

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should handle localStorage errors when removing slot', () => {
      localStorageMock.removeItem.mockImplementationOnce(() => {
        throw new Error('SecurityError');
      });

      const errorHandler = vi.fn();
      eventBus.on(SaveLoadEvents.ERROR, errorHandler);

      system.deleteSlot('slot1');

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should handle missing slot data in localStorage gracefully', () => {
      localStorageMock.getItem.mockImplementation((key: string) => {
        if (key === 'test3.slots') return JSON.stringify(['missing']);
        return null; // Slot data missing
      });

      const eventBus3 = new EventBus();
      const sceneLoader3 = new SceneLoader(eventBus3);
      const world3 = new World({ eventBus: eventBus3, sceneLoader: sceneLoader3 });
      sceneLoader3.registerComponent('SaveLoad', SaveLoadComponent);

      const saveManager3 = world3.createEntity('saveManager3');
      saveManager3.add(new SaveLoadComponent({ storageKey: 'test3' }));

      const system3 = new SaveLoadSystem(eventBus3);
      world3.addSystem(system3);
      world3.initialize();

      // Should not throw, slot just won't be loaded
      expect(system3.getSlot('missing')).toBeUndefined();

      world3.destroy();
    });

    it('should handle invalid JSON in localStorage gracefully', () => {
      localStorageMock.getItem.mockImplementation((key: string) => {
        if (key === 'test4.slots') return JSON.stringify(['invalid']);
        if (key === 'test4.slot.invalid') return 'not valid json';
        return null;
      });

      const eventBus4 = new EventBus();
      const errorHandler = vi.fn();
      eventBus4.on(SaveLoadEvents.ERROR, errorHandler);

      const sceneLoader4 = new SceneLoader(eventBus4);
      const world4 = new World({ eventBus: eventBus4, sceneLoader: sceneLoader4 });
      sceneLoader4.registerComponent('SaveLoad', SaveLoadComponent);

      const saveManager4 = world4.createEntity('saveManager4');
      saveManager4.add(new SaveLoadComponent({ storageKey: 'test4' }));

      const system4 = new SaveLoadSystem(eventBus4);
      world4.addSystem(system4);
      world4.initialize();

      expect(errorHandler).toHaveBeenCalled();

      world4.destroy();
    });
  });

  describe('auto-save', () => {
    it('should trigger auto-save after interval', () => {
      const component = (system as any).component as SaveLoadComponent;
      component.autoSaveEnabled = true;
      component.autoSaveInterval = 1; // 1 second

      // Create entity to save
      world.createEntity('test').add(new PositionComponent());

      const handler = vi.fn();
      eventBus.on(SaveLoadEvents.AUTO_SAVE, handler);

      // Simulate time passing
      world.update(0.5);
      expect(handler).not.toHaveBeenCalled();

      world.update(0.6); // Total: 1.1 seconds
      expect(handler).toHaveBeenCalled();
    });

    it('should not auto-save when disabled', () => {
      const component = (system as any).component as SaveLoadComponent;
      component.autoSaveEnabled = false;
      component.autoSaveInterval = 0.1;

      const handler = vi.fn();
      eventBus.on(SaveLoadEvents.AUTO_SAVE, handler);

      world.update(1);

      expect(handler).not.toHaveBeenCalled();
    });
  });
});

describe('SaveLoadEvents', () => {
  it('should have correct event names', () => {
    expect(SaveLoadEvents.SAVING).toBe('saveload.saving');
    expect(SaveLoadEvents.SAVED).toBe('saveload.saved');
    expect(SaveLoadEvents.LOADING).toBe('saveload.loading');
    expect(SaveLoadEvents.LOADED).toBe('saveload.loaded');
    expect(SaveLoadEvents.ERROR).toBe('saveload.error');
    expect(SaveLoadEvents.SLOT_CREATED).toBe('saveload.slot.created');
    expect(SaveLoadEvents.SLOT_DELETED).toBe('saveload.slot.deleted');
    expect(SaveLoadEvents.AUTO_SAVE).toBe('saveload.autosave');
  });
});
