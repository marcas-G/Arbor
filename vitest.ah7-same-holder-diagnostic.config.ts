import { defineConfig } from "vitest/config";

/**
 * Explicitly runnable diagnostics for unsupported copied-holder concurrent P4
 * Runtime invocations. These files are intentionally outside the default
 * root Vitest include set and make no production single-Executor guarantee.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    include: [
      "packages/tool-runtime/test/p4-ah7-concurrent-invocation.diagnostic.ts",
      "adapters/persistence-sqlite/test/p4-ah7-concurrent-invocation.diagnostic.ts",
      "adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.diagnostic.ts",
    ],
  },
});
