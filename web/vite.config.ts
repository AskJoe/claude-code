import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const SERVER_PORT = Number(process.env.LAB_SERVER_PORT ?? 3101);

export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/api": `http://localhost:${SERVER_PORT}`,
      "/preview": `http://localhost:${SERVER_PORT}`,
      "/health": `http://localhost:${SERVER_PORT}`,
      "/ws": {
        target: `ws://localhost:${SERVER_PORT}`,
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
});
