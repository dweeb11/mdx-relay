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
          includeSource: ["src/contracts/**/*.ts", "src/core/**/*.ts"],
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
      include: ["src/contracts/**/*.ts", "src/core/**/*.ts"],
      exclude: ["src/main.ts"],
      thresholds: {
        statements: 99,
        lines: 99,
        branches: 95,
        functions: 100,
      },
    },
  },
});
