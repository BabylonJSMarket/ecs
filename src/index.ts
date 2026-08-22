export * from './ECS/types';
export * from './ECS/Component/Component';
export * from './ECS/Entity/Entity';
export * from './ECS/EventBus/EventBus';
export * from './ECS/System/System';
export * from './ECS/World/World';
export * from './ECS/SceneLoader/SceneLoader';
export * from './ECS/SaveLoad/SaveLoad';
export * from './ECS/Race/RaceDetector';
export * from './ECS/hookGuard';

export type {
  MeshHandle,
  LightHandle,
  CameraHandle,
  ShadowCasterHandle,
  LabelHandle,
  LineHandle,
  PrimitiveSpec,
  MaterialSpec,
  DirectionalLightSpec,
  HemisphericLightSpec,
  ArcCameraSpec,
  MeshLoadSpec,
  MeshLoadResult,
  LabelSpec,
  RendererInitOptions,
  RendererAdapter,
  EnvironmentTextureOpts,
  MeshGeometry,
  BillboardMode,
  PickOptions,
  PickResult,
  PhysicsBodyOpts,
  PhysicsBodySnapshot,
  IPhysicsInstance,
  PhysicsFactory,
} from './Renderer/types';

export * from './Renderer/raceTrackingAdapter';
export * from './Renderer/MockRendererAdapter';

/**
 * Seeded rock geometry, exported because GAMEPLAY has to agree with it.
 *
 * The adapter displaces an icosphere by `asteroidStretch(seed)` to build a rock,
 * and a component that spawns rocks must derive their collision half-extents from
 * the SAME function — otherwise the box you can shoot and the box you crash into
 * drift away from the shape you can see, and a bullet passes through a visible
 * boulder. Reimplementing the stretch in the component is exactly that bug with
 * extra steps, so the one source of truth is shared instead.
 */
export {
  asteroidStretch,
  asteroidShape,
  asteroidSurfacePosition,
  ASTEROID_RIPPLE_DURATION,
  type AsteroidShape,
} from './Renderer/proceduralRock';
