import { createCoinbaseWalletSDK } from '@coinbase/wallet-sdk';
import type { ProviderInterface } from '@coinbase/wallet-sdk';
import { SUPPORTED_CHAIN_IDS } from '../chains';
import type { WalletPort } from '../bridge/types';

export interface WalletConnection {
  provider: ProviderInterface;
  address: string;
  isSmartAccount: boolean;
  port: WalletPort;
}

export function createWalletPort(provider: ProviderInterface): WalletPort {
  return {
    request: <T>(args: { method: string; params?: unknown }) =>
      provider.request(args as never) as Promise<T>,

    async getChainId() {
      const hex = (await provider.request({ method: 'eth_chainId' })) as string;
      return Number(hex);
    },

    async switchChain(chainId: number) {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      });
    },
  };
}

/**
 * A Base Account is a contract account, so its address has code. This drives
 * the ERC-1271 warnings on signature cards. A failure here must not block the
 * connection — we just lose the warning.
 */
export async function detectSmartAccount(
  provider: ProviderInterface,
  address: string,
): Promise<boolean> {
  try {
    const code = (await provider.request({
      method: 'eth_getCode',
      params: [address, 'latest'],
    })) as string;
    return typeof code === 'string' && code !== '0x' && code.length > 2;
  } catch {
    return false;
  }
}

export async function connectWallet(): Promise<WalletConnection> {
  const sdk = createCoinbaseWalletSDK({
    appName: 'CB ↔ WalletConnect Bridge',
    appLogoUrl: null,
    appChainIds: SUPPORTED_CHAIN_IDS,
  });
  const provider = sdk.getProvider();

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts[0];
  if (!address) throw new Error('Coinbase Wallet returned no accounts.');

  return {
    provider,
    address,
    isSmartAccount: await detectSmartAccount(provider, address),
    port: createWalletPort(provider),
  };
}
