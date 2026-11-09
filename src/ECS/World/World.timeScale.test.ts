import { describe, expect, it } from 'vitest';
import { EventBus } from '../EventBus/EventBus';
import { World } from './World';
import { System } from '../System/System';

class Clock extends System {
  seen: number[] = [];
  protected onUpdate(dt: number): void { this.seen.push(dt); }
}

describe('World.timeScale', () => {
  it('runs every system on game time: real time times the scale', () => {
    const bus = new EventBus();
    const world = new World({ eventBus: bus });
    const clock = new Clock(bus);
    world.addSystem(clock);
    world.update(0.1);
    expect(world.timeScale).toBe(1);
    world.timeScale = 4;
    world.update(0.1);
    world.timeScale = 0.5;
    world.update(0.1);
    expect(clock.seen.map((v) => +v.toFixed(3))).toEqual([0.1, 0.4, 0.05]);
  });

  it('says when it changes, and takes nothing below zero or not a number', () => {
    const bus = new EventBus();
    const world = new World({ eventBus: bus });
    const heard: number[] = [];
    bus.on('world.timeScale', (e: { timeScale: number }) => heard.push(e.timeScale));
    world.timeScale = 2;
    world.timeScale = 2;
    world.timeScale = -3;
    world.timeScale = Number.NaN;
    world.timeScale = 1;
    expect(heard).toEqual([2, 0, 1]);
  });
});
