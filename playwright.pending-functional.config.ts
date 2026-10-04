import { defineConfig } from "@playwright/test";

/** Open functional design gaps have executable acceptance tests here. */
export default defineConfig({
  testDir: "./tests/functional/pending",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  outputDir: ".functional-test-results/pending",
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  },
});
