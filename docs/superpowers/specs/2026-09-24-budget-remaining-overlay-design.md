# Pre-send budget-remaining advice overlay (#462)

## Goal and invariants

Add an optional, workspace-scoped advisory strip beside the existing composer Send control. The strip presents deterministic remaining token facts for the selected employee and, only when both facts are known, may ask local Laya to choose one of `shrink`, `switch_employee`, or `send_anyway`.

The feature is off by default. It must not change hire-time caps, organization data, `assertBudgetScope`, turn envelopes, turn requests, or the existing Send action. Applying a suggestion changes only ephemeral, unsent composer state. It never starts a turn, silently reduces a budget, changes employee selection, or bypasses `perTask <= perDay`.

## Existing fact boundary

RoleWeave's persisted report contract currently proves only:

- the employee's declared `perTask` and `perDay` caps;
- exact usage of the latest persisted turn, which can support a per-task token remainder; and
- lifetime recorded usage, which is not a daily bucket.

`docs/api-contract-v0.md` and `BudgetDashboard.tsx` explicitly state that there is no per-day time-bucket fact and that the UI must not reuse a per-task ratio for the daily lane. Upstream digital-employee accepts a caller-provided, bounded `dayKey`, but does not define a UTC or local calendar boundary that RoleWeave can reconstruct. RoleWeave also does not persist that `dayKey` with its turn records.

Therefore this change must project `remainingPerDay` as unknown until a separate authoritative daily ledger contract exists. It must not sum records by `createdAt`, treat lifetime `recorded.totalTokens` as today's use, invent a day boundary, or read an unrelated engine-internal file. Because advice requires both remainders, the current production path abstains whenever the daily fact is unknown. This limitation is visible and intentional.

## Considered approaches

1. **Add an honest, forward-compatible fact and advice boundary (selected).** Compute the per-task remainder from the latest persisted turn when a token cap exists, carry the daily remainder as unknown, show the deterministic facts, and abstain before Laya unless both are finite non-negative integers. This ships the safe UI and contract without fabricating data; a future authoritative daily projection can activate advice without changing the Laya payload.
2. **Infer daily use from turn `createdAt`.** This could activate suggestions immediately, but it would invent timezone and day-boundary semantics and contradict the frozen reports contract. It is rejected.
3. **Add daily accounting to turn execution in the same PR.** This would require changing the turn envelope, defining and persisting `dayKey`, migrating existing records, and reconciling all personal/group/retry paths. That is a separate execution-accounting feature and is out of scope for this composer overlay.

## Components and data flow

1. A pure server projection reads the selected role and persisted turn reports. It computes `remainingPerTask = max(0, perTask.tokens - latestTurn.totalTokens)` when both operands are authoritative; otherwise it returns unknown. `remainingPerDay` remains unknown under the current report contract.
2. A dedicated authenticated control-plane route accepts only the current workspace path/session/revision and `positionId`. The renderer cannot upload remaining values, caps, usage, composer text, turn text, or a chosen action.
3. The route re-reads workspace experiment consent and the selected role from the open workspace. Disabled consent returns `disabled`; a missing remainder returns `abstained` without calling Laya.
4. When a future authoritative source supplies both remainders, Laya receives exactly `{ remainingPerTask, remainingPerDay, positionId }`, all finite non-negative integers, plus one Choice question with exactly `shrink`, `switch_employee`, and `send_anyway`.
5. The response always returns the server-derived fact snapshot. A valid suggestion is projection-only. Unknown options, missing or extra probability keys, non-finite/out-of-range values, inconsistent selected probability, confidence below `0.6`, provider failure, changed consent, or a stale workspace revision all fail closed.
6. The renderer binds every request to the employee and workspace snapshot that initiated it. Switching employee/workspace or changing experiment revision invalidates a late response. Choosing or applying an option updates only a local unsent selection; it does not invoke `createTurn`, `/turns`, org mutation, hire mutation, or employee selection.

## Contracts and UI states

- Shared request and response types are additive and expose a dedicated budget-advice route.
- The deterministic fact uses nullable remainders so unknown is explicit and cannot be confused with zero.
- Advice status is one of `ready`, `disabled`, `abstained`, or `unavailable`, with finite reason codes.
- Flag off keeps the composer DOM and direct-send behavior unchanged.
- Flag on shows the compact fact strip. The current production state displays known per-task remainder when available, marks daily remainder unavailable, and displays no Laya suggestion.
- A valid future suggestion is labelled as not adopted until the user applies it. Applying `switch_employee` does not switch the employee automatically; it only records that unsent local choice so the operator remains in control.
- The existing composer draft is never read by the advice request and never leaves through this path.

## Error handling and privacy

- Malformed or extra request fields reject before fact lookup or inference.
- Missing role, stale workspace/session/revision, changed consent, storage corruption, and invalid provider output fail closed.
- Provider timeout or failure does not block the existing Send action.
- No task text, draft, turn body, attachment, path, employee name, cap, raw usage event, or report record is sent to Laya.
- The server never accepts client-supplied remaining values and clamps a proven overrun to zero instead of emitting a negative remainder.

## Verification

Tests are written in red-green order for:

- server projection of a finite per-task remainder, explicit unknown daily remainder, no negative values, and missing token-cap handling;
- abstention before inference whenever either remainder is unknown;
- exact outbound Laya payload and exact Choice vocabulary with injected fully known facts;
- rejection of extra fields, non-finite confidence/probabilities, incomplete/extra probability maps, low confidence, inconsistent selection, and unknown choices;
- preload and main-process IPC exact-key validation;
- renderer flag-off DOM parity, deterministic fact display, clicking/applying without sending, and late-response invalidation after employee/workspace changes;
- unchanged hire validation, budget schema, turn request, and turn envelope through existing regression suites and diff review.

## Implementation sequence

1. Add shared additive contracts and pure server fact/advice functions.
2. Add exact request validation and the authenticated server route behind existing workspace experiment consent.
3. Add exact-key main/preload IPC wiring.
4. Add the renderer strip behind the existing workspace flag with snapshot invalidation.
5. Run focused red-green tests, then full server, IPC, renderer, desktop-main, build, and package-layout verification.
