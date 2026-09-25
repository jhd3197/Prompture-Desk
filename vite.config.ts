import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Tauri serves the dev build from this port (see src-tauri/tauri.conf.json devUrl).
const DEV_PORT = 28417;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: DEV_PORT, strictPort: true, host: "127.0.0.1" },
  build: {
    target: "es2021",
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        widget: resolve(__dirname, "widget.html"),
      },
    },
  },
});
