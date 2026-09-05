import type { CardField, CardWarning, DecodeContext, DecodedCard } from '../types';
import { isUnlimitedAmount, safeJson, toBigInt } from '../format';
import { chainName } from '../../chains';

interface TypedData {
  // Fields below are typed loosely on purpose: this is a cast over
  // attacker-controlled JSON, not a validated shape. Nothing here is
  // guaranteed to actually be a string/number at runtime — see coerceString.
  domain?: { name?: unknown; chainId?: unknown; verifyingContract?: unknown };
  primaryType?: unknown;
  message?: unknown;
}

const PERMIT_TYPES = new Set(['Permit', 'PermitSingle', 'PermitBatch']);

/**
 * Limits on how much of `message` gets flattened onto the card.
 *
 * `message` is arbitrary attacker-supplied JSON. Without a cap, a hostile
 * payload can bury the one row that mattered under a thousand others, or
 * recurse deeply enough to be unreadable. Truncation is announced, never
 * silent.
 */
export const MAX_MESSAGE_FIELDS = 40;
const MAX_MESSAGE_DEPTH = 4;

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

/** Hex-ish leaves (addresses, hashes, salts) read better in monospace. */
function looksHex(s: string): boolean {
  return /^0x[0-9a-fA-F]*$/.test(s);
}

/**
 * Flatten `message` into card rows, depth- and count-limited.
 *
 * Spec line 206 requires the message tree on the card, and it is the half that
 * actually matters: a Seaport order whose card shows only Type/Domain/Contract
 * hides the offerer, the consideration and every amount. Those are the
 * signature classes that have drained real wallets. Burying the body in the
 * collapsed `<details>` raw view is not showing it.
 */
function flattenMessage(value: unknown, path: string, out: CardField[], depth: number): void {
  if (out.length >= MAX_MESSAGE_FIELDS) return;

  if (value === null || typeof value !== 'object') {
    out.push({
      label: path,
      value: coerceString(value) ?? 'null',
      mono: typeof value === 'string' && looksHex(value),
    });
    return;
  }

  if (depth >= MAX_MESSAGE_DEPTH) {
    out.push({ label: path, value: '(nested too deeply to display — see the raw request)' });
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push({ label: path, value: '(empty list)' });
      return;
    }
    for (let i = 0; i < value.length; i++) {
      if (out.length >= MAX_MESSAGE_FIELDS) return;
      flattenMessage(value[i], `${path}[${i}]`, out, depth + 1);
    }
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    out.push({ label: path, value: '(empty)' });
    return;
  }
  for (const [k, v] of entries) {
    if (out.length >= MAX_MESSAGE_FIELDS) return;
    flattenMessage(v, `${path}.${k}`, out, depth + 1);
  }
}

/**
 * Legacy `eth_signTypedData` (v1) — params `[typedDataArray, address]`, the
 * reverse of v3/v4's `[address, jsonString]`, with the payload an array of
 * `{ type, name, value }` entries rather than an EIP-712 object.
 *
 * The bridge advertises `eth_signTypedData`, so it has to be able to read what
 * arrives under that name. Reading `params[1]` unconditionally meant a genuine
 * v1 payload decoded to nothing at all — an empty card for a live signature
 * request. Sniffing the payload rather than trusting the position also
 * absorbs the dapps that send v4-shaped params under the v1 method name, which
 * is common.
 */
function decodeLegacyV1(entries: unknown[], method: string, params: unknown): DecodedCard {
  const fields: CardField[] = [];
  entries.slice(0, MAX_MESSAGE_FIELDS).forEach((entry, i) => {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const name = coerceString(e.name) ?? `field ${i + 1}`;
    const type = coerceString(e.type);
    const value = coerceString(e.value) ?? 'null';
    fields.push({
      label: type ? `${name} (${type})` : name,
      value,
      mono: looksHex(value),
    });
  });

  const warnings: CardWarning[] = [
    {
      severity: 'warn',
      text: 'This is a legacy (v1) typed-data signature. It carries no domain — no name, no chain and no verifying contract — so there is nothing binding it to the site that asked or to this network.',
    },
  ];
  if (entries.length > MAX_MESSAGE_FIELDS) {
    warnings.push({
      severity: 'danger',
      text: `This payload has ${entries.length} entries; only the first ${MAX_MESSAGE_FIELDS} are shown. See the raw request before approving.`,
    });
  }

  return {
    method,
    title: 'Typed data signature (legacy v1)',
    fields,
    warnings,
    raw: safeJson(params),
  };
}

export function decodeTypedData(
  method: string,
  params: unknown,
  ctx: DecodeContext,
): DecodedCard {
  const arr = Array.isArray(params) ? params : [];
  // v3/v4 put the payload at [1] and the address at [0]; v1 reverses them. An
  // address never parses as JSON and is never an object, so `parse` picks the
  // payload out of either position without having to know the version.
  const data = parse(arr[1]) ?? parse(arr[0]);
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
      raw: safeJson(params),
    };
  }

  if (Array.isArray(data)) return decodeLegacyV1(data, method, params);

  const primaryType = coerceString(data.primaryType) ?? '(unknown)';
  fields.push({ label: 'Type', value: primaryType });

  const domainName = coerceString(data.domain?.name);
  if (domainName) fields.push({ label: 'Domain', value: domainName });

  const domainChainRaw = data.domain?.chainId;
  const domainChain = domainChainRaw !== undefined ? Number(domainChainRaw) : undefined;
  // Spec line 206 lists domain.chainId as a required row. It was computed for
  // the mismatch warning and then thrown away, so a signature scoped to a
  // chain the user never looked at showed no chain at all.
  if (domainChainRaw !== undefined) {
    fields.push({
      label: 'Domain chain',
      value:
        domainChain !== undefined && Number.isFinite(domainChain)
          ? `${domainChain} (${chainName(domainChain)})`
          : (coerceString(domainChainRaw) ?? 'Could not decode'),
    });
  }

  const verifyingContract = coerceString(data.domain?.verifyingContract);
  if (verifyingContract) fields.push({ label: 'Contract', value: verifyingContract, mono: true });

  if (domainChain !== undefined && domainChain !== ctx.chainId) {
    warnings.push({
      severity: 'danger',
      text: `Typed data is scoped to chain ${domainChain} but this session is on chain ${ctx.chainId}. This mismatch is a common phishing and replay signal.`,
    });
  }

  if (PERMIT_TYPES.has(primaryType)) {
    const msg = (typeof data.message === 'object' && data.message !== null
      ? data.message
      : {}) as Record<string, unknown>;
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
      const details = (typeof detailsRaw === 'object' && detailsRaw !== null
        ? detailsRaw
        : {}) as Record<string, unknown>;
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

  if (data.message !== undefined) {
    const messageFields: CardField[] = [];
    flattenMessage(data.message, 'message', messageFields, 0);
    fields.push(...messageFields);
    if (messageFields.length >= MAX_MESSAGE_FIELDS) {
      warnings.push({
        severity: 'warn',
        text: `The message is too large to show in full; only the first ${MAX_MESSAGE_FIELDS} entries are listed. Read the raw request before approving.`,
      });
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
    raw: safeJson(data),
  };
}
