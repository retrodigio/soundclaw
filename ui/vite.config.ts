import { defineConfig } from 'vite';

// No React plugin: esbuild compiles JSX, and the page is served built (no dev-server refresh).
export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1000 },
  logLevel: 'warn',
});
