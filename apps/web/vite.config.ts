import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The UI talks to the local orchestrator through this proxy. The browser sends
// Origin http://127.0.0.1:5173, which the orchestrator allow-lists; the proxy
// keeps the original Host (127.0.0.1:5173), which the orchestrator accepts as
// loopback. The orchestrator itself must be started from a normal terminal.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    // Vite allows CORS from other localhost origins by default. The UI never
    // needs cross-origin access, so disable it: other local pages must not be
    // able to read orchestrator responses through this proxy.
    cors: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false },
    },
  },
  preview: { port: 5173, strictPort: true, host: '127.0.0.1' },
});
