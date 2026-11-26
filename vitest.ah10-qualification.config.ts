import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/support/p39-windows-global-setup.ts"],
    setupFiles: ["./tests/support/p39-windows-test-setup.ts"],
    include: [
      "tests/functional/process/ah10-child/committed-receipts.functional.test.ts",
      "tests/functional/process/ah10-child/corrupt-binding-attention.functional.test.ts",
      "tests/functional/process/ah10-child/legacy-upgrade.functional.test.ts",
      "tests/functional/process/ah10-child/target-degradation.functional.test.ts",
      "tests/functional/process/ah10-p10-attention-materialization.functional.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
