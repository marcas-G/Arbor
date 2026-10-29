import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/capability/real-provider/public-s0-fixture-retention.test.ts",
      "tests/capability/real-provider/public-s0-evidence-root.test.ts",
      "tests/capability/real-provider/public-s0-response-gate.test.ts",
    ],
    testTimeout: 10_000,
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
  },
});
