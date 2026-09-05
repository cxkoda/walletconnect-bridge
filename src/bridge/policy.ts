import type { Disposition } from './types';

/** Read-only and housekeeping methods. Cannot move value; forwarded silently. */
export const PASS_METHODS = [
  'eth_accounts',
  'eth_chainId',
  'eth_call',
  'eth_estimateGas',
  'eth_getBalance',
  'eth_getCode',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'wallet_switchEthereumChain',
  'wallet_getCapabilities',
] as const;

/** Anything that signs, spends, or changes wallet configuration. */
export const CONFIRM_METHODS = [
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'wallet_sendCalls',
  'wallet_addEthereumChain',
  'wallet_watchAsset',
] as const;

const REJECTED: Record<string, string> = {
  eth_sign:
    'eth_sign is deprecated and unsupported by this bridge. Use personal_sign instead.',
  eth_signTransaction:
    'eth_signTransaction is not possible for a smart account, which cannot produce a standalone signed transaction. Use eth_sendTransaction.',
};

/**
 * What the bridge promises during session negotiation.
 *
 * Deliberately narrower than PASS_METHODS + CONFIRM_METHODS: advertising is the
 * contract, policy is runtime handling. Dapps routinely send methods they never
 * negotiated, and those still need a disposition.
 */
export const ADVERTISED_METHODS = [
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'eth_accounts',
  'eth_chainId',
] as const;

const passSet: ReadonlySet<string> = new Set(PASS_METHODS);
const confirmSet: ReadonlySet<string> = new Set(CONFIRM_METHODS);

/**
 * Allowlist, not blocklist. An unrecognised method returns `unknown`, which the
 * router turns into an explicit user decision — it is never forwarded blindly.
 */
export function classify(method: string): Disposition {
  const rejection = REJECTED[method];
  if (rejection) return { kind: 'reject', code: 4200, message: rejection };
  if (passSet.has(method)) return { kind: 'pass' };
  if (confirmSet.has(method)) return { kind: 'confirm' };
  return { kind: 'unknown' };
}
