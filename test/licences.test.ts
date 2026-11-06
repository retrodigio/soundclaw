// CLAUDE.md: dependencies must have permissive licences. Checks every installed package.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const PERMISSIVE = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD)$/;
const STORE = join(import.meta.dirname, '..', 'node_modules', '.pnpm');

it('every installed package has a permissive licence', () => {
  const bad: string[] = [];
  let n = 0;
  for (const d of readdirSync(STORE)) {
    const nm = join(STORE, d, 'node_modules');
    if (!existsSync(nm)) continue;
    for (const top of readdirSync(nm)) {
      const names = top.startsWith('@') ? readdirSync(join(nm, top)).map((x) => `${top}/${x}`) : [top];
      for (const name of names) {
        const pj = join(nm, name, 'package.json');
        if (!existsSync(pj)) continue;
        const p = JSON.parse(readFileSync(pj, 'utf8')) as { name: string; version: string; license?: unknown };
        n++;
        if (typeof p.license !== 'string' || !PERMISSIVE.test(p.license)) bad.push(`${p.name}@${p.version}: ${JSON.stringify(p.license)}`);
      }
    }
  }
  expect(n).toBeGreaterThan(20);
  expect(bad).toEqual([]);
});
