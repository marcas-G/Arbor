import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * P13 `05` §1: dev proxy only — `/views/*`, `/commands` (HTTP) and `/ws`
 * (WS upgrade) forward to the single-workspace daemon. No dev-time mock
 * backend: the daemon is the real composition.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/views": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
      "/commands": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
