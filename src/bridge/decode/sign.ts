import type { CardField, CardWarning, DecodeContext, RequestCard } from '../types';
import { hexToUtf8 } from '../format';

export interface SiweMessage {
  domain: string;
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: number;
  nonce?: string;
  issuedAt?: string;
}

const SIWE_HEADER = /^([^\n]+?) wants you to sign in with your Ethereum account:\n(0x[0-9a-fA-F]{40})/;

/** Parse an EIP-4361 Sign-In With Ethereum message. Returns null if it isn't one. */
export function parseSiwe(text: string): SiweMessage | null {
  const header = SIWE_HEADER.exec(text);
  if (!header) return null;

  const field = (name: string): string | undefined =>
    new RegExp(`^${name}: (.+)$`, 'm').exec(text)?.[1]?.trim();

  const rest = text.slice(header[0].length).split('\n');
  const statement = rest.find((l) => l.trim() !== '' && !/^[A-Z][\w ]*:/.test(l.trim()))?.trim();
  const chainIdRaw = field('Chain ID');

  return {
    domain: header[1].trim(),
    address: header[2],
    statement,
    uri: field('URI'),
    version: field('Version'),
    chainId: chainIdRaw !== undefined ? Number(chainIdRaw) : undefined,
    nonce: field('Nonce'),
    issuedAt: field('Issued At'),
  };
}

export function decodePersonalSign(params: unknown, ctx: DecodeContext): RequestCard {
  const arr = Array.isArray(params) ? params : [];
  // personal_sign is [message, address]. eth_sign reverses them — which is one
  // reason the bridge refuses eth_sign rather than trying to disambiguate.
  const raw = typeof arr[0] === 'string' ? (arr[0] as string) : '';
  const fields: CardField[] = [];
  const warnings: CardWarning[] = [];

  const text = hexToUtf8(raw);
  if (text === null) {
    fields.push({ label: 'Message (raw hex)', value: raw || '(empty)', mono: true });
    warnings.push({
      severity: 'warn',
      text: 'Message is not valid UTF-8 text; showing raw hex. Be cautious signing opaque bytes.',
    });
  } else {
    fields.push({ label: 'Message', value: text });
  }

  const siwe = text ? parseSiwe(text) : null;
  if (siwe) {
    fields.push({ label: 'Sign-in domain', value: siwe.domain });
    if (siwe.uri) fields.push({ label: 'URI', value: siwe.uri });
    if (siwe.nonce) fields.push({ label: 'Nonce', value: siwe.nonce, mono: true });

    if (siwe.chainId !== undefined && siwe.chainId !== ctx.chainId) {
      warnings.push({
        severity: 'danger',
        text: `Sign-in message declares chain ${siwe.chainId} but this session is on chain ${ctx.chainId}.`,
      });
    }
    if (ctx.isSmartAccount) {
      warnings.push({
        severity: 'warn',
        text:
          'This is a Sign-In With Ethereum request and you are using a smart account. ' +
          'The signature will be an ERC-1271 contract signature; sites that verify with ' +
          'ecrecover will reject it and the login will appear to fail silently.',
      });
    }
  }

  return {
    method: 'personal_sign',
    title: siwe ? 'Sign-in request' : 'Signature request',
    fields,
    warnings,
    raw: JSON.stringify(params, null, 2),
  };
}
