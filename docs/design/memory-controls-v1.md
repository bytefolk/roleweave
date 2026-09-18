# Memory controls v1 — pin / disable / inspect / forget

Status: **design proposal only**. Requirement:
[#355](https://github.com/bytefolk/roleweave/issues/355) (RW-2). Blocked on
Gate D0, mem [#220](https://github.com/bytefolk/mem/issues/220) (MEM-1), and
[#354](https://github.com/bytefolk/roleweave/issues/354) (RW-1).

**No runtime in this change.** Forget is mem’s permissioned lifecycle.
RoleWeave must not locally fake-delete.

Related write acts: [#348](https://github.com/bytefolk/roleweave/issues/348).

## AC-001 — Permissioned paths

Every control is scoped to the **caller’s grant**. Pin does not enlarge
permission (mem durable-memory.v1).

| Control | Who | Path (proposal, post-D0) | mem / RoleWeave |
| --- | --- | --- | --- |
| Inspect | Any principal who can already recall the item, or an operator with admin read | `GET` memory inspect; UI drawer | Read-only. Shows provenance, expiry, omit reason from the **last receipt** plus mem metadata. |
| Pin / unpin | Same grant as recall, plus RoleWeave pin permission | mem pin/unpin (ranking / TTL exception) | Pin cannot un-revoke, un-forget, or cross principal. |
| Disable | Operator; per-workspace or per-position memory switch | RoleWeave policy `enabled: false` | Next receipt must be skip/unavailable, not a fake empty success. |
| Forget | mem `delete` token scope + workspace role that allows deletion | mem forget; RoleWeave only **requests** | Success = mem ack. |

Inspect fields (no secrets):

- `memoryId`, kind, `binding.principal`, `memory_scope`
- grant status (`active` / `revoked`) for **in-scope** callers only
- `expiresAt`, pinned, lifecycle
- last receipt omit reason if omitted
- `trust: untrusted`, `authority: none`
- citation / source digest (full `sha256:` + 64 hex)

Out-of-scope inspect returns the same empty/not-found as recall (#349
non-enumerable deny).

## AC-002 — Forget failure is shown as failure

| mem result | UI |
| --- | --- |
| ack | “Forgotten” only after ack. Tombstone may remain. |
| `forget_denied` / 403 / 404 | Error banner. Item **remains** in the list. |
| timeout / 5xx | Error banner, retryable. Item remains. |

Forbidden: removing the row from local state before ack; painting a
successful omit on the next receipt that RoleWeave invented.

```json
{
  "schemaVersion": "memory-act-result.v1",
  "act": "forget",
  "outcome": "failed",
  "error": "forget_denied",
  "localFake": false
}
```

## AC-003 — Accessibility + permission checks

Specified for the later UI PR:

- Each control is a real button with an accessible name (not icon-only).
- Disabled controls expose `aria-disabled` and the denying reason in text
  (missing grant, memory disabled, running turn).
- Inspect is a dialog with focus trap and labelled fields.
- Forget requires an explicit confirm; Esc cancels.
- Screen-reader live region announces forget failure.

Permission check order: RoleWeave disable switch → caller principal/scope →
mem grant → mem delete (forget only).

## Gate

| Gate | This file |
| --- | --- |
| Now | Design only. |
| D0 + MEM-1 + RW-1 | Controls may be implemented. |
| D3 | Live forget failure evidence. |

## Non-goals

Silent TTL delete of source logs, second session store, pin as a permission
upgrade, implementing mem HTTP.
