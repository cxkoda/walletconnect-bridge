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
    // The bridge depends on ports only. If this fails, the core logic has
    // become untestable without a network and the port abstraction is dead.
    const offenders = walk(join(process.cwd(), 'src/bridge'))
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => BANNED.some((pkg) => readFileSync(f, 'utf8').includes(pkg)));
    expect(offenders).toEqual([]);
  });
});
