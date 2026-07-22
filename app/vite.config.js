import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Dev: Vite en :5173 proxya /api al backend Node (:8082).
// Build: sale a app/dist, que el server Node sirve como estáticos en prod.
export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8082' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
