// @vitest-environment jsdom
//
// The rest of the suite runs on `node`; only this file needs a DOM. Critical
// defects have lived in exactly this seam before — `src/ui/app.ts` and
// `src/main.ts` were the only modules with no tests at all, and the app
// deadlocked on its first signing request because of it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppUI } from './app';
import type { AppCallbacks, SessionRow } from './app';
import { PendingConfirmations } from './pending';
import { handleRequest } from '../bridge/router';
import type {
  DappIdentity,
  IncomingRequest,
  JsonRpcErrorPayload,
  WalletPort,
} from '../bridge/types';

// jsdom implements <dialog> as an element but not its modal API. This is the
// smallest shim that lets the real AppUI code path run unmodified: `open` is a
// reflected attribute, so toggling it is enough for both the guard in
// renderPending and the assertions below.
const dialogProto = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
if (typeof dialogProto.showModal !== 'function') {
  dialogProto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  dialogProto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}

const noop: AppCallbacks = { onConnect: () => {}, onPair: () => {}, onDisconnect: () => {} };

const dapp = (over: Partial<DappIdentity> = {}): DappIdentity => ({
  name: 'Test Dapp',
  url: 'https://dapp.example',
  validation: 'VALID',
  isScam: false,
  ...over,
});

const req = (method: string, params: unknown): IncomingRequest => ({
  id: 7,
  topic: 'topic-1',
  chainId: 8453,
  method,
  params,
  dapp: dapp(),
});

function fakePorts() {
  const results: unknown[] = [];
  const errors: JsonRpcErrorPayload[] = [];
  // Separated from the port object so the spy stays inspectable while the port
  // itself still satisfies WalletPort's generic `request<T>` signature.
  const request = vi.fn(async (_a: { method: string; params?: unknown }): Promise<unknown> => {
    return '0xsignature';
  });
  return {
    results,
    errors,
    request,
    wallet: {
      request: <T,>(a: { method: string; params?: unknown }) => request(a) as Promise<T>,
      getChainId: async () => 8453,
      switchChain: async () => {},
    } satisfies WalletPort,
    dapp: {
      respondResult: vi.fn(async (_t: string, _i: number, r: unknown) => {
        results.push(r);
      }),
      respondError: vi.fn(async (_t: string, _i: number, e: JsonRpcErrorPayload) => {
        errors.push(e);
      }),
    },
  };
}

/** Wire the UI to the queue exactly as `main.ts` does. */
function mount() {
  const ui = new AppUI(noop);
  const pending = new PendingConfirmations();
  pending.onChange = () => ui.renderPending(pending);
  const dialog = document.querySelector('#approval') as HTMLDialogElement;
  return { ui, pending, dialog };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
});

/**
 * The regression test for the deadlock.
 *
 * `main.ts` used to call `ui.renderPending(pending)` immediately before
 * `await handleRequest(...)` — when the queue was still EMPTY, because the
 * pending slot is only created later, inside handleRequest's own
 * `confirm.confirm()` call. renderPending hit its `if (!entry)` guard and
 * opened nothing. The second call sat in a `finally` that could not run until
 * handleRequest settled, which required `pending.approve()`, which only a
 * click handler that was never attached could call. Circular wait: the user
 * saw nothing, the Base app never prompted, and the dapp spun until its TTL
 * dropped the request with no response at all.
 */
