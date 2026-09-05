import { describe, it, expect, vi } from 'vitest';
import { createWalletPort, detectSmartAccount } from './provider';
import type { ProviderInterface } from '@coinbase/wallet-sdk';

function fakeProvider(handler: (m: string, p?: unknown) => unknown): ProviderInterface {
  return {
    request: vi.fn(async (a: { method: string; params?: unknown }) => handler(a.method, a.params)),
  } as unknown as ProviderInterface;
}

describe('createWalletPort', () => {
  it('parses a hex chain id into a number', async () => {
    const port = createWalletPort(fakeProvider(() => '0x2105'));
    expect(await port.getChainId()).toBe(8453);
  });

  it('sends wallet_switchEthereumChain with a hex chain id', async () => {
    const seen: unknown[] = [];
    const port = createWalletPort(
      fakeProvider((m, p) => {
        seen.push({ m, p });
        return null;
      }),
    );
    await port.switchChain(8453);
    expect(seen).toEqual([
      { m: 'wallet_switchEthereumChain', p: [{ chainId: '0x2105' }] },
    ]);
  });

  it('passes arbitrary requests through unchanged', async () => {
    const seen: unknown[] = [];
    const port = createWalletPort(
      fakeProvider((m, p) => {
        seen.push({ m, p });
        return 'sig';
      }),
    );
    const params = ['0x68', '0xabc'];
    expect(await port.request({ method: 'personal_sign', params })).toBe('sig');
    expect(seen).toEqual([{ m: 'personal_sign', p: params }]);
  });

  it('lets provider errors propagate so the router can map them', async () => {
    const port = createWalletPort(
      fakeProvider(() => {
        throw Object.assign(new Error('denied'), { code: 4001 });
      }),
    );
    await expect(port.request({ method: 'personal_sign' })).rejects.toMatchObject({ code: 4001 });
  });
});

describe('detectSmartAccount', () => {
  it('is true when the address has contract code', async () => {
    const p = fakeProvider(() => '0x60806040');
    expect(await detectSmartAccount(p, '0xabc')).toBe(true);
  });

  it('is false for an EOA (code is 0x)', async () => {
    expect(await detectSmartAccount(fakeProvider(() => '0x'), '0xabc')).toBe(false);
  });

  it('is false when the code call fails, rather than throwing', async () => {
    const p = fakeProvider(() => {
      throw new Error('rpc down');
    });
    await expect(detectSmartAccount(p, '0xabc')).resolves.toBe(false);
  });
});
