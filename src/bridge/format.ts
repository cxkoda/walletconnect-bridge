export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;

/**
 * Decode hex to text, or null when the bytes are not valid UTF-8.
 *
 * Null is a meaningful result, not a failure: the caller shows raw hex and warns
 * the user that they are being asked to sign opaque bytes.
 */
export function hexToUtf8(hex: string): string | null {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    return null;
  }
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function toBigInt(v: unknown): bigint | null {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(v);
    if (typeof v === 'string' && v.trim() !== '') return BigInt(v);
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether an allowance is unlimited in practice.
 *
 * Covers the two sentinels in the wild (ERC-20 max-uint256, Permit2 max-uint160)
 * plus anything above 2^159, which is unlimited for any real token: 2^159 units
 * of an 18-decimal token is roughly 7e29 tokens.
 */
export function isUnlimitedAmount(v: bigint): boolean {
  return v === MAX_UINT256 || v === MAX_UINT160 || v >= 1n << 159n;
}

export function formatEther(wei: string | bigint): string {
  const value = toBigInt(wei);
  if (value === null) return '0';
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
