import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/capability/real-provider/public-s0-*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
    reporters: ["verbose"],
  },
});
