import type {
  DecodeContext,
  DecodedCard,
  Disposition,
  IncomingRequest,
  RequestCard,
} from '../types';
import { classify } from '../policy';
import { safeJson } from '../format';
import { decodePersonalSign } from './sign';
import { decodeTypedData } from './typed';
import { decodeTransaction } from './tx';
import { decodeSendCalls } from './calls';
import { decodeAddEthereumChain, decodeRawTransaction, decodeWatchAsset } from './misc';

function decode(req: IncomingRequest, ctx: DecodeContext): DecodedCard {
  switch (req.method) {
    case 'personal_sign':
      return decodePersonalSign(req.params, ctx);
    case 'eth_signTypedData':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4':
      return decodeTypedData(req.method, req.params, ctx);
    case 'eth_sendTransaction':
      return decodeTransaction(req.params, ctx);
    case 'wallet_sendCalls':
      return decodeSendCalls(req.params, ctx);
    case 'eth_sendRawTransaction':
      return decodeRawTransaction(req.params, ctx);
    case 'wallet_addEthereumChain':
      return decodeAddEthereumChain(req.params, ctx);
    case 'wallet_watchAsset':
      return decodeWatchAsset(req.params, ctx);
    default:
      return {
        method: req.method,
        title: `Unrecognised request: ${req.method}`,
        fields: [{ label: 'Method', value: req.method, mono: true }],
        warnings: [
          {
            severity: 'warn',
            text: `This dapp asked for "${req.method}", which is not in the allowlist. Forward it only if you understand what it does.`,
          },
        ],
        raw: safeJson(req.params),
      };
  }
}

/**
 * Build the approval card for one request.
 *
 * Every CONFIRM method must have a case in `decode` above. The `default` arm is
 * for genuinely unknown methods only: it says the method "is not in the
 * allowlist", which for an allowlisted method with a missing decoder is simply
 * false — and a card that tells the user something false about a
 * `wallet_sendCalls` batch is worse than no card at all.
 */
export function buildCard(
  req: IncomingRequest,
  ctx: DecodeContext,
  disposition: Disposition = classify(req.method),
): RequestCard {
  return { ...decode(req, ctx), disposition };
}
