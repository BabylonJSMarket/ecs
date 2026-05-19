import { describe, it, expect, beforeEach } from 'vitest';
import { World, EventBus, Component } from '..';

class Position extends Component {
  x = 0;
  y = 0;
}

class Velocity extends Component {
  dx = 0;
  dy = 0;
}

class Health extends Component {
  value = 100;
}

class Damage extends Component {
  amount = 10;
}

describe('World.query', () => {
  let world: World;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    world = new World({ eventBus });
  });

  describe('empty query', () => {
    it('should return all active entities for empty query', () => {
      const entity1 = world.createEntity();
      const entity2 = world.createEntity();
      const entity3 = world.createEntity();
      entity3.active = false; // Inactive

      const results = world.query({});

      expect(results).toHaveLength(2);
      expect(results).toContain(entity1);
      expect(results).toContain(entity2);
      expect(results).not.toContain(entity3);
    });

    it('should return empty array when no entities exist', () => {
      const results = world.query({});
      expect(results).toHaveLength(0);
    });
  });

  describe('required components', () => {
    it('should filter by single required component', () => {
      const entity1 = world.createEntity().add(Position);
      const entity2 = world.createEntity().add(Velocity);
      const entity3 = world.createEntity().add(Position);

      const results = world.query({ required: [Position] });

      expect(results).toHaveLength(2);
      expect(results).toContain(entity1);
      expect(results).toContain(entity3);
      expect(results).not.toContain(entity2);
    });

    it('should filter by multiple required components', () => {
      const entity1 = world.createEntity().add(Position).add(Velocity);
      const entity2 = world.createEntity().add(Position);
      const entity3 = world.createEntity().add(Position).add(Velocity).add(Health);

      const results = world.query({ required: [Position, Velocity] });

      expect(results).toHaveLength(2);
      expect(results).toContain(entity1);
      expect(results).toContain(entity3);
      expect(results).not.toContain(entity2);
    });
  });

  describe('excluded components', () => {
    it('should exclude entities with specified components', () => {
      const entity1 = world.createEntity().add(Position);
      const entity2 = world.createEntity().add(Position).add(Damage);
      const entity3 = world.createEntity().add(Health);

      const results = world.query({ excluded: [Damage] });

      expect(results).toHaveLength(2);
      expect(results).toContain(entity1);
      expect(results).toContain(entity3);
      expect(results).not.toContain(entity2);
    });

    it('should combine required and excluded', () => {
      const entity1 = world.createEntity().add(Position).add(Health);
      const entity2 = world.createEntity().add(Position).add(Damage);
      const entity3 = world.createEntity().add(Position);

      const results = world.query({
        required: [Position],
        excluded: [Damage],
      });

      expect(results).toHaveLength(2);
      expect(results).toContain(entity1);
      expect(results).toContain(entity3);
      expect(results).not.toContain(entity2);
    });
  });

  describe('anyOf components', () => {
    it('should match entities with any of the specified components', () => {
      const entity1 = world.createEntity().add(Health);
      const entity2 = world.createEntity().add(Damage);
      const entity3 = world.createEntity().add(Position);
      const entity4 = world.createEntity().add(Health).add(Damage);

      const results = world.query({ anyOf: [Health, Damage] });

      expect(results).toHaveLength(3);
      expect(results).toContain(entity1);
      expect(results).toContain(entity2);
      expect(results).toContain(entity4);
      expect(results).not.toContain(entity3);
    });

    it('should combine required and anyOf', () => {
      const entity1 = world.createEntity().add(Position).add(Health);
      const entity2 = world.createEntity().add(Position).add(Damage);
      const entity3 = world.createEntity().add(Position);
      const entity4 = world.createEntity().add(Health);

      const results = world.query({
        required: [Position],
        anyOf: [Health, Damage],
      });

      expect(results).toHaveLength(2);
      expect(results).toContain(entity1);
      expect(results).toContain(entity2);
      expect(results).not.toContain(entity3);
      expect(results).not.toContain(entity4);
    });
  });

  describe('tags', () => {
    it('should filter by single tag', () => {
      const entity1 = world.createEntity().addTag('player');
      const entity2 = world.createEntity().addTag('enemy');
      const entity3 = world.createEntity().addTag('player');

      const results = world.query({ tags: ['player'] });

      expect(results).toHaveLength(2);
      expect(results).toContain(entity1);
      expect(results).toContain(entity3);
      expect(results).not.toContain(entity2);
    });

    it('should filter by multiple tags', () => {
      const entity1 = world.createEntity().addTag('player').addTag('hero');
      const entity2 = world.createEntity().addTag('player');
      const entity3 = world.createEntity().addTag('enemy').addTag('boss');

      const results = world.query({ tags: ['player', 'hero'] });

      expect(results).toHaveLength(1);
      expect(results).toContain(entity1);
      expect(results).not.toContain(entity2);
      expect(results).not.toContain(entity3);
    });
  });

  describe('excludedTags', () => {
    it('should exclude entities with specified tags', () => {
      const entity1 = world.createEntity().addTag('player');
      const entity2 = world.createEntity().addTag('enemy');
      const entity3 = world.createEntity().addTag('neutral');

      const results = world.query({ excludedTags: ['enemy'] });

      expect(results).toHaveLength(2);
      expect(results).toContain(entity1);
      expect(results).toContain(entity3);
      expect(results).not.toContain(entity2);
    });

    it('should exclude entities with any of the excluded tags', () => {
      const entity1 = world.createEntity().addTag('player');
      const entity2 = world.createEntity().addTag('enemy').addTag('boss');
      const entity3 = world.createEntity().addTag('boss');
      const entity4 = world.createEntity().addTag('neutral');

      const results = world.query({ excludedTags: ['enemy', 'boss'] });

      expect(results).toHaveLength(2);
      expect(results).toContain(entity1);
      expect(results).toContain(entity4);
      expect(results).not.toContain(entity2);
      expect(results).not.toContain(entity3);
    });
  });

  describe('complex queries', () => {
    it('should handle all query types combined', () => {
      const entity1 = world.createEntity().add(Position).add(Velocity).addTag('player');

      const entity2 = world.createEntity().add(Position).add(Health).add(Damage).addTag('enemy');

      const entity3 = world.createEntity().add(Position).add(Health).addTag('neutral');

      const entity4 = world
        .createEntity()
        .add(Position)
        .add(Velocity)
        .add(Health)
        .addTag('player')
        .addTag('hero');

      entity4.active = false; // Inactive

      const results = world.query({
        required: [Position],
        excluded: [Damage],
        anyOf: [Health, Velocity],
        tags: ['player'],
        excludedTags: ['hero'],
      });

      expect(results).toHaveLength(1);
      expect(results).toContain(entity1);
      expect(results).not.toContain(entity2); // Has Damage
      expect(results).not.toContain(entity3); // Not tagged 'player'
      expect(results).not.toContain(entity4); // Inactive
    });

    it('should handle edge cases', () => {
      const entity = world.createEntity().add(Position).addTag('test');

      // Empty arrays should not filter
      let results = world.query({
        required: [],
        excluded: [],
        anyOf: [],
        tags: [],
        excludedTags: [],
      });
      expect(results).toContain(entity);

      // Contradictory query (require and exclude same component)
      results = world.query({
        required: [Position],
        excluded: [Position],
      });
      expect(results).toHaveLength(0);
    });
  });

  describe('performance', () => {
    it('should handle large numbers of entities', () => {
      // Create 1000 entities with various configurations
      for (let i = 0; i < 1000; i++) {
        const entity = world.createEntity();

        if (i % 2 === 0) entity.add(Position);
        if (i % 3 === 0) entity.add(Velocity);
        if (i % 5 === 0) entity.add(Health);
        if (i % 7 === 0) entity.addTag('special');
        if (i % 11 === 0) entity.active = false;
      }

      const results = world.query({
        required: [Position],
        anyOf: [Velocity, Health],
        excludedTags: ['special'],
      });

      // Should be entities that:
      // - Are active (not divisible by 11)
      // - Have Position (divisible by 2)
      // - Have Velocity (divisible by 3) OR Health (divisible by 5)
      // - Don't have 'special' tag (not divisible by 7)
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThan(1000);
    });
  });
});
