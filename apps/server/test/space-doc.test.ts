import assert from "node:assert/strict";
import test from "node:test";
import {
  SPACE_DOC_SCHEMA_VERSION,
  parseSpaceDoc,
  renderSpaceDoc,
} from "@roleweave/shared";

/**
 * Indexed access under `noUncheckedIndexedAccess` is `T | undefined`, which turns
 * every `list[0]` in an assertion into a type error. These tests assert on known
 * fixtures, so narrow once here instead of scattering `!` through the file.
 */
function at<T>(list: readonly T[], index: number): T {
  assert.ok(index >= 0 && index < list.length, `index ${index} out of range`);
  const value = list[index];
  assert.ok(value !== undefined, `index ${index} is undefined`);
  return value;
}

const DOC = `# 目标：把结算对账自动化

先把口径对齐，再看边界。

## 背景

这块现在靠人工，每月两个人力日。

## 验收标准
- [ ] 对账差异能被自动归因
- [x] 口径文档已评审
- [ ] 回滚路径有演练记录

## 任务
| 任务 | 状态 | 负责岗位 | 截止 |
| --- | --- | --- | --- |
| 梳理差异分类 | done | analyst | 2026-09-20 |
| 写对账脚本 | in_progress | engineer | 2026-10-05 |
| 补回滚演练 | todo |  |  |

## 风险

数据源有延迟。
`;

test("parses the title", () => {
  const { doc } = parseSpaceDoc(DOC);
  assert.equal(doc.title, "把结算对账自动化");
  assert.equal(doc.schemaVersion, SPACE_DOC_SCHEMA_VERSION);
});

test("parses criteria with their checkbox state and stable index", () => {
  const { doc } = parseSpaceDoc(DOC);
  assert.equal(doc.criteria.length, 3);
  assert.deepEqual(doc.criteria.map((c) => c.criteriaIndex), [0, 1, 2]);
  assert.equal(at(doc.criteria, 0).text, "对账差异能被自动归因");
  assert.equal(at(doc.criteria, 0).done, false);
  assert.equal(at(doc.criteria, 1).done, true);
  assert.equal(at(doc.criteria, 1).marker, "x");
});

test("parses the task table into typed rows", () => {
  const { doc } = parseSpaceDoc(DOC);
  assert.equal(doc.tasks.length, 3);
  assert.deepEqual(at(doc.tasks, 0), {
    title: "梳理差异分类",
    status: "done",
    assigneePositionId: "analyst",
    dueDate: "2026-09-20",
    raw: ["梳理差异分类", "done", "analyst", "2026-09-20"],
  });
  assert.equal(at(doc.tasks, 1).status, "in_progress");
  assert.equal(at(doc.tasks, 2).assigneePositionId, undefined);
  assert.equal(at(doc.tasks, 2).dueDate, undefined);
});

test("keeps sections the parser does not own, in document order", () => {
  const { doc } = parseSpaceDoc(DOC);
  assert.deepEqual(doc.otherSections.map((s) => s.heading), ["背景", "风险"]);
  assert.equal(at(doc.otherSections, 0).body.join("\n").trim(), "这块现在靠人工，每月两个人力日。");
});

test("keeps the intro prose before the first H2", () => {
  const { doc } = parseSpaceDoc(DOC);
  assert.equal(doc.intro, "先把口径对齐，再看边界。");
});

test("a document without the structured sections is still total", () => {
  const { doc, issues } = parseSpaceDoc("# 只有标题\n\n随便写点东西。\n");
  assert.equal(doc.title, "只有标题");
  assert.deepEqual(doc.criteria, []);
  assert.deepEqual(doc.tasks, []);
  assert.equal(doc.tasksUnparseable, false);
  assert.deepEqual(issues, []);
  assert.equal(doc.intro, "随便写点东西。");
});

test("an empty string parses without throwing", () => {
  const { doc } = parseSpaceDoc("");
  assert.equal(doc.title, "");
  assert.deepEqual(doc.criteria, []);
  assert.deepEqual(doc.tasks, []);
});

test("flags a task table that yields no rows", () => {
  const { doc } = parseSpaceDoc("# 目标：x\n\n## 任务\n| 任务 | 状态 |\n| --- | --- |\n");
  assert.equal(doc.tasks.length, 0);
  assert.equal(doc.tasksUnparseable, true);
});

test("reports an unknown status instead of guessing", () => {
  const source = "# 目标：x\n\n## 任务\n| 任务 | 状态 |\n| --- | --- |\n| a | 做完了 |\n";
  const { doc, issues } = parseSpaceDoc(source);
  assert.equal(at(doc.tasks, 0).status, "todo");
  assert.equal(issues.length, 1);
  assert.match(at(issues, 0).message, /unknown task status/);
});

test("ignores a non-position assignee and a non-date due, with an issue", () => {
  const source =
    "# 目标：x\n\n## 任务\n| 任务 | 状态 | 负责岗位 | 截止 |\n| --- | --- | --- | --- |\n| a | todo | Alice Smith | 明天 |\n";
  const { doc, issues } = parseSpaceDoc(source);
  assert.equal(at(doc.tasks, 0).assigneePositionId, undefined);
  assert.equal(at(doc.tasks, 0).dueDate, undefined);
  assert.equal(issues.length, 2);
});

