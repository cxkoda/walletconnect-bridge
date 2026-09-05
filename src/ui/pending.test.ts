import { describe, it, expect } from 'vitest';
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
const card: RequestCard = { method: 'personal_sign', title: 'T', fields: [], warnings: [], raw: '[]' };

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
