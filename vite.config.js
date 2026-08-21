import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import { viteStaticCopy } from "vite-plugin-static-copy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, "manifest.json"), "utf-8"),
);

export default defineConfig({
  plugins: [
    crx({ manifest }),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/jquery/dist/jquery.min.js",
          dest: "libs",
          rename: { stripBase: true },
        },
        {
          src: "node_modules/select2/dist/js/select2.min.js",
          dest: "libs",
          rename: { stripBase: true },
        },
      ],
    }),
  ],
  resolve: {
    alias: [
      { find: /^\/js\//, replacement: path.resolve(__dirname, "js") + "/" },
      { find: /^\/libs\//, replacement: path.resolve(__dirname, "libs") + "/" },
      { find: /^\/css\//, replacement: path.resolve(__dirname, "css") + "/" },
      {
        find: /^\/templates\//,
        replacement: path.resolve(__dirname, "templates") + "/",
      },
    ],
  },
  build: {
    rollupOptions: {
      input: {
        import: path.resolve(__dirname, "html/import.html"),
        cluster: path.resolve(__dirname, "html/cluster.html"),
        map: path.resolve(__dirname, "html/map.html"),
      },
    },
  },
});
