import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: "dist/ui",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
  },
});
