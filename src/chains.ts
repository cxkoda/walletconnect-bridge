export interface ChainInfo {
  id: number;
  name: string;
  nativeSymbol: string;
}

/**
 * Single source of truth for supported chains.
 *
 * Feeds BOTH the Coinbase SDK's `appChainIds` and the WalletConnect
 * `supportedNamespaces`. If those two ever drift, the bridge advertises chains
 * it cannot serve and every request on them fails after the dapp has already
 * connected. Never hardcode a chain list anywhere else.
 */
export const SUPPORTED_CHAINS: ChainInfo[] = [
  { id: 8453, name: 'Base', nativeSymbol: 'ETH' },
  { id: 84532, name: 'Base Sepolia', nativeSymbol: 'ETH' },
  { id: 1, name: 'Ethereum', nativeSymbol: 'ETH' },
  { id: 10, name: 'Optimism', nativeSymbol: 'ETH' },
  { id: 42161, name: 'Arbitrum One', nativeSymbol: 'ETH' },
  { id: 7777777, name: 'Zora', nativeSymbol: 'ETH' },
];

export const SUPPORTED_CHAIN_IDS: number[] = SUPPORTED_CHAINS.map((c) => c.id);

export const SUPPORTED_CAIP_CHAINS: string[] = SUPPORTED_CHAINS.map(
  (c) => `eip155:${c.id}`,
);

export function toCaipChainId(id: number): string {
  return `eip155:${id}`;
}

export function parseCaipChainId(caip: string): number {
  const [namespace, reference] = caip.split(':');
  if (namespace !== 'eip155') {
    throw new Error(`Unsupported CAIP namespace "${namespace}", expected eip155`);
  }
  if (!/^\d+$/.test(reference ?? '')) {
    throw new Error(`Malformed CAIP chain id "${caip}"`);
  }
  return Number(reference);
}

export function chainName(id: number): string {
  return SUPPORTED_CHAINS.find((c) => c.id === id)?.name ?? `Chain ${id}`;
}
