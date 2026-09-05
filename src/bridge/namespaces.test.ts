import { describe, it, expect } from 'vitest';
import { buildSupportedNamespaces, decideProposal } from './namespaces';

const ADDR = '0x1111111111111111111111111111111111111111';

const proposal = (required: unknown, optional: unknown = {}) =>
  ({
    id: 1,
    expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
    relays: [{ protocol: 'irn' }],
    proposer: { publicKey: 'pk', metadata: { name: 'D', description: '', url: 'https://d', icons: [] } },
    requiredNamespaces: required,
    optionalNamespaces: optional,
    pairingTopic: 'topic',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe('buildSupportedNamespaces', () => {
  it('lists one account per supported chain', () => {
    const ns = buildSupportedNamespaces(ADDR);
    expect(ns.eip155.accounts).toContain(`eip155:8453:${ADDR}`);
    expect(ns.eip155.accounts).toHaveLength(ns.eip155.chains.length);
  });

  it('advertises accountsChanged and chainChanged', () => {
    expect(buildSupportedNamespaces(ADDR).eip155.events).toEqual(
      expect.arrayContaining(['accountsChanged', 'chainChanged']),
    );
  });

  it('never advertises eth_sign or eth_signTransaction', () => {
    const methods = buildSupportedNamespaces(ADDR).eip155.methods;
    expect(methods).not.toContain('eth_sign');
    expect(methods).not.toContain('eth_signTransaction');
  });
});

describe('decideProposal', () => {
  it('approves a proposal requiring only Base', () => {
    const d = decideProposal(
      proposal({
        eip155: { chains: ['eip155:8453'], methods: ['eth_sendTransaction', 'personal_sign'], events: ['chainChanged'] },
      }),
      ADDR,
    );
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.namespaces.eip155.accounts).toContain(`eip155:8453:${ADDR}`);
  });

  it('approves an optional-only proposal', () => {
    const d = decideProposal(
      proposal({}, { eip155: { chains: ['eip155:8453', 'eip155:1'], methods: ['personal_sign'], events: [] } }),
      ADDR,
    );
    expect(d.ok).toBe(true);
  });

  it('rejects when a required chain is unsupported, naming the chain', () => {
    const d = decideProposal(
      proposal({ eip155: { chains: ['eip155:43114'], methods: ['personal_sign'], events: [] } }),
      ADDR,
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/43114|chain/i);
  });

  it('rejects when a required method is unsupported', () => {
    const d = decideProposal(
      proposal({ eip155: { chains: ['eip155:8453'], methods: ['eth_signTransaction'], events: [] } }),
      ADDR,
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/eth_signTransaction|method/i);
  });

  it('rejects a non-eip155 required namespace', () => {
    const d = decideProposal(
      proposal({ solana: { chains: ['solana:mainnet'], methods: ['signMessage'], events: [] } }),
      ADDR,
    );
    expect(d.ok).toBe(false);
  });

  it('never throws — always returns a decision', () => {
    expect(() => decideProposal(proposal(undefined), ADDR)).not.toThrow();
  });
});
