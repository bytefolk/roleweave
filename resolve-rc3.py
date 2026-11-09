import re, io

p = "apps/desktop/renderer/test/reports-center.test.tsx"
s = io.open(p, encoding="utf-8").read()

pat = re.compile(r"<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> origin/main\n", re.S)
blocks = list(pat.finditer(s))
assert len(blocks) == 2, f"expected 2 conflicts, got {len(blocks)}"

b2 = blocks[1]
head2, main2 = b2.group(1), b2.group(2)
# head2: it-block lacking its closing "});" (shared tail); main2: complete blocks
res2 = head2 + "\n  });\n\n" + main2 + "\n"
s = s[:b2.start()] + res2 + s[b2.end():]

b1 = blocks[0]
res1 = b1.group(1) + "\n" + b1.group(2) + "\n"
s = s[:b1.start()] + res1 + s[b1.end():]

assert "<<<<<<<" not in s and ">>>>>>>" not in s
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("OK, total lines:", s.count("\n") + 1)
