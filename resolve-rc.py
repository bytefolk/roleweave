import re, io

p = "apps/desktop/renderer/src/reports/ReportsCenter.tsx"
s = io.open(p, encoding="utf-8").read()

pat = re.compile(r"<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> origin/main\n", re.S)

blocks = list(pat.finditer(s))
assert len(blocks) == 3, f"expected 3 conflicts, got {len(blocks)}"

# Resolve from the end so indices stay valid
c3 = blocks[2]
main3 = c3.group(2)
s = s[:c3.start()] + main3 + "\n" + s[c3.end():]

c2 = blocks[1]
main2 = c2.group(2)
# add workspacePath prop to ExceptionWorkbench call to preserve branch feature wiring
assert 'advice={advice.items} /></>' in main2
main2 = main2.replace("advice={advice.items} />", "advice={advice.items} workspacePath={workspacePath} />", 1)
s = s[:c2.start()] + main2 + "\n" + s[c2.end():]

c1 = blocks[0]
main1 = c1.group(2)
s = s[:c1.start()] + main1 + "\n" + s[c1.end():]

assert "<<<<<<<" not in s and ">>>>>>>" not in s

# Remove now-unused branch imports (overlay logic moved to InboxReports)
for line in [
    'import { OverlayReceiptPanel, recordSuggestionClick, syncEvidenceActionOutcome } from "../overlays/OverlayReceiptPanel.js";\n',
    'import { SOURCE_EXECUTION_ACTION } from "../overlays/overlay-receipt-store.js";\n',
]:
    if line in s:
        s = s.replace(line, "", 1)
    else:
        print("WARN: import line not found verbatim:", line.strip()[:60])

# sanity: no remaining references to removed symbols
for sym in ["OverlayReceiptPanel", "recordSuggestionClick", "syncEvidenceActionOutcome", "SOURCE_EXECUTION_ACTION"]:
    if sym in s:
        print("WARN: symbol still referenced:", sym)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("ReportsCenter resolved OK")
