import { RequestExpiredError } from '../bridge/types';
import type { ConfirmPort, IncomingRequest, RequestCard } from '../bridge/types';

export interface PendingEntry {
  req: IncomingRequest;
  card: RequestCard;
}

interface Slot extends PendingEntry {
  resolve: (approved: boolean) => void;
  reject: (err: unknown) => void;
}

/**
 * Holds requests awaiting a decision. Implements ConfirmPort without touching
 * the DOM, so the expiry semantics the router depends on stay unit-testable.
 */
export class PendingConfirmations implements ConfirmPort {
  private slots = new Map<number, Slot>();

  /**
   * Called whenever the queue changes — a slot added, approved, rejected or
   * expired. The UI subscribes once and re-renders from the queue.
   *
   * This has to be an observer rather than a call the caller makes around
   * `confirm()`. `confirm()` is invoked from inside `handleRequest`, whose
   * promise cannot settle until the user clicks — and the user cannot click
   * until the modal that `confirm()` itself caused is on screen. Anything that
   * renders *before* awaiting `handleRequest` renders an empty queue; anything
   * that renders *after* deadlocks. Only a notification from inside the queue
   * lands at the one moment the entry actually exists.
   */
  onChange?: () => void;

  confirm(req: IncomingRequest, card: RequestCard): Promise<boolean> {
    const promise = new Promise<boolean>((resolve, reject) => {
      this.slots.set(req.id, { req, card, resolve, reject });
    });
    // After constructing the promise, not inside the executor: a throwing
    // observer would otherwise reject the confirmation itself, turning a UI
    // bug into a spurious rejection sent to the dapp.
    this.notify();
    return promise;
  }

  approve(id: number): void {
    this.settle(id, (s) => s.resolve(true));
  }

  reject(id: number): void {
    this.settle(id, (s) => s.resolve(false));
  }

  /** The request's own TTL elapsed. The router must send no response at all. */
  expire(id: number): void {
    this.settle(id, (s) => s.reject(new RequestExpiredError(id)));
  }

  list(): PendingEntry[] {
    return [...this.slots.values()].map(({ req, card }) => ({ req, card }));
  }

  private settle(id: number, act: (slot: Slot) => void): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    act(slot);
    this.notify();
  }

  private notify(): void {
    try {
      this.onChange?.();
    } catch (err) {
      // A render failure must not take down the queue: the router is awaiting
      // one of these promises and a throw here would surface as a bridge error
      // for a request the user may still be able to decide on.
      console.error('PendingConfirmations.onChange threw', err);
    }
  }
}
