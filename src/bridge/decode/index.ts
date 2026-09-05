import type { DecodeContext, IncomingRequest, RequestCard } from '../types';
import { decodePersonalSign } from './sign';
import { decodeTypedData } from './typed';
import { decodeTransaction } from './tx';

export function buildCard(req: IncomingRequest, ctx: DecodeContext): RequestCard {
  switch (req.method) {
    case 'personal_sign':
      return decodePersonalSign(req.params, ctx);
    case 'eth_signTypedData':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4':
      return decodeTypedData(req.method, req.params, ctx);
    case 'eth_sendTransaction':
      return decodeTransaction(req.params, ctx);
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
        raw: JSON.stringify(req.params, null, 2),
      };
  }
}
