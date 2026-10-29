import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/support/p39-windows-global-setup.ts"],
    setupFiles: ["./tests/support/p39-windows-test-setup.ts"],
    include: ["tests/architecture/**/*.test.ts"],
    // These suites shell out to git and walk/read the source tree; under the
    // multi-worker runner that can exceed the 5s default when the host is busy.
    testTimeout: 30_000,
  },
});
