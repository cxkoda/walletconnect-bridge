import { describe, it, expect } from 'vitest';
import { classify, ADVERTISED_METHODS } from './policy';

describe('classify', () => {
  it.each([
    'eth_accounts',
    'eth_chainId',
    'eth_call',
    'eth_estimateGas',
    'eth_getBalance',
    'eth_getCode',
    'eth_getTransactionByHash',
    'eth_getTransactionReceipt',
    'eth_getTransactionCount',
    'eth_blockNumber',
    'eth_gasPrice',
    'eth_feeHistory',
    'eth_maxPriorityFeePerGas',
    'wallet_switchEthereumChain',
    'wallet_getCapabilities',
  ])('passes %s silently', (m) => {
    expect(classify(m)).toEqual({ kind: 'pass' });
  });

  it.each([
    'personal_sign',
    'eth_signTypedData',
    'eth_signTypedData_v3',
    'eth_signTypedData_v4',
    'eth_sendTransaction',
    'eth_sendRawTransaction',
    'wallet_sendCalls',
    'wallet_addEthereumChain',
    'wallet_watchAsset',
  ])('confirms %s', (m) => {
    expect(classify(m)).toEqual({ kind: 'confirm' });
  });

  it('rejects eth_sign with 4200', () => {
    const d = classify('eth_sign');
    expect(d.kind).toBe('reject');
    if (d.kind === 'reject') {
      expect(d.code).toBe(4200);
      expect(d.message).toMatch(/personal_sign/);
    }
  });

  it('rejects eth_signTransaction with 4200 and explains why', () => {
    const d = classify('eth_signTransaction');
    expect(d.kind).toBe('reject');
    if (d.kind === 'reject') {
      expect(d.code).toBe(4200);
      expect(d.message).toMatch(/smart account/i);
    }
  });

  it('treats an unrecognised method as unknown, never as pass', () => {
    expect(classify('eth_someFutureThing')).toEqual({ kind: 'unknown' });
    expect(classify('')).toEqual({ kind: 'unknown' });
  });

  it('is an allowlist: a dangerous-looking unknown method is not passed', () => {
    // The failure mode this guards against is blind-forwarding to the wallet.
    expect(classify('wallet_signAndSendEverything')).toEqual({ kind: 'unknown' });
  });

  it('advertises only methods it will actually serve', () => {
    for (const m of ADVERTISED_METHODS) {
      expect(classify(m).kind).not.toBe('reject');
      expect(classify(m).kind).not.toBe('unknown');
    }
  });
});
