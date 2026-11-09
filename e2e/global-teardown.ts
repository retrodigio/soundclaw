// After the whole run: stop any server a browser test started and did not stop (the spec timed out, or its worker was
// killed). Only pids this run's helpers wrote to the registry file are touched, and only while the process at that pid is
// still a `soundclaw ... serve --project` one: a pid the system has reused for something else is left alone.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';

export default function globalTeardown(): void {
  const file = process.env.SOUNDCLAW_E2E_PIDS;
  if (!file || !existsSync(file)) return;
  const pids = [...new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number))].filter((n) => Number.isInteger(n) && n > 1);
  for (const pid of pids) {
    let cmd = '';
    try { cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { continue; } // not running
    if (/soundclaw(\.js)?\s+serve\s+--project\b/.test(cmd)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
  }
  rmSync(file, { force: true });
}
