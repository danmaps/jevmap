import { defineConfig } from 'vite';

export default defineConfig({
  base: '/jevmap/',
  server: {
    proxy: {
      '/api/jev': 'http://127.0.0.1:8788',
      '/api/julia': 'http://127.0.0.1:8765',
    },
  },
  preview: {
    proxy: {
      '/api/jev': 'http://127.0.0.1:8788',
      '/api/julia': 'http://127.0.0.1:8765',
    },
  },
});
