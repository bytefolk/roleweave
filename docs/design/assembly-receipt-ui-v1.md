# Assembly receipt UI v1

Status: **design proposal only**. Requirement:
[#354](https://github.com/bytefolk/roleweave/issues/354) (RW-1). Parent:
[#327](https://github.com/bytefolk/roleweave/issues/327). Blocked on Gate D0
and digital-employee DE-1.

**No runtime in this change.** Aligns budget units with
[#345](https://github.com/bytefolk/roleweave/pull/345) P1 (PeterGuy326):
RoleWeave context receipts are UTF-8 **bytes**; digital-employee task budgets
are **tokens**. This file freezes both, with bytes as the admission authority.

## Budget units (P1)

| Quantity | Authority | Used for |
| --- | --- | --- |
| `hardBudgetBytes` / `admittedBytes` / per-item `bytes` | UTF-8 byte length of the admitted payload | **Admission.** Hard cap. Must not be exceeded. Matches existing RoleWeave context receipts. |
| `softBudgetBytes` | UTF-8 bytes | Compaction trigger. Not a second hard cap. |
| `hardBudgetTokens` / `admittedTokens` (optional) | Model tokenizer named on the receipt | **Cost / employee task budget.** Independent cap when present. |

Rules:

1. Admission **never** converts tokens → bytes with a guessed ratio.
2. If both caps exist, an item is admitted only if **both** remaining budgets
   allow it. Whichever hits zero first wins; the omit reason is `budget_bytes`
   or `budget_tokens`.
3. UI must show the unit next to every number (`1840 B`, not a bare `1840`
   that could be tokens).
4. Net-token success metrics stay a D4 concern. They are not admission.

Illustrative receipt (full SHA-256, not a truncated placeholder):

```json
{
  "schemaVersion": "recall-receipt.v1",
  "turnId": "t42",
  "hardBudgetBytes": 262144,
  "admittedBytes": 18144,
  "hardBudgetTokens": 8000,
  "admittedTokens": 910,
  "tokenizer": "cl100k_base",
  "selected": [
    { "id": "22222222-2222-4222-8222-222222222222", "reason": "user_remember", "bytes": 420, "tokens": 80, "trust": "untrusted", "authority": "none" }
  ],
  "omitted": [
    { "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "reason": "expired" },
    { "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "reason": "budget_bytes" }
  ],
  "degraded": false,
  "unavailable": false,
  "digest": "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  "retrievedAt": "2026-09-18T12:01:00.000Z"
}
```

## AC-001 — Displayed counts equal the receipt

| UI field | Equals |
| --- | --- |
| Admitted count | `selected.length` |
| Omitted count | `omitted.length` |
| Admitted bytes | `admittedBytes` |
| Admitted tokens | `admittedTokens` when present; otherwise the tokens column is hidden, not invented |
| Omit reasons | one row per `omitted[]` entry, same `reason` string |

These fields render on the **turn/task timeline** next to that turn’s
receipt, not on a global memory widget.

Forbidden: summing local caches, counting pins, or guessing from the composer.

The receipt `digest` in examples is illustrative unless stated as a hash of
named UTF-8 text. Runtime must hash the canonical receipt bytes.

## AC-002 — Degraded / unavailable is never drawn as success

| Receipt | UI |
| --- | --- |
| `unavailable: true` or recall skipped | Banner: memory **unavailable / skipped**. No “memory on” badge. Counts 0/0 or hidden. |
| `degraded: true` | Banner: **degraded**. Still show selected/omitted from this receipt only. |
| `unavailable: false` and selected non-empty | “Admitted N items, M B” copied from the receipt. |

#327 AC-007: never show “memory enabled and used” when recall was skipped or
failed.

## AC-003 — Renderer tests (specified, not shipped here)

When DE-1 exists on an accepted revision, renderer tests must cover:

1. Skip path: no receipt → no success badge.
2. Fail path: `unavailable: true` → failure/unavailable copy.
3. Omit path: omitted reasons render; counts match arrays.
4. Byte vs token labels both present when both fields exist.

Fixtures do not substitute for later live E3.

## Gate

Blocked until Gate D0 and DE-1 (AC-004). Pin/forget controls are #355.

## Non-goals

Implementing mem, closing #143, inventing a token↔byte formula.
