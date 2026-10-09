import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
