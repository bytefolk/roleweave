# Memory grants v1 — private / position / team

Status: **design only**. Pins [RoleWeave #327](https://github.com/bytefolk/roleweave/issues/327) R1,
P1 on [#345](https://github.com/bytefolk/roleweave/pull/345), and mem
`durable-memory.v1` (workspace + position principal + `memory_scope` + grant).
Requirement: [#349](https://github.com/bytefolk/roleweave/issues/349). Related: #328, #356.

**No runtime, HTTP, SQL, or UI until Gate D0.** This file is the grant table,
examples, and denial tests. Fixtures here do not substitute for later live E3
receipts.

## Why this is not a new schema

`durable-memory.v1` already fail-closed isolates:

1. mem `workspace_id`;
2. position principal `position.<position_id>`;
3. canonical `memory_scope` (`/workspaces/<instance>/positions/<position_id>`);
4. a grant/revocation tuple (`grant_id`, `grant_version`, `permission_digest`, `revoked_at`).

#349 only classifies **which principal the grant is issued to**. It does not
invent a second ACL, a free-string `scope`, or Palantir-style policy designer.

Default is **deny across principals**. A grant is an explicit, auditable object.

## Grant classes (REQ-001)

| class | principal shape | who can recall | default |
| --- | --- | --- | --- |
| `employee-private` | `position.<employee_position_id>` of the **writer** | only that employee | **yes** (new records) |
| `position` | `position.<position_id>` of a **named seat** (may outlive a hire) | any agent currently occupying that seat, re-evaluated at recall |
| `team/task` | `task.<task_id>` or `team.<team_id>` listed on the grant | principals listed on that task/team grant row |

`grant.mode` remains `read` (same as `durable-context.v1`). Forget stays a mem
`delete` token + workspace role, not a grant mode.

### Product grant object

```json
{
  "schemaVersion": "memory-grant.v1",
  "grantId": "33333333-3333-4333-8333-333333333333",
  "class": "employee-private",
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "principal": "position.issue-researcher",
  "memoryScope": "/workspaces/44444444-4444-4444-8444-444444444444/positions/issue-researcher",
  "memoryId": "22222222-2222-4222-8222-222222222222",
  "mode": "read",
  "grantVersion": 1,
  "expiresAt": "2026-12-17T12:00:00Z",
  "revokedAt": null
}
```

This **is** the mem `durable-memory.v1` `grant` + `binding` pair. RoleWeave UI
toggles `class` / principal; mem stores the row. RoleWeave must not keep a
parallel allowlist.

## Parallel implement + review (AC-001)

Workspace `oss-maintainer`. Two employees:

- A = `position.issue-researcher` (implementer)
- B = `position.pr-gatekeeper` (reviewer)

| memory | writer | class | granted principal | B may recall? |
| --- | --- | --- | --- | --- |
| M1 private notes | A | `employee-private` | `position.issue-researcher` | **no** |
| M2 checkpoint | A | `position` | `position.issue-researcher` | **no** (wrong seat) |
| M3 review pack | A | `team/task` | `task.fix-123` (A and B listed) | **yes**, if B’s current seat is still on the task |
| M4 team decision | A | `team/task` | `team.oss-maintainer` | **yes** after explicit grant |

Example M1 (private — B denied):

```json
{
  "contract": "durable-memory.v1",
  "memory_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "kind": "note",
  "binding": {
    "workspace_id": "11111111-1111-4111-8111-111111111111",
    "position_id": "issue-researcher",
    "principal": "position.issue-researcher",
    "memory_scope": "/workspaces/44444444-4444-4444-8444-444444444444/positions/issue-researcher"
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

`permission_digest` is computed by mem from `(workspace_id, principal, memory_scope, mode, grant_version)`.

## Denial test (AC-002)

Specified, not executed (no runtime before D0). Later E3 must use a live memd,
not this JSON.

**Setup:** persist M1 as above. Recall caller B:

```
workspace_id = 11111111-1111-4111-8111-111111111111
principal    = position.pr-gatekeeper
memory_scope = /workspaces/4444…/positions/pr-gatekeeper
```

**Expect:**

- `EvaluateRecall` → `eligible=false`, `omit_reason=out_of_scope`
- Receipt is empty: no `memory_id`, locator, grant block, or `readback`
- Assembly must not admit M1. A later RoleWeave receipt lists `{ id: M1, reason: "out_of_scope" }`
- Pin on M1 does not enlarge B’s permission

Pass criterion: B’s admitted set never contains M1. Fail if any fixture-only
harness is used as the live evidence.

## Handoff copies references, not permissions (AC-003 / REQ-003)

#328: the successor’s **Position is re-evaluated at recall time**.

Handoff package (illustrative, `handoff.v1` already exists):

```json
{
  "handoffId": "h_3",
  "fromPosition": "issue-researcher",
  "toPosition": "pr-gatekeeper",
  "memoryRefs": [
    { "memoryId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "digest": "sha256:…" }
  ],
  "artifactRefs": [{ "id": "art_decision_1" }]
}
```

What handoff **does**:

- Copies **ids + digests** into the reviewer’s task context list.

What handoff **must not** do:

- Insert a `team/task` grant for B on M1
- Rewrite M1 `principal` to `position.pr-gatekeeper`
- Copy A’s mem token or `delete` scope
- Treat a successful handoff as “B can now recall A’s private notes”

When B later recalls M1, mem still evaluates B’s current principal against the
**original** grant. Private M1 stays omitted (`out_of_scope`). If the review
needs M3, an operator (or A with permission) issues an explicit `team/task`
grant for `task.fix-123` **before** recall — that is a separate auditable row,
not a side effect of handoff.

## Branch merge does not promote private memories (REQ-004)

Merging `br_impl` into `br_review` updates segment heads only. It must not:

- change `class` from `employee-private` to `team/task`
- mint grants for the other branch’s principals
- set `revoked_at` null on a previously revoked grant

Private memories remain private after merge. Team visibility requires a new
grant row (`grant_version` bumps).

## Eligibility order (unchanged from durable-memory.v1)

1. Malformed contract / digest / principal / binding
2. Workspace / principal / `memory_scope` mismatch → `out_of_scope`
3. Revoked grant
4. Forgotten
5. Superseded / archived
6. Expired unless pinned
7. Else eligible; exact readback

Pin never restores a revoked grant or another principal’s record.

## Gate

| Gate | This file |
| --- | --- |
| D0 | Design accepted with #327 R1. **No implementation PR consumes this until D0.** |
| D2 | mem runtime + live E3 denial test (AC-002) with receipt |
| D3 | RoleWeave UI toggles for the three classes (#355) |

## Non-goals

Org-wide “everyone remembers everything”, automatic grant inference from chat,
Palantir-style ACL designer, a second RoleWeave allowlist beside mem.
