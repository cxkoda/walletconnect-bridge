import type { CardField, CardWarning, DecodeContext, DecodedCard } from '../types';
import { chainName, SUPPORTED_CHAINS } from '../../chains';
import { safeJson, toBigInt } from '../format';

function asRecord(v: unknown): Record<string, unknown> {
  return (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : String(v);
}

/**
 * `eth_sendRawTransaction` — params `[signedTxHex]`.
 *
 * The bridge does not RLP-decode. That is a real limitation, and the card says
 * so in as many words: an unreadable card that admits it is unreadable is safe,
 * a card that renders three confident-looking rows about a payload it never
 * parsed is not.
 */
export function decodeRawTransaction(params: unknown, ctx: DecodeContext): DecodedCard {
  const arr = Array.isArray(params) ? params : [];
  const raw = typeof arr[0] === 'string' ? arr[0] : '';
  const fields: CardField[] = [{ label: 'Network', value: chainName(ctx.chainId) }];

  if (raw) {
    const body = raw.startsWith('0x') ? raw.slice(2) : raw;
    fields.push({ label: 'Size', value: `${Math.floor(body.length / 2)} bytes` });
    fields.push({ label: 'Signed transaction', value: raw, mono: true });
  }

  return {
    method: 'eth_sendRawTransaction',
    title: 'Broadcast a pre-signed transaction',
    fields,
    warnings: [
      {
        severity: 'danger',
        text: 'This broadcasts an already-signed transaction. The bridge does not decode it, so the recipient, the amount and the calldata are all invisible here. Approve only if you produced this transaction yourself and know exactly what it does.',
      },
    ],
    raw: safeJson(params),
  };
}

/**
 * `wallet_addEthereumChain` — params `[{ chainId, chainName, rpcUrls, … }]`.
 *
 * The interesting attack is not adding an obscure chain; it is *redefining* a
 * chain the user already trusts so its RPC points somewhere hostile.
 */
export function decodeAddEthereumChain(params: unknown, _ctx: DecodeContext): DecodedCard {
  const arr = Array.isArray(params) ? params : [];
  const chain = asRecord(arr[0]);
  const fields: CardField[] = [];
  const warnings: CardWarning[] = [];

  const idRaw = chain.chainId;
  const id = toBigInt(idRaw);
  fields.push({
    label: 'Chain ID',
    value: id === null ? (str(idRaw) ?? 'Could not decode') : id.toString(),
    mono: true,
  });

  const name = str(chain.chainName);
  fields.push({ label: 'Name', value: name ?? '(none given)' });

  const currency = asRecord(chain.nativeCurrency);
  const symbol = str(currency.symbol);
  if (symbol) fields.push({ label: 'Currency', value: symbol });

  const rpcUrls = Array.isArray(chain.rpcUrls) ? chain.rpcUrls : [];
  if (rpcUrls.length === 0) {
    fields.push({ label: 'RPC URL', value: '(none given)' });
  } else {
    rpcUrls.forEach((u, i) => {
      fields.push({
        label: rpcUrls.length === 1 ? 'RPC URL' : `RPC URL ${i + 1}`,
        value: str(u) ?? 'Could not decode',
        mono: true,
      });
    });
  }

  warnings.push({
    severity: 'warn',
    text: 'Adding a network points your wallet at an RPC endpoint this dapp chose. A hostile endpoint can report false balances, false prices and false transaction results.',
  });

  const known = id === null ? undefined : SUPPORTED_CHAINS.find((c) => BigInt(c.id) === id);
  if (known) {
    warnings.push({
      severity: 'danger',
      text: `Chain ${known.id} is ${known.name}, which this bridge already supports. A request to re-add an existing network under a new name or RPC URL is a known way to make a wallet talk to an impostor of a chain you trust.`,
    });
  }

  return {
    method: 'wallet_addEthereumChain',
    title: `Add network${name ? `: ${name}` : ''}`,
    fields,
    warnings,
    raw: safeJson(params),
  };
}

/**
 * `wallet_watchAsset` — params is an OBJECT, not an array:
 * `{ type, options: { address, symbol, decimals, image } }`.
 */
export function decodeWatchAsset(params: unknown, _ctx: DecodeContext): DecodedCard {
  // Accept both shapes: the EIP-747 object and the array-wrapped form some
  // dapps send anyway. Guessing wrong here would render an empty card.
  const source = Array.isArray(params) ? asRecord(params[0]) : asRecord(params);
  const options = asRecord(source.options);
  const fields: CardField[] = [];

  const type = str(source.type);
  if (type) fields.push({ label: 'Asset type', value: type });

  const address = str(options.address);
  fields.push({ label: 'Contract', value: address ?? '(none given)', mono: true });

  const symbol = str(options.symbol);
  if (symbol) fields.push({ label: 'Symbol', value: symbol });

  const decimals = str(options.decimals);
  if (decimals !== undefined) fields.push({ label: 'Decimals', value: decimals });

  const tokenId = str(options.tokenId);
  if (tokenId !== undefined) fields.push({ label: 'Token ID', value: tokenId, mono: true });

  return {
    method: 'wallet_watchAsset',
    title: `Track a token${symbol ? `: ${symbol}` : ''}`,
    fields,
    warnings: [
      {
        severity: 'warn',
        text: 'This only changes what your wallet displays; it grants no spending permission and moves nothing. Note that any contract can claim any name or symbol — check the contract address, not the symbol.',
      },
    ],
    raw: safeJson(params),
  };
}
