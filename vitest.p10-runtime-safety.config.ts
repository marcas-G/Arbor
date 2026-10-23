import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/p10-runtime-safety-episode-attention.test.ts"],
    testTimeout: 10_000,
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
  },
});
