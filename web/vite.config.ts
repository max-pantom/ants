import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const target = `http://127.0.0.1:${process.env.ANTS_PORT ?? 4747}`;

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("../dist/web", import.meta.url)), emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/auth": { target, changeOrigin: false },
    },
  },
});
