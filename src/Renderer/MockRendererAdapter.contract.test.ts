/**
 * Runs the shared RendererAdapter contract against the MockRendererAdapter.
 * Mock is the reference implementation — if the contract suite ever fails
 * here, the suite itself is wrong (or the Mock has drifted from the
 * interface). For call-recording assertions specific to Mock, see the
 * sibling `MockRendererAdapter.test.ts`.
 */

import { MockRendererAdapter } from './MockRendererAdapter';
import { runRendererAdapterContract } from './rendererAdapterContract';

runRendererAdapterContract('Mock', () => new MockRendererAdapter());
