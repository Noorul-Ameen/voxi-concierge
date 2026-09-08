import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// Builds the drop-in widget script (dist/embed/voxi.js): one IIFE with React, the widget and its CSS inlined.
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist/embed",
    emptyOutDir: false,
    sourcemap: false,
    lib: { entry: "src/embed.tsx", name: "VoxiWidget", formats: ["iife"], fileName: () => "voxi.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
