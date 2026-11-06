import { defineConfig, devices } from '@playwright/test';

// The watch view's browser tests. Each spec starts its own server (MCP over stdio, port 0) on a
// temporary project, so nothing is left running. The UI must be built first (pnpm build).
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: 'test-results',
  use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 860 } },
});
