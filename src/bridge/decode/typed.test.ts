import { describe, it, expect } from 'vitest';
import { decodeTypedData } from './typed';
import type { DecodeContext } from '../types';
import { MAX_UINT160 } from '../format';

const ctx: DecodeContext = { chainId: 8453, isSmartAccount: false };
const smart: DecodeContext = { chainId: 8453, isSmartAccount: true };
const MAX = (2n ** 256n - 1n).toString();

const permit = (value: string, chainId = 8453) => ({
  domain: { name: 'USD Coin', chainId, verifyingContract: '0xA0b8' },
  primaryType: 'Permit',
  message: { owner: '0x1', spender: '0xdeadbeef', value, nonce: '0', deadline: '99999' },
  types: { Permit: [] },
});

describe('decodeTypedData', () => {
  it('surfaces domain, primary type and verifying contract', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100'))], ctx);
    expect(card.fields).toContainEqual({ label: 'Type', value: 'Permit' });
    expect(card.fields).toContainEqual({ label: 'Domain', value: 'USD Coin' });
    expect(card.fields).toContainEqual({ label: 'Contract', value: '0xA0b8', mono: true });
  });

  it('accepts an already-parsed object as well as a JSON string', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', permit('100')], ctx);
    expect(card.fields).toContainEqual({ label: 'Type', value: 'Permit' });
  });

  it('flags a domain chainId that disagrees with the session', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100', 1))], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger' && /chain/i.test(w.text))).toBe(true);
  });

  it('does not flag a matching chainId', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100'))], ctx);
    expect(card.warnings.some((w) => /chain/i.test(w.text))).toBe(false);
  });

  it('surfaces Permit spender and amount', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100'))], ctx);
    expect(card.fields).toContainEqual({ label: 'Spender', value: '0xdeadbeef', mono: true });
    expect(card.fields.some((f) => f.label === 'Amount' && f.value === '100')).toBe(true);
  });

  it('shouts about an unlimited Permit amount', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit(MAX))], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger' && /unlimited/i.test(w.text))).toBe(true);
  });

  it('handles PermitSingle (Permit2) shape', () => {
    const p2 = {
      domain: { name: 'Permit2', chainId: 8453, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      primaryType: 'PermitSingle',
      message: {
        details: { token: '0xtok', amount: MAX, expiration: '1999999999' },
        spender: '0xrouter',
      },
      types: {},
    };
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(p2)], ctx);
    expect(card.fields).toContainEqual({ label: 'Spender', value: '0xrouter', mono: true });
    expect(card.warnings.some((w) => /unlimited/i.test(w.text))).toBe(true);
  });

  it('notes ERC-1271 for smart accounts', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('1'))], smart);
    expect(card.warnings.some((w) => /1271/i.test(w.text))).toBe(true);
  });

  it('does not throw on unparseable JSON', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', 'not json'], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger')).toBe(true);
    expect(card.method).toBe('eth_signTypedData_v4');
  });

  it('does not throw on missing params', () => {
    expect(() => decodeTypedData('eth_signTypedData_v4', null, ctx)).not.toThrow();
  });

  it('flags an unlimited entry inside a real PermitBatch (Permit2 details[])', () => {
    // Permit2's actual PermitBatch carries `details` as an array — one entry
    // per token. A single-object extraction (as PermitSingle uses) silently
    // drops every amount but the first, hiding an unlimited grant.
    const batch = {
      domain: { name: 'Permit2', chainId: 8453, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      primaryType: 'PermitBatch',
      message: {
        spender: '0xrouter',
        details: [
          { token: '0xtokA', amount: '5', expiration: '1999999999' },
          { token: '0xtokB', amount: MAX, expiration: '1999999999' },
        ],
      },
      types: {},
    };
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(batch)], ctx);
    expect(card.fields).toContainEqual({ label: 'Spender', value: '0xrouter', mono: true });
    expect(card.fields.some((f) => f.label === 'Amount 1' && f.value === '5')).toBe(true);
    expect(card.fields.some((f) => f.label === 'Amount 2' && f.value === 'UNLIMITED')).toBe(true);
    expect(card.warnings.some((w) => w.severity === 'danger' && /unlimited/i.test(w.text))).toBe(true);
  });

  it('recognises Permit2\'s real sentinel, type(uint160).max, as unlimited', () => {
    const p2 = {
      domain: { name: 'Permit2', chainId: 8453, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      primaryType: 'PermitSingle',
      message: {
        details: { token: '0xtok', amount: MAX_UINT160.toString(), expiration: '1999999999' },
        spender: '0xrouter',
      },
      types: {},
    };
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(p2)], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger' && /unlimited/i.test(w.text))).toBe(true);
  });
});
