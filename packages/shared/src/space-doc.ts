/**
 * Space document contract (v1).
 *
 * A space (专项作战人机协作区) is a folder inside a workspace. Its spine is one
 * Markdown file that the human and the agents both edit. The file is the
 * source of truth; the structure below is derived from it, never stored
 * alongside it.
 *
 * Structure is carried by fixed H2 headings rather than a custom DSL or
 * front-matter schema, so the same file stays readable as a plain document:
 *
 *   # 目标：<title>
 *
 *   <free prose the human writes>
 *
 *   ## 验收标准
 *   - [ ] <criterion>
 *
 *   ## 任务
 *   | 任务 | 状态 | 负责岗位 | 截止 |
 *   | --- | --- | --- | --- |
 *   | <title> | todo | <positionId> | 2026-10-01 |
 *
 * Parsing is pure and total: any string produces a result, and a document
 * that lacks a section simply yields an empty one. Round-tripping the parsed
 * value never rewrites prose the parser did not understand.
 */

import { goalWorkItemStatuses, type GoalWorkItemStatus } from "./goals.js";

export const SPACE_DOC_SCHEMA_VERSION = "space-doc.v1" as const;

export const SPACE_DOC_MAX_CRITERIA = 64;
export const SPACE_DOC_MAX_TASKS = 128;
export const SPACE_DOC_MAX_TITLE_LENGTH = 256;

/** Section headings are fixed identifiers, not localised at parse time. */
export const SPACE_DOC_CRITERIA_HEADING = "验收标准" as const;
export const SPACE_DOC_TASKS_HEADING = "任务" as const;

export interface SpaceDocCriterion {
  /** Stable index within the document; matches `acceptance.v1` criteriaIndex. */
  criteriaIndex: number;
  text: string;
  done: boolean;
  /** Raw checkbox token as written, so an unrelated state is not silently lost. */
  marker: " " | "x" | "X";
}

export interface SpaceDocTask {
  title: string;
  status: GoalWorkItemStatus;
  /** A position id when the cell looks like one; otherwise undefined. */
  assigneePositionId?: string;
  dueDate?: string;
  /** Cells the parser could not classify, preserved for the structure view. */
  raw: string[];
}

export interface SpaceDocSection {
  heading: string;
  /** Line index of the heading in the source, or -1 for a synthesised section. */
  startLine: number;
  body: string[];
}

export interface SpaceDoc {
  schemaVersion: typeof SPACE_DOC_SCHEMA_VERSION;
  title: string;
  /** Everything before the first H2, minus the H1 line. */
  intro: string;
  criteria: SpaceDocCriterion[];
  tasks: SpaceDocTask[];
  /** Sections that are neither 验收标准 nor 任务, kept in document order. */
  otherSections: SpaceDocSection[];
  /** True when a `## 任务` table was found but no row parsed cleanly. */
  tasksUnparseable: boolean;
}

export interface SpaceDocParseIssue {
  line: number;
  message: string;
}

export interface SpaceDocParseResult {
  doc: SpaceDoc;
  issues: SpaceDocParseIssue[];
}

function isH1(line: string): boolean {
  return /^#\s+/.test(line);
}

function isH2(line: string): boolean {
  return /^##\s+/.test(line);
}

