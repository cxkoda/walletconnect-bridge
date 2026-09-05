import { describe, it, expect } from 'vitest';
import { toDappIdentity, toIncomingRequest } from './walletkit';

const metadata = {
  name: 'Test Dapp',
  description: 'd',
  url: 'https://dapp.example',
  icons: ['https://dapp.example/icon.png'],
};

const verify = (validation: 'VALID' | 'INVALID' | 'UNKNOWN', isScam?: boolean) => ({
  verified: { origin: 'https://dapp.example', validation, verifyUrl: '', isScam },
});

describe('toDappIdentity', () => {
  it('carries name, url and first icon', () => {
    const d = toDappIdentity(metadata, verify('VALID'));
    expect(d).toMatchObject({
      name: 'Test Dapp',
      url: 'https://dapp.example',
      iconUrl: 'https://dapp.example/icon.png',
      validation: 'VALID',
      isScam: false,
    });
  });

  it('defaults isScam to false when absent', () => {
    expect(toDappIdentity(metadata, verify('UNKNOWN')).isScam).toBe(false);
  });

  it('propagates isScam when set', () => {
    expect(toDappIdentity(metadata, verify('INVALID', true)).isScam).toBe(true);
  });

  it('falls back to UNKNOWN when verifyContext is missing', () => {
    expect(toDappIdentity(metadata, undefined).validation).toBe('UNKNOWN');
  });

  it('survives metadata with no icons', () => {
    const d = toDappIdentity({ ...metadata, icons: [] }, verify('VALID'));
    expect(d.iconUrl).toBeUndefined();
  });
});

describe('toIncomingRequest', () => {
  const event = {
    id: 99,
    topic: 'abc',
    params: {
      request: { method: 'personal_sign', params: ['0x68', '0xa'], expiryTimestamp: 1234 },
      chainId: 'eip155:8453',
    },
    verifyContext: verify('VALID'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it('normalises the WalletKit event shape', () => {
    const r = toIncomingRequest(event, metadata);
    expect(r).toMatchObject({
      id: 99,
      topic: 'abc',
      chainId: 8453,
      method: 'personal_sign',
      params: ['0x68', '0xa'],
      expiryTimestamp: 1234,
    });
    expect(r.dapp.name).toBe('Test Dapp');
  });

  it('throws on a non-eip155 chain id rather than guessing', () => {
    const bad = { ...event, params: { ...event.params, chainId: 'solana:x' } };
    expect(() => toIncomingRequest(bad, metadata)).toThrow(/eip155/);
  });
});
