import io

# ---- 1) reports-center.test.tsx: keep both sides ----
p = "apps/desktop/renderer/test/reports-center.test.tsx"
s = io.open(p, encoding="utf-8").read()

c1 = s.split("<<<<<<< HEAD\n")[1]
head1 = c1.split("\n=======\n")[0]
main1 = c1.split("\n=======\n")[1].split("\n>>>>>>> origin/main\n")[0]
res1 = head1 + "\n" + main1
s = s.replace("<<<<<<< HEAD\n" + c1, res1, 1)

c2 = s.split("<<<<<<< HEAD\n")[1]
head2 = c2.split("\n=======\n")[0]
main2 = c2.split("\n=======\n")[1].split("\n>>>>>>> origin/main\n")[0]
# head2: it-block missing its closing "});" (shared with main side)
# main2: two complete it-blocks minus final closing "});"
res2 = head2 + "\n  });\n\n" + main2 + "\n"
s = s.replace("<<<<<<< HEAD\n" + c2, res2, 1)

assert "<<<<<<<" not in s and ">>>>>>>" not in s
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("test file resolved OK")

# ---- 2) InboxReports.tsx: port overlay receipts into ExceptionWorkbench ----
p2 = "apps/desktop/renderer/src/reports/InboxReports.tsx"
t = io.open(p2, encoding="utf-8").read()

t = t.replace(
    'import { useState } from "react";',
    'import { useEffect, useState } from "react";\n'
    'import { OverlayReceiptPanel, recordSuggestionClick, syncEvidenceActionOutcome } from "../overlays/OverlayReceiptPanel.js";\n'
    'import { SOURCE_EXECUTION_ACTION } from "../overlays/overlay-receipt-store.js";',
    1,
)

old_sig = 'export function ExceptionWorkbench({ entries, evidence, evidenceByTurn, positionNames, onOpenTimeline, onOpenTurn, advice }: {\n  entries: EscalationEntry[]; evidence: EvidenceEntry[]; evidenceByTurn: Map<string, EvidenceEntry>;\n  positionNames?: Record<string, string>; onOpenTimeline: TraceLink; onOpenTurn?: SourceLink;\n  advice: ReturnType<typeof useReportAdvice>["items"];\n}) {'
new_sig = 'export function ExceptionWorkbench({ entries, evidence, evidenceByTurn, positionNames, onOpenTimeline, onOpenTurn, advice, workspacePath }: {\n  entries: EscalationEntry[]; evidence: EvidenceEntry[]; evidenceByTurn: Map<string, EvidenceEntry>;\n  positionNames?: Record<string, string>; onOpenTimeline: TraceLink; onOpenTurn?: SourceLink;\n  advice: ReturnType<typeof useReportAdvice>["items"];\n  workspacePath?: string;\n}) {'
assert old_sig in t, "ExceptionWorkbench signature not found"
t = t.replace(old_sig, new_sig, 1)

old_body = '  const receipt = selected ? evidenceByTurn.get(evidenceKey(selected)) : undefined;\n  if (!selected) return <p className="owb-report-empty">{t("rep.noEscalations")}</p>;'
new_body = '''  const receipt = selected ? evidenceByTurn.get(evidenceKey(selected)) : undefined;
  const overlay = selected?.escalation ? advice.get(reportAdviceKey(selected.escalation)) : undefined;
  const itemId = selected ? `escalation:${selected.escalation?.turnId ?? selected.turnId}` : undefined;
  useEffect(() => {
    if (!overlay || !receipt || !itemId) return;
    syncEvidenceActionOutcome(workspacePath, itemId, SOURCE_EXECUTION_ACTION, receipt.status);
  }, [overlay, receipt, itemId, workspacePath]);
  if (!selected) return <p className="owb-report-empty">{t("rep.noEscalations")}</p>;'''
assert old_body in t, "receipt/body anchor not found"
t = t.replace(old_body, new_body, 1)

old_chip = '    {selected.escalation ? <ReportAdviceChip advice={advice.get(reportAdviceKey(selected.escalation))} /> : null}'
new_chip = '    {selected.escalation ? <ReportAdviceChip advice={advice.get(reportAdviceKey(selected.escalation))} /> : null}\n    {overlay && itemId ? <OverlayReceiptPanel workspaceKey={workspacePath} itemId={itemId} enabled /> : null}'
assert old_chip in t, "advice chip anchor not found"
t = t.replace(old_chip, new_chip, 1)

old_trace = "    <footer><Button onClick={() => onOpenTimeline(selected.positionId, selected.turnId)}>{t(\"rep.traceRun\")}</Button></footer>"
new_trace = '    <footer><Button onClick={() => { if (overlay && itemId) recordSuggestionClick(workspacePath, itemId, "trace-run"); onOpenTimeline(selected.positionId, selected.turnId); }}>{t("rep.traceRun")}</Button></footer>'
assert old_trace in t, "trace footer anchor not found"
t = t.replace(old_trace, new_trace, 1)

io.open(p2, "w", encoding="utf-8", newline="").write(t)
print("InboxReports port OK")
