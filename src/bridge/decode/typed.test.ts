import { describe, it, expect } from 'vitest';
import { decodeTypedData, MAX_MESSAGE_FIELDS } from './typed';
import type { DecodeContext } from '../types';
import { MAX_UINT160 } from '../format';

const ctx: DecodeContext = { chainId: 8453, isSmartAccount: false };
const smart: DecodeContext = { chainId: 8453, isSmartAccount: true };
const MAX = (2n ** 256n - 1n).toString();

const permit = (value: string, chainId = 8453) => ({
  domain: { name: 'USD Coin', chainId, verifyingContract: '0xA0b8' },
  primaryType: 'Permit',
  message: { owner: '0x1', spender: '0xdeadbeef', value, nonce: '0', deadline: '99999' },
  types: { Permit: [] },
});

describe('decodeTypedData', () => {
  it('surfaces domain, primary type and verifying contract', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100'))], ctx);
    expect(card.fields).toContainEqual({ label: 'Type', value: 'Permit' });
    expect(card.fields).toContainEqual({ label: 'Domain', value: 'USD Coin' });
    expect(card.fields).toContainEqual({ label: 'Contract', value: '0xA0b8', mono: true });
  });

  it('accepts an already-parsed object as well as a JSON string', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', permit('100')], ctx);
    expect(card.fields).toContainEqual({ label: 'Type', value: 'Permit' });
  });

  it('flags a domain chainId that disagrees with the session', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100', 1))], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger' && /chain/i.test(w.text))).toBe(true);
  });

  it('does not flag a matching chainId', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100'))], ctx);
    expect(card.warnings.some((w) => /chain/i.test(w.text))).toBe(false);
  });

  it('surfaces Permit spender and amount', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100'))], ctx);
    expect(card.fields).toContainEqual({ label: 'Spender', value: '0xdeadbeef', mono: true });
    expect(card.fields.some((f) => f.label === 'Amount' && f.value === '100')).toBe(true);
  });

  it('shouts about an unlimited Permit amount', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit(MAX))], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger' && /unlimited/i.test(w.text))).toBe(true);
  });

  it('handles PermitSingle (Permit2) shape', () => {
    const p2 = {
      domain: { name: 'Permit2', chainId: 8453, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      primaryType: 'PermitSingle',
      message: {
        details: { token: '0xtok', amount: MAX, expiration: '1999999999' },
        spender: '0xrouter',
      },
      types: {},
    };
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(p2)], ctx);
    expect(card.fields).toContainEqual({ label: 'Spender', value: '0xrouter', mono: true });
    expect(card.warnings.some((w) => /unlimited/i.test(w.text))).toBe(true);
  });

  it('notes ERC-1271 for smart accounts', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('1'))], smart);
    expect(card.warnings.some((w) => /1271/i.test(w.text))).toBe(true);
  });

  it('does not throw on unparseable JSON', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', 'not json'], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger')).toBe(true);
    expect(card.method).toBe('eth_signTypedData_v4');
  });

  it('does not throw on missing params', () => {
    expect(() => decodeTypedData('eth_signTypedData_v4', null, ctx)).not.toThrow();
  });

  it('flags an unlimited entry inside a real PermitBatch (Permit2 details[])', () => {
    // Permit2's actual PermitBatch carries `details` as an array — one entry
    // per token. A single-object extraction (as PermitSingle uses) silently
    // drops every amount but the first, hiding an unlimited grant.
    const batch = {
      domain: { name: 'Permit2', chainId: 8453, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      primaryType: 'PermitBatch',
      message: {
        spender: '0xrouter',
        details: [
          { token: '0xtokA', amount: '5', expiration: '1999999999' },
          { token: '0xtokB', amount: MAX, expiration: '1999999999' },
        ],
      },
      types: {},
    };
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(batch)], ctx);
    expect(card.fields).toContainEqual({ label: 'Spender', value: '0xrouter', mono: true });
    expect(card.fields.some((f) => f.label === 'Amount 1' && f.value === '5')).toBe(true);
    expect(card.fields.some((f) => f.label === 'Amount 2' && f.value === 'UNLIMITED')).toBe(true);
    expect(card.warnings.some((w) => w.severity === 'danger' && /unlimited/i.test(w.text))).toBe(true);
  });

  describe('domain.chainId is a field, not just a warning input', () => {
    it('renders the domain chain, named where we know it', () => {
      const card = decodeTypedData(
        'eth_signTypedData_v4',
        ['0xabc', JSON.stringify(permit('100'))],
        ctx,
      );
      expect(card.fields).toContainEqual({ label: 'Domain chain', value: '8453 (Base)' });
    });

    it('renders a mismatching domain chain too, alongside the warning', () => {
      const card = decodeTypedData(
        'eth_signTypedData_v4',
        ['0xabc', JSON.stringify(permit('100', 1))],
        ctx,
      );
      expect(card.fields).toContainEqual({ label: 'Domain chain', value: '1 (Ethereum)' });
      expect(card.warnings.some((w) => w.severity === 'danger')).toBe(true);
    });

    it('does not invent a chain row when the domain carries none', () => {
      const card = decodeTypedData(
        'eth_signTypedData_v4',
        ['0xabc', JSON.stringify({ domain: { name: 'X' }, primaryType: 'Mail', message: {} })],
        ctx,
      );
      expect(card.fields.some((f) => f.label === 'Domain chain')).toBe(false);
    });
  });

  describe('the message tree', () => {
    /**
     * The Seaport case. Before this, an order card showed exactly three
     * innocuous rows — Type, Domain, Contract — while the offerer, the
     * consideration and every amount reached the user only inside `card.raw`,
     * which the renderer hides behind a collapsed <details>. This is the
     * signature class that has actually drained wallets.
     */
    const seaport = {
      domain: {
        name: 'Seaport',
        chainId: 8453,
        verifyingContract: '0x0000000000000068F116a894984e2DB1123eB395',
      },
      primaryType: 'OrderComponents',
      message: {
        offerer: '0x1111111111111111111111111111111111111111',
        zone: '0x0000000000000000000000000000000000000000',
        offer: [{ token: '0xBAYC', identifierOrCriteria: '4271', startAmount: '1' }],
        consideration: [
          { token: '0x0000', startAmount: '1', recipient: '0xATTACKER' },
        ],
        startTime: '0',
        endTime: '99999999999',
      },
      types: {},
    };

    it('surfaces the offerer, the offer and the consideration recipient', () => {
      const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(seaport)], ctx);
      const values = card.fields.map((f) => f.value);
      expect(values).toContain('0x1111111111111111111111111111111111111111');
      expect(values).toContain('0xBAYC');
      expect(values).toContain('0xATTACKER');
    });

    it('labels leaves by their path through the message', () => {
      const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(seaport)], ctx);
      expect(card.fields).toContainEqual({
        label: 'message.consideration[0].recipient',
        value: '0xATTACKER',
        mono: false,
      });
    });

    it('renders a non-Permit message that would otherwise show nothing at all', () => {
      const mail = {
        domain: { name: 'Ether Mail', chainId: 8453 },
        primaryType: 'Mail',
        message: { from: 'alice', to: 'bob', contents: 'hello' },
      };
      const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(mail)], ctx);
      expect(card.fields).toContainEqual({
        label: 'message.contents',
        value: 'hello',
        mono: false,
      });
    });

    it('caps a hostile payload rather than emitting a thousand rows', () => {
      const message: Record<string, string> = {};
      for (let i = 0; i < 500; i++) message[`k${i}`] = `v${i}`;
      const card = decodeTypedData(
        'eth_signTypedData_v4',
        ['0xabc', JSON.stringify({ domain: {}, primaryType: 'Spam', message })],
        ctx,
      );
      const messageFields = card.fields.filter((f) => f.label.startsWith('message'));
      expect(messageFields).toHaveLength(MAX_MESSAGE_FIELDS);
      // Truncation is announced, never silent.
      expect(card.warnings.some((w) => /too large/i.test(w.text))).toBe(true);
    });

    it('stops descending rather than recursing without bound', () => {
      let deep: unknown = 'bottom';
      for (let i = 0; i < 30; i++) deep = { nested: deep };
      const card = decodeTypedData(
        'eth_signTypedData_v4',
        ['0xabc', JSON.stringify({ domain: {}, primaryType: 'D', message: deep })],
        ctx,
      );
      expect(card.fields.some((f) => /too deeply/i.test(f.value))).toBe(true);
    });

    it('does not throw on a message that is not an object', () => {
      expect(() =>
        decodeTypedData(
          'eth_signTypedData_v4',
          ['0xabc', JSON.stringify({ domain: {}, primaryType: 'X', message: 'plain' })],
          ctx,
        ),
      ).not.toThrow();
    });
  });

  describe('legacy v1 param order', () => {
    // v1's params are [typedData, address] — the reverse of v3/v4. Reading
    // arr[1] unconditionally meant a real v1 request decoded to nothing: an
    // empty card for a live signature request on an advertised method.
    const v1 = [
      { type: 'string', name: 'Message', value: 'Approve the transfer' },
      { type: 'address', name: 'Spender', value: '0xdeadbeef' },
    ];

    it('decodes a v1 payload found at params[0]', () => {
      const card = decodeTypedData('eth_signTypedData', [v1, '0xmyaddress'], ctx);
      expect(card.fields).toContainEqual({
        label: 'Message (string)',
        value: 'Approve the transfer',
        mono: false,
      });
      expect(card.fields).toContainEqual({
        label: 'Spender (address)',
        value: '0xdeadbeef',
        mono: true,
      });
    });

    it('decodes a v1 payload sent as a JSON string', () => {
      const card = decodeTypedData('eth_signTypedData', [JSON.stringify(v1), '0xa'], ctx);
      expect(card.fields.some((f) => f.value === 'Approve the transfer')).toBe(true);
    });

    it('warns that a v1 payload has no domain binding it to anything', () => {
      const card = decodeTypedData('eth_signTypedData', [v1, '0xa'], ctx);
      expect(card.warnings.some((w) => /legacy/i.test(w.text) && /domain/i.test(w.text))).toBe(true);
    });

    it('still prefers params[1] when the request is really v4', () => {
      // eth_signTypedData is commonly sent with v4-shaped params, so position
      // cannot be trusted either way — the payload is sniffed, not assumed.
      const card = decodeTypedData(
        'eth_signTypedData',
        ['0xabc', JSON.stringify(permit('100'))],
        ctx,
      );
      expect(card.fields).toContainEqual({ label: 'Type', value: 'Permit' });
    });

    it('does not throw on junk v1 entries', () => {
      expect(() => decodeTypedData('eth_signTypedData', [[null, 3, 'x'], '0xa'], ctx)).not.toThrow();
    });
  });

  it('recognises Permit2\'s real sentinel, type(uint160).max, as unlimited', () => {
    const p2 = {
      domain: { name: 'Permit2', chainId: 8453, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      primaryType: 'PermitSingle',
      message: {
        details: { token: '0xtok', amount: MAX_UINT160.toString(), expiration: '1999999999' },
        spender: '0xrouter',
      },
      types: {},
    };
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(p2)], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger' && /unlimited/i.test(w.text))).toBe(true);
  });
});
