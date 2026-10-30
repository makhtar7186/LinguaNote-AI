/// <reference types="vitest/config" />
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The packaged app loads dist/index.html from file://, where response headers do not apply:
// embed the strict CSP as a meta tag at build time only (dev needs Vite's inline HMR scripts).
const PACKAGED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function productionCsp(): Plugin {
  return {
    name: "linguanote-production-csp",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: PACKAGED_CSP }, injectTo: "head-prepend" },
    ],
  };
}

export default defineConfig({
  plugins: [react(), productionCsp()],
  // Relative asset URLs are required to load dist/index.html through file://.
  base: "./",
  build: {
    rollupOptions: {
      // Two windows, two pages: the main window and the floating bubble.
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        bubble: resolve(import.meta.dirname, "bubble.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
  },
});
