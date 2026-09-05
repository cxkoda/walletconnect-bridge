import { describe, it, expect } from 'vitest';
import { decodePersonalSign, parseSiwe } from './sign';
import type { DecodeContext } from '../types';

const eoa: DecodeContext = { chainId: 8453, isSmartAccount: false };
const smart: DecodeContext = { chainId: 8453, isSmartAccount: true };

const hex = (s: string) =>
  '0x' + Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const SIWE = `example.com wants you to sign in with your Ethereum account:
0x1111111111111111111111111111111111111111

Sign in to Example.

URI: https://example.com
Version: 1
Chain ID: 8453
Nonce: abc123
Issued At: 2026-09-05T12:00:00Z`;

describe('parseSiwe', () => {
  it('parses a well-formed SIWE message', () => {
    const m = parseSiwe(SIWE);
    expect(m).not.toBeNull();
    expect(m!.domain).toBe('example.com');
    expect(m!.address).toBe('0x1111111111111111111111111111111111111111');
    expect(m!.uri).toBe('https://example.com');
    expect(m!.chainId).toBe(8453);
    expect(m!.nonce).toBe('abc123');
    expect(m!.statement).toBe('Sign in to Example.');
  });

  it('returns null for ordinary text', () => {
    expect(parseSiwe('hello world')).toBeNull();
  });
});

describe('decodePersonalSign', () => {
  it('decodes a plain UTF-8 message', () => {
    const card = decodePersonalSign([hex('hello world'), '0xabc'], eoa);
    expect(card.method).toBe('personal_sign');
    expect(card.fields).toContainEqual({ label: 'Message', value: 'hello world' });
    expect(card.warnings).toHaveLength(0);
  });

  it('falls back to raw hex for non-UTF-8 payloads and warns', () => {
    const card = decodePersonalSign(['0xfffefd', '0xabc'], eoa);
    expect(card.fields[0].label).toMatch(/raw hex/i);
    expect(card.warnings.some((w) => /utf-8/i.test(w.text))).toBe(true);
  });

  it('surfaces SIWE fields', () => {
    const card = decodePersonalSign([hex(SIWE), '0xabc'], eoa);
    expect(card.title).toMatch(/sign-in/i);
    expect(card.fields).toContainEqual({ label: 'Sign-in domain', value: 'example.com' });
  });

  it('warns that a smart account signature may fail SIWE verification', () => {
    const card = decodePersonalSign([hex(SIWE), '0xabc'], smart);
    expect(card.warnings.some((w) => /1271/i.test(w.text))).toBe(true);
  });

  it('does not raise the 1271 warning for an EOA', () => {
    const card = decodePersonalSign([hex(SIWE), '0xabc'], eoa);
    expect(card.warnings.some((w) => /1271/i.test(w.text))).toBe(false);
  });

  it('flags a SIWE chain id that disagrees with the session chain', () => {
    const other = SIWE.replace('Chain ID: 8453', 'Chain ID: 1');
    const card = decodePersonalSign([hex(other), '0xabc'], eoa);
    expect(card.warnings.some((w) => w.severity === 'danger' && /chain/i.test(w.text))).toBe(true);
  });

  it('tolerates malformed params without throwing', () => {
    expect(() => decodePersonalSign(null, eoa)).not.toThrow();
    expect(() => decodePersonalSign([], eoa)).not.toThrow();
    expect(decodePersonalSign([], eoa).method).toBe('personal_sign');
  });
});
