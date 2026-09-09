# Continuing work with an AI team

This source change implements [#214 R1](https://github.com/bytefolk/roleweave/issues/214) and the local context decision in [#143 R3](https://github.com/bytefolk/roleweave/issues/143#issuecomment-5582885932). It is not included in the v0.1.1 installers.

## Continue a conversation

Select an employee, give them the project background and a first task, and wait for a completed response. Send a follow-up in the same session. The server includes a bounded selection of earlier completed requests and visible answers in the next model input. Reopening the workspace preserves these local records.

Session settings contain a context switch. It is on by default, including for existing sessions; switching it off persists for that session. A fresh session starts without the previous session's history. A running personal or group task prevents that employee's session from being rotated or its context setting from changing.

The context receipt shows the source count, actual UTF-8 bytes, digest, and a short excerpt of the data selected for the latest turn. These are measured input bytes, not a claimed model tokenizer count. An empty or disabled window displays zero. Older records without a receipt cannot establish what their model received.

Context is limited to 12 source turns and 64 KiB including its framing; individual input and answer excerpts are limited to 8 KiB. The current request remains intact within the existing 256 KiB total input boundary. The first completed background and newest completed results have priority; the receipt exposes omitted or truncated data. This is bounded task continuity, not unlimited recall of every earlier detail.

Only visible answer fields from trusted completed turns qualify. Failed, interrupted and running output does not become a previous successful answer. Recognizable credentials and private reasoning are filtered from complete selected fields before byte truncation; this is best-effort sanitization, not a guarantee that arbitrary sensitive prose can be recognized. Context is sent to the configured AI host as task data. The host's existing role instructions, tool permissions and approval gates still apply.

## Assign independent tasks

Send the weekly report to employee A, select employee B and send the analysis task, then select employee C and prepare the customer reply. The employees can run concurrently. Switching employees preserves each conversation's pending task and draft, and a late result belongs to the employee/session that produced it.

One employee has one active execution per workspace. A second overlapping assignment to that employee reports a conflict instead of replacing the running process. Cancel retains the original workspace and, once known, the turn identity, so navigation cannot retarget it to another workspace or a later turn. Selecting an idle employee does not start a model process or consume model tokens.

## Run a parallel group or an ordered relay

Create a group and explicitly select the employees that should receive the request. Choose parallel mode to start their independent turns together.

Choose relay mode for a draft-to-review flow. The selected employee order is the execution order. The next employee receives the same original task plus a bounded, sanitized excerpt of the predecessor's trusted completed result. Include the intended stages in the task, for example: “The writer drafts the report; the reviewer checks accuracy and returns the final version.” Each employee retains its own role and permissions.

If a predecessor fails, is cancelled, or ends without a trusted terminal, the remaining steps are recorded as blocked without calling those employees. Accepted group spawn identities and terminal records support timeline readback after a reconnect. Restart does not automatically retry a model call or replay an unfinished relay.

Assignment is explicit. This change does not add role-based automatic matching, a durable background queue, scheduled work, cross-device workers, or long-term memory storage in `mem`.

## API and compatibility

- `PATCH /sessions/:sessionId/context` accepts exactly `{ "enabled": true }` or `{ "enabled": false }` and returns the updated `workbench-session.v1`. The optional `threadContextEnabled` field defaults to `true` when absent in older records.
- `POST /groups/:conversationRef/turns` accepts optional `mode: "parallel" | "relay"`; omitted mode means parallel. The `mentions` array is the explicit recipient/relay order.
- `turn-record.v1` may include a `threadContext` receipt (`thread-context.v1`). The original operator `input` remains separate from the materialized model input.
- The existing sealed `turn-envelope.input` carries the versioned historical data block; its digest covers what the engine receives. No upstream envelope schema or provider session contract is added.
- All new settings and receipts use the existing workspace-local stores and validation boundaries. No database migration or direct `mem`/`context` database access is involved.

Rollback requires reverting this source change and retaining a workspace backup. Older strict readers may reject records with the new optional fields; do not edit durable records by hand to simulate a successful rollback. New sessions in a separate workspace can be used to test an older application version.
