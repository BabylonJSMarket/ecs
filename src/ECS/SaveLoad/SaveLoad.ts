/**
 * SaveLoad.ts - Save and load game state
 *
 * This module provides save/load functionality for ECS games.
 * It integrates with SceneLoader to serialize worlds to JSON format
 * and supports localStorage persistence for browser games.
 *
 * Features:
 * - Multiple save slots
 * - Auto-save functionality
 * - localStorage persistence
 * - JSON export/import
 * - Event-based lifecycle notifications
 */

import { Component } from '../Component/Component';
import { System } from '../System/System';
import { EventBus } from '../EventBus/EventBus';
import { SceneData } from '../SceneLoader/SceneLoader';

// ============================================
// Interfaces
// ============================================

/**
 * A single save slot containing serialized game state.
 */
export interface SaveSlot {
  /** Name/identifier of this save slot */
  name: string;
  /** Unix timestamp when this save was created */
  timestamp: number;
  /** The serialized scene data */
  sceneData: SceneData;
  /** Optional custom metadata (player name, level, playtime, etc.) */
  metadata?: Record<string, any>;
}

/**
 * Input options for creating a SaveLoadComponent.
 */
export interface SaveLoadInput {
  /** Pre-existing save slots (for loading saved state) */
  slots?: Record<string, SaveSlot>;
  /** Enable automatic saving at intervals */
  autoSaveEnabled?: boolean;
  /** Seconds between auto-saves (default: 60) */
  autoSaveInterval?: number;
  /** Maximum number of save slots allowed (default: 10) */
  maxSlots?: number;
  /** localStorage key prefix (default: "saveload") */
  storageKey?: string;
  /** Name of the auto-save slot (default: "autosave") */
  autoSaveSlot?: string;
}

// ============================================
// Events
// ============================================

/**
 * Events emitted during save/load operations.
 * Listen to these for UI updates, loading screens, etc.
 */
export const SaveLoadEvents = {
  /** Emitted when a save operation starts */
  SAVING: 'saveload.saving',
  /** Emitted when a save operation completes successfully */
  SAVED: 'saveload.saved',
  /** Emitted when a load operation starts */
  LOADING: 'saveload.loading',
  /** Emitted when a load operation completes successfully */
  LOADED: 'saveload.loaded',
  /** Emitted when a save/load operation fails */
  ERROR: 'saveload.error',
  /** Emitted when a new save slot is created */
  SLOT_CREATED: 'saveload.slot.created',
  /** Emitted when a save slot is deleted */
  SLOT_DELETED: 'saveload.slot.deleted',
  /** Emitted when auto-save triggers */
  AUTO_SAVE: 'saveload.autosave',
} as const;

// ============================================
// SaveLoadComponent
// ============================================

/**
 * SaveLoadComponent - Stores save/load configuration and state.
 *
 * Attach this component to an entity (typically a global/world entity)
 * to enable save/load functionality via the SaveLoadSystem.
 *
 * Example:
 * ```typescript
 * const saveManager = world.createEntity("saveManager");
 * saveManager.add(new SaveLoadComponent({
 *   autoSaveEnabled: true,
 *   autoSaveInterval: 120,
 *   storageKey: "myGame",
 * }));
 * ```
 */
export class SaveLoadComponent extends Component {
  /** Map of save slot name -> SaveSlot data */
  slots: Map<string, SaveSlot> = new Map();

  /** Whether auto-save is enabled */
  autoSaveEnabled: boolean;

  /** Seconds between auto-saves */
  autoSaveInterval: number;

  /** Maximum number of save slots */
  maxSlots: number;

  /** localStorage key prefix */
  storageKey: string;

  /** Name of the auto-save slot */
  autoSaveSlot: string;

  /** Timestamp of the last save operation */
  lastSaveTime: number = 0;

  /** Name of the currently loaded save slot (null if new game) */
  currentSlot: string | null = null;

  constructor(data: SaveLoadInput = {}) {
    super();
    this.autoSaveEnabled = data.autoSaveEnabled ?? false;
    this.autoSaveInterval = data.autoSaveInterval ?? 60;
    this.maxSlots = data.maxSlots ?? 10;
    this.storageKey = data.storageKey ?? 'saveload';
    this.autoSaveSlot = data.autoSaveSlot ?? 'autosave';

    // Load initial slots if provided
    if (data.slots) {
      for (const [name, slot] of Object.entries(data.slots)) {
        this.slots.set(name, slot);
      }
    }
  }

