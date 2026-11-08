import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Some exhaustive tests take a few seconds when every file runs at once.
    testTimeout: 20_000,
    include: ['core/test/**/*.test.ts', 'server/test/**/*.test.ts', 'cli/test/**/*.test.ts', 'ui/test/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
