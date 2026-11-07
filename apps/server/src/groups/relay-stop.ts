import type { TurnRecord } from "@roleweave/shared";
import { askLaya, type LayaAsk } from "../laya/client.js";
import { layaEnabled } from "../laya/config.js";

export const RELAY_STOP_TIMEOUT_MS = 30_000;
export const RELAY_STOP_PROBABILITY_THRESHOLD = 0.6;

export type RelayStopDecision = "stop" | "continue";
export type RelayStopResolutionReason = "owner" | "timeout" | "disconnect";

export interface RelayStopSuggestion {
  probability: number;
}

export interface RelayStopResolution {
  decision: RelayStopDecision;
  reason: RelayStopResolutionReason;
}

interface PendingRelayStop {
  workspace: string;
  conversationRef: string;
  messageId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (resolution: RelayStopResolution) => void;
}

export interface RelayStopGate {
  expiresAt: string;
  wait: Promise<RelayStopResolution>;
}

export interface RelayStopCoordinatorOptions {
  env?: NodeJS.Dict<string>;
  ask?: LayaAsk;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * In-process owner-confirmation gate for a live relay. The accepted spawn list
 * remains immutable on disk; this registry only controls when the background
 * loop may start the next already-accepted identity.
 */
export class RelayStopCoordinator {
  private readonly env: NodeJS.Dict<string>;
  private readonly ask: LayaAsk;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly pending = new Map<string, PendingRelayStop>();

  constructor(options: RelayStopCoordinatorOptions = {}) {
    this.env = options.env ?? process.env;
    this.ask = options.ask ?? ((request) => askLaya(request, { env: this.env }));
    this.timeoutMs = options.timeoutMs ?? RELAY_STOP_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async suggest(record: Pick<TurnRecord, "status" | "error" | "output">): Promise<RelayStopSuggestion | null> {
    if (!layaEnabled(this.env)) return null;
    const state = {
      status: record.status,
      errorCode: record.error?.code ?? null,
      hasOutput: typeof record.output === "string" ? record.output.trim().length > 0 : record.output != null,
    };
    try {
      const answers = await this.ask({
        state,
        questions: {
          stop: {
            type: "noul",
            instructions: "Is the relay task already complete enough to suggest stopping the remaining accepted legs? Advisory only; the owner must confirm.",
          },
        },
      });
      const answer = answers?.stop;
      if (answer?.type !== "noul" || answer.probability < RELAY_STOP_PROBABILITY_THRESHOLD) return null;
      return { probability: answer.probability };
    } catch {
      return null;
    }
  }

  begin(workspace: string, conversationRef: string, messageId: string): RelayStopGate {
    const key = this.key(workspace, conversationRef, messageId);
    if (this.pending.has(key)) throw new Error("relay stop decision is already pending");
    const expiresAt = new Date(this.now().getTime() + this.timeoutMs).toISOString();
    let settle!: (resolution: RelayStopResolution) => void;
    const wait = new Promise<RelayStopResolution>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => this.finish(key, "continue", "timeout"), this.timeoutMs);
    timer.unref?.();
    this.pending.set(key, {
      workspace,
      conversationRef,
      messageId,
      timer,
      resolve: settle,
    });
    return { expiresAt, wait };
  }

  decide(
    workspace: string,
    conversationRef: string,
    messageId: string,
    decision: RelayStopDecision,
  ): boolean {
    return this.finish(this.key(workspace, conversationRef, messageId), decision, "owner");
  }

  continueAll(reason: "disconnect" = "disconnect"): void {
    for (const key of [...this.pending.keys()]) this.finish(key, "continue", reason);
  }

  private finish(
    key: string,
    decision: RelayStopDecision,
    reason: RelayStopResolutionReason,
  ): boolean {
    const pending = this.pending.get(key);
    if (!pending) return false;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve({ decision, reason });
    return true;
  }

  private key(workspace: string, conversationRef: string, messageId: string): string {
    return `${workspace}\0${conversationRef}\0${messageId}`;
  }
}