  /**
   * Serialize this component for persistence.
   * Note: Slot data is stored separately in localStorage.
   */
  serialize(): SaveLoadInput {
    return {
      autoSaveEnabled: this.autoSaveEnabled,
      autoSaveInterval: this.autoSaveInterval,
      maxSlots: this.maxSlots,
      storageKey: this.storageKey,
      autoSaveSlot: this.autoSaveSlot,
    };
  }

  /**
   * Get slot names sorted by timestamp (most recent first).
   */
  getSlotNames(): string[] {
    return Array.from(this.slots.entries())
      .sort((a, b) => b[1].timestamp - a[1].timestamp)
      .map(([name]) => name);
  }

  /**
   * Check if a slot exists.
   */
  hasSlot(slotName: string): boolean {
    return this.slots.has(slotName);
  }

  /**
   * Get a slot by name.
   */
  getSlot(slotName: string): SaveSlot | undefined {
    return this.slots.get(slotName);
  }

  /**
   * Override toJSON to handle Map serialization.
   */
  toJSON(): any {
    const slotsObj: Record<string, SaveSlot> = {};
    for (const [name, slot] of this.slots) {
      slotsObj[name] = slot;
    }
    return {
      slots: slotsObj,
      autoSaveEnabled: this.autoSaveEnabled,
      autoSaveInterval: this.autoSaveInterval,
      maxSlots: this.maxSlots,
      storageKey: this.storageKey,
      autoSaveSlot: this.autoSaveSlot,
      lastSaveTime: this.lastSaveTime,
      currentSlot: this.currentSlot,
    };
  }
}

// ============================================
// SaveLoadSystem
// ============================================

/**
 * SaveLoadSystem - Handles save and load operations.
 *
 * This system integrates with SceneLoader to:
 * - Serialize the current World state to JSON
 * - Store saves in memory and localStorage
 * - Restore World state from saved data
 *
 * Requirements:
 * - World must have a SceneLoader configured
 * - SceneLoader must have all used components registered
 *
 * Example:
 * ```typescript
 * world.addSystem(new SaveLoadSystem(eventBus));
 *
 * // Later, get the system to save/load
 * const saveSystem = world.getSystem(SaveLoadSystem);
 * saveSystem.saveToSlot("slot1");
 * saveSystem.loadFromSlot("slot1");
 * ```
 */
export class SaveLoadSystem extends System {
  /** The SaveLoadComponent this system manages */
  private component: SaveLoadComponent | null = null;

  /** Timer for auto-save functionality */
  private autoSaveTimer: number = 0;

  /** Event unsubscribe functions for cleanup */
  private unsubscribes: (() => void)[] = [];

  constructor(eventBus: EventBus) {
    super(eventBus);
    // Query for entities with SaveLoadComponent
    this.query = {
      required: [SaveLoadComponent],
    };
    // Don't pause during game pause - save/load should always be available
    this._pauseable = false;
  }

  /**
   * Initialize the system.
   * Loads saved slots from localStorage if available.
   */
  protected onInitialize(): void {
    // Load from localStorage when system initializes
    this.loadFromLocalStorage();
  }

  /**
   * Called when an entity with SaveLoadComponent is added.
   */
  protected onEntityAdded(entity: any): void {
    // Use the first SaveLoadComponent found
    if (!this.component) {
      this.component = entity.get(SaveLoadComponent);
    }
  }

  /**
   * Called when an entity with SaveLoadComponent is removed.
   */
  protected onEntityRemoved(entity: any): void {
    if (this.component && entity.get(SaveLoadComponent) === this.component) {
      this.component = null;
    }
  }

  /**
   * Update loop - handles auto-save timer.
   */
  protected onUpdate(deltaTime: number): void {
    if (!this.component || !this.component.autoSaveEnabled) {
      return;
    }

    this.autoSaveTimer += deltaTime;

    if (this.autoSaveTimer >= this.component.autoSaveInterval) {
      this.autoSaveTimer = 0;
      this.autoSave();
    }
  }

  /**
   * Cleanup on shutdown.
   */
  protected onShutdown(): void {
    // Unsubscribe from all events
    this.unsubscribes.forEach(fn => fn());
    this.unsubscribes = [];
  }

  // ============================================
  // Save Operations
  // ============================================

