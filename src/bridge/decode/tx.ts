import type { CardField, CardWarning, DecodeContext, DecodedCard } from '../types';
import { formatEther, isUnlimitedAmount, safeJson, toBigInt } from '../format';
import { chainName } from '../../chains';

/** Well-known 4-byte selectors worth naming on the approval card. */
export const SELECTORS: Record<string, string> = {
  '0x095ea7b3': 'approve(address,uint256)',
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0xa22cb465': 'setApprovalForAll(address,bool)',
  '0xd505accf': 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  '0xac9650d8': 'multicall(bytes[])',
  '0xb61d27f6': 'execute(address,uint256,bytes)',
};

/**
 * Well-formed `0x`-prefixed calldata: the prefix, hex digits only, whole bytes.
 *
 * Checking the prefix is not pedantry. `data.slice(0, 10)` assumes it, so
 * calldata with the `0x` stripped shifts every byte two characters left: an
 * `approve(spender, MAX_UINT256)` payload then reads as an unknown selector,
 * losing the Spender row, the Allowance row and the UNLIMITED warning, while
 * every word `word()` extracts is misaligned but rendered with full
 * confidence. A plausible-looking wrong decode is worse than an honest refusal.
 */
const HEX_CALLDATA = /^0x(?:[0-9a-fA-F]{2})*$/;

/** Read the nth 32-byte ABI word from calldata (after the 4-byte selector). */
function word(data: string, n: number): string | null {
  const start = 10 + n * 64;
  const w = data.slice(start, start + 64);
  return w.length === 64 ? w : null;
}

/**
 * Interpret a 32-byte word as a uint256.
 *
 * Calldata is attacker-controlled bytes straight off the wire. A bare
 * `BigInt('0x' + w)` throws SyntaxError on anything non-hex, which would take
 * down the whole approval card — the user's only view of the request — for a
 * malformed `data` field. Routes through `toBigInt`, which already
 * try/catches, and returns null ("could not decode") instead.
 */
function wordToBigInt(w: string): bigint | null {
  return toBigInt('0x' + w);
}

/** Interpret a 32-byte word as a left-padded address. Null when not valid hex. */
function wordToAddress(w: string): string | null {
  if (wordToBigInt(w) === null) return null;
  return '0x' + w.slice(24);
}

export interface DecodedCall {
  fields: CardField[];
  warnings: CardWarning[];
}

/**
 * Decode one call — `{ to, value, data }` — into card rows and warnings.
 *
 * Shared by `eth_sendTransaction` (one call) and `wallet_sendCalls` (a batch).
 * `label` prefixes every row so a batch's rows stay attributable to their call;
 * it is empty for a single transaction.
 */
export function decodeCall(
  call: Record<string, unknown>,
  prefix = '',
): DecodedCall {
  const fields: CardField[] = [];
  const warnings: CardWarning[] = [];
  const label = (name: string) => (prefix ? `${prefix} ${name}` : name);

  const to = typeof call.to === 'string' ? call.to : null;
  if (to) {
    fields.push({ label: label('To'), value: to, mono: true });
  } else {
    warnings.push({
      severity: 'danger',
      text: `${prefix ? `${prefix}: this call` : 'This transaction'} has no recipient — it is a contract creation. Only approve this if you meant to deploy a contract.`,
    });
  }

  // Value is the single most important row on the card, so it is never
  // omitted. It used to be read only when it was a `string`, and `formatEther`
  // returned '0' on any parse failure, after which a zero row was suppressed
  // entirely — so a JSON *number* value, or a malformed one, rendered exactly
  // like a genuine zero-value call.
  fields.push({ label: label('Value'), ...formatValue(call.value, warnings, prefix) });

  const rawData = call.data;
  const data = typeof rawData === 'string' ? rawData : '';
  if (data !== '' && data !== '0x') {
    if (!HEX_CALLDATA.test(data)) {
      fields.push({ label: label('Calldata'), value: data, mono: true });
      warnings.push({
        severity: 'danger',
        text: `${prefix ? `${prefix}: the` : 'The'} calldata is malformed and could not be decoded — it is not whole bytes of \`0x\`-prefixed hex. The bridge cannot tell you what this call does.`,
      });
    } else if (data.length >= 10) {
      decodeCalldata(data, fields, warnings, label, prefix);
    }
  }

  return { fields, warnings };
}

