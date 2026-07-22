import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer build. base "./" so the built index.html loads assets via relative paths
// when served from file:// in production.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5178,
    strictPort: true,
  },
});
