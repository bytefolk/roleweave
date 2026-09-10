import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { OrgRole } from "@roleweave/shared";
import { resolvePositionPackageDir } from "../src/context-sources.js";
import { POSITIONS_DIR } from "../src/workspace-state.js";

const WORKSPACE = path.resolve("/fixture/workspace");
const POSITIONS_ROOT = path.resolve(WORKSPACE, POSITIONS_DIR);

function roleWith(localReference: string, id = "repo-owner"): OrgRole {
  return {
    id,
    package: { name: "p", version: "1.0.0", digest: "0".repeat(64), localReference },
  } as unknown as OrgRole;
}

function staysInsidePositions(resolved: string): boolean {
  const relative = path.relative(POSITIONS_ROOT, resolved);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

test("an absolute reference inside this workspace is used as-is", () => {
  const bound = path.join(POSITIONS_ROOT, "repo-owner");
  assert.equal(resolvePositionPackageDir(WORKSPACE, roleWith(bound)), bound);
});

test("a relative reference is resolved against the opened workspace", () => {
  assert.equal(
    resolvePositionPackageDir(WORKSPACE, roleWith(path.join(POSITIONS_DIR, "repo-owner"))),
    path.join(POSITIONS_ROOT, "repo-owner"),
  );
});

test("a portable reference rooted at another checkout is rebased, not trusted", () => {
  const foreign = path.posix.join("/other/checkout", POSITIONS_DIR, "repo-owner", "docs");
  assert.equal(
    resolvePositionPackageDir(WORKSPACE, roleWith(foreign)),
    path.join(POSITIONS_ROOT, "repo-owner", "docs"),
  );
});

test("references that cannot be proven to stay in positions/ fall back to the flat path", () => {
  const fallback = path.join(POSITIONS_ROOT, "repo-owner");
  for (const reference of [
    "/etc/passwd",
    "/workspace/secrets",
    path.posix.join(POSITIONS_DIR, "..", "..", "escape"),
    "/..",
    POSITIONS_ROOT,
    path.posix.join("/other", POSITIONS_DIR),
  ]) {
    const resolved = resolvePositionPackageDir(WORKSPACE, roleWith(reference));
    assert.equal(resolved, fallback, `expected fallback for ${reference}`);
  }
});

test("no localReference can move the resolved package outside positions/", () => {
  const adversarial = [
    "/tmp/anything",
    path.join(POSITIONS_ROOT, "..", "..", "outside"),
    path.posix.join("/x/positions/../../y"),
    "/x/positions/repo-owner/../../../../etc/passwd",
    "/x/positions/a/../../b",
    "/x/positions/repo-owner/./sub",
    "/x/other/positions/repo-owner/../../..",
    path.posix.join("/x/other/repo-owner"),
    "positions/repo-owner/../../../../etc",
    "",
  ];
  for (const reference of adversarial) {
    const resolved = resolvePositionPackageDir(WORKSPACE, roleWith(reference));
    assert.ok(staysInsidePositions(resolved), `${JSON.stringify(reference)} escaped to ${resolved}`);
  }
});
