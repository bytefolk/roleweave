# Relay handoff notes v1

Tracking: #617. Scope: explicit step requirements and traceable handoff data for sequential groups. Full task-level collaborator context, parallel dependency coordination, and delegation are separate future work.

## Data and authority

`GroupMessage.relaySteps?: { positionId: string; instruction: string }[]` records operator-authored requirements. `mentions` owns ordering. HTTP, desktop IPC and storage share the `@roleweave/shared/relay-steps` validation contract: relay-only, selected recipients, unique entries, exact fields, 4 KiB per instruction and 32 KiB aggregate UTF-8. Empty arrays are omitted; blank entries are rejected. The request must also fit the existing 1-MiB serialized HTTP-body limit.

The accepted message and per-member engine/spawn identities are persisted before 202. Only the group executor constructs `RelayExecutionContext`; clients cannot supply source output, digests or generated identities. Every source must match a completed predecessor from this message, in accepted order and in the same conversation. An employee's role does not imply instructions, acceptance, resource access or budget transfer.

## Payload

`TurnRecord.relayHandoff` contains `payload`, `payloadBytes` and `payloadDigest`. Its versioned payload contains:

- `schemaVersion: "relay-handoff.v1"`, generation timestamp, conversation/message/turn identities;
- `step: { positionId, number, total, nextPositionId? }`;
- `taskExcerpt` (at most 2 KiB) and `instruction` (explicit requirement or null);
- `sources: [{ turnId, positionId, sourceUpdatedAt, outputExcerpt, excerptDigest, truncated, redacted }]`;
- `omittedSourceCount`, `taskExcerptTruncated`, and `redacted`.

Timestamps identify recorded execution data, not acceptance. A result may have no visible text. Sources retain separate excerpts; there is no inferred list of business blockers or automatic resolution of contradictory conclusions.

`serializeRelayHandoff` sorts object keys recursively, retaining array order. `excerptDigest` covers the filtered excerpt. `payloadDigest` covers precisely the canonical payload bytes inserted into the input. Existing thread-context and envelope digests continue to cover their larger respective scopes. Digests provide consistency evidence, not signatures or proof of business accuracy.

## Assembly

1. Capture the accepted message, recipient and prior completed sources.
2. Remove current relay predecessor identities from ordinary group-history candidates before history compaction. A source omitted from the relay cannot re-enter through history.
3. Filter recognizable credentials and private reasoning from public answer fields before shortening them. Carry truncation/redaction facts through the compact projection.
4. Reserve the task excerpt, identity/order fields and the complete filtered requirement. Prefer the immediate predecessor, then recent preceding steps, then ordinary history.
5. Use one shared 64-KiB serialized context budget and 12 unique-source limit; the complete input, including existing presentation/vault content, remains within 256 KiB. Account for JSON escaping, wrappers and UTF-8 boundaries.
6. If necessary, shorten the immediate predecessor excerpt to fit. Reject if required framing cannot fit or a non-empty immediate predecessor would disappear entirely. An originally empty public answer remains explicitly empty.
7. Return the final input, receipt and snapshot from the same assembly. The current original request remains intact in the existing request section and durable `TurnRecord.input`.

Deduplication does not count as omission. Source omissions do; the snapshot counts omitted relay sources and the existing receipt accounts for relay plus ordinary history. A first step can have positive context bytes with zero source turns because order and operator requirements are present.

## Execution and recovery

Write the running record with snapshot before calling the driver. Storage failure prevents the call. Terminal records preserve the snapshot rather than regenerating it. Reading validates exact fields, identities, timestamps, source counts, byte counts and hashes, including linkage to the parent turn and context receipt.

A pre-execution relay input/budget rejection becomes `group_handoff_invalid` with a durable reason. Later steps use existing relay blocking. Cancellation, owner-confirmed stop, workspace switching and restart retain the existing non-replay behavior. An unstarted step has no invented used snapshot. Explicitly submitting a new relay creates new identities; this feature does not add group retry.

## Desktop and packaging

The existing group IPC channel forwards `relaySteps`. Group drafts retain step requirements per group; only selected recipients are submitted, and switching to parallel omits them. Acceptance clears only the submitted draft identity, preserving edits made while awaiting the response.

The timeline reads the saved snapshot through the existing turn adapter. The details component lazily renders bounded text, source identities, timestamps and limits. It does not grant access to arbitrary file paths found in output. New runtime modules and the shared CommonJS validator are included in the explicit desktop packaging allowlist.

## Compatibility and rollback

Both new fields are optional for new readers. Older strict readers can reject new records. Deploy the renderer, desktop IPC and server together. Do not retry against an older server by silently dropping requirements. Retain workspace backups; a downgrade should use a pre-upgrade backup or separate workspace rather than deleting historical snapshot fields.

## Verification

- Pure assembly/validator tests: source deduplication, accepted identities, first/last steps, public output filtering, 32-member relay, shared budgets, escaped data, UTF-8, missing space and tampered snapshots.
- Controlled-driver API tests: exact persisted/injected payload, original task preservation, instruction validation, no replay after restart, and durable pre-execution budget failures.
- Existing group/failure/cancel/stop/workspace-switch tests remain applicable.
- Renderer tests: requirement submission, byte limits, parallel-mode isolation, snapshot expand/collapse and absent instructions.
- Repository checks and packaged runtime inventories; browser validation uses deterministic renderer fixtures and is separate from real-provider quality evaluation.
