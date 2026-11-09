# Memory pack v1 — clone export / import (design only)

Status: **design proposal only**. Requirement:
[#350](https://github.com/bytefolk/roleweave/issues/350) R1. Parent:
[#327](https://github.com/bytefolk/roleweave/issues/327) R1.

**Gate D0 is not accepted.** This file must not be consumed by a runtime PR.
**No runtime, HTTP, SQL, clone UI, mem writes, or engine wiring in this
change.** The JSON fixture is fictional and contains no PII.

Related: [memory-plane-v1.md](./memory-plane-v1.md),
[memory-grants-v1.md](./memory-grants-v1.md),
mem `durable-memory.v1`.

## What #350 owns

A **versioned pack** that travels with a cloned digital employee: granted
standing memories (preferences, confirmed decisions, workflow refs), each
with scope, digest, expiry, pin, and provenance.

It does **not** own: workspace backup, vector dumps, Sales Workbench export,
[#143](https://github.com/bytefolk/roleweave/issues/143) short window, or
Gate D0 itself.

## Invariants

1. Pack records are **derived durable records** only (`durable-memory.v1`
   shape). Raw turns stay in the session/archive plane.
2. Every record carries **scope** (`workspaceId` + `principal` +
   `memoryScope` + grant tuple), **digest** (SHA-256 of `text` UTF-8),
   **expiry** (`expiresAt`), **pin** (`pinned`), and **provenance**
   (server-derived; `clientSupplied: false`).
3. Recalled/imported text stays `trust: "untrusted"` and `authority: "none"`.
4. Import is **additive and untrusted**. The host must re-run
   digest / expiry / scope / grant checks **before any admit**. A stored pack
   is not an assembly receipt.
5. Clone copies **this hire’s granted rows**. It does not copy another
   principal’s private memories, even if those lines appeared in a shared
   thread (REQ-004). Seat reuse (`position.*`) does not inherit
   `employee.<hire_id>` private rows ([#349](https://github.com/bytefolk/roleweave/issues/349)).

## Example pack

Fictional fixture (real SHA-256 of each `text`):

[`fixtures/memory-pack.v1.example.json`](./fixtures/memory-pack.v1.example.json)

Three records, one employee `employee.hire_pack_01`:

| memoryId prefix | kind | principal | pinned | why it may travel |
| --- | --- | --- | --- | --- |
| `11111111` | preference | `employee.hire_pack_01` | true | granted employee-private derived preference |
| `22222222` | workflow_ref | `position.sales-ae` | false | granted position-class workflow ref |
| `33333333` | project_decision | `employee.hire_pack_01` | false | granted derived decision |

## Exclusion list (AC-002, #327 non-goals)

A valid `memory-pack.v1` **must not** contain:

| Excluded | Why |
| --- | --- |
| Raw turns / transcripts | Archive plane; not standing memory |
| Credentials / API keys / tokens / host secrets | Never memory |
| Approval payloads | Hidden authority; #327 non-goal |
| Chain-of-thought / hidden reasoning | #327 non-goal |
| Private chat of any other principal | REQ-004 |
| Ungranted team or position memories | Missing grant |
| Vector index dumps | Non-goal |
| Sales Workbench / CRM rows | Non-goal (#350) |
| Client-supplied `"provenance": "user"` | Provenance is server-derived |

The example pack lists the same exclusions under `excludedByContract`.

## Import failure modes (AC-003)

Host **must fail closed** (refuse admit; do not inject; do not silently
drop into the next turn as selected). Catalog only — no runtime here.

### 1. Digest mismatch

Record `digest` ≠ SHA-256 of `text` UTF-8 bytes (or `sourceDigest` ≠
referenced source). Treat as malformed. Do not “repair” by hashing at
import time and keeping the bytes.

```json
{
  "memoryId": "11111111-1111-4111-8111-111111111111",
  "text": "Prefer a written recap after every customer call; never invent next-step dates.",
  "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "import": "reject",
  "reason": "digest_mismatch"
}
```

### 2. Expired

`expiresAt` ≤ import clock, or `lifecycle` is `expired`. Pin does **not**
waive expiry. Source evidence may still exist under retention; the pack
row is ineligible.

```json
{
  "memoryId": "33333333-3333-4333-8333-333333333333",
  "expiresAt": "2020-01-01T00:00:00.000Z",
  "pinned": true,
  "import": "reject",
  "reason": "expired"
}
```

### 3. Out of scope

Caller workspace / principal / `memoryScope` does not equal the record
binding. Matching one UUID and guessing the other is malformed
([memory-grants-v1.md](./memory-grants-v1.md)). Cross-principal default
deny.

```json
{
  "memoryId": "11111111-1111-4111-8111-111111111111",
  "principal": "employee.hire_pack_01",
  "callerPrincipal": "employee.hire_other",
  "import": "reject",
  "reason": "out_of_scope"
}
```

### 4. Missing grant

No grant row, `grantVersion`/`revocationVersion` stale, grant revoked, or
the record was never issued to the clone target. Ungranted team memories
fail here, not as a partial copy.

```json
{
  "memoryId": "22222222-2222-4222-8222-222222222222",
  "grantId": "grant_pack_wf_01",
  "grantVersion": 2,
  "callerGrantVersion": 1,
  "import": "reject",
  "reason": "missing_grant"
}
```

Failure is visible. Do not write rejected rows into a recall receipt
`selected` list.

## Runtime (blocked)

Export/import, clone UI, and mem writes wait for **#327 Gate D0** accepted
plus the additive employee-private principal where private rows are copied.
This document is not that gate.

## Document checks (this PR)

- Fixture JSON parses as UTF-8 JSON.
- `schemaVersion` is `memory-pack.v1`.
- Every `records[]` item has `memoryScope`, `digest`, `expiresAt`, `pinned`,
  `provenance`.
- Every `digest` equals `sha256:` + hex(SHA-256(`text` UTF-8)).
- No record field named `credential`, `token`, `approval`, `chainOfThought`,
  or raw `turns`.
- Exclusion list and four import failures are documented above.
