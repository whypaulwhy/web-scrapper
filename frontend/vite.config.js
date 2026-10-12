import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// During local development, requests to /api are forwarded to the Express backend.
const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backendUrl, changeOrigin: true },
    },
  },
});
