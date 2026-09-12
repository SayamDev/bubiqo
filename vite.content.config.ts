import { defineConfig } from "vite";
import { resolve } from "node:path";

// MV3 content scripts are classic scripts, not ES modules, so this is a
// separate IIFE build that must not emit chunks.
export default defineConfig({
  resolve: {
    alias: {
      "@core": resolve(__dirname, "extension/src/core"),
      "@shared": resolve(__dirname, "extension/src/shared"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "chrome116",
    lib: {
      entry: resolve(__dirname, "extension/src/content/content-script.ts"),
      formats: ["iife"],
      name: "BubiqoContent",
      fileName: () => "content-script.js",
    },
  },
});
