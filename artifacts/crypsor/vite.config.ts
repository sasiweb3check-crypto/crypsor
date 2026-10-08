import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  build: { outDir: path.join(import.meta.dirname, 'dist/public'), emptyOutDir: true },
  server: { host: '0.0.0.0', port: Number(process.env.PORT ?? 5173), strictPort: true, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
