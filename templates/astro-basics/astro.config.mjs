import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  server: {
    allowedHosts: [".e2b.app"],
  },
});
