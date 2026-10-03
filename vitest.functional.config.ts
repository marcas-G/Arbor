import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/capability/black-box/s1-s4-public-api.test.ts",
      "tests/functional/process/**/*.functional.test.ts",
      "tests/functional/package/**/*.functional.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
