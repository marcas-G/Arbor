import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/capability/real-provider/public-s3-response-gate-harness.test.ts",
    ],
    testTimeout: 8_000,
    hookTimeout: 2_000,
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
  },
});
