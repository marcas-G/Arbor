import { defineConfig } from "vitest/config";

/** Open functional design gaps stay executable but outside the green gate. */
export default defineConfig({
  test: {
    include: ["tests/functional/pending/**/*.functional.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