test("accepts header aliases", () => {
  const source = "# 目标：x\n\n## 任务\n| Title | Status | Assignee | Due Date |\n| --- | --- | --- | --- |\n| a | blocked | engineer | 2026-11-01 |\n";
  const { doc } = parseSpaceDoc(source);
  assert.equal(at(doc.tasks, 0).status, "blocked");
  assert.equal(at(doc.tasks, 0).assigneePositionId, "engineer");
  assert.equal(at(doc.tasks, 0).dueDate, "2026-11-01");
});

test("round-trip preserves prose and other sections byte for byte", () => {
  const { doc } = parseSpaceDoc(DOC);
  const rendered = renderSpaceDoc(doc, DOC);
  const reparsed = parseSpaceDoc(rendered).doc;

  assert.equal(reparsed.intro, doc.intro);
  // startLine is source provenance, so it legitimately shifts after a rewrite;
  // the content of sections the parser does not own must not change.
  assert.deepEqual(
    reparsed.otherSections.map((s) => ({ heading: s.heading, body: s.body })),
    doc.otherSections.map((s) => ({ heading: s.heading, body: s.body })),
  );
  assert.deepEqual(reparsed.criteria, doc.criteria);
  assert.deepEqual(reparsed.tasks, doc.tasks);
  assert.ok(rendered.includes("这块现在靠人工，每月两个人力日。"));
  assert.ok(rendered.includes("数据源有延迟。"));
});

test("round-trip on an already-canonical document is a fixed point", () => {
  const { doc } = parseSpaceDoc(DOC);
  const once = renderSpaceDoc(doc, DOC);
  const twice = renderSpaceDoc(parseSpaceDoc(once).doc, once);
  assert.equal(once, twice);
});

test("toggling a criterion rewrites only its line", () => {
  const { doc } = parseSpaceDoc(DOC);
  doc.criteria[0] = { ...at(doc.criteria, 0), done: true };
  const rendered = renderSpaceDoc(doc, DOC);
  assert.ok(rendered.includes("- [x] 对账差异能被自动归因"));
  assert.ok(rendered.includes("- [x] 口径文档已评审"));
  assert.ok(rendered.includes("- [ ] 回滚路径有演练记录"));
});

test("renders a task row without assignee or due as empty cells", () => {
  const { doc } = parseSpaceDoc(DOC);
  const rendered = renderSpaceDoc(doc, DOC);
  assert.ok(rendered.includes("| 补回滚演练 | todo |  |  |"));
});

test("preserves CRLF line endings", () => {
  const crlf = DOC.replace(/\n/g, "\r\n");
  const { doc } = parseSpaceDoc(crlf);
  const rendered = renderSpaceDoc(doc, crlf);
  assert.ok(rendered.includes("\r\n"));
  assert.ok(!rendered.replace(/\r\n/g, "").includes("\n"));
});

test("criteria before a later section do not leak into it", () => {
  const source = "# 目标：x\n\n## 验收标准\n- [ ] a\n\n## 备注\n- [ ] 这不是验收项\n";
  const { doc } = parseSpaceDoc(source);
  assert.equal(doc.criteria.length, 1);
  assert.equal(at(doc.criteria, 0).text, "a");
  assert.equal(doc.otherSections.length, 1);
  assert.equal(at(doc.otherSections, 0).heading, "备注");
});


test("canonical round trips preserve every byte including separators and EOF", () => {
  assert.equal(renderSpaceDoc(parseSpaceDoc(DOC).doc, DOC), DOC);
  for (const eol of ["\n", "\r\n"]) {
    for (const ending of ["", eol, eol + eol]) {
      const source = ["# x", "", "## 验收标准", "", "- [ ] a"].join(eol) + ending;
      assert.equal(renderSpaceDoc(parseSpaceDoc(source).doc, source), source);
    }
  }
});

test("missing sections are inserted rather than silently dropping new data", () => {
  const source = "# x\n\nKeep this prose.\n";
  const {doc} = parseSpaceDoc(source);
  doc.criteria = [{criteriaIndex: 0, text: "new criterion", done: false, marker: " "}];
  doc.tasks = [{title: "new task", status: "todo", raw: []}];
  const rendered = renderSpaceDoc(doc, source);
  assert.ok(rendered.startsWith(source));
  assert.equal(parseSpaceDoc(rendered).doc.criteria[0]?.text, "new criterion");
  assert.equal(parseSpaceDoc(rendered).doc.tasks[0]?.title, "new task");
  assert.equal(renderSpaceDoc(parseSpaceDoc(rendered).doc, rendered), rendered);
});

test("a missing task section is added without disturbing the existing criteria section", () => {
  const source = "# x\n\n## 验收标准\n- [ ] a\n";
  const {doc} = parseSpaceDoc(source);
  doc.tasks = [{title: "new task", status: "review", raw: []}];
  const rendered = renderSpaceDoc(doc, source);
  assert.ok(rendered.startsWith(source));
  assert.equal(parseSpaceDoc(rendered).doc.tasks[0]?.title, "new task");
});

test("empty structured sections can be cleared while preserving surrounding prose", () => {
  const source = "# x\n\n## 验收标准\n- [ ] remove\n\n## Notes\nKeep this.\n";
  const {doc} = parseSpaceDoc(source); doc.criteria = [];
  const rendered = renderSpaceDoc(doc, source);
  assert.ok(!rendered.includes("remove"));
  assert.ok(rendered.endsWith("\n## Notes\nKeep this.\n"));
});
