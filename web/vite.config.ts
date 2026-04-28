import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const currentDir = dirname(fileURLToPath(import.meta.url));
const allowedHosts = Array.from(new Set([
  "federation.big.ussy.promethean.rest",
  "brethren.big.ussy.promethean.rest",
  "proxx.big.ussy.promethean.rest",
  "testing.proxx.ussy.promethean.rest",
  "staging.proxx.ussy.promethean.rest",
  "prod.proxx.ussy.promethean.rest",
  ...(process.env.VITE_ALLOWED_HOSTS
    ? process.env.VITE_ALLOWED_HOSTS.split(",").map((entry) => entry.trim()).filter(Boolean)
    : []),
]));

export default defineConfig({
  root: currentDir,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    allowedHosts,
    proxy: {
      "/api": "http://127.0.0.1:8789",
      "/v1": "http://127.0.0.1:8789",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    allowedHosts,
  },
  build: {
    outDir: resolve(currentDir, "dist"),
    emptyOutDir: true,
  },
});
