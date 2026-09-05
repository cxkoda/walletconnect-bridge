import type { CardField, CardWarning, DecodeContext, RequestCard } from '../types';
import { isUnlimitedAmount, toBigInt } from '../format';

interface TypedData {
  // Fields below are typed loosely on purpose: this is a cast over
  // attacker-controlled JSON, not a validated shape. Nothing here is
  // guaranteed to actually be a string/number at runtime — see coerceString.
  domain?: { name?: unknown; chainId?: unknown; verifyingContract?: unknown };
  primaryType?: unknown;
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

/**
 * Coerce an arbitrary JSON value to a display string.
 *
 * The approval card is the ONLY place the user can see what they're being
 * asked to sign (the wallet's own confirmation sheet sees the bridge's
 * origin, not the dapp's). A dapp that puts an object where a string is
 * expected (e.g. `domain: { name: { evil: 1 } }`) must not be able to hand
 * the card a non-string `CardField.value` — that's a value a renderer can
 * choke on, which would suppress the user's only view of the request.
 */
function coerceString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : String(v);
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

  const primaryType = coerceString(data.primaryType) ?? '(unknown)';
  fields.push({ label: 'Type', value: primaryType });

  const domainName = coerceString(data.domain?.name);
  if (domainName) fields.push({ label: 'Domain', value: domainName });

  const verifyingContract = coerceString(data.domain?.verifyingContract);
  if (verifyingContract) fields.push({ label: 'Contract', value: verifyingContract, mono: true });

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
    const detailsRaw = msg.details;
    const topLevelSpender = coerceString(msg.spender);

    if (Array.isArray(detailsRaw)) {
      // Permit2's real PermitBatch carries `details` as PermitDetails[], one
      // entry per token — each independently able to grant an unlimited
      // allowance. Folding this into a single object (as PermitSingle does)
      // would silently drop every amount but the first.
      if (topLevelSpender) fields.push({ label: 'Spender', value: topLevelSpender, mono: true });

      let anyUnlimited = false;
      detailsRaw.forEach((entry, i) => {
        const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
          string,
          unknown
        >;
        const n = i + 1;
        const token = coerceString(e.token);
        if (token) fields.push({ label: `Token ${n}`, value: token, mono: true });

        const amount = toBigInt(e.amount);
        const unlimited = amount !== null && isUnlimitedAmount(amount);
        if (unlimited) anyUnlimited = true;
        fields.push({
          label: `Amount ${n}`,
          value: unlimited ? 'UNLIMITED' : (coerceString(e.amount) ?? 'Could not decode'),
        });

        const expiration = coerceString(e.expiration);
        if (expiration) fields.push({ label: `Expires ${n}`, value: expiration });
      });

      if (anyUnlimited) {
        warnings.push({
          severity: 'danger',
          text: `This grants ${topLevelSpender ?? 'the spender'} an UNLIMITED allowance on at least one token in this batch. It can move that token from your account at any time until revoked.`,
        });
      }
    } else {
      // Permit / PermitSingle: `details`, if present, is a single object.
      const details = (detailsRaw ?? {}) as Record<string, unknown>;
      const spender = topLevelSpender ?? coerceString(details.spender);
      const amountRaw = msg.value ?? details.amount;

      if (spender) fields.push({ label: 'Spender', value: spender, mono: true });
      const token = coerceString(details.token);
      if (token) fields.push({ label: 'Token', value: token, mono: true });

      if (amountRaw !== undefined && amountRaw !== null) {
        const amount = toBigInt(amountRaw);
        const unlimited = amount !== null && isUnlimitedAmount(amount);
        fields.push({
          label: 'Amount',
          value: unlimited ? 'UNLIMITED' : (coerceString(amountRaw) ?? 'Could not decode'),
        });
        if (unlimited) {
          warnings.push({
            severity: 'danger',
            text: `This grants ${spender ?? 'the spender'} an UNLIMITED token allowance. It can move that token from your account at any time until revoked.`,
          });
        }
      }
      const deadline = coerceString(msg.deadline ?? details.expiration);
      if (deadline) fields.push({ label: 'Expires', value: deadline });
    }
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
