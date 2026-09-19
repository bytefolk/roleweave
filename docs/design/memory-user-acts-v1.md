# User remember / correct / forget acts v1

Status: **design proposal only**. Requirement:
[#348](https://github.com/bytefolk/roleweave/issues/348). Related: #327, #328,
#355, mem [#220](https://github.com/bytefolk/mem/issues/220).

**No runtime, HTTP, SQL, or UI in this change.** Payloads here are candidates.
They are not an extension of a consumed `durable-memory.v1` revision until
[#327](https://github.com/bytefolk/roleweave/issues/327) Gate D0 is accepted.

This file revises the AC-001/AC-002 draft on the issue (waterbro-8, 2026-09-18):
untrusted recall, write ≠ admitted, append-only supersession, server-derived
provenance, no implicit supersede.

## What this issue owns

The **user-authored write path**: intent, confirmation, supersession of a
wrong derived memory, and the refusal to treat chat residue as a pin.

[#327](https://github.com/bytefolk/roleweave/issues/327) owns lifecycle and
receipts. [#355](https://github.com/bytefolk/roleweave/issues/355) owns the
workbench controls. This file specifies the **acts** those controls submit.

## Invariants

1. Recalled text is `trust: "untrusted"` and `authority: "none"`. User
   provenance is not a tool, identity, or permission grant (REQ-004).
2. A write response reports **created/stored** only. `admitted` / `omitted`
   appear only on the **next real assembly receipt**. UI must not show
   “memory used” before that receipt.
3. Old records are **immutable**. Correct appends a new memory plus a
   supersession **relation/event**. A projection view omits the old record by
   default. Do not PATCH the old row to `status: superseded`.
4. `provenance` is **server-derived** from the authenticated, authorized user
   act. Clients must not self-report `"provenance": "user"`.
5. Supersession exists only after an explicit `correct` with
   `targetMemoryId`. Text clash between derived and user records is ranking /
   omission, not an audit-chain rewrite.
6. Forget is mem’s permissioned lifecycle. RoleWeave must not fake-delete
   locally. Failure is a visible error.

## Principals (aligned with #364)

`employee-private` is **not** a reusable seat. [#364](https://github.com/bytefolk/roleweave/pull/364)
pins:

| `scopeClass` | Request identity | mem principal (when stored) |
| --- | --- | --- |
| `employee-private` | `hireId` (issued at hire, **never reissued**) | `employee.<hire_id>` |
| `position` | `positionId` (reusable seat) | `position.<position_id>` |

**mem#221 as shipped** only fail-closes on `position.<id>` +
`/workspaces/<instance>/positions/<position_id>`. `employee.<hire_id>` and
`/workspaces/<instance>/employees/<hire_id>` are a **later additive** mem
contract. Until that lands, RoleWeave must not persist private notes as
`position.sales-owner` and call them private. A later occupant of the same
seat must not see hire A’s private records.

Client remember/correct/forget for `employee-private` sends `hireId`, never
`positionId`.

## AC-001 — Remember flow (example, no secrets, no real PII)

Operator confirms “Acme accepts email only” for hire `hire_a` (currently
seated at sales-owner; the seat is **not** the isolation key), then submits
Remember. Chat residue without that act is not a pin.

**Request** (client does not send provenance):

```json
{
  "schemaVersion": "memory-act-request.v1",
  "act": "remember",
  "hireId": "hire_a",
  "scopeClass": "employee-private",
  "content": {
    "text": "Customer Acme accepts email only.",
    "format": "plaintext"
  },
  "citation": {
    "turnId": "turn-20260918-0042",
    "sessionId": "sess-abc123"
  }
}
```

**Write response** (`created`, not `admitted`):

```json
{
  "schemaVersion": "memory-act-result.v1",
  "act": "remember",
  "outcome": "created",
  "memoryId": "22222222-2222-4222-8222-222222222222",
  "digest": "sha256:a4a76f15fd79a253891d86cf5c9fbf0caba45dd436aedf8834fee457ee8f7267",
  "createdAt": "2026-09-18T14:30:00.000Z"
}
```

`digest` is SHA-256 of `content.text` UTF-8 bytes (same rule as mem
durable-memory.v1). Forbidden on this response: `status: admitted`,
`used: true`, `trust: trusted`.

## AC-001 — Correct flow

Operator names the wrong derived record and submits Correct.

**Request:**

```json
{
  "schemaVersion": "memory-act-request.v1",
  "act": "correct",
  "hireId": "hire_a",
  "scopeClass": "employee-private",
  "targetMemoryId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "content": {
    "text": "Customer Acme accepts email only (not phone).",
    "format": "plaintext"
  },
  "citation": {
    "turnId": "turn-20260918-0050",
    "sessionId": "sess-abc123"
  }
}
```

**Write response** (new record + append-only relation; old row untouched):

```json
{
  "schemaVersion": "memory-act-result.v1",
  "act": "correct",
  "outcome": "created",
  "memoryId": "33333333-3333-4333-8333-333333333333",
  "digest": "sha256:d942f4c0037e91b59589391726ff4a8cb3a31248097560ea722c0b25b6666dc3",
  "relation": {
    "kind": "supersession",
    "relationId": "rel-0001",
    "fromMemoryId": "33333333-3333-4333-8333-333333333333",
    "toMemoryId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "relationship": "corrects"
  },
  "createdAt": "2026-09-18T14:35:00.000Z"
}
```

The derived record `aaaaaaaa-…` stays byte-identical. A projection marks it
omitted-by-default because of `rel-0001`.

Relation direction (do **not** PATCH the old row):

| Field | Value | Meaning |
| --- | --- | --- |
| `fromMemoryId` | **new** record (`3333…`) | The correcting write just created |
| `toMemoryId` | **old** record (`aaaa…`) | Immutable target; bytes unchanged |

Edge: `new ──corrects──► old`.

## AC-002 — Append-only supersession model

```
new user record ──relation/event──► old record (immutable)
     created                         unchanged bytes
     fromMemoryId                    toMemoryId
```

| Scene | Behavior |
| --- | --- |
| user corrects derived | New record + relation. Old derived unchanged. Projection omits old. |
| user corrects user | Same. Chain is the relation list, not a mutated field on the old row. |
| derived vs user text clash | **No** relation. Recall ranks; receipt may omit with `ranked_below_user`. |
| forget | mem permissioned forget; RoleWeave shows failure if mem fails. |
| handoff | Copy memoryId + digest only if the successor already has a grant (#328, #349). |

## AC-003 — Next assembly receipt (not the write response)

Only the **next** turn’s receipt may say admitted/omitted.

```json
{
  "schemaVersion": "recall-receipt.v1",
  "turnId": "turn-20260918-0051",
  "hardBudgetBytes": 262144,
  "admittedBytes": 420,
  "selected": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "reason": "user_correct",
      "bytes": 420,
      "trust": "untrusted",
      "authority": "none"
    }
  ],
  "omitted": [
    {
      "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "reason": "superseded_by:33333333-3333-4333-8333-333333333333"
    }
  ],
  "degraded": false,
  "unavailable": false,
  "digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

UI counts **must** equal `selected.length` and `omitted.length`. If
`unavailable` is true or recall was skipped, the UI must not display
“memory enabled and used”.

## Forget act

```json
{
  "schemaVersion": "memory-act-request.v1",
  "act": "forget",
  "hireId": "hire_a",
  "scopeClass": "employee-private",
  "targetMemoryId": "33333333-3333-4333-8333-333333333333"
}
```

Success is mem’s ack. On deny/unavailable:

```json
{
  "schemaVersion": "memory-act-result.v1",
  "act": "forget",
  "outcome": "failed",
  "error": "forget_denied",
  "localFake": false
}
```

Workbench must show this as failure (#355).

## Gate

| Gate | This file |
| --- | --- |
| Now | Design proposal. Not a consumed #327 schema. |
| D0 | Product owner accepts #327 R1. Still no RoleWeave runtime. |
| D2/D3 | Runtime + live receipt evidence. Fixtures do not substitute. |

## Non-goals

Full compaction UI, vector ranking, Sales Workbench, closing #143, treating
chat residue as a pin, in-place edits, client-supplied provenance.
