import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/functional/ui",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  outputDir: ".functional-test-results",
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  },
});
