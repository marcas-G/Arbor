import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/capability/real-provider/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    // A real-provider case may legitimately span many model turns. The
    // Provider Runtime already owns connect/first-event/idle/turn deadlines,
    // retry bounds, and the Agent Runtime owns the 24-turn ceiling. A second
    // wall-clock deadline here cannot observe progress and, when it fires,
    // Vitest does not cancel the still-running provider operation. Keep the
    // qualification harness out of that policy boundary.
    testTimeout: 0,
    hookTimeout: 60_000,
    fileParallelism: false,
    reporters: ["json"],
  },
});
