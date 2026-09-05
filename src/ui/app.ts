import { escapeHtml, renderCard, renderDappHeader } from './render';
import type { PendingConfirmations } from './pending';
import type { DappIdentity } from '../bridge/types';

export interface AppCallbacks {
  onConnect: () => void;
  onPair: (uri: string) => void;
  onDisconnect: (topic: string) => void;
}

export interface SessionRow {
  topic: string;
  dapp: DappIdentity;
}

export class AppUI {
  private root: HTMLElement;
  private dialog: HTMLDialogElement;

  constructor(private cb: AppCallbacks) {
    this.root = document.getElementById('app')!;
    this.root.innerHTML = `
      <h1>Coinbase ↔ WalletConnect Bridge</h1>
      <section id="wallet">
        <div class="row">
          <button id="connect">Connect Coinbase Wallet</button>
          <span id="wallet-status" class="muted">Not connected</span>
        </div>
        <div id="wallet-note"></div>
        <div id="wallet-warning"></div>
      </section>
      <section id="pair">
        <div class="row">
          <input id="uri" placeholder="Paste the dapp's wc:… URI here" disabled />
          <button id="pair-btn" disabled>Pair</button>
        </div>
        <p class="muted" id="pair-status">Connect your wallet first.</p>
      </section>
      <section id="sessions"><p class="muted">No active sessions.</p></section>
      <dialog id="approval"></dialog>`;

    this.dialog = this.root.querySelector('#approval') as HTMLDialogElement;
    this.root.querySelector('#connect')!.addEventListener('click', () => this.cb.onConnect());
    this.root.querySelector('#pair-btn')!.addEventListener('click', () => {
      const input = this.root.querySelector('#uri') as HTMLInputElement;
      const uri = input.value.trim();
      if (uri) {
        input.value = '';
        this.cb.onPair(uri);
      }
    });
  }

  setWallet(address: string, isSmartAccount: boolean): void {
    (this.root.querySelector('#wallet-status') as HTMLElement).textContent = address;
    (this.root.querySelector('#connect') as HTMLButtonElement).disabled = true;
    (this.root.querySelector('#uri') as HTMLInputElement).disabled = false;
    (this.root.querySelector('#pair-btn') as HTMLButtonElement).disabled = false;
    this.setPairStatus('');
    if (isSmartAccount) {
      (this.root.querySelector('#wallet-note') as HTMLElement).innerHTML =
        `<div class="banner warn">This is a smart account. Signatures are ERC-1271 contract
         signatures — dapps that verify with ecrecover (many sign-in flows) will reject them.</div>`;
    }
  }

  /**
   * Transient wallet-level notice (stale account, disconnected wallet).
   *
   * Kept in its own node, separate from the persistent smart-account banner
   * `setWallet` writes to `#wallet-note` — this fires repeatedly (e.g. on
   * every `accountsChanged`, even a benign reconnect) and must not clobber
   * that standing warning when it clears itself back to `''`.
   */
  setWalletWarning(text: string): void {
    (this.root.querySelector('#wallet-warning') as HTMLElement).innerHTML = text
      ? `<div class="banner warn">${text}</div>`
      : '';
  }

  setPairStatus(text: string, isError = false): void {
    const el = this.root.querySelector('#pair-status') as HTMLElement;
    el.textContent = text;
    el.className = isError ? 'warning danger' : 'muted';
  }

  setSessions(rows: SessionRow[]): void {
    const el = this.root.querySelector('#sessions') as HTMLElement;
    if (rows.length === 0) {
      el.innerHTML = '<p class="muted">No active sessions.</p>';
      return;
    }
    el.innerHTML = rows
      .map(
        (r) =>
          `<div class="row" style="margin-bottom:8px">${renderDappHeader(r.dapp)}
           <button class="secondary" data-topic="${escapeHtml(r.topic)}">Disconnect</button></div>`,
      )
      .join('');
    el.querySelectorAll<HTMLButtonElement>('button[data-topic]').forEach((b) =>
      b.addEventListener('click', () => this.cb.onDisconnect(b.dataset.topic!)),
    );
  }

  /** Render the topmost pending request, or close the modal when the queue empties. */
  renderPending(pending: PendingConfirmations): void {
    const [entry] = pending.list();
    if (!entry) {
      if (this.dialog.open) this.dialog.close();
      return;
    }
    const unknown = entry.card.title.startsWith('Unrecognised');
    this.dialog.innerHTML = `
      ${renderDappHeader(entry.req.dapp)}
      ${renderCard(entry.card)}
      <div class="row" style="margin-top:16px; justify-content:flex-end">
        <button class="secondary" id="reject">Reject</button>
        <button id="approve">${unknown ? 'Forward once' : 'Approve'}</button>
      </div>`;
    this.dialog.querySelector('#approve')!.addEventListener('click', () => {
      pending.approve(entry.req.id);
      this.renderPending(pending);
    });
    this.dialog.querySelector('#reject')!.addEventListener('click', () => {
      pending.reject(entry.req.id);
      this.renderPending(pending);
    });
    if (!this.dialog.open) this.dialog.showModal();
  }
}
