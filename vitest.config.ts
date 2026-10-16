import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/support/p39-windows-global-setup.ts"],
    setupFiles: ["./tests/support/p39-windows-test-setup.ts"],
    testTimeout: 30_000,
    // Keep the root core suite within the measured memory budget on this
    // four-logical-CPU Windows host. Functional, architecture, and Web suites
    // use their own configs and worker budgets.
    maxWorkers: 2,
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
