# Multi-agent branch heads and handoff-carried checkpoints v1

Status: **design proposal only**. Requirement:
[#356](https://github.com/bytefolk/roleweave/issues/356) (RW-3). Blocked on
Gate D0 and digital-employee DE-2. Related grants:
[#349](https://github.com/bytefolk/roleweave/issues/349). Handoff contract:
[`workflow-handoff-v1.md`](workflow-handoff-v1.md) — do not rewrite
hire/turn-envelope.

**No runtime in this change.** Successor permissions are re-evaluated at
recall/execution time ([#328](https://github.com/bytefolk/roleweave/issues/328)).

## AC-001 — Agent B cannot silently overwrite Agent A’s checkpoint

Each agent owns a **branch head** (segment id + hire principal). Writes go to
that head only.

| Actor | May |
| --- | --- |
| Hire A on `br_impl` | Append a new segment whose `parentSegmentId` is A’s head. |
| Hire B on `br_review` | Append on B’s head only. |
| Hire B | **Must not** update A’s head pointer, rewrite A’s segment, or replace A’s checkpoint memory in place. |

A write that names another hire’s `headId` is rejected. There is no “force
head” without a merge record (AC-003).

## AC-003 — Merge record required; no in-place head clobber

```json
{
  "schemaVersion": "memory-branch.v1",
  "branchId": "br_impl",
  "parentHeadId": "seg_01",
  "ownerHireId": "employee.hire_a",
  "createdAt": "2026-09-18T12:05:00.000Z"
}
```

```json
{
  "schemaVersion": "memory-merge.v1",
  "mergeId": "mg_1",
  "fromBranchIds": ["br_impl", "br_review"],
  "resultHeadId": "seg_09",
  "evidence": ["handoff:h_3"],
  "createdAt": "2026-09-18T13:00:00.000Z"
}
```

Merge **creates** `seg_09` and a merge record. It does not overwrite `seg_01`
bytes. Private memories are not promoted (#349 REQ-004).

## AC-002 — Handoff carries refs, not leftover grants

The handoff package includes:

- checkpoint **reference** (`segmentId` / `memoryId` + full digest)
- optional assembly **receipt** digest
- artifact refs the successor can already read

It must **not** include:

- leftover grants, tokens, or capability payloads
- another hire’s private `memoryId` (#349 non-enumerable deny)
- the whole transcript

Illustrative legal package. Digests below are full 64-hex SHA-256 **shapes**;
runtime must hash the named segment/receipt/memory bytes, not copy these
constants:

```json
{
  "schemaVersion": "workflow-handoff.v1",
  "handoffId": "h_3",
  "fromHire": "employee.hire_a",
  "toHire": "employee.hire_b",
  "checkpointRef": {
    "segmentId": "seg_01",
    "digest": "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"
  },
  "receiptRef": {
    "turnId": "t42",
    "digest": "sha256:fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9"
  },
  "memoryRefs": [
    {
      "memoryId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ]
}
```

`memoryRefs` lists only records for which B **already** has a mem grant row.
Packaging a ref does not mint a grant. At B’s next recall, #328 re-evaluates
B’s position/hire; revoked rows stay ineligible.

Do not rewrite hire/turn-envelope fields in `workflow-handoff-v1.md`.

## Gate

AC-004: blocked on Gate D0 and DE-2. Automatic routing and unattended
scheduling are non-goals. Do not close #143.
