import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/functional/pending/s3-any-producer-settled-wait-attention.pending.test.ts",
    ],
    testTimeout: 10_000,
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
  },
});
