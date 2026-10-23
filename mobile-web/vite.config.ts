import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by backend-v2 at <api>/mobile-app/sign/ (see app.ts), which sits
// behind different path prefixes depending on the proxy (e.g.
// /etl/flowdesk/uat/ on the external proxy) - so every asset URL is
// relative, never rooted at "/".
export default defineConfig({
  base: "./",
  plugins: [react()],
  // pdf.js alone is ~500 kB; it's one page, so splitting buys nothing.
  build: { outDir: "dist", emptyOutDir: true, target: "es2020", chunkSizeWarningLimit: 1600 },
  server: { port: 5180 }
});
