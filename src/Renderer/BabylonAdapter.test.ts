/**
 * Unit tests for the pure pieces of BabylonAdapter that don't need a live
 * engine. The engine-bound methods are exercised by BabylonAdapter.contract
 * (NullEngine); here we lock down `hardwareScalingLevelForDpr`, which decides
 * how crisp a retina display renders — a 2× display must drive the backing
 * buffer at full physical resolution, not 1× CSS pixels.
 */

import { describe, it, expect } from 'vitest';
import { hardwareScalingLevelForDpr } from './BabylonAdapter';

describe('hardwareScalingLevelForDpr', () => {
  it('renders a 2x (retina) display at physical resolution', () => {
    // level is the inverse of DPR: 1/2 backing buffer = full 2x pixels.
    expect(hardwareScalingLevelForDpr(2)).toBe(0.5);
  });

  it('is a no-op (level 1) on a standard 1x display', () => {
    expect(hardwareScalingLevelForDpr(1)).toBe(1);
  });

  it('handles a fractional DPR (e.g. 1.5x display)', () => {
    expect(hardwareScalingLevelForDpr(1.5)).toBeCloseTo(1 / 1.5, 6);
  });

  it('never upscales past native for a sub-1 DPR (floors the ratio at 1)', () => {
    expect(hardwareScalingLevelForDpr(0.75)).toBe(1);
  });

  it('caps absurdly high DPRs at 3x so the render target stays sane', () => {
    expect(hardwareScalingLevelForDpr(8)).toBeCloseTo(1 / 3, 6);
  });

  it('collapses to level 1 for missing / zero / non-finite DPR (headless)', () => {
    expect(hardwareScalingLevelForDpr(undefined)).toBe(1);
    expect(hardwareScalingLevelForDpr(0)).toBe(1);
    expect(hardwareScalingLevelForDpr(Number.NaN)).toBe(1);
    expect(hardwareScalingLevelForDpr(Number.POSITIVE_INFINITY)).toBe(1);
    expect(hardwareScalingLevelForDpr(-2)).toBe(1);
  });
});
