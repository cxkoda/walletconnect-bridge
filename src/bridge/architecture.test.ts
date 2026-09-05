/// <reference types="node" />
// Scoped to this file rather than added to tsconfig's global `types`: this
// is a deliberately no-backend, client-side-only app, and putting "node" in
// the project-wide types array would let `process`/`Buffer`/`NodeJS.*`
// silently typecheck anywhere under src/**, including code that should only
// ever use `import.meta.env`.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BANNED = ['@reown/walletkit', '@coinbase/wallet-sdk'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('bridge layer isolation', () => {
  it('never imports a wallet or dapp SDK client', () => {
    const files = walk(join(process.cwd(), 'src/bridge')).filter((f) => !f.endsWith('.test.ts'));
    // Guard the guard: if the walk ever found nothing (an emptied
    // src/bridge, or a broken path), `offenders` below would also be `[]`
    // and the test would pass vacuously without checking anything.
    expect(files.length).toBeGreaterThan(0);

    // The bridge depends on ports only. If this fails, the core logic has
    // become untestable without a network and the port abstraction is dead.
    const offenders = files.filter((f) =>
      BANNED.some((pkg) => readFileSync(f, 'utf8').includes(pkg)),
    );
    expect(offenders).toEqual([]);
  });
});
