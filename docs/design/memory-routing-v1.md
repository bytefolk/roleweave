# Memory routing v1 — short window, durable memory, Knowledge Base

Status: **design proposal only**. Requirement:
[#352](https://github.com/bytefolk/roleweave/issues/352). Parent:
[#327](https://github.com/bytefolk/roleweave/issues/327). Related: #143, #347,
#348.

**No runtime in this change.** Closing [#143](https://github.com/bytefolk/roleweave/issues/143)
is out of scope (REQ-004 / AC-003).

## One sentence

Last-turn chatter stays in the **#143 short window**; a confirmed standing
fact about **this employee’s work** is a **#327 / #348 durable record**; a
shared job document lives in the **#347 Knowledge Base**. “记住” without a
document target writes durable memory, not a KB file.

## AC-001 — Routing table

| Input | Store | Why | Next-turn injection |
| --- | --- | --- | --- |
| Last user utterance (“continue with the same patch”) | **#143** short window | Ephemeral follow-up. Not standing memory. | Trusted short excerpt in the FIFO window. Not a durable pin. |
| Confirmed customer preference (“Acme accepts email only”, operator Remember) | **#327 durable** via **#348** remember | Standing fact about this hire’s work. | Ranked durable item, `trust: untrusted`. |
| Team SOP markdown under Job Documents | **#347 KB** | Shared document, not an employee note. | Citation + excerpt only. Never full text every turn (REQ-003). |
| Tool log / raw command output | **#143** (or session log) | Not a confirmed fact. Too large for durable. | FIFO; may compact to a segment later. Not auto-KB. |
| Rejected idea (“we will not force-push”) | **#327 durable** as `negative_signal` if operator Remember/Correct; else stay in the window | Only an explicit act makes it standing. | If durable: untrusted recall. If not: window only. |

“记住” with no document picker → #348 remember into #327 (REQ-002).  
“记住” with a KB document selected → write/update that #347 document, not a
memory row.

## AC-002 — One turn using all three (not concatenated)

Turn `t51`, hire `employee.hire_a`, task `fix-123`.

1. **#143 window** admits the last user line (bounded bytes).
2. **Durable** admits one Remember record if the receipt selected it.
3. **KB** admits a citation + excerpt of `sop-review.md`, not the file body.

Illegal assembly: concatenate window + all memories + full SOP into one
string and slice arbitrary bytes.

Legal assembly (illustrative):

```json
{
  "schemaVersion": "recall-receipt.v1",
  "turnId": "t51",
  "hardBudgetBytes": 262144,
  "admittedBytes": 1840,
  "selected": [
    { "id": "turn:t50", "store": "short_window", "reason": "fifo_head", "bytes": 220 },
    { "id": "22222222-2222-4222-8222-222222222222", "store": "durable", "reason": "user_remember", "bytes": 420, "trust": "untrusted", "authority": "none" },
    { "id": "owb-doc://repo-owner/knowledge/sop-review.md", "store": "knowledge_base", "reason": "citation_excerpt", "bytes": 1200, "trust": "untrusted", "authority": "none" }
  ],
  "omitted": [
    { "id": "kb:sop-review.md#body", "reason": "kb_full_text_forbidden" }
  ],
  "degraded": false,
  "unavailable": false
}
```

The model sees three **items**, each with a store tag. UI counts equal those
arrays (#354).

## AC-003 — #143 stays open

The short window remains the trusted follow-up path. Durable memory does not
replace it. This issue must not be used to close #143.

## Gate

Design-only until #327 Gate D0 (AC-004). No automatic classification ML.

## Non-goals

Replacing the doc editor, a second session store, auto-routing ML before this
table is accepted, injecting KB full text every turn.
