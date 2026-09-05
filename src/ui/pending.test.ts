import { describe, it, expect, vi } from 'vitest';
import { PendingConfirmations } from './pending';
import { RequestExpiredError } from '../bridge/types';
import type { IncomingRequest, RequestCard } from '../bridge/types';

const req = (id: number): IncomingRequest => ({
  id,
  topic: 't',
  chainId: 8453,
  method: 'personal_sign',
  params: [],
  dapp: { name: 'D', url: 'https://d', validation: 'VALID', isScam: false },
});
const card: RequestCard = {
  method: 'personal_sign',
  title: 'T',
  fields: [],
  warnings: [],
  raw: '[]',
  disposition: { kind: 'confirm' },
};

describe('PendingConfirmations', () => {
  it('resolves true when approved', async () => {
    const p = new PendingConfirmations();
    const promise = p.confirm(req(1), card);
    p.approve(1);
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false when rejected', async () => {
    const p = new PendingConfirmations();
    const promise = p.confirm(req(1), card);
    p.reject(1);
    await expect(promise).resolves.toBe(false);
  });

  it('rejects with RequestExpiredError when expired', async () => {
    const p = new PendingConfirmations();
    const promise = p.confirm(req(1), card);
    p.expire(1);
    await expect(promise).rejects.toBeInstanceOf(RequestExpiredError);
  });

  it('removes the entry once settled', async () => {
    const p = new PendingConfirmations();
    const promise = p.confirm(req(1), card);
    expect(p.list()).toHaveLength(1);
    p.approve(1);
    await promise;
    expect(p.list()).toHaveLength(0);
  });

  it('ignores settle calls for unknown ids', () => {
    const p = new PendingConfirmations();
    expect(() => p.approve(404)).not.toThrow();
    expect(() => p.expire(404)).not.toThrow();
  });

  it('ignores a second settle for the same id', async () => {
    const p = new PendingConfirmations();
    const promise = p.confirm(req(1), card);
    p.approve(1);
    p.reject(1);
    await expect(promise).resolves.toBe(true);
  });

  /**
   * The observer is what breaks the deadlock. The queue entry only exists
   * between `confirm()` and the user's decision, and `confirm()` is called
   * from inside `handleRequest`, whose promise cannot settle until the user
   * clicks. Nothing outside the queue can observe that window: rendering
   * before the call sees an empty queue, rendering after it waits forever.
   */
  describe('onChange', () => {
    it('fires the moment a slot is added, while confirm() is still pending', async () => {
      const p = new PendingConfirmations();
      const seen: number[] = [];
      p.onChange = () => seen.push(p.list().length);

      const promise = p.confirm(req(1), card);
      // Already notified — not on some later tick, and not after settlement.
      expect(seen).toEqual([1]);

      p.approve(1);
      await promise;
    });

    it.each([
      ['approve', (p: PendingConfirmations) => p.approve(1)],
      ['reject', (p: PendingConfirmations) => p.reject(1)],
      ['expire', (p: PendingConfirmations) => p.expire(1)],
    ])('fires again when a slot is settled by %s', async (_name, settle) => {
      const p = new PendingConfirmations();
      const promise = p.confirm(req(1), card);
      promise.catch(() => {});
      const seen: number[] = [];
      p.onChange = () => seen.push(p.list().length);

      settle(p);
      // Observed with the slot already removed, so the UI closes the modal.
      expect(seen).toEqual([0]);
    });

    it('does not fire for a settle call that changed nothing', () => {
      const p = new PendingConfirmations();
      const onChange = vi.fn();
      p.onChange = onChange;
      p.approve(404);
      p.expire(404);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('does not let a throwing observer reject the confirmation', async () => {
      // The router is awaiting this promise. A render failure must not surface
      // to the dapp as a bridge error for a request the user can still decide.
      const p = new PendingConfirmations();
      p.onChange = () => {
        throw new Error('render blew up');
      };
      const promise = p.confirm(req(1), card);
      p.approve(1);
      await expect(promise).resolves.toBe(true);
    });
  });

  it('tracks several pending requests independently', async () => {
    const p = new PendingConfirmations();
    const a = p.confirm(req(1), card);
    const b = p.confirm(req(2), card);
    expect(p.list().map((e) => e.req.id)).toEqual([1, 2]);
    p.approve(1);
    p.reject(2);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(false);
  });
});
