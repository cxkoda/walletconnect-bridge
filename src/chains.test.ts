import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_CHAINS,
  SUPPORTED_CHAIN_IDS,
  SUPPORTED_CAIP_CHAINS,
  parseCaipChainId,
  toCaipChainId,
  chainName,
} from './chains';

describe('chains', () => {
  it('includes Base mainnet', () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(8453);
  });

  it('derives ids and CAIP ids from the same table', () => {
    expect(SUPPORTED_CHAIN_IDS).toEqual(SUPPORTED_CHAINS.map((c) => c.id));
    expect(SUPPORTED_CAIP_CHAINS).toEqual(SUPPORTED_CHAINS.map((c) => `eip155:${c.id}`));
  });

  it('has no duplicate chain ids', () => {
    expect(new Set(SUPPORTED_CHAIN_IDS).size).toBe(SUPPORTED_CHAIN_IDS.length);
  });

  it('round-trips CAIP-2 chain ids', () => {
    expect(toCaipChainId(8453)).toBe('eip155:8453');
    expect(parseCaipChainId('eip155:8453')).toBe(8453);
  });

  it('rejects a non-eip155 CAIP id', () => {
    expect(() => parseCaipChainId('solana:mainnet')).toThrow(/eip155/);
  });

  it('rejects a malformed CAIP id', () => {
    expect(() => parseCaipChainId('eip155:abc')).toThrow();
  });

  it('names known chains and falls back for unknown ones', () => {
    expect(chainName(8453)).toBe('Base');
    expect(chainName(999999)).toBe('Chain 999999');
  });
});
