import { buildApprovedNamespaces } from '@walletconnect/utils';
import type { ProposalTypes, SessionTypes } from '@walletconnect/types';
import { SUPPORTED_CAIP_CHAINS, SUPPORTED_CHAINS, toCaipChainId } from '../chains';
import { ADVERTISED_METHODS } from './policy';

export const ADVERTISED_EVENTS = ['accountsChanged', 'chainChanged'] as const;

export type ProposalDecision =
  | { ok: true; namespaces: SessionTypes.Namespaces }
  | { ok: false; reason: string };

export function buildSupportedNamespaces(address: string) {
  return {
    eip155: {
      chains: [...SUPPORTED_CAIP_CHAINS],
      methods: [...ADVERTISED_METHODS],
      events: [...ADVERTISED_EVENTS],
      accounts: SUPPORTED_CHAINS.map((c) => `${toCaipChainId(c.id)}:${address}`),
    },
  };
}

/**
 * Decide whether we can serve a session proposal.
 *
 * buildApprovedNamespaces throws when the proposal requires a chain or method
 * outside what we support. Rejecting here is deliberately better than approving
 * a session that will fail on the dapp's first real request.
 */
export function decideProposal(
  proposal: ProposalTypes.Struct,
  address: string,
): ProposalDecision {
  try {
    const namespaces = buildApprovedNamespaces({
      proposal,
      supportedNamespaces: buildSupportedNamespaces(address),
    });
    return { ok: true, namespaces };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `This dapp requires something this account can't provide: ${detail}`,
    };
  }
}
