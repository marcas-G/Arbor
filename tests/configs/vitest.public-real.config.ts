import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: [
      "./tests/support/windows-global-setup.ts",
      "./tests/functional/support/schema44-global-setup.ts",
    ],
    setupFiles: ["./tests/support/windows-test-setup.ts"],
    include: [
      "tests/capability/real-provider/public-s*-*.test.ts",
      "tests/capability/real-provider/s1/*.test.ts",
      "tests/capability/real-provider/s4/*.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    // Every opt-in public journey owns a 20-minute absolute deadline. This
    // bounded outer margin leaves time for orderly daemon stop and evidence.
    testTimeout: 22 * 60_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
    reporters: ["verbose"],
  },
});
