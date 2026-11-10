import { defineConfig } from 'vite';

// No React plugin: esbuild compiles JSX, and the page is served built (no dev-server refresh).
export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  esbuild: { jsx: 'automatic' },
  // the recorder's audio worklet is loaded by its address, so it stays a file (a data: address would not pass the page's content security policy)
  build: { assetsInlineLimit: (file) => (file.endsWith('.worklet.js') ? false : undefined), outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1000 },
  logLevel: 'warn',
});
