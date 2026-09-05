import { describe, it, expect } from 'vitest';
import { decodeSendCalls, MAX_RENDERED_CALLS } from './calls';
import type { DecodeContext } from '../types';

const ctx: DecodeContext = { chainId: 8453, isSmartAccount: true };
const pad = (s: string) => s.replace(/^0x/, '').padStart(64, '0');
const MAX = 'f'.repeat(64);
const APPROVE_UNLIMITED = '0x095ea7b3' + pad('0xbeef') + MAX;

const bundle = (calls: unknown[]) => [
  { version: '2.0.0', chainId: '0x2105', from: '0xme', calls },
];

describe('decodeSendCalls', () => {
  it('is a batch card, not an "unrecognised method" card', () => {
    // wallet_sendCalls is in the CONFIRM allowlist. The generic fallback card
    // claimed it "is not in the allowlist", which is simply false, and offered
    // it under a "Forward once" button.
    const card = decodeSendCalls(bundle([{ to: '0xa', value: '0x0' }]), ctx);
    expect(card.method).toBe('wallet_sendCalls');
    expect(card.title).not.toMatch(/unrecognised/i);
    expect(card.warnings.some((w) => /not in the allowlist/i.test(w.text))).toBe(false);
  });

  it('reports how many calls the batch contains', () => {
    const card = decodeSendCalls(
      bundle([{ to: '0xa' }, { to: '0xb' }, { to: '0xc' }]),
      ctx,
    );
    expect(card.fields).toContainEqual({ label: 'Calls', value: '3' });
    expect(card.title).toMatch(/3 calls/);
  });

  it('decodes every call, not just the first', () => {
    const card = decodeSendCalls(
      bundle([
        { to: '0xa', value: '0xde0b6b3a7640000' },
        { to: '0xb', value: '0x0', data: '0xa9059cbb' + pad('0x22') + pad('0x64') },
      ]),
      ctx,
    );
    expect(card.fields).toContainEqual({ label: 'Call 1 To', value: '0xa', mono: true });
    expect(card.fields).toContainEqual({ label: 'Call 1 Value', value: '1 ETH' });
    expect(card.fields).toContainEqual({ label: 'Call 2 To', value: '0xb', mono: true });
    expect(
      card.fields.some((f) => f.label === 'Call 2 Function' && /transfer/.test(f.value)),
    ).toBe(true);
  });

  it('surfaces an unlimited approval hidden as the SECOND call of a batch', () => {
    // The whole point. A batch whose innocuous first call is followed by
    // `approve(attacker, MAX_UINT256)` used to render one field and no
    // warning at all — the most likely fund-moving path for a Base Account.
    const card = decodeSendCalls(
      bundle([
        { to: '0xharmless', value: '0x0' },
        { to: '0xtoken', value: '0x0', data: APPROVE_UNLIMITED },
      ]),
      ctx,
    );
    expect(card.fields.some((f) => f.label === 'Call 2 Spender')).toBe(true);
    expect(
      card.fields.some((f) => f.label === 'Call 2 Allowance' && f.value === 'UNLIMITED'),
    ).toBe(true);
    expect(
      card.warnings.some((w) => w.severity === 'danger' && /UNLIMITED/.test(w.text)),
    ).toBe(true);
  });

  it('leads with a batch-level danger warning naming the dangerous calls', () => {
    const card = decodeSendCalls(
      bundle([
        { to: '0xharmless', value: '0x0' },
        { to: '0xtoken', value: '0x0', data: APPROVE_UNLIMITED },
      ]),
      ctx,
    );
    expect(card.warnings[0].severity).toBe('danger');
    expect(card.warnings[0].text).toMatch(/Call 2/);
    expect(card.warnings[0].text).toMatch(/every call/i);
  });

  it('flags a contract creation buried in a batch', () => {
    const card = decodeSendCalls(bundle([{ to: '0xa' }, { value: '0x0' }]), ctx);
    expect(
      card.warnings.some((w) => w.severity === 'danger' && /contract creation/i.test(w.text)),
    ).toBe(true);
  });

  it('raises no batch-level danger when every call is benign', () => {
    const card = decodeSendCalls(
      bundle([
        { to: '0xa', value: '0x0' },
        { to: '0xb', value: '0x1', data: '0xa9059cbb' + pad('0x22') + pad('0x64') },
      ]),
      ctx,
    );
    expect(card.warnings.some((w) => w.severity === 'danger')).toBe(false);
  });

  it('refuses to silently drop calls past the render cap', () => {
    const calls = Array.from({ length: MAX_RENDERED_CALLS + 5 }, () => ({
      to: '0xa',
      value: '0x0',
    }));
    const card = decodeSendCalls(bundle(calls), ctx);
    expect(card.fields).toContainEqual({ label: 'Calls', value: String(calls.length) });
    expect(
      card.warnings.some(
        (w) => w.severity === 'danger' && w.text.includes(String(calls.length)),
      ),
    ).toBe(true);
    expect(card.fields.some((f) => f.label === `Call ${MAX_RENDERED_CALLS + 1} To`)).toBe(false);
  });

  it('says plainly when there is no readable call list', () => {
    const card = decodeSendCalls([{ version: '2.0.0' }], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger')).toBe(true);
    expect(card.method).toBe('wallet_sendCalls');
  });

  it('does not throw on malformed params', () => {
    expect(() => decodeSendCalls(null, ctx)).not.toThrow();
    expect(() => decodeSendCalls([], ctx)).not.toThrow();
    expect(() => decodeSendCalls(bundle([null, 7, 'x']), ctx)).not.toThrow();
  });

  it('names the session network', () => {
    expect(decodeSendCalls(bundle([{ to: '0xa' }]), ctx).fields).toContainEqual({
      label: 'Network',
      value: 'Base',
    });
  });
});
