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

  it('refuses to decode non-hex calldata rather than guessing at it', () => {
    // `data` is attacker-controlled JSON off the wire. Anything that isn't
    // whole bytes of hex cannot be split into a selector and words at all, so
    // the card says so instead of rendering plausible-looking rubbish.
    const card = decodeTransaction(
      [{ to: '0xtok', data: '0x095ea7b3' + 'z'.repeat(128) }],
      ctx,
    );
    expect(
      card.warnings.some((w) => w.severity === 'danger' && /malformed/i.test(w.text)),
    ).toBe(true);
    expect(card.fields.some((f) => f.label === 'Function')).toBe(false);
  });

  it('does not throw on non-hex setApprovalForAll calldata', () => {
    expect(() =>
      decodeTransaction([{ to: '0xnft', data: '0xa22cb465' + 'z'.repeat(128) }], ctx),
    ).not.toThrow();
  });

  describe('calldata prefix validation', () => {
    const APPROVE_MAX = '0x095ea7b3' + pad('0xbeef') + MAX;

    it('decodes the well-formed control payload', () => {
      const card = decodeTransaction([{ to: '0xtok', data: APPROVE_MAX }], ctx);
      expect(card.fields.some((f) => f.label === 'Allowance' && f.value === 'UNLIMITED')).toBe(true);
      expect(card.warnings.some((w) => /UNLIMITED/.test(w.text))).toBe(true);
    });

    // `data.slice(0, 10)` assumed the `0x` prefix. Strip it (or prepend a
    // space) and the same unlimited-approval payload used to render as
    // `Function: unknown 095ea7b3bb` with no Spender row, no Allowance row and
    // NO UNLIMITED WARNING — a two-character edit that silently disarmed the
    // selector table, with every extracted word misaligned but confident.
    it.each([
      ['prefix stripped', APPROVE_MAX.slice(2)],
      ['leading space', ' ' + APPROVE_MAX],
      ['uppercase prefix', '0X' + APPROVE_MAX.slice(2)],
    ])('never lets %s bypass the selector table', (_label, data) => {
      const card = decodeTransaction([{ to: '0xtok', data }], ctx);
      expect(
        card.warnings.some((w) => w.severity === 'danger' && /malformed/i.test(w.text)),
      ).toBe(true);
      // Crucially: it must NOT claim to have identified a function.
      expect(card.fields.some((f) => f.label === 'Function')).toBe(false);
      expect(card.fields.some((f) => f.label === 'Spender')).toBe(false);
    });

    it('rejects odd-length calldata instead of reporting fractional bytes', () => {
      const card = decodeTransaction([{ to: '0xc', data: '0xdeadbeef1' }], ctx);
      expect(card.fields.every((f) => !/4\.5 bytes/.test(f.value))).toBe(true);
      expect(
        card.warnings.some((w) => w.severity === 'danger' && /malformed/i.test(w.text)),
      ).toBe(true);
    });
  });

  describe('value', () => {
    it('always renders a Value row, including a genuine zero', () => {
      const card = decodeTransaction([{ to: '0xabc', value: '0x0' }], ctx);
      expect(card.fields).toContainEqual({ label: 'Value', value: '0 ETH' });
    });

    it('renders a Value row when the field is absent entirely', () => {
      const card = decodeTransaction([{ to: '0xabc' }], ctx);
      expect(card.fields).toContainEqual({ label: 'Value', value: '0 ETH' });
    });

    it('accepts a JSON number value', () => {
      // A number, not a hex string — previously ignored outright, so a
      // one-ETH transfer rendered exactly like a zero-value call.
      const card = decodeTransaction([{ to: '0xabc', value: 1e18 }], ctx);
      expect(card.fields).toContainEqual({ label: 'Value', value: '1 ETH' });
    });

    it('accepts a bigint value', () => {
      const card = decodeTransaction([{ to: '0xabc', value: 2n * 10n ** 18n }], ctx);
      expect(card.fields).toContainEqual({ label: 'Value', value: '2 ETH' });
    });

    it('accepts a decimal string value', () => {
      const card = decodeTransaction([{ to: '0xabc', value: '1000000000000000000' }], ctx);
      expect(card.fields).toContainEqual({ label: 'Value', value: '1 ETH' });
    });

    it.each([
      ['a non-hex string', 'lots'],
      ['a fractional number', 1.5],
      ['an object', { evil: true }],
      ['a negative amount', '-1'],
    ])('says so loudly when the value is %s', (_label, value) => {
      const card = decodeTransaction([{ to: '0xabc', value }], ctx);
      expect(card.fields).toContainEqual({ label: 'Value', value: 'Could not decode' });
      // It must never be mistakable for a zero-value call.
      expect(card.fields.some((f) => f.label === 'Value' && /ETH/.test(f.value))).toBe(false);
      expect(
        card.warnings.some((w) => w.severity === 'danger' && /value/i.test(w.text)),
      ).toBe(true);
    });
  });
});
