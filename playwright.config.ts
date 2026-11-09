import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Where the helpers note the pid of every server they start, for global-teardown.ts (workers inherit this).
process.env.SOUNDCLAW_E2E_PIDS ??= join(tmpdir(), `soundclaw-e2e-pids-${process.pid}`);

// The watch view's browser tests. Each spec starts its own server (MCP over stdio, port 0) on a
// temporary project, so nothing is left running. The UI must be built first (pnpm build).
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: 'test-results',
  globalTeardown: './e2e/global-teardown.ts',
  use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 860 } },
});
