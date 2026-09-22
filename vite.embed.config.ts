import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { cartulaWorker } from './scripts/worker-plugin.js';
export default defineConfig({
  plugins: [react(), cartulaWorker(), viteSingleFile()],
  build: { outDir: 'dist/embed', emptyOutDir: true, chunkSizeWarningLimit: 5000, rollupOptions: { input: 'app.html' } },
});
