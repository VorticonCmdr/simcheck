import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome116",
    // The service worker has no document for a preload polyfill to work on.
    modulePreload: false,
    rollupOptions: {
      input: {
        index: "index.html",
        offscreen: "offscreen.html",
        background: "src/background/index.ts",
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  worker: { format: "es" },
  test: { include: ["tests/**/*.test.ts"] },
});
