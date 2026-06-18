import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // tests, type-only declarations, and re-export barrels (no logic)
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/**/index.ts',
        'src/babylon.ts',
        'src/three.ts',
        'src/babylon-lite.ts',
        'src/testing.ts',
        // Solid debug UI — ephemeral, not unit-tested
        'src/**/*.viz.{ts,tsx}',
        'src/**/*.panel.tsx',
        'src/Viz/VizRoot.tsx',
        'src/Viz/VizPanel.tsx',
        // Renderer engine bindings — verified by the RendererContract (run
        // against MockRendererAdapter) + integration, not unit-testable without
        // a real Babylon/Three engine. Coverage here = unit-testable logic.
        'src/Renderer/BabylonAdapter.ts',
        'src/Renderer/ThreeAdapter.ts',
        'src/Renderer/BabylonLiteAdapter.ts',
      ],
      // Publish guardrail: prepublishOnly runs test:coverage, so a publish
      // ABORTS if coverage regresses. lines/functions/statements held at 100;
      // branches floored just below current (the remainder are documented
      // defensive guards).
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 98,
      },
    },
  },
});
