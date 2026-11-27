import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/support/windows-global-setup.ts"],
    setupFiles: ["./tests/support/windows-test-setup.ts"],
    include: [
      "tests/functional/process/child/committed-receipts.functional.test.ts",
      "tests/functional/process/child/corrupt-binding-attention.functional.test.ts",
      "tests/functional/process/child/legacy-upgrade.functional.test.ts",
      "tests/functional/process/child/target-degradation.functional.test.ts",
      "tests/functional/process/attention-materialization.functional.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
