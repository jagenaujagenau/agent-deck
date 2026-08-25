import { defineConfig } from "vite";

export default defineConfig({
  // Fixed port: Tauri's dev URL has to know where to look, and a port that
  // moves when something else grabs it is a dev server Tauri never finds.
  server: { port: 5183, strictPort: true },
  build: { target: "safari15", emptyOutDir: true },
});
