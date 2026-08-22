import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Component } from './Component/Component';
import { System } from './System/System';
import { resetHookGuard, setHookGuardEnabled } from './hookGuard';

describe('hook guard', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetHookGuard();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    setHookGuardEnabled(true);
    resetHookGuard();
  });

  it('warns when a Component defines a System hook', () => {
    class HealthComponent extends Component {
      hp = 10;
      // Wrong class: the World never calls this on a component.
      protected onUpdate(_dt: number): void {}
    }

    new HealthComponent();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('HealthComponent');
    expect(message).toContain('onUpdate()');
    expect(message).toContain('System');
  });

  it('lists every misplaced System hook in one warning', () => {
    class BadComponent extends Component {
      protected onInitialize(): void {}
      protected onShutdown(): void {}
      protected onEntityAdded(): void {}
      protected onEntityRemoved(): void {}
    }

    new BadComponent();

    const message = warn.mock.calls[0][0] as string;
    for (const hook of ['onInitialize()', 'onShutdown()', 'onEntityAdded()', 'onEntityRemoved()']) {
      expect(message).toContain(hook);
    }
  });

  it('warns when a System defines a Component hook', () => {
    class HealthSystem extends System {
      // Wrong class: only an entity attaches components.
      protected onAttachOverride(): void {}
      protected onUpdate(_dt: number): void {}
    }

    new HealthSystem();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('HealthSystem');
    expect(message).toContain('onAttachOverride()');
    expect(message).toContain('Component');
  });

  it('stays quiet for correctly written classes', () => {
    class PositionComponent extends Component {
      x = 0;
      protected onAttachOverride(): void {}
      protected onDetachOverride(): void {}
    }
    class MovementSystem extends System {
      protected onInitialize(): void {}
      protected onEntityAdded(): void {}
      protected onUpdate(_dt: number): void {}
      protected onShutdown(): void {}
    }

    new PositionComponent();
    new MovementSystem();

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per class, not once per instance', () => {
    class ChattyComponent extends Component {
      protected onUpdate(_dt: number): void {}
    }

    new ChattyComponent();
    new ChattyComponent();
    new ChattyComponent();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('catches a hook inherited from an intermediate subclass', () => {
    class BaseWeapon extends Component {
      protected onUpdate(_dt: number): void {}
    }
    class Shotgun extends BaseWeapon {}

    new Shotgun();

    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('Shotgun');
    expect(message).toContain('onUpdate()');
  });

  it('can be switched off', () => {
    setHookGuardEnabled(false);

    class QuietComponent extends Component {
      protected onUpdate(_dt: number): void {}
    }
    new QuietComponent();

    expect(warn).not.toHaveBeenCalled();
  });
});
