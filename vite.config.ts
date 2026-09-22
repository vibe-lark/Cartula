import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cartulaWorker } from './scripts/worker-plugin.js';
export default defineConfig({
  plugins: [react(), cartulaWorker()],
  build: { outDir: 'dist/web', emptyOutDir: true, chunkSizeWarningLimit: 2500, rollupOptions: { input: { main: 'index.html', host: 'mcp-host.html' } } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3900', '/m/': { target: 'http://localhost:3900', ws: true }, '/mcp': 'http://localhost:3900' } },
});
