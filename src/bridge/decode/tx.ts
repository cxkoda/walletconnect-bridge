import type { CardField, CardWarning, DecodeContext, RequestCard } from '../types';
import { formatEther, isUnlimitedAmount } from '../format';
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

/** Read the nth 32-byte ABI word from calldata (after the 4-byte selector). */
function word(data: string, n: number): string | null {
  const start = 10 + n * 64;
  const w = data.slice(start, start + 64);
  return w.length === 64 ? w : null;
}

const wordToAddress = (w: string) => '0x' + w.slice(24);
const wordToBigInt = (w: string) => BigInt('0x' + w);

export function decodeTransaction(params: unknown, ctx: DecodeContext): RequestCard {
  const arr = Array.isArray(params) ? params : [];
  const tx = (typeof arr[0] === 'object' && arr[0] !== null ? arr[0] : {}) as Record<string, unknown>;
  const fields: CardField[] = [];
  const warnings: CardWarning[] = [];

  const to = typeof tx.to === 'string' ? tx.to : null;
  if (to) {
    fields.push({ label: 'To', value: to, mono: true });
  } else {
    warnings.push({
      severity: 'danger',
      text: 'This transaction has no recipient — it is a contract creation. Only approve this if you meant to deploy a contract.',
    });
  }

  fields.push({ label: 'Network', value: chainName(ctx.chainId) });

  const value = typeof tx.value === 'string' ? tx.value : '0x0';
  const eth = formatEther(value);
  if (eth !== '0') fields.push({ label: 'Value', value: `${eth} ETH` });

  const data = typeof tx.data === 'string' ? tx.data : '';
  if (data.length >= 10) {
    const selector = data.slice(0, 10).toLowerCase();
    const known = SELECTORS[selector];
    const byteLen = Math.max(0, (data.length - 2) / 2);
    fields.push({
      label: 'Function',
      value: known ? `${known}  ${selector}` : `unknown  ${selector}  (${byteLen} bytes calldata)`,
      mono: !known,
    });
    if (!known) {
      fields.push({ label: 'Calldata', value: `${byteLen} bytes`, mono: true });
    }

    if (selector === '0x095ea7b3') {
      const spender = word(data, 0);
      const amount = word(data, 1);
      if (spender) fields.push({ label: 'Spender', value: wordToAddress(spender), mono: true });
      if (amount) {
        const v = wordToBigInt(amount);
        const unlimited = isUnlimitedAmount(v);
        fields.push({ label: 'Allowance', value: unlimited ? 'UNLIMITED' : v.toString() });
        if (unlimited) {
          warnings.push({
            severity: 'danger',
            text: 'This approves an UNLIMITED token allowance. The spender can move this token from your account at any time until you revoke it.',
          });
        }
      }
    }

    if (selector === '0xa22cb465') {
      const operator = word(data, 0);
      const approved = word(data, 1);
      if (operator) fields.push({ label: 'Operator', value: wordToAddress(operator), mono: true });
      if (approved && wordToBigInt(approved) !== 0n) {
        warnings.push({
          severity: 'danger',
          text: 'This grants control over every NFT you own in this collection, including ones you buy later.',
        });
      }
    }
  }

  return {
    method: 'eth_sendTransaction',
    title: 'Transaction request',
    fields,
    warnings,
    raw: JSON.stringify(params, null, 2),
  };
}
