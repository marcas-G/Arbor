import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/support/p39-windows-global-setup.ts"],
    setupFiles: ["./tests/support/p39-windows-test-setup.ts"],
    testTimeout: 30_000,
    // Prefer reliability on the constrained Windows host; performance tuning
    // is deferred. Functional, architecture, and Web suites use separate
    // configs and worker budgets.
    maxWorkers: 1,
    include: [
      "packages/*/test/**/*.test.ts",
      "adapters/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    // `apps/web` runs its own jsdom vitest project (`pnpm --filter
    // @arbor/web test`); its tests must not run under the root node-env
    // configuration (P13 `05` §5).
    exclude: [
      "**/node_modules/**",
      "apps/web/**",
      "tests/capability/real-provider/**",
      "tests/architecture/**",
      "tests/capability/black-box/s1-s4-public-api.test.ts",
      "tests/functional/**",
    ],
  },
});
