import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['@mediapipe/tasks-vision']
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        ws: true
      }
    }
  }
});
