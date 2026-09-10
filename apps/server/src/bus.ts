import type { SseEventEnvelope, SseEventType } from "@roleweave/shared";

const RING_SIZE = 256;

export type BusListener = (event: SseEventEnvelope) => void;

/**
 * In-process event bus backing GET /events. Keeps a bounded ring so SSE
 * clients can resume after disconnect using their last event id (version
 * stamp), per the frozen v0 contract.
 */
export class EventBus {
  private seq = 0;
  private ring: SseEventEnvelope[] = [];
  private listeners = new Set<BusListener>();

  get currentSeq(): number {
    return this.seq;
  }

  publish(type: SseEventType, payload: unknown): SseEventEnvelope {
    this.seq += 1;
    const event: SseEventEnvelope = {
      seq: this.seq,
      type,
      at: new Date().toISOString(),
      payload,
    };
    this.ring.push(event);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    for (const listener of this.listeners) {
      try {
        // A disconnected SSE client must not abort task execution, starve
        // healthy clients, or create an unhandled async rejection.
        void Promise.resolve(listener(event)).catch(() => { this.listeners.delete(listener); });
      } catch {
        this.listeners.delete(listener);
      }
    }
    return event;
  }

  since(seq: number): SseEventEnvelope[] {
    return this.ring.filter((event) => event.seq > seq);
  }

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
