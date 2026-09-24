# Send-time human-gate advice overlay (#461)

## Goal and invariants

Add an optional, workspace-scoped advisory step beside the existing composer Send control. It shows the selected employee's deterministic persisted mode and can ask local Laya whether to keep it or suggest `approval_required` for this send.

The feature is off by default. It must not change the turn request, turn envelope, `dont_ask`, the persisted `PositionMode`, approval policy, or the existing Send action. Applying a suggestion only changes an ephemeral composer control. Sending remains an explicit click on the existing Send button.

## Considered approaches

1. **Extend the existing workspace experiment consent and IPC path (selected).** This reuses revision-bound workspace consent, loopback-only Laya configuration, cancellation on workspace changes, and the enumerated preload bridge. It adds the least new authority and fails closed with existing settings.
2. **Add an environment-only flag.** This is simpler on the server, but the renderer cannot explain or revoke workspace consent and would need a second status mechanism.
3. **Call Laya from the renderer.** This would bypass the control-plane trust boundary and duplicate endpoint validation, timeout, and response checks, so it is rejected.

## Data flow

1. `TurnPanel` reads the existing workspace experiment snapshot. When it is disabled, unavailable, stale, or the selected position profile has no authoritative mode, the new overlay is absent.
2. When enabled, a compact advisory control shows the rule fact (`read_only` or `approval_required`) and opens a separate task-summary confirmation surface. The summary field is independent of the composer textarea; code must never initialize it from or read it from the draft.
3. Confirmation calls the enumerated preload/IPC method with workspace path/session/revision, `positionId`, and an explicitly confirmed `taskSummary`. The renderer does not send `mode` as authority.
4. The server validates the exact request shape, re-reads the current role and mode from the open workspace, re-checks workspace experiment consent, and sends Laya only `{ positionId, mode, taskSummary }`. Without a confirmed summary it returns an explicit abstention without invoking Laya.
5. Laya receives one Choice question with exactly `keep` and `approval_required`. Unknown options, malformed probabilities, confidence below the conservative threshold, timeout, disabled consent, or changed workspace state all abstain or fail closed.
6. A valid suggestion is projection-only. Selecting it updates local composer state and never invokes `createTurn`, `/turns`, a session turn endpoint, org mutation, or approval mutation.

## Contracts and UI states

- Shared request/response types are additive and expose a new control-plane route dedicated to send-gate advice.
- The response always carries the authoritative rule fact. Advice status is one of `ready`, `disabled`, `abstained`, or `unavailable`; reasons are finite codes.
- The workspace experiment disclosure adds the send-gate base fields (`positionId`, `mode`) and separately identifies `taskSummary` as per-request opt-in data.
- Flag off keeps the composer DOM and behavior unchanged.
- Before task-summary confirmation there is no Laya request and no recommendation.
- A differing valid suggestion is labelled as not adopted until the user applies it. Applying it does not send the turn.
- Changing employee, workspace, or confirmed summary invalidates any previous suggestion and local prefill.

## Verification

Tests are added in red-green order for:

- exact shared/server request validation and authoritative mode lookup;
- flag-off, missing-summary, low-confidence, invalid-choice, timeout, and stale-workspace abstention;
- the outbound Laya payload allowlist and absence of composer/turn bodies;
- preload and main-process IPC exact-key validation;
- renderer flag-off parity, separate summary confirmation, stale-result invalidation, not-adopted display, and applying without posting a turn;
- unchanged turn envelope, `dont_ask`, and `PositionMode` behavior through existing regression suites and diff review.

