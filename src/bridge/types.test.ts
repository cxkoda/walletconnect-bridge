import { describe, it, expect } from 'vitest';
import { RequestExpiredError, USER_REJECTED } from './types';

describe('types', () => {
  it('USER_REJECTED uses EIP-1193 code 4001, not the WC SDK 5000', () => {
    // Load-bearing: dapps look for 4001 to re-enable their connect button.
    // getSdkError('USER_REJECTED') returns 5000 and must never be used here.
    expect(USER_REJECTED.code).toBe(4001);
    expect(USER_REJECTED.message).toMatch(/reject/i);
  });

  it('RequestExpiredError is identifiable via instanceof', () => {
    const err = new RequestExpiredError(42);
    expect(err).toBeInstanceOf(RequestExpiredError);
    expect(err).toBeInstanceOf(Error);
    expect(err.requestId).toBe(42);
  });
});