describe('approval modal wiring', () => {
  it('opens the modal while the request is still pending', async () => {
    const { pending, dialog } = mount();
    const ports = fakePorts();

    const inFlight = handleRequest(req('personal_sign', ['0x68690a', '0xabc']), {
      wallet: ports.wallet,
      dapp: ports.dapp,
      confirm: pending,
      isSmartAccount: () => true,
    });
    // Give the router every chance to reach confirm.confirm().
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(dialog.open).toBe(true);
    // Nothing may have been forwarded or answered yet: the user has not decided.
    expect(ports.request).not.toHaveBeenCalled();
    expect(ports.dapp.respondResult).not.toHaveBeenCalled();
    expect(ports.dapp.respondError).not.toHaveBeenCalled();

    dialog.querySelector<HTMLButtonElement>('#approve')!.click();
    await inFlight;

    expect(ports.request).toHaveBeenCalledOnce();
    expect(ports.results).toEqual(['0xsignature']);
    expect(dialog.open).toBe(false);
  });

  it('shows who is asking and what they asked for', async () => {
    const { pending, dialog } = mount();
    const ports = fakePorts();

    const inFlight = handleRequest(req('eth_sendTransaction', [{ to: '0xrecipient', value: '0x0' }]), {
      wallet: ports.wallet,
      dapp: ports.dapp,
      confirm: pending,
      isSmartAccount: () => true,
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // The origin is the reason the card exists: the wallet's own sheet sees
    // the bridge's origin, not the dapp's.
    expect(dialog.textContent).toContain('https://dapp.example');
    expect(dialog.textContent).toContain('Transaction request');
    expect(dialog.textContent).toContain('0xrecipient');

    dialog.querySelector<HTMLButtonElement>('#reject')!.click();
    await inFlight;
  });

  it('rejecting from the modal sends 4001 and closes it', async () => {
    const { pending, dialog } = mount();
    const ports = fakePorts();

    const inFlight = handleRequest(req('personal_sign', ['0x68', '0xabc']), {
      wallet: ports.wallet,
      dapp: ports.dapp,
      confirm: pending,
      isSmartAccount: () => true,
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    dialog.querySelector<HTMLButtonElement>('#reject')!.click();
    await inFlight;

    expect(ports.request).not.toHaveBeenCalled();
    expect(ports.errors).toEqual([{ code: 4001, message: expect.stringContaining('rejected') }]);
    expect(dialog.open).toBe(false);
  });

  it('closes the modal when the request expires with no response sent', async () => {
    const { pending, dialog } = mount();
    const ports = fakePorts();

    const inFlight = handleRequest(req('personal_sign', ['0x68', '0xabc']), {
      wallet: ports.wallet,
      dapp: ports.dapp,
      confirm: pending,
      isSmartAccount: () => true,
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(dialog.open).toBe(true);

    // What `session_request_expire` does.
    pending.expire(7);
    await inFlight;

    expect(dialog.open).toBe(false);
    expect(ports.dapp.respondResult).not.toHaveBeenCalled();
    expect(ports.dapp.respondError).not.toHaveBeenCalled();
  });

  it('keeps the modal open for a second request when the first is settled', async () => {
    const { pending, dialog } = mount();
    const ports = fakePorts();
    const deps = {
      wallet: ports.wallet,
      dapp: ports.dapp,
      confirm: pending,
      isSmartAccount: () => true,
    };

    const first = handleRequest({ ...req('personal_sign', ['0x68', '0xa']), id: 1 }, deps);
    const second = handleRequest({ ...req('personal_sign', ['0x69', '0xa']), id: 2 }, deps);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    dialog.querySelector<HTMLButtonElement>('#approve')!.click();
    await first;
    expect(dialog.open).toBe(true);

    dialog.querySelector<HTMLButtonElement>('#approve')!.click();
    await second;
    expect(dialog.open).toBe(false);
  });
});

describe('approve button label', () => {
  const build = async (method: string) => {
    const { pending, dialog } = mount();
    const ports = fakePorts();
    const inFlight = handleRequest(req(method, [{}]), {
      wallet: ports.wallet,
      dapp: ports.dapp,
      confirm: pending,
      isSmartAccount: () => true,
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const label = dialog.querySelector('#approve')!.textContent;
    dialog.querySelector<HTMLButtonElement>('#reject')!.click();
    await inFlight;
    return label;
  };

  it('offers "Forward once" only for a genuinely un-allowlisted method', async () => {
    expect(await build('eth_futureThing')).toBe('Forward once');
  });

  it.each(['eth_sendTransaction', 'wallet_sendCalls', 'wallet_watchAsset', 'personal_sign'])(
    'offers "Approve" for the allowlisted %s',
    async (method) => {
      expect(await build(method)).toBe('Approve');
    },
  );

  /**
   * The label must follow the router's classification, not the card's prose.
   *
   * These two cases are exactly where the old title-sniffing heuristic
   * (`title.startsWith('Unrecognised')`) diverges from the truth: it agrees
   * with the disposition only for as long as every CONFIRM method happens to
   * have a decoder whose title does not start with that word. That was already
   * false for four allowlisted methods once, and nothing but these assertions
   * stops it becoming false again.
   */
  const labelFor = (
    title: string,
    disposition: { kind: 'confirm' } | { kind: 'unknown' },
  ) => {
    const { ui, pending, dialog } = mount();
    void pending.confirm(req('wallet_sendCalls', [{}]), {
      method: 'wallet_sendCalls',
      title,
      fields: [],
      warnings: [],
      raw: '[]',
      disposition,
    });
    ui.renderPending(pending);
    return dialog.querySelector('#approve')!.textContent;
  };

  it('says "Approve" for a confirm disposition even if the title reads "Unrecognised"', () => {
    expect(labelFor('Unrecognised request: wallet_sendCalls', { kind: 'confirm' })).toBe('Approve');
  });

  it('says "Forward once" for an unknown disposition whatever the title says', () => {
    expect(labelFor('Batch transaction request', { kind: 'unknown' })).toBe('Forward once');
  });
});

describe('relay status', () => {
  it('has its own node, and does not clobber the wallet warning', () => {
    const { ui } = mount();
    ui.setWalletWarning('Coinbase Wallet disconnected.');
    ui.setRelayStatus('disconnected');

    const relay = document.querySelector('#relay-status') as HTMLElement;
    const walletWarning = document.querySelector('#wallet-warning') as HTMLElement;
    expect(relay.textContent).toMatch(/relay/i);
    expect(walletWarning.textContent).toContain('Coinbase Wallet disconnected.');
    expect(relay.contains(walletWarning)).toBe(false);
  });

  it('marks a dropped relay as dangerous rather than silent', () => {
    const { ui } = mount();
    ui.setRelayStatus('disconnected');
    const relay = document.querySelector('#relay-status') as HTMLElement;
    expect(relay.querySelector('.danger')).not.toBeNull();
  });

  it('reports a healthy relay quietly', () => {
    const { ui } = mount();
    ui.setRelayStatus('connected');
    const relay = document.querySelector('#relay-status') as HTMLElement;
    expect(relay.textContent).toMatch(/connected/i);
    expect(relay.querySelector('.danger')).toBeNull();
  });

  it('survives a reconnect without leaving the danger banner behind', () => {
    const { ui } = mount();
    ui.setRelayStatus('disconnected');
    ui.setRelayStatus('connected');
    expect((document.querySelector('#relay-status') as HTMLElement).querySelector('.danger')).toBeNull();
  });
});

describe('session rows', () => {
  const row = (over: Partial<SessionRow> = {}): SessionRow => ({
    topic: 'topic-1',
    dapp: dapp(),
    verified: true,
    ...over,
  });

  it('shows the verify badge when a verify context was actually seen', () => {
    const { ui } = mount();
    ui.setSessions([row({ dapp: dapp({ validation: 'VALID' }) })]);
    expect(document.querySelector('#session-list .badge')).not.toBeNull();
  });

  it('shows no badge at all rather than a permanent amber "Unverified origin"', () => {
    // Every row used to render amber because main.ts passed `undefined` as the
    // verify context, training the user to ignore the badge the approval card
    // depends on.
    const { ui } = mount();
    ui.setSessions([row({ verified: false, dapp: dapp({ validation: 'UNKNOWN' }) })]);
    const list = document.querySelector('#session-list') as HTMLElement;
    expect(list.querySelector('.badge')).toBeNull();
    expect(list.textContent).not.toMatch(/unverified/i);
    // The row itself is still there and still disconnectable.
    expect(list.querySelector('button[data-topic]')).not.toBeNull();
  });

  it('still renders a scam flag on a session row', () => {
    const { ui } = mount();
    ui.setSessions([row({ dapp: dapp({ isScam: true }) })]);
    expect(document.querySelector('#session-list .badge.danger')).not.toBeNull();
  });

  it('calls back with the topic when disconnect is clicked', () => {
    const onDisconnect = vi.fn();
    const ui = new AppUI({ ...noop, onDisconnect });
    ui.setSessions([row({ topic: 'abc123' })]);
    document.querySelector<HTMLButtonElement>('#session-list button[data-topic]')!.click();
    expect(onDisconnect).toHaveBeenCalledWith('abc123');
  });

  it('does not lose the relay status when the session list re-renders', () => {
    const { ui } = mount();
    ui.setRelayStatus('disconnected');
    ui.setSessions([row()]);
    ui.setSessions([]);
    expect((document.querySelector('#relay-status') as HTMLElement).querySelector('.danger')).not.toBeNull();
  });
});
