import type { CardField, CardWarning, DecodeContext, RequestCard } from '../types';
import { isUnlimitedAmount, toBigInt } from '../format';

interface TypedData {
  domain?: { name?: string; chainId?: number | string; verifyingContract?: string };
  primaryType?: string;
  message?: Record<string, unknown>;
}

const PERMIT_TYPES = new Set(['Permit', 'PermitSingle', 'PermitBatch']);

function parse(raw: unknown): TypedData | null {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as TypedData;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && raw !== null) return raw as TypedData;
  return null;
}

export function decodeTypedData(
  method: string,
  params: unknown,
  ctx: DecodeContext,
): RequestCard {
  const arr = Array.isArray(params) ? params : [];
  const data = parse(arr[1]);
  const fields: CardField[] = [];
  const warnings: CardWarning[] = [];

  if (!data) {
    warnings.push({
      severity: 'danger',
      text: 'Could not parse the typed data payload. Do not approve unless you know what this is.',
    });
    return {
      method,
      title: 'Typed data signature',
      fields,
      warnings,
      raw: JSON.stringify(params, null, 2),
    };
  }

  const primaryType = data.primaryType ?? '(unknown)';
  fields.push({ label: 'Type', value: primaryType });
  if (data.domain?.name) fields.push({ label: 'Domain', value: data.domain.name });
  if (data.domain?.verifyingContract) {
    fields.push({ label: 'Contract', value: data.domain.verifyingContract, mono: true });
  }

  const domainChain =
    data.domain?.chainId !== undefined ? Number(data.domain.chainId) : undefined;
  if (domainChain !== undefined && domainChain !== ctx.chainId) {
    warnings.push({
      severity: 'danger',
      text: `Typed data is scoped to chain ${domainChain} but this session is on chain ${ctx.chainId}. This mismatch is a common phishing and replay signal.`,
    });
  }

  if (PERMIT_TYPES.has(primaryType)) {
    const msg = (data.message ?? {}) as Record<string, unknown>;
    const details = (msg.details ?? {}) as Record<string, unknown>;
    const spender = (msg.spender ?? details.spender) as string | undefined;
    const amountRaw = msg.value ?? details.amount;

    if (spender) fields.push({ label: 'Spender', value: spender, mono: true });
    if (details.token) fields.push({ label: 'Token', value: String(details.token), mono: true });

    if (amountRaw !== undefined && amountRaw !== null) {
      const amount = toBigInt(amountRaw);
      const unlimited = amount !== null && isUnlimitedAmount(amount);
      fields.push({ label: 'Amount', value: unlimited ? 'UNLIMITED' : String(amountRaw) });
      if (unlimited) {
        warnings.push({
          severity: 'danger',
          text: `This grants ${spender ?? 'the spender'} an UNLIMITED token allowance. It can move that token from your account at any time until revoked.`,
        });
      }
    }
    const deadline = msg.deadline ?? details.expiration;
    if (deadline !== undefined) fields.push({ label: 'Expires', value: String(deadline) });
  }

  if (ctx.isSmartAccount) {
    warnings.push({
      severity: 'warn',
      text:
        'You are signing with a smart account, so this produces an ERC-1271 contract signature. ' +
        'Dapps that verify with ecrecover will reject it.',
    });
  }

  return {
    method,
    title: 'Typed data signature',
    fields,
    warnings,
    raw: JSON.stringify(data, null, 2),
  };
}
