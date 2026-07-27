import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
          includeSource: [
            "src/contracts/**/*.ts",
            "src/core/**/*.ts",
            "src/canonical/**/*.ts",
            "src/markdown/**/*.ts",
            "src/profiles/**/*.ts",
            "src/images/**/*.ts",
            "src/worker/**/*.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["tests/jsdom/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          exclude: ["tests/integration/private-baseline/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "private-baseline",
          environment: "node",
          include: ["tests/integration/private-baseline/**/*.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: [
        "src/contracts/**/*.ts",
        "src/core/**/*.ts",
        "src/canonical/**/*.ts",
        "src/markdown/**/*.ts",
        "src/profiles/**/*.ts",
        "src/images/**/*.ts",
        "src/worker/**/*.ts",
      ],
      // Narrow bootstrap exclusions (APP-601):
      // - processing.worker.ts wires WASM modules into DedicatedWorkerGlobalScope;
      //   its production path is proven by `npm run test:bundle`, not unit coverage.
      // - wasm.d.ts is ambient typings for esbuild's binary WASM loader only.
      exclude: [
        "src/main.ts",
        "src/worker/processing.worker.ts",
        "src/worker/wasm.d.ts",
      ],
      thresholds: {
        statements: 99,
        lines: 99,
        branches: 95,
        functions: 100,
        "src/canonical/**": {
          statements: 100,
          lines: 100,
          branches: 100,
          functions: 100,
        },
        "src/markdown/**": {
          statements: 100,
          lines: 100,
          branches: 100,
          functions: 100,
        },
        "src/profiles/**": {
          statements: 100,
          lines: 100,
          branches: 100,
          functions: 100,
        },
        // Floors from exercised image/worker behavior (not padding tests).
        "src/images/**": {
          statements: 96,
          lines: 96,
          branches: 85,
          functions: 100,
        },
        "src/worker/**": {
          statements: 98,
          lines: 98,
          branches: 90,
          functions: 100,
        },
      },
    },
  },
});
