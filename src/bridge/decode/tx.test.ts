import { describe, it, expect } from 'vitest';
import { decodeTransaction } from './tx';
import type { DecodeContext } from '../types';

const ctx: DecodeContext = { chainId: 8453, isSmartAccount: true };
const pad = (s: string) => s.replace(/^0x/, '').padStart(64, '0');
const MAX = 'f'.repeat(64);

describe('decodeTransaction', () => {
  it('shows recipient and value in ETH', () => {
    const card = decodeTransaction(
      [{ to: '0x1111111111111111111111111111111111111111', value: '0xde0b6b3a7640000' }],
      ctx,
    );
    expect(card.fields).toContainEqual({
      label: 'To',
      value: '0x1111111111111111111111111111111111111111',
      mono: true,
    });
    expect(card.fields.some((f) => f.label === 'Value' && f.value === '1 ETH')).toBe(true);
  });

  it('treats a missing `to` as contract creation and warns', () => {
    const card = decodeTransaction([{ data: '0x6060' }], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger' && /contract creation/i.test(w.text))).toBe(true);
  });

  it('names a known selector', () => {
    const card = decodeTransaction(
      [{ to: '0xtok', data: '0xa9059cbb' + pad('0x22') + pad('0x64') }],
      ctx,
    );
    expect(card.fields.some((f) => f.label === 'Function' && /transfer/.test(f.value))).toBe(true);
  });

  it('decodes approve args and shouts about unlimited allowance', () => {
    const card = decodeTransaction(
      [{ to: '0xtok', data: '0x095ea7b3' + pad('0xbeef') + MAX }],
      ctx,
    );
    expect(card.fields.some((f) => f.label === 'Spender')).toBe(true);
    expect(card.fields.some((f) => f.label === 'Allowance' && f.value === 'UNLIMITED')).toBe(true);
    expect(card.warnings.some((w) => w.severity === 'danger' && /unlimited/i.test(w.text))).toBe(true);
  });

  it('reports a finite approve amount without the unlimited warning', () => {
    const card = decodeTransaction(
      [{ to: '0xtok', data: '0x095ea7b3' + pad('0xbeef') + pad('0x64') }],
      ctx,
    );
    expect(card.fields.some((f) => f.label === 'Allowance' && f.value === '100')).toBe(true);
    expect(card.warnings.some((w) => /unlimited/i.test(w.text))).toBe(false);
  });

  it('warns when setApprovalForAll grants approval', () => {
    const card = decodeTransaction(
      [{ to: '0xnft', data: '0xa22cb465' + pad('0xbeef') + pad('0x1') }],
      ctx,
    );
    expect(card.warnings.some((w) => w.severity === 'danger' && /every/i.test(w.text))).toBe(true);
  });

  it('does not warn when setApprovalForAll revokes approval', () => {
    const card = decodeTransaction(
      [{ to: '0xnft', data: '0xa22cb465' + pad('0xbeef') + pad('0x0') }],
      ctx,
    );
    expect(card.warnings.some((w) => /every/i.test(w.text))).toBe(false);
  });

  it('falls back to selector plus calldata size for unknown functions', () => {
    const card = decodeTransaction([{ to: '0xc', data: '0xdeadbeef' + pad('0x1') }], ctx);
    expect(card.fields.some((f) => f.label === 'Function' && f.value.includes('0xdeadbeef'))).toBe(true);
    expect(card.fields.some((f) => /bytes/.test(f.value))).toBe(true);
  });

  it('handles a plain value transfer with no data', () => {
    const card = decodeTransaction([{ to: '0xabc', value: '0x0' }], ctx);
    expect(card.fields.some((f) => f.label === 'Function')).toBe(false);
  });

  it('does not throw on malformed params', () => {
    expect(() => decodeTransaction(null, ctx)).not.toThrow();
    expect(() => decodeTransaction([], ctx)).not.toThrow();
    expect(() => decodeTransaction([{ to: '0xa', data: '0x09' }], ctx)).not.toThrow();
  });
});
