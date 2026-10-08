#!/usr/bin/env node
// The design-system repo is consumed via file: and carries its own
// node_modules (devDeps include react/react-dom). A second React copy
// breaks hooks at runtime/test time, so repoint design-system's react
// and react-dom at this workspace's copies. Idempotent; rebuilds missing
// sibling links when the workspace copy exists. Works from git worktree copies too: the real
// design-system is discovered by probing ancestor siblings and verifying
// the target tree's package identity, and the rewritten directory links
// are asserted resolvable from the design-system perspective (#49).
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN_SYSTEM_PACKAGE = "@fullstack-ai-infra/ui";

function isDesignSystem(candidate) {
  let raw;
  try {
    raw = readFileSync(join(candidate, "package.json"), "utf8");
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
  try {
    if (JSON.parse(raw).name !== DESIGN_SYSTEM_PACKAGE) return false;
  } catch {
    return false;
  }
  return existsSync(join(candidate, "node_modules"));
}

// Probe the classic sibling position first, then walk ancestor directories so
// git worktree copies (e.g. `.worktrees/*`) still reach the real checkout.
function findDesignSystem() {
  const seen = new Set();
  const probe = (candidate) => {
    let real;
    try {
      real = realpathSync(candidate);
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
    if (seen.has(real)) return null;
    seen.add(real);
    return isDesignSystem(real) ? real : null;
  };
  let current = root;
  for (;;) {
    const hit = probe(join(current, "..", "design-system"));
    if (hit) return hit;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const designSystem = findDesignSystem();
if (!designSystem) {
  console.log("dedupe-react: no design-system checkout found beside an ancestor of this workspace; skipping");
  process.exit(0);
}

const workspaceCopy = (name) => join(root, "node_modules", name);
const siblingCopy = (name) => join(designSystem, "node_modules", name);

for (const name of ["react", "react-dom"]) {
  const canonical = workspaceCopy(name);
  const sibling = siblingCopy(name);
  let siblingStat;
  try {
    siblingStat = lstatSync(sibling);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!existsSync(canonical)) continue;
  let converged = false;
  try {
    converged = realpathSync(sibling) === realpathSync(canonical);
  } catch {
    // Dangling symlink: rewrite it below.
  }
  if (converged) continue;
  if (siblingStat?.isSymbolicLink()) {
    unlinkSync(sibling);
  } else if (siblingStat) {
    rmSync(sibling, { recursive: true, force: true });
  }
  mkdirSync(dirname(sibling), { recursive: true });
  // Windows junctions do not need symbolic-link privileges and must use an
  // absolute directory target. Keep portable relative links on POSIX.
  symlinkSync(process.platform === "win32" ? canonical : relative(dirname(sibling), canonical),
    sibling, process.platform === "win32" ? "junction" : "dir");
  console.log(`dedupe-react: ${sibling} -> ${canonical}`);
}

// Post-rewrite assertion (#49): the directory links must be self-consistent
// from the design-system/node_modules perspective — react/react-dom resolve
// and converge on this workspace's canonical copies.
const requireFromDesignSystem = createRequire(join(designSystem, "package.json"));
for (const name of ["react", "react-dom"]) {
  const canonical = workspaceCopy(name);
  const sibling = siblingCopy(name);
  if (!existsSync(canonical) || !existsSync(sibling)) continue;
  requireFromDesignSystem.resolve(name);
  if (realpathSync(sibling) !== realpathSync(canonical)) {
    throw new Error(`dedupe-react: ${name} link does not converge on the workspace copy from ${designSystem}`);
  }
  console.log(`dedupe-react: ${name} resolves from ${designSystem} to the workspace copy`);
}
