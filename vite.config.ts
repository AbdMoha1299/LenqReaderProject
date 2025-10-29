import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
    include: ['react-router-dom'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['*', 'neylify.app'], // autorise tous les hôtes du réseau local
  },
});
