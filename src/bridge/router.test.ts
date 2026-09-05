import { describe, it, expect, vi } from 'vitest';
import { handleRequest } from './router';
import { RequestExpiredError } from './types';
import type { IncomingRequest, JsonRpcErrorPayload } from './types';
import type { RouterDeps } from './router';

const req = (method: string, params: unknown = [], chainId = 8453): IncomingRequest => ({
  id: 7,
  topic: 'topic-1',
  chainId,
  method,
  params,
  dapp: { name: 'Test Dapp', url: 'https://t.example', validation: 'VALID', isScam: false },
});

function makeDeps(over: Partial<{
  request: (a: { method: string; params?: unknown }) => Promise<unknown>;
  chainId: number;
  confirm: (...a: unknown[]) => Promise<boolean>;
}> = {}) {
  const results: unknown[] = [];
  const errors: JsonRpcErrorPayload[] = [];
  const switched: number[] = [];
  const requested: { method: string; params?: unknown }[] = [];
  // Shared ordering log, so a test can assert switch-then-forward directly.
  const order: string[] = [];

  const deps = {
    wallet: {
      request: vi.fn(async (a: { method: string; params?: unknown }) => {
        order.push('request');
        requested.push(a);
        return over.request ? over.request(a) : 'ok';
      }),
      getChainId: vi.fn(async () => over.chainId ?? 8453),
      switchChain: vi.fn(async (id: number) => {
        order.push('switch');
        switched.push(id);
      }),
    },
    dapp: {
      respondResult: vi.fn(async (_t: string, _i: number, r: unknown) => {
        results.push(r);
      }),
      respondError: vi.fn(async (_t: string, _i: number, e: JsonRpcErrorPayload) => {
        errors.push(e);
      }),
    },
    confirm: {
      confirm: vi.fn(async () => (over.confirm ? over.confirm() : true)),
    },
    isSmartAccount: () => true,
    timeoutMs: 50,
  } as unknown as RouterDeps;

  return { deps, results, errors, switched, requested, order };
}

const totalResponses = (h: ReturnType<typeof makeDeps>) => h.results.length + h.errors.length;

describe('handleRequest', () => {
  it('forwards a PASS method without prompting', async () => {
    const h = makeDeps();
    await handleRequest(req('eth_chainId'), h.deps);
    expect(h.deps.confirm.confirm).not.toHaveBeenCalled();
    expect(h.results).toEqual(['ok']);
  });

  it('prompts then forwards a CONFIRM method', async () => {
    const h = makeDeps();
    await handleRequest(req('personal_sign', ['0x68', '0xabc']), h.deps);
    expect(h.deps.confirm.confirm).toHaveBeenCalledOnce();
    expect(h.results).toEqual(['ok']);
  });

  it('responds 4001 and never touches the wallet when the user rejects', async () => {
    const h = makeDeps({ confirm: async () => false });
    await handleRequest(req('eth_sendTransaction', [{ to: '0xabc' }]), h.deps);
    expect(h.deps.wallet.request).not.toHaveBeenCalled();
    expect(h.errors).toEqual([{ code: 4001, message: expect.stringMatching(/reject/i) }]);
  });

  it('rejects a REJECT method with 4200 and never touches the wallet', async () => {
    const h = makeDeps();
    await handleRequest(req('eth_signTransaction'), h.deps);
    expect(h.deps.wallet.request).not.toHaveBeenCalled();
    expect(h.errors[0].code).toBe(4200);
  });

  it('prompts for an unknown method rather than forwarding it blindly', async () => {
    const h = makeDeps();
    await handleRequest(req('eth_futureThing'), h.deps);
    expect(h.deps.confirm.confirm).toHaveBeenCalledOnce();
    expect(h.results).toEqual(['ok']);
  });

  it('preserves a 4001 thrown by the wallet', async () => {
    const h = makeDeps({
      request: async () => {
        throw Object.assign(new Error('User denied'), { code: 4001 });
      },
    });
    await handleRequest(req('personal_sign'), h.deps);
    expect(h.errors[0].code).toBe(4001);
  });

  it('still responds when the wallet throws a bare Error', async () => {
    const h = makeDeps({
      request: async () => {
        throw new Error('kaboom');
      },
    });
    await handleRequest(req('personal_sign'), h.deps);
    expect(totalResponses(h)).toBe(1);
    expect(h.errors[0]).toEqual({ code: 5000, message: 'kaboom' });
  });

  it('still responds when the wallet throws a non-Error', async () => {
    const h = makeDeps({
      request: async () => {
        throw 'string throw';
      },
    });
    await handleRequest(req('personal_sign'), h.deps);
    expect(totalResponses(h)).toBe(1);
  });

  it('switches chain before forwarding when the session chain differs', async () => {
    const h = makeDeps({ chainId: 1 });
    await handleRequest(req('eth_sendTransaction', [{ to: '0xa' }], 8453), h.deps);
    expect(h.switched).toEqual([8453]);
    // The switch must be recorded before anything is forwarded.
    expect(h.order).toEqual(['switch', 'request']);
  });

  it('does not switch chain when already on the session chain', async () => {
    const h = makeDeps({ chainId: 8453 });
    await handleRequest(req('eth_chainId', [], 8453), h.deps);
    expect(h.switched).toEqual([]);
  });

  it('responds with an error when the chain switch fails', async () => {
    const h = makeDeps({ chainId: 1 });
    (h.deps.wallet.switchChain as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('unrecognised chain'), { code: 4902 }),
    );
    await handleRequest(req('eth_sendTransaction', [{ to: '0xa' }], 8453), h.deps);
    expect(h.errors[0].code).toBe(4902);
    expect(totalResponses(h)).toBe(1);
  });

  it('times out a wallet that never answers', async () => {
    const h = makeDeps({ request: () => new Promise(() => {}) });
    await handleRequest(req('personal_sign'), h.deps);
    expect(h.errors[0].code).toBe(5000);
    expect(h.errors[0].message).toMatch(/wallet/i);
  });

  it('sends NO response at all for an expired request', async () => {
    const h = makeDeps();
    (h.deps.confirm.confirm as ReturnType<typeof vi.fn>).mockRejectedValue(
      new RequestExpiredError(7),
    );
    await handleRequest(req('personal_sign'), h.deps);
    expect(totalResponses(h)).toBe(0);
  });

  it('responds exactly once even when the dapp port itself is slow', async () => {
    const h = makeDeps();
    await handleRequest(req('eth_chainId'), h.deps);
    expect(totalResponses(h)).toBe(1);
  });

  it('forwards the original method and params unchanged', async () => {
    const h = makeDeps();
    const params = [{ to: '0xabc', value: '0x1' }];
    await handleRequest(req('eth_sendTransaction', params), h.deps);
    expect(h.requested).toEqual([{ method: 'eth_sendTransaction', params }]);
  });
});