/** Render `value` in ETH, or say plainly that it could not be read. */
function formatValue(
  raw: unknown,
  warnings: CardWarning[],
  prefix: string,
): { value: string } {
  if (raw === undefined || raw === null) return { value: '0 ETH' };
  const wei = toBigInt(raw);
  if (wei === null || wei < 0n) {
    warnings.push({
      severity: 'danger',
      text: `${prefix ? `${prefix}: the` : 'The'} transaction's value could not be decoded, so the bridge cannot tell you how much this moves. Do not approve unless you know.`,
    });
    return { value: 'Could not decode' };
  }
  return { value: `${formatEther(wei)} ETH` };
}

function decodeCalldata(
  data: string,
  fields: CardField[],
  warnings: CardWarning[],
  label: (name: string) => string,
  prefix: string,
): void {
  const selector = data.slice(0, 10).toLowerCase();
  const known = SELECTORS[selector];
  const byteLen = (data.length - 2) / 2;
  fields.push({
    label: label('Function'),
    value: known ? `${known}  ${selector}` : `unknown  ${selector}  (${byteLen} bytes calldata)`,
    mono: !known,
  });
  if (!known) {
    fields.push({ label: label('Calldata'), value: `${byteLen} bytes`, mono: true });
  }

  if (selector === '0x095ea7b3') {
    const spenderWord = word(data, 0);
    const amountWord = word(data, 1);
    if (spenderWord) {
      const spender = wordToAddress(spenderWord);
      fields.push({ label: label('Spender'), value: spender ?? 'Could not decode', mono: true });
    }
    if (amountWord) {
      const v = wordToBigInt(amountWord);
      if (v === null) {
        fields.push({ label: label('Allowance'), value: 'Could not decode' });
      } else {
        const unlimited = isUnlimitedAmount(v);
        fields.push({ label: label('Allowance'), value: unlimited ? 'UNLIMITED' : v.toString() });
        if (unlimited) {
          warnings.push({
            severity: 'danger',
            text: `${prefix ? `${prefix}: this ` : 'This '}approves an UNLIMITED token allowance. The spender can move this token from your account at any time until you revoke it.`,
          });
        }
      }
    }
  }

  if (selector === '0xa22cb465') {
    const operatorWord = word(data, 0);
    const approvedWord = word(data, 1);
    if (operatorWord) {
      const operator = wordToAddress(operatorWord);
      fields.push({ label: label('Operator'), value: operator ?? 'Could not decode', mono: true });
    }
    if (approvedWord) {
      const v = wordToBigInt(approvedWord);
      if (v !== null && v !== 0n) {
        warnings.push({
          severity: 'danger',
          text: `${prefix ? `${prefix}: this ` : 'This '}grants control over every NFT you own in this collection, including ones you buy later.`,
        });
      }
    }
  }
}

export function decodeTransaction(params: unknown, ctx: DecodeContext): DecodedCard {
  const arr = Array.isArray(params) ? params : [];
  const tx = (typeof arr[0] === 'object' && arr[0] !== null ? arr[0] : {}) as Record<string, unknown>;

  const { fields, warnings } = decodeCall(tx);
  // Network sits between To and Value, matching how the row reads aloud:
  // "to X, on Base, for Y ETH".
  const valueIdx = fields.findIndex((f) => f.label === 'Value');
  fields.splice(valueIdx < 0 ? fields.length : valueIdx, 0, {
    label: 'Network',
    value: chainName(ctx.chainId),
  });

  return {
    method: 'eth_sendTransaction',
    title: 'Transaction request',
    fields,
    warnings,
    raw: safeJson(params),
  };
}
