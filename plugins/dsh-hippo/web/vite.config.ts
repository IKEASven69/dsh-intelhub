import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite on 5174, proxy /api to the hippo HTTP server on 8140.
// Prod: vite build → web/dist; the hippo `ui` command serves it.
// (Ports are configurable; these defaults avoid clashing with other local
// services that commonly grab 5173/8139.)
const API_PORT = process.env.HIPPO_API_PORT ?? '8140';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
    },
  },
  build: {
    outDir: 'dist',
  },
});