  /**
   * Save the current World state to a named slot.
   *
   * @param slotName - Name for the save slot
   * @param metadata - Optional custom metadata to store with the save
   * @returns True if save was successful
   */
  saveToSlot(slotName: string, metadata?: Record<string, any>): boolean {
    if (!this.component || !this.world) {
      this.emitError('No SaveLoadComponent or World available');
      return false;
    }

    const sceneLoader = this.world.sceneLoader;
    if (!sceneLoader) {
      this.emitError('World does not have a SceneLoader configured');
      return false;
    }

    // Check max slots limit (don't count if overwriting existing slot)
    if (!this.component.slots.has(slotName) && this.component.slots.size >= this.component.maxSlots) {
      this.emitError(`Maximum save slots (${this.component.maxSlots}) reached`);
      return false;
    }

    this.eventBus.emit(SaveLoadEvents.SAVING, { slotName });

    try {
      // Use SceneLoader to serialize the world
      const sceneData = sceneLoader.serializeWorld(this.world, slotName);

      // Exclude the save manager entity from the save data
      // (it has the SaveLoadComponent and should persist across loads)
      const saveManagerEntity = this.entities.values().next().value;
      if (saveManagerEntity && sceneData.entities[saveManagerEntity.id]) {
        delete sceneData.entities[saveManagerEntity.id];
      }

      const isNew = !this.component.slots.has(slotName);

      // Create the save slot
      const slot: SaveSlot = {
        name: slotName,
        timestamp: Date.now(),
        sceneData,
        metadata,
      };

      this.component.slots.set(slotName, slot);
      this.component.lastSaveTime = slot.timestamp;
      this.component.currentSlot = slotName;

      // Persist to localStorage
      this.saveSlotToLocalStorage(slotName, slot);

      this.eventBus.emit(SaveLoadEvents.SAVED, {
        slotName,
        timestamp: slot.timestamp,
        entityCount: Object.keys(sceneData.entities).length,
      });

      if (isNew) {
        this.eventBus.emit(SaveLoadEvents.SLOT_CREATED, { slotName });
      }

      return true;
    } catch (error) {
      this.emitError(`Failed to save: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Trigger an auto-save to the configured auto-save slot.
   */
  autoSave(): boolean {
    if (!this.component) return false;

    this.eventBus.emit(SaveLoadEvents.AUTO_SAVE, {
      slotName: this.component.autoSaveSlot,
    });

    return this.saveToSlot(this.component.autoSaveSlot, { autoSave: true });
  }

  // ============================================
  // Load Operations
  // ============================================

  /**
   * Load game state from a saved slot.
   *
   * Warning: This removes all current entities and replaces them
   * with the saved state.
   *
   * @param slotName - Name of the slot to load
   * @returns True if load was successful
   */
  loadFromSlot(slotName: string): boolean {
    if (!this.component || !this.world) {
      this.emitError('No SaveLoadComponent or World available');
      return false;
    }

    const slot = this.component.slots.get(slotName);
    if (!slot) {
      this.emitError(`Save slot not found: ${slotName}`);
      return false;
    }

    const sceneLoader = this.world.sceneLoader;
    if (!sceneLoader) {
      this.emitError('World does not have a SceneLoader configured');
      return false;
    }

    this.eventBus.emit(SaveLoadEvents.LOADING, { slotName });

    try {
      // Remove all current entities (except the save manager itself)
      const saveManagerEntity = this.entities.values().next().value;
      const entitiesToRemove = this.world.getEntities().filter(e => e !== saveManagerEntity);
      for (const entity of entitiesToRemove) {
        this.world.removeEntity(entity);
      }

      // Load the scene data into SceneLoader
      sceneLoader.loadSceneFromData(slot.sceneData);

      // Instantiate the scene into the world
      const { entities, systems } = sceneLoader.instantiateScene(slot.name, this.world, {
        createSystems: false, // Don't recreate systems - they're already set up
      });

      this.component.currentSlot = slotName;

      this.eventBus.emit(SaveLoadEvents.LOADED, {
        slotName,
        timestamp: slot.timestamp,
        entityCount: entities.size,
      });

      return true;
    } catch (error) {
      this.emitError(`Failed to load: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // ============================================
  // Slot Management
  // ============================================

  /**
   * Delete a save slot.
   *
   * @param slotName - Name of the slot to delete
   * @returns True if slot was found and deleted
   */
  deleteSlot(slotName: string): boolean {
    if (!this.component) return false;

    if (!this.component.slots.has(slotName)) {
      return false;
    }

    this.component.slots.delete(slotName);
    this.removeSlotFromLocalStorage(slotName);

    if (this.component.currentSlot === slotName) {
      this.component.currentSlot = null;
    }

    this.eventBus.emit(SaveLoadEvents.SLOT_DELETED, { slotName });
    return true;
  }

  /**
   * Get names of all save slots.
   */
  getSlotNames(): string[] {
    return this.component?.getSlotNames() ?? [];
  }

  /**
   * Get a specific save slot.
   */
  getSlot(slotName: string): SaveSlot | undefined {
    return this.component?.getSlot(slotName);
  }

  // ============================================
  // JSON Export/Import
  // ============================================

  /**
   * Export a save slot as a JSON string.
   * Useful for downloading saves or sharing.
   *
   * @param slotName - Name of the slot to export
   * @returns JSON string, or null if slot not found
   */
  exportToJSON(slotName: string): string | null {
    const slot = this.component?.slots.get(slotName);
    if (!slot) return null;
    return JSON.stringify(slot, null, 2);
  }

  /**
   * Import a save from a JSON string.
   *
   * @param json - JSON string containing SaveSlot data
   * @param slotName - Optional override for the slot name
   * @returns True if import was successful
   */
  importFromJSON(json: string, slotName?: string): boolean {
    if (!this.component) return false;

    try {
      const slot: SaveSlot = JSON.parse(json);

      // Use provided name or the name from the JSON
      const name = slotName ?? slot.name;
      if (!name) {
        this.emitError('No slot name provided and none found in JSON');
        return false;
      }

      // Update the slot name if overridden
      slot.name = name;

      // Check max slots limit
      if (!this.component.slots.has(name) && this.component.slots.size >= this.component.maxSlots) {
        this.emitError(`Maximum save slots (${this.component.maxSlots}) reached`);
        return false;
      }

      this.component.slots.set(name, slot);
      this.saveSlotToLocalStorage(name, slot);

      this.eventBus.emit(SaveLoadEvents.SLOT_CREATED, { slotName: name });
      return true;
    } catch (error) {
      this.emitError(`Failed to import JSON: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // ============================================
  // localStorage Operations
  // ============================================

  /**
   * Save all slots to localStorage.
   */
  saveToLocalStorage(): void {
    if (!this.component) return;

    const storageKey = this.component.storageKey;

    // Save slot index
    const slotNames = Array.from(this.component.slots.keys());
    try {
      localStorage.setItem(`${storageKey}.slots`, JSON.stringify(slotNames));
    } catch (error) {
      this.emitError(`Failed to save slot index: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // Save each slot
    for (const [name, slot] of this.component.slots) {
      this.saveSlotToLocalStorage(name, slot);
    }
  }

  /**
   * Load all slots from localStorage.
   */
  loadFromLocalStorage(): void {
    if (!this.component) return;

    const storageKey = this.component.storageKey;

    try {
      const slotsJson = localStorage.getItem(`${storageKey}.slots`);
      if (!slotsJson) return;

      const slotNames: string[] = JSON.parse(slotsJson);

      for (const name of slotNames) {
        this.loadSlotFromLocalStorage(name);
      }
    } catch (error) {
      this.emitError(`Failed to load from localStorage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Save a single slot to localStorage.
   */
  private saveSlotToLocalStorage(slotName: string, slot: SaveSlot): void {
    if (!this.component) return;

    const storageKey = this.component.storageKey;

    try {
      localStorage.setItem(`${storageKey}.slot.${slotName}`, JSON.stringify(slot));

      // Update slot index
      const slotNames = Array.from(this.component.slots.keys());
      localStorage.setItem(`${storageKey}.slots`, JSON.stringify(slotNames));
    } catch (error) {
      this.emitError(`Failed to save slot to localStorage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Load a single slot from localStorage.
   */
  private loadSlotFromLocalStorage(slotName: string): void {
    if (!this.component) return;

    const storageKey = this.component.storageKey;

    try {
      const slotJson = localStorage.getItem(`${storageKey}.slot.${slotName}`);
      if (!slotJson) return;

      const slot: SaveSlot = JSON.parse(slotJson);
      this.component.slots.set(slotName, slot);
    } catch (error) {
      this.emitError(`Failed to load slot from localStorage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Remove a slot from localStorage.
   */
  private removeSlotFromLocalStorage(slotName: string): void {
    if (!this.component) return;

    const storageKey = this.component.storageKey;

    try {
      localStorage.removeItem(`${storageKey}.slot.${slotName}`);

      // Update slot index
      const slotNames = Array.from(this.component.slots.keys());
      localStorage.setItem(`${storageKey}.slots`, JSON.stringify(slotNames));
    } catch (error) {
      this.emitError(`Failed to remove slot from localStorage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Clear all save data from localStorage.
   */
  clearLocalStorage(): void {
    if (!this.component) return;

    const storageKey = this.component.storageKey;

    // Get all slot names and remove each
    const slotNames = this.getSlotNames();
    for (const name of slotNames) {
      localStorage.removeItem(`${storageKey}.slot.${name}`);
    }

    localStorage.removeItem(`${storageKey}.slots`);
    this.component.slots.clear();
  }

  // ============================================
  // Helpers
  // ============================================

  /**
   * Emit an error event.
   */
  private emitError(message: string): void {
    this.eventBus.emit(SaveLoadEvents.ERROR, { error: message });
  }
}
