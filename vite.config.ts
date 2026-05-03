import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import manifest from './src/manifest';

// Phase 4 onward: the sidebar is a real React app at src/sidebar/. Legacy
// pass-through plugin retired — @crxjs drives the sidepanel entry directly
// from `side_panel.default_path` in the manifest.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: 'inline',
  },
});
