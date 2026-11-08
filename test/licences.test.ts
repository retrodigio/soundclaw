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

// The dashboard bundles three fonts as woff2 in ui/. They are under the SIL Open Font License, which is not one of the
// code licences above (nothing in node_modules is a font), so each font file must have its licence text next to it.
it('every bundled font has the SIL OFL text next to it', () => {
  const dir = join(import.meta.dirname, '..', 'ui', 'src', 'studio', 'fonts');
  const fonts = readdirSync(dir).filter((f) => f.endsWith('.woff2'));
  expect(fonts.sort()).toEqual(['inter.woff2', 'jetbrains-mono.woff2', 'space-grotesk.woff2']);
  for (const f of fonts) {
    const text = readFileSync(join(dir, `OFL-${f.replace(/\.woff2$/, '')}.txt`), 'utf8');
    expect(text, f).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    expect(text, f).toMatch(/Copyright/);
  }
});
