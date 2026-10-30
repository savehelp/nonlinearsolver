import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { standalone } from './build/standalone';

export default defineConfig({
  plugins: [react(), standalone()],
  base: './',
  build: {
    // One embedded module and stylesheet also work when opened with file://.
    assetsInlineLimit: Infinity,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  worker: { format: 'iife' },
  test: { environment: 'node' },
});
