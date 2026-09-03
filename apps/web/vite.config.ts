import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: process.env.VITE_API_PROXY ?? "http://localhost:4020", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") } } },
  build: { outDir: "dist", sourcemap: true },
});
