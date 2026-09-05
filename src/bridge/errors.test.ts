import { describe, it, expect, vi } from 'vitest';
import { toJsonRpcError, withTimeout, TimeoutError } from './errors';

describe('toJsonRpcError', () => {
  it('preserves 4001 so dapps see a real user rejection', () => {
    const err = Object.assign(new Error('User denied'), { code: 4001 });
    expect(toJsonRpcError(err)).toEqual({ code: 4001, message: 'User denied' });
  });

  it.each([4100, 4200, 4900, 4901, 4902])(
    'passes standard EIP-1193 code %i through',
    (code) => {
      const err = Object.assign(new Error('nope'), { code });
      expect(toJsonRpcError(err).code).toBe(code);
    },
  );

  it('maps a bare Error to 5000 keeping the message', () => {
    expect(toJsonRpcError(new Error('boom'))).toEqual({
      code: 5000,
      message: 'boom',
    });
  });

  it('maps a thrown string to 5000', () => {
    expect(toJsonRpcError('kaboom')).toEqual({ code: 5000, message: 'kaboom' });
  });

  it('maps a thrown null/undefined to 5000 with a placeholder message', () => {
    expect(toJsonRpcError(null).code).toBe(5000);
    expect(toJsonRpcError(null).message).toMatch(/unknown/i);
    expect(toJsonRpcError(undefined).code).toBe(5000);
  });

  it('ignores a non-numeric code property', () => {
    const err = Object.assign(new Error('weird'), { code: 'ENOENT' });
    expect(toJsonRpcError(err).code).toBe(5000);
  });

  it('does not pass through a non-EIP-1193 numeric code', () => {
    // A random numeric code (e.g. an HTTP status leaking through) must not be
    // presented to the dapp as if it were a 1193 error.
    const err = Object.assign(new Error('http'), { code: 503 });
    expect(toJsonRpcError(err).code).toBe(5000);
  });

  it('maps a TimeoutError to 5000 mentioning the wallet', () => {
    const r = toJsonRpcError(new TimeoutError('timed out waiting for wallet'));
    expect(r.code).toBe(5000);
    expect(r.message).toMatch(/wallet/i);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise wins', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'nope')).resolves.toBe(7);
  });

  it('rejects with TimeoutError when time wins', async () => {
    vi.useFakeTimers();
    const pending = new Promise(() => {});
    const p = withTimeout(pending, 1000, 'timed out waiting for wallet');
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    vi.useRealTimers();
  });

  it('propagates the original rejection unchanged', async () => {
    const err = Object.assign(new Error('denied'), { code: 4001 });
    await expect(withTimeout(Promise.reject(err), 1000, 'x')).rejects.toBe(err);
  });
});
