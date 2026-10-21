# Task collaboration context v1

Tracking: #621. Phase three extends project goal work items with explicit collaborators and task dependencies. It builds on relay snapshots (#617) and project task briefings (#619). Project work items are the executable task spine covered here; unbound personal conversations and task-board bookkeeping do not invent collaboration relationships. Agent reviewer dispatch (phase 2b), automatic scheduling and live negotiation (#452) remain separate capabilities.

## Human-owned plan

`GoalWorkItem` gains optional fields:

```ts
participants?: { positionId: string; role: "contributor" | "reviewer"; responsibility: string }[];
dependsOn?: string[];
```

At most eight extra participants and eight predecessors per task; responsibilities are explicit, nonblank and at most 1024 characters. The assignee remains the primary recipient and cannot be duplicated among participants. Recording a reviewer does not dispatch them or give them acceptance authority.

The complete submitted work-item list validates duplicates, employee identifiers, missing/self edges and cycles. Dependencies reference tasks in the same goal. Fan-in expresses dependencies on parallel upstream tasks. The HTTP update route verifies declared collaborators against current workspace employees; execution verifies their continued availability.

Removing a referenced task requires explicitly editing its incoming references first. Omitting relationship fields while editing an existing task preserves them, protecting against writers that do not know these new fields. Explicit empty arrays clear relationships. The merged plan is validated again under the existing goal edit lock; plan, graph and optimistic revision checks commit atomically.

## Readiness and scope

`GoalDetail.taskCollaborations` projects each task's explicit collaborators, direct predecessors and direct downstream references. Upstream evidence is resolved from current turn/delivery/acceptance projections, scoped to that goal and task. A task without relationships has empty lists.

| Readiness | Required evidence |
| --- | --- |
| `accepted` | Upstream plan status is done; latest eligible execution has a completed personal-session delivery; its exact position/turn/session/output digest matches the latest human acceptance; criteria match current goal criteria. |
| `manual_done` | Explicit manual done state with no task-bound execution or acceptance history. No delivery is invented. |
| `pending` | Work, output or current human acceptance is missing, or a newer attempt/criteria invalidated old acceptance. |
| `unavailable` | Execution evidence cannot be read. This never degrades into manual completion. |

Only accepted/manual-done direct predecessors permit execution. A new failed/running/unknown predecessor attempt blocks future launches even if the human-owned status still says done. Manual completion remains an explicit human plan fact. Readiness is a direct-dependency contract, not automatic cascading workflow acceptance.

Execution re-reads evidence before preparing the turn. Configured tasks cannot bypass the gate by omitting a briefing, using a bare turn, or using group dispatch. Group rejection occurs before durable acceptance. Unrelated legacy goal tags remain supported. A missing source/evidence read prevents the model call; no used snapshot is fabricated.

## Snapshot and budgets

The existing `TaskBriefingPayload` gains optional `collaboration`, with schema `task-collaboration.v1`: goal/task identity, capture time, participants, dependencies, downstream references, omission count and redaction facts. Each dependency may include execution status and an exact public delivery reference: employee, turn, session, output digest, completion time, filtered excerpt and excerpt digest. Accepted dependencies retain acceptance ID/time. It contains no resource grants, private session history or model reasoning.

Public output filtering occurs before UTF-8 shortening. Each excerpt is at most 2 KiB. At most eight direct downstream references enter the view/snapshot; an explicit count records remaining direct downstream tasks. Dependency requirements and participant instructions are not silently omitted: the existing 48-KiB required-briefing cap rejects oversized input.

Canonical payload serialization is both injected and saved in the running record before model execution. The total remains within the existing 64-KiB context and 256-KiB input budgets. Dependency delivery identities reserve slots in the shared 12-source limit and are deduplicated against optional history. Deduplication is not counted as omission.

Readers validate exact fields, limits, timestamps, source/excerpt digests, readiness semantics, unique sources, parent goal/task/time/employee linkage and context source counts. Existing snapshots without collaboration remain valid. Hashes provide consistency, not authenticity or business approval.

## Refresh and review

Current UI state reuses goal/turn events, reconnect refresh, explicit refresh and the existing periodic project refresh. It exposes observed-at time and source-session navigation. Started executions retain their captured input; events never silently rewrite it. Later launches, explicit retries and approval resumes refresh dependencies while retaining their existing task/plan binding checks.

The task editor records responsibilities and dependencies; cards/schedule rows expose relation details and readiness. Unready or unverifiable dependencies disable Run, while the server remains authoritative against stale clients. The acceptance drawer keeps execution-time collaboration separate from current state and warns when they differ. Human criteria/output/version/idempotency checks remain in force; collaboration data does not auto-accept work.

## Verification and delivery

Contract/DAG tests; API validation, legacy-writer preservation and bypass tests; accepted/manual/unknown/new-attempt readiness; source deduplication and shared budgets; running/terminal/reopened snapshot equality and tampering; editor, source navigation, snapshot/current-state distinction and reconnect tests. Browser QA uses real project components, local control-plane HTTP/SSE and a deterministic driver at desktop/narrow widths, not a live-provider quality claim. Required check results and native CI coverage are recorded on the PR.

Deploy matching server, IPC and renderer. Optional fields preserve current-reader compatibility, but older strict readers can reject new records. Revert code to roll back and use pre-upgrade backups or separate workspaces when downgrading. Do not erase historical snapshots to fabricate compatibility.
