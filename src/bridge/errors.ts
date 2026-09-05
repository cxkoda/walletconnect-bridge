import type { JsonRpcErrorPayload } from './types';

/** Standard EIP-1193 provider error codes worth relaying verbatim. */
const EIP1193_CODES = new Set([4001, 4100, 4200, 4900, 4901, 4902]);

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return 'Unknown bridge error';
}

/**
 * Map anything thrown while handling a request onto a JSON-RPC error.
 *
 * 4001 surviving as 4001 is load-bearing: dapps use it to tell "user said no"
 * from "something broke". Only genuine EIP-1193 codes pass through — a stray
 * numeric `code` (an HTTP status, an errno) must not masquerade as one.
 */
export function toJsonRpcError(err: unknown): JsonRpcErrorPayload {
  const message = messageOf(err);
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'number' && EIP1193_CODES.has(code)) {
      return { code, message };
    }
  }
  return { code: 5000, message };
}

/** Reject with TimeoutError if `p` has not settled within `ms`. */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
