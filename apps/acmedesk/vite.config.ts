import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// AcmeDesk always runs on a fixed port so tutorials and Kane runs target a stable URL.
// strictPort: fail loudly instead of silently moving to another port.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5174, strictPort: true, host: '127.0.0.1' },
});
