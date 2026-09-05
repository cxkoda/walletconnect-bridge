import { describe, it, expect } from 'vitest';
import { decodeAddEthereumChain, decodeRawTransaction, decodeWatchAsset } from './misc';
import type { DecodeContext } from '../types';

const ctx: DecodeContext = { chainId: 8453, isSmartAccount: true };

/**
 * All three methods are in the CONFIRM allowlist but had no decoder, so each
 * fell to the generic card claiming the method "is not in the allowlist" — a
 * statement that is not true. These assert the cards are at minimum honest.
 */
describe('decoders for the remaining CONFIRM methods', () => {
  it.each([
    ['eth_sendRawTransaction', () => decodeRawTransaction(['0xf86b80'], ctx)],
    ['wallet_addEthereumChain', () => decodeAddEthereumChain([{ chainId: '0x1a4' }], ctx)],
    ['wallet_watchAsset', () => decodeWatchAsset({ type: 'ERC20', options: {} }, ctx)],
  ])('%s never claims to be outside the allowlist', (method, build) => {
    const card = build();
    expect(card.method).toBe(method);
    expect(card.title).not.toMatch(/unrecognised/i);
    expect(card.warnings.some((w) => /not in the allowlist/i.test(w.text))).toBe(false);
  });
});

describe('decodeRawTransaction', () => {
  it('admits it cannot see inside a pre-signed transaction', () => {
    const card = decodeRawTransaction(['0x' + 'ab'.repeat(100)], ctx);
    expect(
      card.warnings.some((w) => w.severity === 'danger' && /does not decode/i.test(w.text)),
    ).toBe(true);
    expect(card.fields).toContainEqual({ label: 'Size', value: '100 bytes' });
  });

  it('names the session network', () => {
    expect(decodeRawTransaction(['0xab'], ctx).fields).toContainEqual({
      label: 'Network',
      value: 'Base',
    });
  });

  it('does not throw on malformed params', () => {
    expect(() => decodeRawTransaction(null, ctx)).not.toThrow();
    expect(() => decodeRawTransaction([{}], ctx)).not.toThrow();
  });
});

describe('decodeAddEthereumChain', () => {
  const chain = (over: Record<string, unknown> = {}) => [
    {
      chainId: '0x2019',
      chainName: 'Klaytn',
      rpcUrls: ['https://rpc.example'],
      nativeCurrency: { symbol: 'KLAY', decimals: 18 },
      ...over,
    },
  ];

  it('shows the chain id, name and RPC endpoint', () => {
    const card = decodeAddEthereumChain(chain(), ctx);
    expect(card.fields).toContainEqual({ label: 'Chain ID', value: '8217', mono: true });
    expect(card.fields).toContainEqual({ label: 'Name', value: 'Klaytn' });
    expect(card.fields).toContainEqual({
      label: 'RPC URL',
      value: 'https://rpc.example',
      mono: true,
    });
    expect(card.fields).toContainEqual({ label: 'Currency', value: 'KLAY' });
  });

  it('warns that the dapp chooses the RPC endpoint', () => {
    const card = decodeAddEthereumChain(chain(), ctx);
    expect(card.warnings.some((w) => /RPC/i.test(w.text))).toBe(true);
  });

  it('raises a danger warning when a dapp re-defines a chain we already support', () => {
    // The real attack: "Ethereum Mainnet", chainId 1, RPC pointed at a host
    // the attacker controls.
    const card = decodeAddEthereumChain(
      chain({ chainId: '0x1', chainName: 'Ethereum Mainnet', rpcUrls: ['https://evil.example'] }),
      ctx,
    );
    expect(
      card.warnings.some((w) => w.severity === 'danger' && /already supports/i.test(w.text)),
    ).toBe(true);
  });

  it('lists every RPC URL when several are offered', () => {
    const card = decodeAddEthereumChain(chain({ rpcUrls: ['https://a', 'https://b'] }), ctx);
    expect(card.fields).toContainEqual({ label: 'RPC URL 1', value: 'https://a', mono: true });
    expect(card.fields).toContainEqual({ label: 'RPC URL 2', value: 'https://b', mono: true });
  });

  it('does not throw on malformed params', () => {
    expect(() => decodeAddEthereumChain(null, ctx)).not.toThrow();
    expect(() => decodeAddEthereumChain([{ chainId: {} }], ctx)).not.toThrow();
    expect(() => decodeAddEthereumChain(['nonsense'], ctx)).not.toThrow();
  });
});

describe('decodeWatchAsset', () => {
  const asset = {
    type: 'ERC20',
    options: { address: '0xtoken', symbol: 'USDC', decimals: 6 },
  };

  it('reads EIP-747\'s object params, which are not an array', () => {
    const card = decodeWatchAsset(asset, ctx);
    expect(card.fields).toContainEqual({ label: 'Contract', value: '0xtoken', mono: true });
    expect(card.fields).toContainEqual({ label: 'Symbol', value: 'USDC' });
    expect(card.fields).toContainEqual({ label: 'Decimals', value: '6' });
  });

  it('also reads the array-wrapped shape some dapps send', () => {
    const card = decodeWatchAsset([asset], ctx);
    expect(card.fields).toContainEqual({ label: 'Contract', value: '0xtoken', mono: true });
  });

  it('says the symbol proves nothing and points at the contract address', () => {
    const card = decodeWatchAsset(asset, ctx);
    expect(card.warnings.some((w) => /contract address/i.test(w.text))).toBe(true);
  });

  it('does not throw on malformed params', () => {
    expect(() => decodeWatchAsset(null, ctx)).not.toThrow();
    expect(() => decodeWatchAsset('nonsense', ctx)).not.toThrow();
  });
});
