import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The architecture suites shell out to `git` and walk/read the whole
    // source tree; under the containerized multi-worker runner that can exceed
    // the 5s default under load. A generous bound keeps `pnpm check` reliable
    // without changing any test semantics.
    testTimeout: 30_000,
    include: [
      "packages/*/test/**/*.test.ts",
      "adapters/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
  },
});
