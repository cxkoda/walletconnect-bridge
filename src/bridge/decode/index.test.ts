import { describe, it, expect } from 'vitest';
import { buildCard } from './index';
import type { DecodeContext, IncomingRequest } from '../types';

const ctx: DecodeContext = { chainId: 8453, isSmartAccount: true };

const req = (method: string, params: unknown): IncomingRequest => ({
  id: 1,
  topic: 't',
  chainId: 8453,
  method,
  params,
  dapp: { name: 'Test', url: 'https://t.example', validation: 'VALID', isScam: false },
});

describe('buildCard', () => {
  it('routes personal_sign', () => {
    expect(buildCard(req('personal_sign', ['0x68690a', '0xabc']), ctx).title).toMatch(/signature/i);
  });

  it.each(['eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4'])(
    'routes %s',
    (m) => {
      expect(buildCard(req(m, ['0xabc', '{}']), ctx).title).toMatch(/typed data/i);
    },
  );

  it('routes eth_sendTransaction', () => {
    expect(buildCard(req('eth_sendTransaction', [{ to: '0xabc' }]), ctx).title).toMatch(/transaction/i);
  });

  it('produces a generic card for an unrecognised method', () => {
    const card = buildCard(req('wallet_weirdThing', [1, 2]), ctx);
    expect(card.method).toBe('wallet_weirdThing');
    expect(card.warnings.some((w) => /not in the allowlist/i.test(w.text))).toBe(true);
    expect(card.raw).toContain('1');
  });

  it('always includes the raw params', () => {
    expect(buildCard(req('eth_sendTransaction', [{ to: '0xabc' }]), ctx).raw).toContain('0xabc');
  });
});