function h2Heading(line: string): string {
  return line.replace(/^##\s+/, "").trim();
}

/** `# 目标：X` / `# 目标: X` / `# X` all resolve to the title text. */
export function parseSpaceDocTitle(line: string): string {
  const text = line.replace(/^#\s+/, "").trim();
  const stripped = text.replace(/^目标\s*[：:]\s*/, "").trim();
  return stripped.length > 0 ? stripped : text;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")));
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2;
}

function parseCriterion(line: string, criteriaIndex: number): SpaceDocCriterion | null {
  const match = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[1];
  if (marker === undefined) return null;
  const text = (match[2] ?? "").trim();
  if (text.length === 0) return null;
  return { criteriaIndex, text, done: marker !== " ", marker: marker as " " | "x" | "X" };
}

const TASK_COLUMN_ALIASES: Record<string, "title" | "status" | "assignee" | "due"> = {
  "任务": "title",
  "标题": "title",
  "task": "title",
  "title": "title",
  "状态": "status",
  "status": "status",
  "负责岗位": "assignee",
  "负责": "assignee",
  "assignee": "assignee",
  "owner": "assignee",
  "截止": "due",
  "截止时间": "due",
  "due": "due",
  "due date": "due",
};

const POSITION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isPositionId(value: string): boolean {
  return value.length > 0 && value.length <= 64 && POSITION_ID_PATTERN.test(value);
}

function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value) || value.startsWith("0000-")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isWorkItemStatus(value: string): value is GoalWorkItemStatus {
  return (goalWorkItemStatuses as readonly string[]).includes(value);
}

/** Column index → semantic role, resolved from a header row (or its alias). */
function resolveColumns(header: string[]): Array<"title" | "status" | "assignee" | "due" | null> {
  return header.map((cell) => TASK_COLUMN_ALIASES[cell.toLowerCase()] ?? TASK_COLUMN_ALIASES[cell] ?? null);
}

function parseTaskRow(cells: string[], columns: Array<string | null>, line: number, issues: SpaceDocParseIssue[]): SpaceDocTask | null {
  const title = cells[0]?.trim() ?? "";
  if (title.length === 0) {
    issues.push({ line, message: "task row has an empty title" });
    return null;
  }

  const task: SpaceDocTask = {
    title: title.slice(0, SPACE_DOC_MAX_TITLE_LENGTH),
    status: "todo",
    raw: cells,
  };

  for (let index = 1; index < cells.length; index += 1) {
    const role = columns[index] ?? null;
    const value = cells[index]?.trim() ?? "";
    if (value.length === 0) continue;

    if (role === "status") {
      if (isWorkItemStatus(value)) task.status = value;
      else issues.push({ line, message: `unknown task status "${value}"; kept as todo` });
    } else if (role === "assignee") {
      if (isPositionId(value)) task.assigneePositionId = value;
      else issues.push({ line, message: `"${value}" is not a position id; left unassigned` });
    } else if (role === "due") {
      if (isCalendarDate(value)) task.dueDate = value;
      else issues.push({ line, message: `"${value}" is not a YYYY-MM-DD date; ignored` });
    }
  }
  return task;
}

function parseTasks(section: SpaceDocSection, issues: SpaceDocParseIssue[]): { tasks: SpaceDocTask[]; unparseable: boolean } {
  const tasks: SpaceDocTask[] = [];
  let columns: Array<string | null> | null = null;
  let sawTable = false;

  for (let offset = 0; offset < section.body.length; offset += 1) {
    const line = section.body[offset] ?? "";
    const lineNumber = section.startLine + offset + 1;

    if (!isTableRow(line)) continue;
    const cells = splitTableRow(line);

    if (!sawTable) {
      // First row is the header, the second (separator) is skipped.
      if (isTableSeparator(cells)) continue;
      columns = resolveColumns(cells);
      sawTable = true;
      continue;
    }
    if (isTableSeparator(cells)) continue;

    const task = parseTaskRow(cells, columns ?? [], lineNumber, issues);
    if (task) tasks.push(task);
    if (tasks.length >= SPACE_DOC_MAX_TASKS) break;
  }

  return { tasks, unparseable: sawTable && tasks.length === 0 };
}

export function parseSpaceDoc(source: string): SpaceDocParseResult {
  const issues: SpaceDocParseIssue[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");

  let title = "";
  let introLines: string[] = [];
  const sections: SpaceDocSection[] = [];
  let current: SpaceDocSection | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (isH2(line)) {
      current = { heading: h2Heading(line), startLine: index, body: [] };
      sections.push(current);
      continue;
    }
    if (isH1(line)) {
      if (title.length === 0) title = parseSpaceDocTitle(line);
      continue;
    }
    if (current) current.body.push(line);
    else introLines.push(line);
  }

  let criteria: SpaceDocCriterion[] = [];
  let tasks: SpaceDocTask[] = [];
  let tasksUnparseable = false;
  const otherSections: SpaceDocSection[] = [];

  for (const section of sections) {
    if (section.heading === SPACE_DOC_CRITERIA_HEADING) {
      for (let offset = 0; offset < section.body.length; offset += 1) {
        if (criteria.length >= SPACE_DOC_MAX_CRITERIA) break;
        const criterion = parseCriterion(section.body[offset] ?? "", criteria.length);
        if (criterion) criteria.push(criterion);
      }
    } else if (section.heading === SPACE_DOC_TASKS_HEADING) {
      const parsed = parseTasks(section, issues);
      tasks = parsed.tasks;
      tasksUnparseable = parsed.unparseable;
    } else {
      otherSections.push(section);
    }
  }

  return {
    doc: {
      schemaVersion: SPACE_DOC_SCHEMA_VERSION,
      title,
      intro: introLines.join("\n").trim(),
      criteria,
      tasks,
      otherSections,
      tasksUnparseable,
    },
    issues,
  };
}

/**
 * Rewrite only the two structured sections, leaving every other byte of the
 * document untouched. This is what makes the structure view safe to edit:
 * prose the parser did not understand is never regenerated from a lossy model.
 */
export function renderSpaceDoc(doc: SpaceDoc, source: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const criterionLines = doc.criteria.map(
    (criterion) => `- [${criterion.done ? "x" : " "}] ${criterion.text}`,
  );
  const taskLines = [
    "| 任务 | 状态 | 负责岗位 | 截止 |",
    "| --- | --- | --- | --- |",
    ...doc.tasks.map((task) =>
      [
        task.title,
        task.status,
        task.assigneePositionId ?? "",
        task.dueDate ?? "",
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    ),
  ];

  const replacements = new Map<string, string[]>([
    [SPACE_DOC_CRITERIA_HEADING, criterionLines],
    [SPACE_DOC_TASKS_HEADING, taskLines],
  ]);
  // Keep complete source lines, including their individual line endings.
  // Only a structured section's nonblank body is regenerated.
  const chunks = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const textOf = (line: string) => line.replace(/(?:\r\n|\r|\n)$/, "");
  const seen = new Set<string>();
  let out = "";
  let index = 0;
  while (index < chunks.length) {
    const chunk = chunks[index] ?? "";
    const line = textOf(chunk);
    const heading = isH2(line) ? h2Heading(line) : "";
    const replacement = replacements.get(heading);
    if (!replacement) {
      out += chunk;
      index += 1;
      continue;
    }
    seen.add(heading);
    out += chunk;
    index += 1;
    const start = index;
    while (index < chunks.length && !isH2(textOf(chunks[index] ?? ""))) index += 1;
    let bodyStart = start;
    let bodyEnd = index;
    while (bodyStart < bodyEnd && textOf(chunks[bodyStart] ?? "").trim() === "") bodyStart += 1;
    while (bodyEnd > bodyStart && textOf(chunks[bodyEnd - 1] ?? "").trim() === "") bodyEnd -= 1;
    if (replacement.length > 0 && !/[\r\n]$/.test(chunk)) out += eol;
    out += chunks.slice(start, bodyStart).join("");
    out += replacement.join(eol);
    // Preserve the last content line's terminator and every separator byte.
    const terminator = (chunks[bodyEnd - 1] ?? "").match(/(?:\r\n|\r|\n)$/)?.[0] ?? "";
    if (replacement.length > 0) out += bodyEnd > bodyStart ? terminator : (index < chunks.length ? eol : "");
    out += chunks.slice(bodyEnd, index).join("");
  }
  for (const [heading, replacement] of replacements) {
    if (seen.has(heading) || (heading === SPACE_DOC_CRITERIA_HEADING ? doc.criteria.length === 0 : doc.tasks.length === 0)) continue;
    if (out.length > 0) {
      if (!/[\r\n]$/.test(out)) out += eol;
      if (!out.endsWith(eol + eol)) out += eol;
    }
    out += `## ${heading}${eol}${replacement.join(eol)}${eol}`;
  }
  return out;
}

/** Derive the `acceptance.v1` criteria count a space exposes to the gate. */
export function spaceDocCriteriaCount(doc: SpaceDoc): number {
  return doc.criteria.length;
}
