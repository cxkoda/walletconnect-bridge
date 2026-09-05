import { describe, it, expect } from 'vitest';
import { buildCard } from './index';
import { CONFIRM_METHODS } from '../policy';
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

  it.each(['wallet_sendCalls', 'eth_sendRawTransaction', 'wallet_addEthereumChain', 'wallet_watchAsset'])(
    'routes %s to a real decoder',
    (m) => {
      expect(buildCard(req(m, [{}]), ctx).title).not.toMatch(/unrecognised/i);
    },
  );

  /**
   * The guard that would have caught the original defect. `classify` returned
   * `confirm` for four methods that `buildCard`'s switch had no case for, so
   * each rendered "Unrecognised request: wallet_sendCalls" over the warning
   * "…which is not in the allowlist" — a factually false statement about the
   * single most likely fund-moving method a Base Account will ever see.
   */
  it('gives every allowlisted CONFIRM method a card that does not lie about it', () => {
    for (const method of CONFIRM_METHODS) {
      const card = buildCard(req(method, [{}]), ctx);
      expect(card.method, method).toBe(method);
      expect(card.title, method).not.toMatch(/unrecognised/i);
      expect(
        card.warnings.some((w) => /not in the allowlist/i.test(w.text)),
        method,
      ).toBe(false);
    }
  });

  describe('disposition', () => {
    it('marks an allowlisted method as confirm, not unknown', () => {
      expect(buildCard(req('wallet_sendCalls', [{}]), ctx).disposition).toEqual({
        kind: 'confirm',
      });
    });

    it('marks a genuinely unrecognised method as unknown', () => {
      expect(buildCard(req('wallet_weirdThing', []), ctx).disposition).toEqual({
        kind: 'unknown',
      });
    });

    it('threads the router\'s own classification through rather than re-deriving it', () => {
      const card = buildCard(req('personal_sign', ['0x68', '0xa']), ctx, { kind: 'unknown' });
      expect(card.disposition).toEqual({ kind: 'unknown' });
    });
  });
});
