import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 开发时前端跑在 5173，接口转发给后端 7860。生产构建输出到 web/dist，由后端托管。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:7860' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
