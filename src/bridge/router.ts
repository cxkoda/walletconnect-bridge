import type {
  ConfirmPort,
  DappPort,
  IncomingRequest,
  JsonRpcErrorPayload,
  WalletPort,
} from './types';
import { RequestExpiredError, USER_REJECTED } from './types';
import { classify, isChainIndependent } from './policy';
import { toJsonRpcError, withTimeout } from './errors';
import { buildCard } from './decode';

export const WALLET_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Compile-time exhaustiveness check for the dispatch switch below. If a fifth
 * `Disposition` kind is ever added and not handled explicitly, this call site
 * fails to typecheck instead of silently falling through to "forward to the
 * wallet" — the exact failure mode the allowlist policy forbids.
 */
function assertNever(x: never): never {
  throw new Error(`Unhandled disposition: ${JSON.stringify(x)}`);
}

export interface RouterDeps {
  wallet: WalletPort;
  dapp: DappPort;
  confirm: ConfirmPort;
  isSmartAccount: () => boolean;
  timeoutMs?: number;
  /** Injectable clock, so expiry behaviour is testable without real waiting. */
  now?: () => number;
  /** Injectable sink for the diagnostics below. Defaults to console.error. */
  logError?: (message: string, err: unknown) => void;
}

/**
 * Handle one session_request end to end.
 *
 * Invariant: exactly one response per request id — except an expired request,
 * which gets none (responding to an expired id throws inside WalletKit).
 * A missing response leaves the dapp spinning forever with no recovery short of
 * a page reload, so the response is guaranteed by the `finally` block.
 */
export async function handleRequest(
  req: IncomingRequest,
  deps: RouterDeps,
): Promise<void> {
  const { wallet, dapp, confirm } = deps;
  const now = deps.now ?? Date.now;
  const logError =
    deps.logError ??
    ((message: string, err: unknown) => {
      console.error(message, err);
    });
  let responded = false;

  const respondResult = async (result: unknown) => {
    if (responded) return;
    responded = true;
    await dapp.respondResult(req.topic, req.id, result);
  };
  const respondError = async (error: JsonRpcErrorPayload) => {
    if (responded) return;
    responded = true;
    await dapp.respondError(req.topic, req.id, error);
  };

  /**
   * Milliseconds left on the request's own TTL, or null when it carries none.
   *
   * `expiryTimestamp` is in SECONDS (WalletConnect wire format), not ms.
   */
  const remainingMs = (): number | null =>
    req.expiryTimestamp === undefined ? null : req.expiryTimestamp * 1000 - now();

  /**
   * Abort if the dapp's TTL has lapsed.
   *
   * Without this, the whole expiry story only worked while the user was still
   * looking at the card: `session_request_expire` fires, `pending.expire(id)`
   * finds nothing because the slot settled the moment the user approved, and
   * the router carries on — the wallet signs, **the transaction lands
   * on-chain**, and only then does `respondResult` throw for the dead id. The
   * user pays gas for a request the dapp gave up on minutes earlier.
   *
   * Throwing `RequestExpiredError` routes into the same arm as the queue's own
   * expiry: claim the latch, send nothing.
   */
  const abortIfExpired = () => {
    const left = remainingMs();
    if (left !== null && left <= 0) throw new RequestExpiredError(req.id);
  };

  try {
    const disposition = classify(req.method);

    switch (disposition.kind) {
      case 'reject':
        await respondError({ code: disposition.code, message: disposition.message });
        return;
      case 'confirm':
      case 'unknown': {
        const card = buildCard(
          req,
          { chainId: req.chainId, isSmartAccount: deps.isSmartAccount() },
          disposition,
        );
        const approved = await confirm.confirm(req, card);
        if (!approved) {
          await respondError(USER_REJECTED);
          return;
        }
        break;
      }
      case 'pass':
        break;
      default:
        assertNever(disposition);
    }

    // The user may have taken minutes deciding. Check before spending a single
    // wallet round-trip on a request nobody is waiting for any more.
    abortIfExpired();

    if (!isChainIndependent(req.method)) {
      const currentChain = await wallet.getChainId();
      if (currentChain !== req.chainId) {
        await wallet.switchChain(req.chainId);
      }
    }

    // Never wait past the TTL: a wallet answering after expiry produces a
    // signature or a broadcast the dapp will never hear about.
    const baseTimeout = deps.timeoutMs ?? WALLET_TIMEOUT_MS;
    const left = remainingMs();
    const effectiveTimeout = left === null ? baseTimeout : Math.min(baseTimeout, left);

    const result = await withTimeout(
      wallet.request({ method: req.method, params: req.params }),
      effectiveTimeout,
      'Timed out waiting for the wallet to respond.',
    );

    // And check again on the way out: the wallet round-trip itself is the slow
    // part, and responding to an expired id throws inside WalletKit.
    abortIfExpired();
    await respondResult(result);
  } catch (err) {
    if (err instanceof RequestExpiredError) {
      // Suppress the finally-block fallback: an expired id must get no response.
      responded = true;
      return;
    }
    // The TTL can lapse while an unrelated failure is propagating (a clamped
    // wallet timeout is exactly that case). An expired id still gets nothing.
    const left = remainingMs();
    if (left !== null && left <= 0) {
      responded = true;
      return;
    }
    // This module is the highest-risk one in the app and its failures were
    // previously undiagnosable: every original error and stack was discarded
    // by toJsonRpcError, leaving only a 5000 and a message on the dapp's side.
    logError(`[router] ${req.method} (id ${req.id}) failed`, err);
    await respondError(toJsonRpcError(err));
  } finally {
    if (!responded) {
      responded = true;
      await dapp.respondError(req.topic, req.id, {
        code: 5000,
        message: 'Bridge failed to produce a response.',
      });
    }
  }
}
