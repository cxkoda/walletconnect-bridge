import { describe, it, expect, vi } from 'vitest';
import { handleRequest } from './router';
import { RequestExpiredError } from './types';
import type { IncomingRequest, JsonRpcErrorPayload } from './types';
import type { RouterDeps } from './router';

const req = (
  method: string,
  params: unknown = [],
  chainId = 8453,
  expiryTimestamp?: number,
): IncomingRequest => ({
  id: 7,
  topic: 'topic-1',
  chainId,
  method,
  params,
  expiryTimestamp,
  dapp: { name: 'Test Dapp', url: 'https://t.example', validation: 'VALID', isScam: false },
});

function makeDeps(over: Partial<{
  request: (a: { method: string; params?: unknown }) => Promise<unknown>;
  chainId: number;
  confirm: (...a: unknown[]) => Promise<boolean>;
  now: () => number;
  timeoutMs: number;
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
    timeoutMs: over.timeoutMs ?? 50,
    now: over.now,
    logError: vi.fn(),
  } as unknown as RouterDeps;

  return { deps, results, errors, switched, requested, order };
}

const totalResponses = (h: ReturnType<typeof makeDeps>) => h.results.length + h.errors.length;

/** utf8 text -> `0x`-prefixed hex, without pulling in Node's Buffer typings. */
function utf8ToHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

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

  it('responds exactly once even when the dapp port resolves respondResult slowly', async () => {
    const h = makeDeps();
    let releaseRespond: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRespond = resolve;
    });
    (h.deps.dapp.respondResult as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_t: string, _i: number, r: unknown) => {
        await gate;
        h.results.push(r);
      },
    );

    const pending = handleRequest(req('eth_chainId'), h.deps);
    // Flush microtasks (chain-id check, withTimeout wrapping, ...) until the
    // dapp port has actually been reached, without hard-coding a tick count.
    const respondResultMock = h.deps.dapp.respondResult as ReturnType<typeof vi.fn>;
    for (let i = 0; i < 50 && respondResultMock.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    // While the dapp port's call is still pending, nothing else must be queued.
    expect(respondResultMock).toHaveBeenCalledTimes(1);
    expect(h.deps.dapp.respondError).not.toHaveBeenCalled();

    releaseRespond();
    await pending;
    expect(totalResponses(h)).toBe(1);
    expect(h.deps.dapp.respondResult).toHaveBeenCalledTimes(1);
    expect(h.deps.dapp.respondError).not.toHaveBeenCalled();
  });

  it('does not fall back to respondError when respondResult has already claimed the latch and then rejects', async () => {
    const h = makeDeps();
    (h.deps.dapp.respondResult as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('dapp port went away'),
    );

    await handleRequest(req('eth_chainId'), h.deps);

    // The `responded` latch is set before dapp.respondResult is awaited, so its
    // rejection must NOT trigger the catch block's respondError fallback — a
    // regression that moved the latch-set to after the await would fail this.
    expect(h.deps.dapp.respondResult).toHaveBeenCalledTimes(1);
    expect(h.deps.dapp.respondError).not.toHaveBeenCalled();
  });

  it('passes the original request and a matching card to confirm', async () => {
    const h = makeDeps();
    const r = req('personal_sign', ['0x68656c6c6f', '0xabc']);
    await handleRequest(r, h.deps);
    const confirmMock = h.deps.confirm.confirm as ReturnType<typeof vi.fn>;
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const [passedReq, passedCard] = confirmMock.mock.calls[0] as [unknown, { method: string }];
    expect(passedReq).toBe(r);
    expect(passedCard).toMatchObject({ method: 'personal_sign' });
  });

  it('reaches deps.isSmartAccount() through to the confirmation card', async () => {
    // A SIWE personal_sign message: decodePersonalSign adds an ERC-1271 warning
    // only when ctx.isSmartAccount is true, so the card content itself proves
    // whether the accessor's return value reached buildCard, not just that it
    // was called.
    const siwe =
      'example.com wants you to sign in with your Ethereum account:\n' +
      '0x0000000000000000000000000000000000000001\n\n' +
      'URI: https://example.com\n' +
      'Version: 1\n' +
      'Chain ID: 8453\n' +
      'Nonce: abcdef123456';
    const hex = utf8ToHex(siwe);

    const smart = makeDeps();
    await handleRequest(req('personal_sign', [hex, '0xabc'], 8453), smart.deps);
    const smartConfirmMock = smart.deps.confirm.confirm as ReturnType<typeof vi.fn>;
    const smartCard = smartConfirmMock.mock.calls[0][1] as {
      warnings: { text: string }[];
    };

    const eoa = makeDeps();
    eoa.deps.isSmartAccount = () => false;
    await handleRequest(req('personal_sign', [hex, '0xabc'], 8453), eoa.deps);
    const eoaConfirmMock = eoa.deps.confirm.confirm as ReturnType<typeof vi.fn>;
    const eoaCard = eoaConfirmMock.mock.calls[0][1] as {
      warnings: { text: string }[];
    };

    expect(smartCard.warnings.some((w) => /ERC-1271/.test(w.text))).toBe(true);
    expect(eoaCard.warnings.some((w) => /ERC-1271/.test(w.text))).toBe(false);
  });

  it('forwards the original method and params unchanged, without rewrapping or mutating them', async () => {
    const h = makeDeps();
    const params = [{ to: '0xabc', value: '0x1' }];
    const snapshot = structuredClone(params);
    await handleRequest(req('eth_sendTransaction', params), h.deps);
    expect(h.requested).toEqual([{ method: 'eth_sendTransaction', params: snapshot }]);
    // Same object, not a re-wrapped copy — and per the deep-equal above, untouched.
    expect(h.requested[0].params).toBe(params);
  });

  it('logs the original error before flattening it to a JSON-RPC payload', () => {
    // toJsonRpcError discards the error and its stack, so without this the
    // highest-risk module in the app reports its failures as a bare 5000 and
    // nothing else — undiagnosable.
    const h = makeDeps({
      request: async () => {
        throw new Error('kaboom');
      },
    });
    return handleRequest(req('personal_sign'), h.deps).then(() => {
      const logError = h.deps.logError as ReturnType<typeof vi.fn>;
      expect(logError).toHaveBeenCalledTimes(1);
      const [message, err] = logError.mock.calls[0] as [string, unknown];
      expect(message).toContain('personal_sign');
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('kaboom');
    });
  });

  /**
   * `expiryTimestamp` (in SECONDS) was populated off the wire and read
   * nowhere. `session_request_expire` only reached the pending queue, whose
   * slot is already gone the moment the user approves — so a request that
   * expired while the Base app was open still got signed and broadcast, and
   * only then did `respondResult` throw for the dead id. The user paid gas for
   * a request the dapp had abandoned.
   */
  describe('request expiry (expiryTimestamp)', () => {
    const NOW = 1_800_000_000_000;
    const at = (msFromNow: number) => Math.floor((NOW + msFromNow) / 1000);
    const clock = () => NOW;

    it('never reaches the wallet when the TTL lapsed while the user was deciding', async () => {
      const h = makeDeps({ now: clock });
      await handleRequest(
        req('eth_sendTransaction', [{ to: '0xa' }], 8453, at(-1000)),
        h.deps,
      );
      expect(h.deps.wallet.getChainId).not.toHaveBeenCalled();
      expect(h.deps.wallet.request).not.toHaveBeenCalled();
      expect(totalResponses(h)).toBe(0);
    });

    it('sends no response for a lapsed TTL, exactly like session_request_expire', async () => {
      const h = makeDeps({ now: clock });
      await handleRequest(req('personal_sign', [], 8453, at(-1)), h.deps);
      expect(h.deps.dapp.respondResult).not.toHaveBeenCalled();
      expect(h.deps.dapp.respondError).not.toHaveBeenCalled();
    });

    it('drops a response whose TTL lapsed during the wallet round-trip', async () => {
      // The dangerous ordering: the wallet DOES sign, but the dapp is gone.
      // Nothing may be sent for that id — responding to it throws inside
      // WalletKit — but the user must not be billed for it silently either.
      let currentTime = NOW;
      const h = makeDeps({
        now: () => currentTime,
        request: async () => {
          currentTime = NOW + 10_000;
          return '0xsignature';
        },
      });
      await handleRequest(req('personal_sign', [], 8453, at(5_000)), h.deps);
      expect(h.deps.wallet.request).toHaveBeenCalledOnce();
      expect(totalResponses(h)).toBe(0);
    });

    it('proceeds normally while the TTL still has time left', async () => {
      const h = makeDeps({ now: clock });
      await handleRequest(
        req('eth_sendTransaction', [{ to: '0xa' }], 8453, at(60_000)),
        h.deps,
      );
      expect(h.results).toEqual(['ok']);
    });

    it('treats expiryTimestamp as SECONDS, not milliseconds', () => {
      // Read as milliseconds, a timestamp 60s in the future looks like 1970 —
      // every request would be born expired and the bridge would answer none.
      const h = makeDeps({ now: clock });
      return handleRequest(req('personal_sign', [], 8453, at(60_000)), h.deps).then(() => {
        expect(h.results).toEqual(['ok']);
      });
    });

    it('clamps the wallet timeout down to the remaining TTL', async () => {
      // The wallet timeout is 3 minutes by default and the TTL is typically 5,
      // but a TTL with 40ms left must not license a 3-minute wait: the answer
      // would arrive for a request nobody can be told about. expiryTimestamp
      // has one-second resolution, so this picks a clock offset that leaves
      // exactly 40ms rather than going through `at()`.
      const h = makeDeps({
        now: () => 1_800_000_000_960,
        timeoutMs: 60_000,
        request: () => new Promise(() => {}),
      });
      const started = Date.now();
      await handleRequest(req('personal_sign', [], 8453, 1_800_000_001), h.deps);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(5_000);
      // The clamped timeout fired before the TTL, so the id is still live and
      // the dapp gets its timeout error.
      expect(h.errors[0]?.code).toBe(5000);
      expect(h.errors[0]?.message).toMatch(/wallet/i);
    });

    it('sends nothing when a failure surfaces after the TTL has lapsed', async () => {
      let currentTime = NOW;
      const h = makeDeps({
        now: () => currentTime,
        request: async () => {
          currentTime = NOW + 10_000;
          throw new Error('wallet blew up');
        },
      });
      await handleRequest(req('personal_sign', [], 8453, at(5_000)), h.deps);
      expect(totalResponses(h)).toBe(0);
    });

    it('is unaffected when the request carries no expiry at all', async () => {
      const h = makeDeps({ now: clock });
      await handleRequest(req('personal_sign'), h.deps);
      expect(h.results).toEqual(['ok']);
    });
  });

  /**
   * The chain sync exists for eth_call / eth_estimateGas / eth_getBalance and
   * must stay. Running it for chain-independent methods meant a bare
   * eth_chainId could pop a real network-switch prompt in the Base app, and
   * wallet_switchEthereumChain cost two prompts for one switch.
   */
  describe('chain sync', () => {
    it.each([
      'eth_accounts',
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_getCapabilities',
    ])('does not touch the chain for %s', async (method) => {
      const h = makeDeps({ chainId: 1 });
      await handleRequest(req(method, [], 8453), h.deps);
      expect(h.deps.wallet.getChainId).not.toHaveBeenCalled();
      expect(h.deps.wallet.switchChain).not.toHaveBeenCalled();
      expect(h.results).toEqual(['ok']);
    });

    it('costs wallet_switchEthereumChain exactly one prompt, not two', async () => {
      const h = makeDeps({ chainId: 1 });
      await handleRequest(
        req('wallet_switchEthereumChain', [{ chainId: '0x2105' }], 8453),
        h.deps,
      );
      expect(h.switched).toEqual([]);
      expect(h.order).toEqual(['request']);
    });

    it.each(['eth_call', 'eth_estimateGas', 'eth_getBalance'])(
      'still syncs the chain for %s, which reads chain state',
      async (method) => {
        const h = makeDeps({ chainId: 1 });
        await handleRequest(req(method, [], 8453), h.deps);
        expect(h.switched).toEqual([8453]);
        expect(h.order).toEqual(['switch', 'request']);
      },
    );

    it('still syncs the chain for an unknown method (deny by default)', async () => {
      const h = makeDeps({ chainId: 1 });
      await handleRequest(req('eth_futureThing', [], 8453), h.deps);
      expect(h.switched).toEqual([8453]);
    });
  });
});
