/**
 * Runs the shared RendererAdapter contract against the MockRendererAdapter.
 * Mock is the reference implementation — if the contract suite ever fails
 * here, the suite itself is wrong (or the Mock has drifted from the
 * interface). For call-recording assertions specific to Mock, see the
 * sibling `MockRendererAdapter.test.ts`.
 */

import { MockRendererAdapter } from './MockRendererAdapter';
import { runRendererAdapterContract } from './rendererAdapterContract';

runRendererAdapterContract('Mock', () => new MockRendererAdapter(), {
  // No scene graph to walk: a handle IS the unit, so the whitelist Mock keeps
  // for assertions answers for the whole "subtree" under it.
  glowEnrolled: (adapter, _meshId, handle) => ({
    total: 1,
    enrolled: (adapter as MockRendererAdapter).glowMeshes.has(handle) ? 1 : 0,
  }),
});
