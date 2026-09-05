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

  confirm(req: IncomingRequest, card: RequestCard): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.slots.set(req.id, { req, card, resolve, reject });
    });
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
  }
}
