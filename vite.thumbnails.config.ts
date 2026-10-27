import { defineConfig } from 'vite';
export default defineConfig({
  build: { outDir: 'build/thumbnail-renderer', emptyOutDir: true, lib: { entry: 'renderer/scene.ts', name: 'AssetThumbnail', formats: ['iife'], fileName: () => 'renderer.js' } },
});
