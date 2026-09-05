import type {
  ConfirmPort,
  DappPort,
  IncomingRequest,
  JsonRpcErrorPayload,
  WalletPort,
} from './types';
import { RequestExpiredError, USER_REJECTED } from './types';
import { classify } from './policy';
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

  try {
    const disposition = classify(req.method);

    switch (disposition.kind) {
      case 'reject':
        await respondError({ code: disposition.code, message: disposition.message });
        return;
      case 'confirm':
      case 'unknown': {
        const card = buildCard(req, {
          chainId: req.chainId,
          isSmartAccount: deps.isSmartAccount(),
        });
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

    const currentChain = await wallet.getChainId();
    if (currentChain !== req.chainId) {
      await wallet.switchChain(req.chainId);
    }

    const result = await withTimeout(
      wallet.request({ method: req.method, params: req.params }),
      deps.timeoutMs ?? WALLET_TIMEOUT_MS,
      'Timed out waiting for the wallet to respond.',
    );
    await respondResult(result);
  } catch (err) {
    if (err instanceof RequestExpiredError) {
      // Suppress the finally-block fallback: an expired id must get no response.
      responded = true;
      return;
    }
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
