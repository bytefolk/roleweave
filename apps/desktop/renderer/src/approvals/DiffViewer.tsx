import { useMemo } from "react";
import { safeApprovalText } from "./safe-display";

export interface DiffLine {
  type: "add" | "delete" | "normal";
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface DiffViewerProps {
  before?: string;
  after?: string;
  change?: string;
}

export function computeLineDiff(before?: string, after?: string, change?: string): DiffLine[] {
  if (change === "add" || change === "create" || before === undefined) {
    if (after === undefined || after === "") return [];
    return after.split("\n").map((line, i) => ({
      type: "add",
      newLine: i + 1,
      content: line,
    }));
  }

  if (change === "delete" || after === undefined) {
    if (before === undefined || before === "") return [];
    return before.split("\n").map((line, i) => ({
      type: "delete",
      oldLine: i + 1,
      content: line,
    }));
  }

  if (before === "" && after === "") {
    return [];
  }

  const beforeLines = before ? before.split("\n") : [];
  const afterLines = after ? after.split("\n") : [];
  const m = beforeLines.length;
  const n = afterLines.length;

  if (m === 0) {
    return afterLines.map((line, i) => ({
      type: "add",
      newLine: i + 1,
      content: line,
    }));
  }

  if (n === 0) {
    return beforeLines.map((line, i) => ({
      type: "delete",
      oldLine: i + 1,
      content: line,
    }));
  }

  if (m === n && beforeLines.every((line, i) => line === afterLines[i])) {
    return beforeLines.map((line, i) => ({
      type: "normal",
      oldLine: i + 1,
      newLine: i + 1,
      content: line,
    }));
  }

  // Bound LCS table to prevent memory blowup on massive files
  if (m * n > 250000) {
    const fallback: DiffLine[] = [];
    beforeLines.forEach((line, i) => fallback.push({ type: "delete", oldLine: i + 1, content: line }));
    afterLines.forEach((line, i) => fallback.push({ type: "add", newLine: i + 1, content: line }));
    return fallback;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (beforeLines[i] === afterLines[j]) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i]![j + 1]!, dp[i + 1]![j]!);
      }
    }
  }

  const diff: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
      diff.push({
        type: "normal",
        oldLine: i,
        newLine: j,
        content: beforeLines[i - 1]!,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      diff.push({
        type: "add",
        newLine: j,
        content: afterLines[j - 1]!,
      });
      j--;
    } else if (i > 0 && (j === 0 || dp[i]![j - 1]! < dp[i - 1]![j]!)) {
      diff.push({
        type: "delete",
        oldLine: i,
        content: beforeLines[i - 1]!,
      });
      i--;
    }
  }
  return diff.reverse();
}

export function DiffViewer({ before, after, change }: DiffViewerProps) {
  const lines = useMemo(() => computeLineDiff(before, after, change), [before, after, change]);

  return (
    <div className="owb-diff-viewer" data-testid="approval-diff-viewer">
      <div className="owb-diff-table" role="table">
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={`owb-diff-row is-${line.type}`}
            data-line-type={line.type}
            role="row"
          >
            <span className="owb-diff-gutter owb-diff-gutter--old" role="cell">
              {line.oldLine ?? ""}
            </span>
            <span className="owb-diff-gutter owb-diff-gutter--new" role="cell">
              {line.newLine ?? ""}
            </span>
            <span className="owb-diff-sign" role="cell">
              {line.type === "add" ? "+" : line.type === "delete" ? "-" : " "}
            </span>
            <span className="owb-diff-content" role="cell">
              <code>{safeApprovalText(line.content)}</code>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
