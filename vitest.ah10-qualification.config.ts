import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/support/p39-windows-global-setup.ts"],
    setupFiles: ["./tests/support/p39-windows-test-setup.ts"],
    include: [
      "tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts",
      "tests/functional/process/ah10-p10-attention-materialization.functional.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
