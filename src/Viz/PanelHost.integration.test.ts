/**
 * Free-setup integration: the decoupled panel-host contract works with ONLY the
 * free ecs package — a `PanelHostSystem` builds a `PanelSpec` and EMITS it on the
 * EventBus; no renderer is involved. This mirrors a production build where the
 * dev-only viz-pro layer is absent: the emits land on no listener and nothing
 * breaks. A subscriber standing in for that layer proves the spec is delivered
 * intact, and the HOST_READY re-emit proves registration is order-independent.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventBus, World, MockRendererAdapter } from '@babylonjsmarket/ecs'
import { PanelHostComponent, PanelHostSystem } from './PanelHost'
import { VizEvents } from './VizEvents'
import { definePanel, type PanelSpec } from './spec'

class DemoPanelComponent extends PanelHostComponent {
  constructor() {
    super({ panelId: 'demo' })
  }
}

class DemoPanelSystem extends PanelHostSystem<DemoPanelComponent> {
  constructor(eventBus: EventBus) {
    super(eventBus, DemoPanelComponent)
  }
  protected buildSpec(): PanelSpec {
    return definePanel({ id: 'demo', title: 'Demo', sections: [] })
  }
}

describe('PanelHost (free decoupled-viz contract)', () => {
  let eventBus: EventBus
  let world: World

  // emit() is queued behind processQueue; flush a few frames to drain it.
  const flush = (): void => {
    for (let i = 0; i < 3; i++) world.update(1 / 60)
  }
  // Adding the host backfills the pre-existing entity → onEntityAdded →
  // tryRegister → emit, so subscribe BEFORE calling this to observe it.
  const addHost = (): void => {
    world.addSystem(new DemoPanelSystem(eventBus))
  }

  beforeEach(() => {
    eventBus = new EventBus()
    world = new World({ eventBus, renderer: new MockRendererAdapter(), detectRaces: false })
    // Entity before system, mirroring the live SceneLoader order (entities
    // created, then systems backfilled).
    world.createEntity('demo-panel').add(new DemoPanelComponent())
  })

  it('emits PANEL_REGISTERED with the built spec (what the viz layer renders)', () => {
    const seen: PanelSpec[] = []
    eventBus.on(VizEvents.PANEL_REGISTERED, (e: { spec: PanelSpec }) => seen.push(e.spec))
    addHost()
    flush()
    expect(seen.length).toBe(1)
    expect(seen[0]!.id).toBe('demo')
    expect(seen[0]!.title).toBe('Demo')
  })

  it('runs with NO viz layer subscribed (the prod/free build) without throwing', () => {
    expect(() => {
      addHost()
      flush()
    }).not.toThrow()
  })

  it('emits PANEL_UNREGISTERED when the host system is removed', () => {
    addHost()
    flush() // register
    const removed: string[] = []
    eventBus.on(VizEvents.PANEL_UNREGISTERED, (e: { id: string }) => removed.push(e.id))
    world.removeSystem(world.getSystem(DemoPanelSystem)!)
    flush()
    expect(removed).toContain('demo')
  })

  it('re-emits its spec on HOST_READY so a late-mounting viz layer still gets it', () => {
    addHost()
    flush() // host initializes (subscribes HOST_READY) + does its initial register
    const seen: PanelSpec[] = []
    eventBus.on(VizEvents.PANEL_REGISTERED, (e: { spec: PanelSpec }) => seen.push(e.spec))
    eventBus.emit(VizEvents.HOST_READY, {})
    flush() // host re-emits its built spec → the late listener receives it
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.every((s) => s.id === 'demo')).toBe(true)
  })
})
