import { Core } from '@walletconnect/core';
import { WalletKit, type WalletKitTypes } from '@reown/walletkit';
import { formatJsonRpcError, formatJsonRpcResult } from '@walletconnect/jsonrpc-utils';
import type { CoreTypes, Verify } from '@walletconnect/types';
import { parseCaipChainId } from '../chains';
import type { DappIdentity, DappPort, IncomingRequest, JsonRpcErrorPayload } from '../bridge/types';

/**
 * `@reown/walletkit`'s index re-exports the class as
 * `export declare const WalletKit: typeof Client`, a value-only binding —
 * `WalletKit` is not usable as a type name from that import path. This
 * alias recovers the instance type without re-declaring the SDK's shape.
 */
export type WalletKitInstance = InstanceType<typeof WalletKit>;

export function toDappIdentity(
  metadata: CoreTypes.Metadata,
  verifyContext: Verify.Context | undefined,
): DappIdentity {
  return {
    name: metadata.name,
    url: metadata.url,
    iconUrl: metadata.icons?.[0],
    validation: verifyContext?.verified.validation ?? 'UNKNOWN',
    isScam: verifyContext?.verified.isScam ?? false,
  };
}

export function toIncomingRequest(
  event: WalletKitTypes.SessionRequest,
  metadata: CoreTypes.Metadata,
): IncomingRequest {
  return {
    id: event.id,
    topic: event.topic,
    chainId: parseCaipChainId(event.params.chainId),
    method: event.params.request.method,
    params: event.params.request.params,
    expiryTimestamp: event.params.request.expiryTimestamp,
    dapp: toDappIdentity(metadata, event.verifyContext),
  };
}

export async function createWalletKit(projectId: string): Promise<WalletKitInstance> {
  if (!projectId) {
    throw new Error(
      'VITE_REOWN_PROJECT_ID is not set. Get a free project ID at https://dashboard.reown.com and copy .env.example to .env.',
    );
  }
  return WalletKit.init({
    core: new Core({ projectId }),
    metadata: {
      name: 'CB ↔ WalletConnect Bridge',
      description: 'Bridges WalletConnect dapps to a Coinbase Base Account',
      url: window.location.origin,
      icons: [],
    },
  });
}

export function createDappPort(kit: WalletKitInstance): DappPort {
  return {
    async respondResult(topic: string, id: number, result: unknown) {
      await kit.respondSessionRequest({ topic, response: formatJsonRpcResult(id, result) });
    },
    async respondError(topic: string, id: number, error: JsonRpcErrorPayload) {
      await kit.respondSessionRequest({
        topic,
        response: formatJsonRpcError(id, { code: error.code, message: error.message }),
      });
    },
  };
}
