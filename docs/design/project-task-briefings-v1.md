# Project task briefings v1

Tracking: #619, follow-up to #617/#618. Phase 2a of the collaborator-context roadmap covers project delegation requirements and their inspection during human review. It uses existing goal work items, sessions, turns and human acceptance. Agent reviewer dispatch, task-board execution, participants/dependencies and live coordination remain future slices.

## Contract and authority

Project Run adds `taskBriefing: { expectedWorkspacePath, expectedUpdatedAt }` to the existing personal-session turn request, alongside `goalId` and `branchId` (work item ID). It sends no client-authored snapshot. HTTP and desktop IPC share an exact-fields validator.

The server binds the request to the captured open workspace, loads the goal, compares its exact revision, resolves the work item and checks that the recipient is still the assignee. Missing goals, removed tasks, changed revisions/assignees and wrong workspaces fail before model execution. Older callers without the opt-in retain existing goal-tag semantics; bare and group routes do not accept it. A rejection is never retried by dropping requirements.

## Snapshot and input

`TurnRecord.taskBriefing?: TaskBriefingSnapshot` contains:

- `payload`: `task-briefing.v1`, generation and plan timestamps, goal/task/turn/session/employee identities, goal title/description, task title/description, ordered acceptance criteria and redaction flag;
- `payloadBytes` and `payloadDigest`: UTF-8 length and SHA-256 of canonical payload serialization.

Canonical serialization sorts object keys recursively and preserves array order. Relay handoffs use the same helper without changing their bytes. Hashes detect consistency errors; they are not signatures or proof of business correctness.

Recognizable credentials and private reasoning markers are filtered using the existing context sanitizer. There is no model summarization call. Requirements and criteria remain whole after filtering: a serialized payload exceeding 48 KiB fails explicitly and asks for a shorter plan. An incomplete checklist is never silently substituted.

The rendered mandatory briefing is reserved before optional history. Both share the existing 64-KiB context and 256-KiB final-input limits, including JSON escaping, response presentation, attachments and vault content. Disabling optional conversation history does not disable an explicitly requested briefing. The same serialized payload appears in the sealed input and running record; storage precedes model execution. Original user input remains unchanged in `TurnRecord.input`.

Readers validate exact fields, sizes/counts, timestamps and hashes, then enforce parent turn/session/goal/task/employee/time and context-receipt linkage. Terminal records retain the running snapshot. Reopening a workspace reads it rather than regenerating from the latest goal.

## Retry, approval and review

Explicit retries inherit the source snapshot's goal/task/plan binding. They cannot change it, invent a briefing for an unbound historical retry, or silently drop it. The server reloads and validates the plan; changes require a fresh launch. Approval and atomic batch resumes carry the same binding. A changed plan prevents model execution and the existing approval machinery records the failure.

The latest eligible completed delivery projects its briefing alongside the exact output/session/digest reference. Personal conversations and the human acceptance drawer show an expandable, bounded text-only view. The drawer preserves execution-time requirements, warns when the project revision differs and keeps current human-review criteria separate. Historical deliveries without a snapshot remain reviewable and explicitly state that it is unavailable.

Human acceptance remains authoritative: output digest, current criteria, workspace/revision checks, idempotency and operator verdicts are unchanged. Briefings grant no acceptance, capabilities, resource access or budget.

## Validation and delivery

- Pure tests: request contract, injected bytes, mandatory-context priority, escaped/UTF-8 budgets, complete criteria or explicit rejection, filtering, tampering and parent linkage.
- Controlled-driver API tests: running/completed/reopened equality; plan edits leave old snapshots intact; stale/missing/foreign requests never call the model; retries and approval resumes retain bindings and reject changed plans.
- IPC and renderer tests: launch metadata, no conflict fallback, personal adapter, expansion/collapse, current vs execution criteria, historical delivery compatibility.
- Browser QA: actual project Run → saved delivery → human review using production components/CSS and a deterministic local control plane, with desktop/narrow screenshots. Live-provider quality and native OS packaging are distinct checks.
- Explicit runtime packaging inventory; repository checks and CI results recorded on the PR. No coverage percentage is claimed.

Deploy matching renderer/IPC/server. Older strict readers may reject new records. Revert code to roll back and use pre-upgrade backups or separate workspaces when downgrading; do not delete historical evidence to fabricate compatibility.

## Remaining roadmap

Phase 2b: dispatch an employee to review a pinned delivery version, with original criteria and source references while final acceptance stays with the human. It needs a separate review-attempt identity so review output cannot become the implementation delivery.

Phase 3: participants and responsibilities, upstream/parallel dependencies, scoped state/artifact indexes, defined refresh and notification behavior. These remain necessary for every task to support collaborator context; project briefings alone do not claim that coverage.
