import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: [
      "./tests/support/p39-windows-global-setup.ts",
      "./tests/functional/support/schema42-global-setup.ts",
    ],
    setupFiles: ["./tests/support/p39-windows-test-setup.ts"],
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
