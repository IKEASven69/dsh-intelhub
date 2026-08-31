import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite on 5174, proxy /api to the hippo HTTP server on 8140.
// Prod: vite build → web/dist; the hippo `ui` command serves it.
// (Ports are configurable; these defaults avoid clashing with other local
// services that commonly grab 5173/8139.)
const API_PORT = process.env.HIPPO_API_PORT ?? '8140';
export default defineConfig({
  base: './', // 相对资源路径：根路径(独立 GUI)与 /dsh-hippo/app(插件桥接)双兼容
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
