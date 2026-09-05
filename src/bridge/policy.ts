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

/**
 * Methods whose answer does not depend on which chain the wallet is currently
 * on, so the router must not sync the chain before forwarding them.
 *
 * The sync exists for `eth_call` / `eth_estimateGas` / `eth_getBalance`, which
 * genuinely read chain state and would answer from the wrong chain without it.
 * Applying it to everything meant a bare `eth_chainId` or `eth_accounts` could
 * pop a real network-switch prompt in the Base app for a question that never
 * needed one — and `wallet_switchEthereumChain` cost *two* prompts for one
 * switch: one to sync to the session chain, then the dapp's own.
 */
export const CHAIN_INDEPENDENT_METHODS = [
  'eth_accounts',
  'eth_chainId',
  'wallet_getCapabilities',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_watchAsset',
] as const;

const passSet: ReadonlySet<string> = new Set(PASS_METHODS);
const confirmSet: ReadonlySet<string> = new Set(CONFIRM_METHODS);
const chainIndependentSet: ReadonlySet<string> = new Set(CHAIN_INDEPENDENT_METHODS);

/**
 * Whether the router may skip the chain sync for this method.
 *
 * Deny-by-default on purpose: an unrecognised method is assumed to need the
 * right chain. Being on the wrong chain is a correctness bug; an extra prompt
 * is only an annoyance.
 */
export function isChainIndependent(method: string): boolean {
  return chainIndependentSet.has(method);
}

/**
 * Allowlist, not blocklist. An unrecognised method returns `unknown`, which the
 * router turns into an explicit user decision — it is never forwarded blindly.
 */
export function classify(method: string): Disposition {
  // Object.hasOwn, not `REJECTED[method]`: a plain index lookup resolves
  // inherited Object.prototype members ('toString', 'constructor', 'valueOf',
  // ...), which would return a truthy function as `message` — violating the
  // `message: string` contract and silently dropping the message when the
  // payload is serialised to the dapp.
  if (Object.hasOwn(REJECTED, method)) {
    return { kind: 'reject', code: 4200, message: REJECTED[method] };
  }
  if (passSet.has(method)) return { kind: 'pass' };
  if (confirmSet.has(method)) return { kind: 'confirm' };
  return { kind: 'unknown' };
}
