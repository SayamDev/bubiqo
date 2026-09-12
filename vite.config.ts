import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Vite writes an HTML entry to a path mirroring its source location, which would
 * leave the panel at dist/extension/src/sidepanel/index.html. The manifest wants a
 * flat dist/, so this moves the file up and rewrites its asset URLs to match.
 *
 * Doing it here rather than restructuring the source keeps the source layout
 * readable: the panel lives next to its styles and components.
 */
function flattenPanelHtml(): Plugin {
  return {
    name: "bubiqo-flatten-panel-html",
    closeBundle() {
      const nested = resolve(here, "dist/extension/src/sidepanel/index.html");
      if (!existsSync(nested)) return;

      const html = readFileSync(nested, "utf8")
        // "../../../../sidepanel.js" -> "sidepanel.js"
        .replace(/(src|href)="[./]*\/?((?:assets|chunks)\/)?/g, (_match, attr: string, dir = "") => `${attr}="${dir}`);

      writeFileSync(resolve(here, "dist/sidepanel.html"), html);
      rmSync(resolve(here, "dist/extension"), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), flattenPanelHtml()],
  // Icons and manifest.json are copied verbatim into dist/.
  publicDir: resolve(here, "extension/public"),
  resolve: {
    alias: {
      "@core": resolve(here, "extension/src/core"),
      "@shared": resolve(here, "extension/src/shared"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome116",
    // A readable bundle is worth more than a few saved kilobytes in a repo whose
    // whole pitch is that you can audit what it does.
    minify: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(here, "extension/src/sidepanel/index.html"),
        "service-worker": resolve(here, "extension/src/background/service-worker.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
