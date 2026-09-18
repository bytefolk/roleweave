# Memory grants v1 — private / position / team

Status: **design proposal only**. Requirement:
[#349](https://github.com/bytefolk/roleweave/issues/349). Related: #328, #356.

**No runtime, HTTP, SQL, or UI in this change.** Fixtures in this file do not
substitute for later live E3 receipts.

## Baselines (what is and is not accepted)

| Artifact | Status | How this file uses it |
| --- | --- | --- |
| mem `durable-memory.v1` | **Merged** in [mem#221](https://github.com/bytefolk/mem/pull/221), merge commit [`e0e47c7f4ee09bb2a18d0e25794af3ff59a03491`](https://github.com/bytefolk/mem/commit/e0e47c7f4ee09bb2a18d0e25794af3ff59a03491). Schema: `docs/schemas/durable-memory.v1.schema.json`. Decode requires `binding.principal == position.<position_id>` and `memory_scope` `/workspaces/<id>/positions/<position_id>`. | **Pinned.** `position` class maps 1:1 onto this contract. |
| RoleWeave [#327](https://github.com/bytefolk/roleweave/issues/327) Gate D0 | **Not accepted.** | Constraint and vocabulary only. This file is not a consumed #327 revision. |
| RoleWeave [#345](https://github.com/bytefolk/roleweave/pull/345) | **Open, not accepted.** | Same. Do not treat #345 schemas as RoleWeave baseline. |

`employee-private` as “only that hire” **cannot** be expressed on mem#221 as
shipped: that contract’s only fail-closed principal is a **reusable seat**
`position.<id>`. Shipping employee-private therefore needs a **later additive
mem contract** (proposed below). It is not silently in `e0e47c7`.

## workspaceId vs memoryScope

These are **different UUID namespaces**. They must not be required to match.

| Field | Owner | Meaning |
| --- | --- | --- |
| `binding.workspace_id` | **mem** workspace | Tenant/isolation key inside mem. Cross-workspace probes are `out_of_scope`. |
| `memory_scope` prefix `/workspaces/<instance>/…` | **digital-employee** workspace instance | Virtual path for MemoryPort. `<instance>` is not mem’s workspace id. |

A record is in-scope only when **both** the mem workspace id **and** the
canonical `memory_scope` string equal the caller’s. Matching one UUID and
guessing the other is malformed.

## What mem#221 can already isolate

Fail-closed tuple:

1. mem `workspace_id`;
2. position principal `position.<position_id>` (seat; **reused across hires**);
3. `memory_scope` `/workspaces/<instance>/positions/<position_id>`;
4. one grant row: `grant_id`, `grant_version`, `permission_digest`, `revoked_at`.
   `grant.mode` is `read`. There is **no** membership list on the row.

Recall compares the **caller’s** workspace + principal + `memory_scope` to that
tuple. Pin does not enlarge it. Out-of-scope and malformed probes return an
**empty** receipt (no `memory_id`, locator, grant block, or readback).

## Grant classes (REQ-001)

| class | Who may recall | Maps onto mem#221 today? |
| --- | --- | --- |
| `employee-private` | **Only the writing hire**, forever. A later occupant of the same seat must not see it. | **No.** Needs additive principal `employee.<hire_id>` (below). |
| `position` | Current occupant of seat `position.<id>`, **re-evaluated at recall**. | **Yes.** One durable-memory.v1 record / grant as shipped. |
| `team/task` | Explicit members of a task or team. | **Not as `task.<id>` / `team.<id>` principals.** Expand to **N mem grant rows**, one per member principal (below). |

Default for **new derived records** is `employee-private` (once the additive
principal exists). Until then, RoleWeave must not persist private notes as
`position.*` and call them private.

### Additive mem principal for a hire (employee-private)

Stable id: `hire_id` issued at hire, **never reissued** after dismiss.

Proposed mapping (future mem additive; not in `e0e47c7`):

| Field | Value |
| --- | --- |
| `binding.principal` | `employee.<hire_id>` |
| `binding.position_id` | omitted or a new required `hire_id` field — **must not** equal a reusable seat id |
| `memory_scope` | `/workspaces/<instance>/employees/<hire_id>` |

Fail-closed: caller principal must equal `employee.<hire_id>` and `memory_scope`
must already be that canonical path. Occupying `position.issue-researcher`
after A is dismissed does **not** match A’s private binding.

Until mem accepts that additive, RoleWeave #349 runtime is blocked on **both**
Gate D0 **and** that mem revision. This document does not pretend it already
landed.

### team/task without a new mem principal (grant-row expansion)

Do **not** introduce `task.<id>` or `team.<id>` as `durable-memory.v1`
principals. mem#221 has one principal per record and no membership field.

**Issue-time expansion:**

1. Source of membership: the Task or team roster **at grant-issue time**
   (RoleWeave control-plane snapshot). No inference from chat.
2. For each member, insert **one** mem grant row whose principal is that
   member’s **employee.*** (preferred) or **position.*** (only for
   `position`-class shares).
3. RoleWeave may store grouping metadata (`issued_for_task_id`) **outside**
   mem. mem never sees a member list.
4. Later roster joins do **not** mint rows. Later leaves **revoke** that
   member’s row (`revoked_at`, `grant_version++`). Recall does not consult
   the live roster.

**Recall-time evaluation:** mem evaluates **that one row** against the caller.
If B never received a row, B is `out_of_scope` — same as any other
cross-principal deny. No “listed principals” inside a single grant tuple.

## Product grant object (RoleWeave metadata + mem row)

RoleWeave grouping (not a mem principal):

```json
{
  "schemaVersion": "memory-grant.v1",
  "class": "team/task",
  "issuedForTaskId": "task.fix-123",
  "memGrantId": "33333333-3333-4333-8333-333333333333",
  "memberPrincipal": "employee.hire_a",
  "issuedAt": "2026-09-18T12:00:00Z"
}
```

The mem row remains durable-memory.v1 (or the future employee additive).
`grant.mode` stays `read`. Forget stays mem `delete` + workspace role.

## Parallel implement + review (AC-001)

Workspace example `oss-maintainer`.

- Hire A: `employee.hire_a`, seated at `position.issue-researcher`
- Hire B: `employee.hire_b`, seated at `position.pr-gatekeeper`
- Task `task.fix-123` roster at issue time: A and B

| memory | writer | class | mem principal | B may recall? |
| --- | --- | --- | --- | --- |
| M1 private notes | A | `employee-private` | `employee.hire_a` | **no** (no row for B; empty receipt) |
| M2 seat checkpoint | A | `position` | `position.issue-researcher` | **no** (B’s caller principal is not that seat) |
| M3 review pack | A | `team/task` | **two rows**: `employee.hire_a` and `employee.hire_b` | **yes**, via B’s own row |
| M4 after A dismissed, C occupies researcher | C | — | cannot use A’s `employee.hire_a` rows | C does **not** see M1 |

M1 binding (illustrative; requires mem additive):

```json
{
  "contract": "durable-memory.v1",
  "memory_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "kind": "note",
  "binding": {
    "workspace_id": "11111111-1111-4111-8111-111111111111",
    "hire_id": "hire_a",
    "principal": "employee.hire_a",
    "memory_scope": "/workspaces/44444444-4444-4444-8444-444444444444/employees/hire_a"
  },
  "grant": {
    "grant_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "mode": "read",
    "grant_version": 1,
    "capability_grant": { "schema_version": "capability-grant.v1", "server": "mem" },
    "granted_at": "2026-09-18T12:00:00Z",
    "revoked_at": null
  },
  "lifecycle": "active",
  "trust": "untrusted",
  "authority": "none",
  "text": "I am not sure the flake is real; do not tell the reviewer yet."
}
```

`permission_digest` stays SHA-256 of
`(workspace_id, principal, memory_scope, mode, grant_version)` as in mem#221.

## Denial test (AC-002) — non-enumerable

Specified, not executed. Later E3 uses live memd. Fixtures do not substitute.

**Setup (test runner only):** persist M1 as A’s private record. The runner
keeps `memory_id` in **test-private** state. It is not given to B.

**Caller B:**

```
workspace_id = 11111111-1111-4111-8111-111111111111
principal    = employee.hire_b
memory_scope = /workspaces/4444…/employees/hire_b
```

**Expect, visible to B:**

- `EvaluateRecall` → `eligible=false`, `omit_reason=out_of_scope`
- Receipt is **empty**: no `memory_id`, locator, grant block, pin, or readback
- RoleWeave assembly **must not** list `{ id: M1, … }` to B. Omitted entries
  for unauthorized callers are either absent or use a **non-stable** token
  that is not M1’s id/digest (e.g. omitted-count only)
- Pin on M1 does not enlarge B’s permission

**Expect, visible only to the test runner:** admitted set does not contain the
runner’s private M1 id.

**Fail if:** B’s receipt, assembly omitted list, or handoff package contains
M1’s `memory_id` or content digest. Existence of A’s private memory must not
be enumerable by B.

## Handoff copies authorized refs only (AC-003 / REQ-003)

#328: successor Position / hire is **re-evaluated at recall**. Handoff must
not mint grants and must not leak unauthorized identities.

Allowed in the handoff package:

- Artifact refs B can already read
- Memory refs for which B **already has** a mem grant row at pack time
  (e.g. M3’s `employee.hire_b` row)

Forbidden:

- Copying M1 `memoryId` or digest into B’s task context
- Inserting a `team/task` expansion row for B as a side effect of handoff
- Rewriting M1’s principal to B
- Copying A’s mem token

If A wants B to see a derived pack, an operator (or A with permission) issues
the **explicit** member grant row **first**. Only then may that `memoryId`
appear on the handoff. Unauthorized leftovers are dropped, or summarized as
“additional private context withheld” **without ids**.

Illustrative **legal** handoff (M3 only):

```json
{
  "handoffId": "h_3",
  "fromHire": "employee.hire_a",
  "toHire": "employee.hire_b",
  "memoryRefs": [
    { "memoryId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "digest": "sha256:…" }
  ]
}
```

M1 is not in `memoryRefs`.

## Branch merge does not promote private memories (REQ-004)

Merging `br_impl` into `br_review` updates segment heads only. It must not:

- change `class` from `employee-private` to `team/task`
- mint member grant rows for the other branch
- copy private `memoryId`s onto the merged head’s handoff
- clear `revoked_at` on a revoked row

Team visibility requires new grant rows (`grant_version` bumps).

## Eligibility order (mem#221, unchanged)

1. Malformed contract / digest / principal / binding
2. Workspace / principal / `memory_scope` mismatch → empty `out_of_scope` receipt
3. Revoked grant
4. Forgotten
5. Superseded / archived
6. Expired unless pinned
7. Else eligible; exact readback

## Gate

| Gate | This file |
| --- | --- |
| Now | Design proposal. Not a consumed #327 revision. |
| D0 | Product owner accepts #327 R1 / #345. Still no RoleWeave runtime. |
| mem additive | employee principal + `/employees/<hire_id>` scope accepted in mem. |
| D2 | Live E3 denial test (AC-002) with empty B receipt; fixtures ≠ evidence. |
| D3 | UI toggles (#355) only after the above. |

## Non-goals

Org-wide “everyone remembers everything”, automatic grant inference from chat,
Palantir-style ACL designer, `task.*` / `team.*` mem principals, treating
#345 or unaccepted D0 text as frozen RoleWeave baseline.
