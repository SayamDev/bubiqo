import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Builds the side panel (HTML entry) and the service worker (ES module).
// The content script is built separately as an IIFE by vite.content.config.ts,
// because MV3 content scripts cannot be ES modules.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@core": resolve(__dirname, "extension/src/core"),
      "@shared": resolve(__dirname, "extension/src/shared"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome116",
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "extension/src/sidepanel/index.html"),
        "service-worker": resolve(__dirname, "extension/src/background/service-worker.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
