import type { CardField, CardWarning, DecodeContext, DecodedCard } from '../types';
import { decodeCall } from './tx';
import { safeJson } from '../format';
import { chainName } from '../../chains';

/**
 * Cap on how many calls of a batch get rendered.
 *
 * `calls` is attacker-controlled and unbounded. A thousand-entry batch would
 * produce thousands of rows, burying whatever the user needed to see — the
 * denial-of-service version of a lie. Anything past the cap is refused
 * outright with a danger warning rather than silently dropped.
 */
export const MAX_RENDERED_CALLS = 20;

/**
 * `wallet_sendCalls` (EIP-5792) — params `[{ version, chainId, from, calls }]`.
 *
 * This is the NATIVE batch path for a Base Account, which makes it the most
 * likely fund-moving method the bridge will ever see, and every call in the
 * batch executes atomically on approval. Decoding only the first one (or, as
 * before, not at all) means a batch whose second call is
 * `approve(attacker, MAX_UINT256)` gets approved on the strength of an
 * innocuous first call.
 */
export function decodeSendCalls(params: unknown, ctx: DecodeContext): DecodedCard {
  const arr = Array.isArray(params) ? params : [];
  const bundle = (typeof arr[0] === 'object' && arr[0] !== null ? arr[0] : {}) as Record<
    string,
    unknown
  >;
  const fields: CardField[] = [];
  const warnings: CardWarning[] = [];

  const calls = Array.isArray(bundle.calls) ? bundle.calls : null;
  if (!calls) {
    warnings.push({
      severity: 'danger',
      text: 'This batch request carries no readable list of calls. The bridge cannot tell you what it does — do not approve unless you know.',
    });
    return {
      method: 'wallet_sendCalls',
      title: 'Batch transaction request',
      fields,
      warnings,
      raw: safeJson(params),
    };
  }

  fields.push({ label: 'Network', value: chainName(ctx.chainId) });
  fields.push({ label: 'Calls', value: String(calls.length) });

  const shown = calls.slice(0, MAX_RENDERED_CALLS);
  if (calls.length > shown.length) {
    warnings.push({
      severity: 'danger',
      text: `This batch contains ${calls.length} calls; only the first ${MAX_RENDERED_CALLS} are shown. The bridge cannot tell you what the rest do — do not approve unless you know.`,
    });
  }

  const dangerous: number[] = [];
  shown.forEach((entry, i) => {
    const call = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const decoded = decodeCall(call, `Call ${i + 1}`);
    fields.push(...decoded.fields);
    warnings.push(...decoded.warnings);
    if (decoded.warnings.some((w) => w.severity === 'danger')) dangerous.push(i + 1);
  });

  // A batch is all-or-nothing: approving it approves the worst call in it. Say
  // so once, at the top, rather than relying on the user to read to the bottom.
  if (dangerous.length > 0) {
    warnings.unshift({
      severity: 'danger',
      text: `${dangerous.length === 1 ? 'Call' : 'Calls'} ${dangerous.join(', ')} in this batch ${dangerous.length === 1 ? 'is' : 'are'} dangerous (see below). Approving this batch executes every call in it — you cannot approve part of it.`,
    });
  }

  return {
    method: 'wallet_sendCalls',
    title: `Batch transaction request (${calls.length} ${calls.length === 1 ? 'call' : 'calls'})`,
    fields,
    warnings,
    raw: safeJson(params),
  };
}
