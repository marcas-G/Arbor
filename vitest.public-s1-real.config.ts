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
    testTimeout: 0,
    hookTimeout: 120_000,
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
    reporters: ["verbose"],
  },
});
