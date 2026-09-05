import './ui/styles.css';
import { AppUI, type SessionRow } from './ui/app';
import { PendingConfirmations } from './ui/pending';
import { connectWallet, type WalletConnection } from './cb/provider';
import {
  createDappPort,
  createWalletKit,
  toDappIdentity,
  toIncomingRequest,
  type WalletKitInstance,
} from './wc/walletkit';
import { decideProposal } from './bridge/namespaces';
import { handleRequest } from './bridge/router';
import { toCaipChainId } from './chains';
import { getSdkError } from '@walletconnect/utils';

const pending = new PendingConfirmations();
let wallet: WalletConnection | null = null;
let kit: WalletKitInstance | null = null;

const ui = new AppUI({
  onConnect: async () => {
    try {
      wallet = await connectWallet();
      ui.setWallet(wallet.address, wallet.isSmartAccount);
      kit = await start(wallet);
    } catch (err) {
      ui.setPairStatus(err instanceof Error ? err.message : String(err), true);
    }
  },
  onPair: async (uri) => {
    if (!kit) return;
    try {
      ui.setPairStatus('Pairing…');
      await kit.pair({ uri });
    } catch {
      ui.setPairStatus(
        'Could not pair with that URI. WalletConnect URIs are single-use and expire after a few minutes — refresh the dapp’s QR code and copy a fresh one.',
        true,
      );
    }
  },
  onDisconnect: async (topic) => {
    await kit?.disconnectSession({ topic, reason: getSdkError('USER_DISCONNECTED') });
    refreshSessions();
  },
});

function refreshSessions(): void {
  if (!kit) return;
  const rows: SessionRow[] = Object.values(kit.getActiveSessions()).map((s) => ({
    topic: s.topic,
    dapp: toDappIdentity(s.peer.metadata, undefined),
  }));
  ui.setSessions(rows);
}

async function start(w: WalletConnection): Promise<WalletKitInstance> {
  const instance = await createWalletKit(import.meta.env.VITE_REOWN_PROJECT_ID);
  // Assign before registering handlers: refreshSessions() and the provider
  // event handlers below all read the module-level `kit`, and they can fire
  // before this function returns.
  kit = instance;
  const dapp = createDappPort(instance);

  instance.on('session_proposal', async (proposal) => {
    const decision = decideProposal(proposal.params, w.address);
    if (!decision.ok) {
      await instance.rejectSession({ id: proposal.id, reason: { code: 5000, message: decision.reason } });
      ui.setPairStatus(decision.reason, true);
      return;
    }
    await instance.approveSession({ id: proposal.id, namespaces: decision.namespaces });
    ui.setPairStatus('Connected.');
    refreshSessions();
  });

  instance.on('session_request', async (event) => {
    const session = instance.getActiveSessions()[event.topic];
    const req = toIncomingRequest(event, session.peer.metadata);
    ui.renderPending(pending);
    await handleRequest(req, {
      wallet: w.port,
      dapp,
      confirm: pending,
      isSmartAccount: () => w.isSmartAccount,
    });
    ui.renderPending(pending);
  });

  instance.on('session_request_expire', ({ id }) => {
    pending.expire(id);
    ui.renderPending(pending);
  });

  instance.on('session_delete', refreshSessions);

  // Fan wallet state changes out to every live session. Without this, dapps
  // keep displaying a stale address indefinitely.
  w.provider.on('accountsChanged', (accounts: string[]) => {
    const next = accounts[0];
    if (!next || !kit) return;
    let stale = false;
    for (const session of Object.values(kit.getActiveSessions())) {
      const approved = session.namespaces.eip155?.accounts ?? [];
      const isApproved = approved.some((a) => a.toLowerCase().endsWith(next.toLowerCase()));
      if (!isApproved) {
        // Emitting accountsChanged for an account the session never approved is
        // protocol-sketchy, so tell the user instead of lying to the dapp.
        stale = true;
        continue;
      }
      void kit.emitSessionEvent({
        topic: session.topic,
        event: { name: 'accountsChanged', data: [next] },
        chainId: approved[0].split(':').slice(0, 2).join(':'),
      });
    }
    ui.setWalletWarning(
      stale
        ? 'Your wallet switched to an account one or more connected dapps never approved. Disconnect and reconnect those dapps to use the new account.'
        : '',
    );
  });

  // A disconnected wallet makes in-flight requests throw; the router maps the
  // provider's 4900 through to the dapp. The banner is for the user.
  w.provider.on('disconnect', () => {
    ui.setWalletWarning('Coinbase Wallet disconnected. Reload the page to reconnect.');
  });

  w.provider.on('chainChanged', (hexChainId: string) => {
    if (!kit) return;
    const chainId = toCaipChainId(Number(hexChainId));
    for (const session of Object.values(kit.getActiveSessions())) {
      void kit.emitSessionEvent({
        topic: session.topic,
        event: { name: 'chainChanged', data: Number(hexChainId) },
        chainId,
      });
    }
  });

  refreshSessions();
  return instance;
}

window.addEventListener('beforeunload', (e) => {
  if (kit && Object.keys(kit.getActiveSessions()).length > 0) {
    e.preventDefault();
  }
});
