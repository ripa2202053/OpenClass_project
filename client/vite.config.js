import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  base: '/',
  publicDir: 'public',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      output: {
        manualChunks: {
          vendor: ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/storage'],
          chat: ['firebase/database', 'firebase/messaging'],
          meeting: ['react', 'react-dom', 'socket.io-client', 'lucide-react'],
        },
      },
    },
    chunkSizeWarningLimit: 400,
  },
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});
