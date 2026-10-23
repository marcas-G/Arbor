import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: [
      "./tests/support/p39-windows-global-setup.ts",
      "./tests/functional/support/schema44-global-setup.ts",
    ],
    setupFiles: ["./tests/support/p39-windows-test-setup.ts"],
    include: ["tests/capability/real-provider/public-s1-lifecycle.test.ts"],
    exclude: ["**/node_modules/**"],
    // The test gets its own 20-minute absolute journey deadline; leave a
    // bounded two-minute outer margin for Vitest and fixture cleanup hooks.
    testTimeout: 22 * 60_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
    reporters: ["verbose"],
  },
});
