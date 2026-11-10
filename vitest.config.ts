import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Some exhaustive tests take a few seconds alone and several times that when every file (or other jobs on the machine) runs at once.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // no test process holds a provider key (test/support/no-keys.ts)
    setupFiles: ['test/support/no-keys.ts'],
    include: ['core/test/**/*.test.ts', 'server/test/**/*.test.ts', 'cli/test/**/*.test.ts', 'ui/test/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
