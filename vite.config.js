import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const devTlsCertPath = process.env.DEV_TLS_CERT_PATH;
const devTlsKeyPath = process.env.DEV_TLS_KEY_PATH;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['@mediapipe/tasks-vision']
  },
  server: {
    host: process.env.HOST || '127.0.0.1',
    ...(devTlsCertPath && devTlsKeyPath
      ? {
          https: {
            cert: readFileSync(devTlsCertPath),
            key: readFileSync(devTlsKeyPath)
          }
        }
      : {}),
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        ws: true,
        configure: (proxy) => {
          const setForwardedProtocol = (proxyRequest, request) => {
            proxyRequest.setHeader('x-forwarded-proto', request.socket.encrypted ? 'https' : 'http');
          };
          proxy.on('proxyReq', setForwardedProtocol);
          proxy.on('proxyReqWs', setForwardedProtocol);
        }
      }
    }
  }
});
