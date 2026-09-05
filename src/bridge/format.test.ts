import { describe, it, expect } from 'vitest';
import {
  hexToUtf8,
  toBigInt,
  isUnlimitedAmount,
  formatEther,
  shortAddress,
  MAX_UINT256,
  MAX_UINT160,
} from './format';

describe('hexToUtf8', () => {
  it('decodes valid UTF-8 hex', () => {
    expect(hexToUtf8('0x68656c6c6f')).toBe('hello');
  });

  it('decodes multi-byte characters', () => {
    expect(hexToUtf8('0xc3a9')).toBe('é');
  });

  it('returns null for bytes that are not valid UTF-8', () => {
    expect(hexToUtf8('0xfffefd')).toBeNull();
  });

  it('returns null for malformed hex', () => {
    expect(hexToUtf8('0xzz')).toBeNull();
    expect(hexToUtf8('0x123')).toBeNull();
    expect(hexToUtf8('')).toBeNull();
  });
});

describe('toBigInt', () => {
  it('parses decimal strings, hex strings, numbers and bigints', () => {
    expect(toBigInt('100')).toBe(100n);
    expect(toBigInt('0x64')).toBe(100n);
    expect(toBigInt(100)).toBe(100n);
    expect(toBigInt(100n)).toBe(100n);
  });

  it('returns null for junk', () => {
    expect(toBigInt('abc')).toBeNull();
    expect(toBigInt(null)).toBeNull();
    expect(toBigInt({})).toBeNull();
  });
});

describe('isUnlimitedAmount', () => {
  it('flags the ERC-20 max-uint256 sentinel', () => {
    expect(isUnlimitedAmount(MAX_UINT256)).toBe(true);
  });

  it('flags the Permit2 max-uint160 sentinel', () => {
    expect(isUnlimitedAmount(MAX_UINT160)).toBe(true);
  });

  it('does not flag ordinary amounts', () => {
    expect(isUnlimitedAmount(0n)).toBe(false);
    expect(isUnlimitedAmount(10n ** 24n)).toBe(false);
  });
});

describe('formatEther', () => {
  it('formats whole ether from a hex wei string', () => {
    expect(formatEther('0xde0b6b3a7640000')).toBe('1');
  });

  it('formats a fraction and trims trailing zeros', () => {
    expect(formatEther(10n ** 17n)).toBe('0.1');
    expect(formatEther(1500000000000000000n)).toBe('1.5');
  });

  it('formats zero as "0"', () => {
    expect(formatEther('0x0')).toBe('0');
    expect(formatEther(0n)).toBe('0');
  });

  it('returns "0" for unparseable input rather than throwing', () => {
    expect(formatEther('nonsense')).toBe('0');
  });
});

describe('shortAddress', () => {
  it('abbreviates the middle', () => {
    expect(shortAddress('0x1111111111111111111111111111111111111111')).toBe('0x1111…1111');
  });

  it('leaves short strings alone', () => {
    expect(shortAddress('0xabc')).toBe('0xabc');
  });
});
