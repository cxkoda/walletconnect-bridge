/** A JSON-RPC error as sent back to the dapp. */
export interface JsonRpcErrorPayload {
  code: number;
  message: string;
}

/**
 * EIP-1193 user-rejection. Hand-written on purpose.
 *
 * `getSdkError('USER_REJECTED')` from @walletconnect/utils returns code 5000,
 * which lives in the WalletConnect protocol error namespace, NOT EIP-1193.
 * Dapps check for 4001 to distinguish "user said no" (re-enable the button)
 * from "something broke" (show an error state). Sending 5000 leaves dapps
 * stuck in a permanent failure state.
 */
export const USER_REJECTED: JsonRpcErrorPayload = {
  code: 4001,
  message: 'User rejected the request.',
};

/** How the bridge should treat an incoming method. */
export type Disposition =
  | { kind: 'pass' }
  | { kind: 'confirm' }
  | { kind: 'reject'; code: number; message: string }
  | { kind: 'unknown' };

export type Severity = 'info' | 'warn' | 'danger';

export interface CardWarning {
  severity: Severity;
  text: string;
}

export interface CardField {
  label: string;
  value: string;
  /** Render in a monospace font (addresses, hex, calldata). */
  mono?: boolean;
}

/** The human-readable model rendered in the approval modal. */
export interface RequestCard {
  method: string;
  title: string;
  fields: CardField[];
  warnings: CardWarning[];
  /** Pretty-printed original params, shown collapsed. */
  raw: string;
}

/** Who is asking, per session metadata + WalletKit Verify. */
export interface DappIdentity {
  name: string;
  url: string;
  iconUrl?: string;
  validation: 'VALID' | 'INVALID' | 'UNKNOWN';
  isScam: boolean;
}

/** A session_request, normalised away from WalletKit's shape. */
export interface IncomingRequest {
  id: number;
  topic: string;
  /** Parsed from the CAIP-2 `eip155:8453` the session request carries. */
  chainId: number;
  method: string;
  params: unknown;
  expiryTimestamp?: number;
  dapp: DappIdentity;
}

/** Thrown when a request expires while awaiting confirmation. */
export class RequestExpiredError extends Error {
  constructor(public readonly requestId: number) {
    super(`Request ${requestId} expired`);
    this.name = 'RequestExpiredError';
  }
}

/** Context the decoders need beyond the request itself. */
export interface DecodeContext {
  /** The session's chain, for detecting typed-data domain mismatch. */
  chainId: number;
  /** True when the connected account has contract code (a Base Account). */
  isSmartAccount: boolean;
}

/** Wallet-facing port. Implemented by src/cb/provider.ts. */
export interface WalletPort {
  request<T = unknown>(args: { method: string; params?: unknown }): Promise<T>;
  getChainId(): Promise<number>;
  switchChain(chainId: number): Promise<void>;
}

/** Dapp-facing port. Implemented by src/wc/walletkit.ts. */
export interface DappPort {
  respondResult(topic: string, id: number, result: unknown): Promise<void>;
  respondError(topic: string, id: number, error: JsonRpcErrorPayload): Promise<void>;
}

/** UI port. Implemented by src/ui/approval.ts. Rejects with RequestExpiredError. */
export interface ConfirmPort {
  confirm(req: IncomingRequest, card: RequestCard): Promise<boolean>;
}
