import { defineConfig } from "@playwright/test";

/** The open F21 design gap has its own executable acceptance gate. */
export default defineConfig({
  testDir: "./tests/functional/pending",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  outputDir: ".functional-test-results/f21",
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  },
});
