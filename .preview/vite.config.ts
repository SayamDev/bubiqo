import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: here,
  plugins: [react()],
  server: { port: 8231, strictPort: true },
  resolve: {
    alias: {
      "@core": resolve(here, "../extension/src/core"),
      "@shared": resolve(here, "../extension/src/shared"),
    },
  },
});
