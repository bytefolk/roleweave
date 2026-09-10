import type { EngineEvent } from "@roleweave/shared";

const DEFAULT_RATE_LIMIT_MS = 100;
const DEFAULT_BUFFER_CAP_BYTES = 64 * 1024;

export interface DeltaForwarderOptions {
  /** Minimum interval (ms) between forwarded model.delta events. */
  rateLimitMs?: number;
  /** Maximum accumulated delta bytes before forwarding stops. */
  bufferCapBytes?: number;
  /** Called for each forwarded event (rate-limited deltas, passthrough events). */
  onForward: (event: EngineEvent) => void;
  /** Current time source; injectable for tests. */
  now?: () => number;
}

/**
 * Rate-limited, buffer-capped forwarder for engine model.delta events (#142).
 *
 * Non-delta events (run.started, usage, approval) pass through immediately.
 * model.delta text is accumulated and flushed at most once per rateLimitMs.
 * Once the accumulated buffer exceeds bufferCapBytes, forwarding stops (the
 * engine continues; only the SSE stream is throttled). A terminal event
 * (run.completed / run.failed) flushes any remaining buffered text.
 */
export class DeltaForwarder {
  private bufferedText = "";
  private bufferedBytes = 0;
  private forwardedBytes = 0;
  private lastForwardAt = 0;
  private capped = false;
  private closed = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly rateLimitMs: number;
  private readonly bufferCapBytes: number;
  private readonly onForward: (event: EngineEvent) => void;
  private readonly now: () => number;
  private runId: string | null = null;
  private timestamp: string | null = null;

  constructor(options: DeltaForwarderOptions) {
    this.rateLimitMs = options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.bufferCapBytes = options.bufferCapBytes ?? DEFAULT_BUFFER_CAP_BYTES;
    this.onForward = options.onForward;
    this.now = options.now ?? Date.now;
    this.lastForwardAt = this.now();
  }

  handle(event: EngineEvent): void {
    if (this.closed) return;
    if (event.type === "model.delta") {
      if (this.runId === null) {
        this.runId = event.runId;
        this.timestamp = event.timestamp;
      }
      if (this.capped) return;
      const deltaBytes = Buffer.byteLength(event.text, "utf8");
      if (this.forwardedBytes + this.bufferedBytes + deltaBytes >= this.bufferCapBytes) {
        this.capped = true;
        this.flush();
        return;
      }
      this.bufferedText += event.text;
      this.bufferedBytes += deltaBytes;
      this.scheduleFlush();
      return;
    }

    if (event.type === "run.completed" || event.type === "run.failed") {
      try {
        this.flush();
        this.onForward(event);
      } finally {
        this.close();
      }
      return;
    }

    this.onForward(event);
  }

  private scheduleFlush(): void {
    const elapsed = this.now() - this.lastForwardAt;
    if (elapsed >= this.rateLimitMs) {
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flush();
      return;
    }
    if (this.flushTimer !== null) return;
    const delay = this.rateLimitMs - elapsed;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (this.closed) return;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.bufferedText.length === 0 || this.runId === null || this.timestamp === null) return;
    this.onForward({
      type: "model.delta",
      runId: this.runId,
      timestamp: this.timestamp,
      text: this.bufferedText,
    });
    this.lastForwardAt = this.now();
    this.forwardedBytes += this.bufferedBytes;
    this.bufferedText = "";
    this.bufferedBytes = 0;
  }

  /** End stream ownership without forwarding untrusted buffered content.
   * Safe after a terminal and on cancellation, driver return or failure. */
  close(): void {
    this.closed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.bufferedText = "";
    this.bufferedBytes = 0;
    this.runId = null;
    this.timestamp = null;
  }

  /** Exposed for tests — returns whether the buffer cap was hit. */
  get isCapped(): boolean {
    return this.capped;
  }
}
