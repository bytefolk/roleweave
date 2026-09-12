import path from "node:path";
import { OrgApiError, errorCodes } from "@roleweave/shared";

export interface RunningTurnReservation {
  setAbort(abort: () => void): void;
  release(): void;
}

interface RunningTurn {
  abort?: () => void;
  cancelled: boolean;
  kind: "turn" | "mutation";
  turnId?: string;
  mutationUsers?: number;
}

/**
 * Execution bookkeeping — ownership and why these are intentionally separate.
 *
 * Four structures track "active" work across the control plane. They look
 * overlapping but differ in key scope, lifetime, and cleanup semantics:
 *
 * - RunningTurnRegistry (this class):
 *   Key: workspace\0positionId. Lifetime: from reserve() until release().
 *   Holds abort hooks and cancellation state. Provides per-employee mutual
 *   exclusion between model turns and lifecycle mutations. Cleanup: explicit
 *   release(); mutation entries are ref-counted.
 *
 * - TurnStore.activeTurns (Set<string>):
 *   Key: workspace\0positionId\0turnId or workspace\0session:id\0turnId.
 *   Lifetime: between begin()/beginSession() and finish()/finishSession().
 *   Detects orphaned "running" records on disk for crash recovery — if a
 *   record is "running" but its key is absent, the control plane stopped
 *   before reaching a terminal state. Cleanup: removed in finally blocks.
 *
 * - SessionStore.activeTurns (Map<string, number>):
 *   Key: workspace\0sessionId. Lifetime: between reserveTurn() and
 *   releaseTurn(). Ref-counted guard that blocks rotate() and
 *   setThreadContext() while a session has active turns. Cleanup: decremented
 *   to zero then deleted.
 *
 * - GroupStore.activeDispatches (Set<string>):
 *   Key: workspace\0conversationRef\0messageId. Lifetime: from beginDispatch()
 *   until the returned callback runs. Identifies in-flight group dispatches
 *   so timeline reads skip recovery for spawns the dispatch still owns.
 *   Cleanup: explicit callback in finally blocks.
 *
 * These are not consolidated because collapsing them would conflate distinct
 * invariants: abort hooks vs crash-recovery detection vs lifecycle guards vs
 * dispatch ownership. Each key scope matches its exclusion boundary.
 */
/** Reserves one position before asynchronous work; different employees run independently. */
export class RunningTurnRegistry {
  private readonly turns = new Map<string, RunningTurn>();

  reserve(workspace: string, positionId: string, turnId?: string): RunningTurnReservation {
    return this.acquire(workspace, positionId, { cancelled: false, kind: "turn", ...(turnId !== undefined ? { turnId } : {}) });
  }

  /** A lifecycle transaction excludes model execution but is not cancellable. */
  reserveMutation(workspace: string, positionId: string): () => void {
    const key = this.key(workspace, positionId);
    let entry = this.turns.get(key);
    if (entry?.kind === "turn") {
      throw new OrgApiError(errorCodes.session_conflict, 409, "this employee already has a turn in progress");
    }
    if (entry === undefined) {
      entry = { cancelled: false, kind: "mutation", mutationUsers: 0 };
      this.turns.set(key, entry);
    }
    // SessionStore serializes mutations of a session, including idempotent
    // rotate. Keep the employee excluded while any such transaction waits.
    entry.mutationUsers = (entry.mutationUsers ?? 0) + 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.mutationUsers = (entry.mutationUsers ?? 1) - 1;
      if (entry.mutationUsers === 0 && this.turns.get(key) === entry) this.turns.delete(key);
    };
  }

  private acquire(workspace: string, positionId: string, turn: RunningTurn): RunningTurnReservation {
    const key = this.key(workspace, positionId);
    if (this.turns.has(key)) {
      throw new OrgApiError(errorCodes.session_conflict, 409, "this employee already has a turn in progress");
    }
    this.turns.set(key, turn);
    return {
      setAbort: (abort) => {
        if (this.turns.get(key) !== turn) return;
        turn.abort = abort;
        if (turn.cancelled) abort();
      },
      release: () => {
        if (this.turns.get(key) === turn) this.turns.delete(key);
      },
    };
  }

  cancel(workspace: string, positionId: string, turnId?: string): boolean {
    const turn = this.turns.get(this.key(workspace, positionId));
    if (turn === undefined || turn.kind !== "turn" || (turnId !== undefined && turn.turnId !== turnId)) return false;
    if (!turn.cancelled) {
      turn.cancelled = true;
      turn.abort?.();
    }
    return true;
  }

  private key(workspace: string, positionId: string): string {
    return `${path.resolve(workspace)}\0${positionId}`;
  }
}
