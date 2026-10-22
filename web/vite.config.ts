import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Two pages: the DM app (index.html) and the players' join page (play.html), a small bundle of
// its own that the public player server serves. `npm run web:dev` proxies to a running `npm run app`.
export default defineConfig({
  root: here('.'),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: { main: here('index.html'), play: here('play.html') } } },
  server: { proxy: { '/api': 'http://localhost:4400', '/p/': 'http://localhost:4410' } },
});
