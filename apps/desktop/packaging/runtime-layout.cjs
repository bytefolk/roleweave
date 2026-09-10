const path = require("node:path");

// Every source-side runtime input is named here. Do not replace these filters
// with repository- or node_modules-wide globs: the staging package is also a
// boundary against credentials, tests, source maps, and developer state.
const DESKTOP_RUNTIME_FILES = [
  "package.json",
  "src/main.js",
  "src/macos-github-updater.cjs",
  "src/macos-login-path.cjs",
  "src/macos-update-helper.cjs",
  "src/preload.js",
  "src/approval-ipc.cjs",
  "src/assets-ipc.cjs",
  "src/control-plane-lifecycle.cjs",
  "src/auto-open-workspace.cjs",
  "src/control-plane-launch.cjs",
  "src/docs-ipc.cjs",
  "src/drive-ipc.cjs",
  "src/group-ipc.cjs",
  "src/hire-ipc.cjs",
  "src/last-workspace.cjs",
  "src/workspace-ipc.cjs",
  "src/org-ipc.cjs",
  "src/packaged-behavior-smoke.cjs",
  "src/packaged-smoke.cjs",
  "src/runtime-paths.cjs",
  // The app's only third-party runtime dependency, bundled to one file by
  // scripts/bundle-updater.mjs. Shipping electron-updater as a package would add
  // 16 packages and 325 files to a tree that asserts 189 files byte-exact, and
  // the filters below must not become a node_modules-wide glob.
  "src/vendor/electron-updater.cjs",
  "src/session-ipc.cjs",
  "src/turn-ipc.cjs",
  "src/update-trust.cjs",
  "src/updater.cjs",
  "src/update-ipc.cjs",
  "src/window-ipc.cjs",
  "dist/renderer/**/*",
];

const SERVER_RUNTIME_FILES = [
  "package.json",
  "bin/qoder-engine.mjs",
  "src/qoder-binary.js",
  "src/claude-binary.js",
  "src/codex-binary.js",
  "src/windows-launcher.js",
  "dist/src/agent-registry.js",
  "dist/src/assets/store.js",
  "dist/src/auth.js",
  "dist/src/bus.js",
  "dist/src/claude-binary.js",
  "dist/src/codex-binary.js",
  "dist/src/config.js",
  "dist/src/context-export/adapter-cli.js",
  "dist/src/context-export/exporter.js",
  "dist/src/context-sources.js",
  "dist/src/context.js",
  "dist/src/engine/driver-cli.js",
  "dist/src/engine/probe.js",
  "dist/src/engine/process-environment.js",
  "dist/src/groups/store.js",
  "dist/src/http.js",
  "dist/src/index.js",
  "dist/src/org/apply.js",
  "dist/src/org/layout.js",
  "dist/src/org/restore.js",
  "dist/src/org/undo.js",
  "dist/src/qoder-binary.js",
  "dist/src/routes/assets.js",
  "dist/src/routes/doc-plane.js",
  "dist/src/routes/docs.js",
  "dist/src/routes/drive.js",
  "dist/src/routes/events.js",
  "dist/src/routes/groups.js",
  "dist/src/routes/health.js",
  "dist/src/routes/hire.js",
  "dist/src/routes/org.js",
  "dist/src/routes/positions.js",
  "dist/src/routes/reports.js",
  "dist/src/routes/sessions.js",
  "dist/src/routes/turns.js",
  "dist/src/routes/workspace.js",
  "dist/src/server.js",
  "dist/src/sessions/store.js",
  "dist/src/stable-read.js",
  "dist/src/turns/delta-forwarder.js",
  "dist/src/turns/envelope.js",
  "dist/src/turns/running.js",
  "dist/src/turns/store.js",
  "dist/src/turns/thread-context.js",
  "dist/src/windows-launcher.js",
  "dist/src/workspace-state.js",
];

const SHARED_RUNTIME_FILES = [
  "package.json",
  "pending-approval.cjs",
  "position-id.cjs",
  "turn-engines.cjs",
  "dist/api.js",
  "dist/capabilities.js",
  "dist/change-manifest.js",
  "dist/context-sources.js",
  "dist/docs.js",
  "dist/drive.js",
  "dist/errors.js",
  "dist/groups.js",
  "dist/health.js",
  "dist/hire.js",
  "dist/index.js",
  "dist/org-layout.js",
  "dist/org-tree.js",
  "dist/pending-approval.js",
  "dist/position-id.js",
  "dist/sessions.js",
  "dist/turns.js",
  "dist/updates.js",
  "dist/workflows.js",
];

const EXAMPLE_RUNTIME_FILES = [
  "context/README.md",
  "organization.v1alpha1.json",
  "positions/repo-owner/SKILL.md",
  "positions/repo-owner/budget.json",
  "positions/repo-owner/community-operator/SKILL.md",
  "positions/repo-owner/community-operator/budget.json",
  "positions/repo-owner/community-operator/employee.json",
  "positions/repo-owner/community-operator/evals/cases.json",
  "positions/repo-owner/community-operator/knowledge/README.md",
  "positions/repo-owner/community-operator/schemas/input.schema.json",
  "positions/repo-owner/community-operator/schemas/output.schema.json",
  "positions/repo-owner/employee.json",
  "positions/repo-owner/evals/cases.json",
  "positions/repo-owner/issue-researcher/SKILL.md",
  "positions/repo-owner/issue-researcher/budget.json",
  "positions/repo-owner/issue-researcher/employee.json",
  "positions/repo-owner/issue-researcher/evals/cases.json",
  "positions/repo-owner/issue-researcher/knowledge/README.md",
  "positions/repo-owner/issue-researcher/schemas/input.schema.json",
  "positions/repo-owner/issue-researcher/schemas/output.schema.json",
  "positions/repo-owner/knowledge/README.md",
  "positions/repo-owner/release-engineer/SKILL.md",
  "positions/repo-owner/release-engineer/budget.json",
  "positions/repo-owner/release-engineer/employee.json",
  "positions/repo-owner/release-engineer/evals/cases.json",
  "positions/repo-owner/release-engineer/knowledge/README.md",
  "positions/repo-owner/release-engineer/schemas/input.schema.json",
  "positions/repo-owner/release-engineer/schemas/output.schema.json",
  "positions/repo-owner/schemas/input.schema.json",
  "positions/repo-owner/schemas/output.schema.json",
  "workspace.json",
];

const RUNTIME_FILE_SETS = [
  { from: ".", to: ".", filter: ["package.json", "LICENSE"] },
  {
    from: "apps/desktop",
    to: "apps/desktop",
    filter: DESKTOP_RUNTIME_FILES,
  },
  {
    from: "apps/server",
    to: "apps/server",
    filter: SERVER_RUNTIME_FILES,
  },
  {
    from: "packages/shared",
    to: "node_modules/@roleweave/shared",
    filter: SHARED_RUNTIME_FILES,
  },
  {
    from: "examples/oss-maintainer",
    to: "examples/oss-maintainer",
    filter: EXAMPLE_RUNTIME_FILES,
  },
];

const APP_RESOURCE_REQUIRED_ENTRIES = [
  "package.json",
  "LICENSE",
  ...DESKTOP_RUNTIME_FILES
    .filter((entry) => !entry.includes("*"))
    .map((entry) => `apps/desktop/${entry}`),
  "apps/desktop/dist/renderer/index.html",
  "apps/server/package.json",
  "apps/server/dist/src/engine/process-environment.js",
  "apps/server/dist/src/index.js",
  "apps/server/dist/src/stable-read.js",
  "apps/server/bin/qoder-engine.mjs",
  "apps/server/src/qoder-binary.js",
  "node_modules/@roleweave/shared/package.json",
  "node_modules/@roleweave/shared/dist/index.js",
  "node_modules/@roleweave/shared/position-id.cjs",
  "node_modules/@roleweave/shared/pending-approval.cjs",
  "node_modules/@roleweave/shared/turn-engines.cjs",
  "examples/oss-maintainer/workspace.json",
  "examples/oss-maintainer/organization.v1alpha1.json",
];

const PLATFORM_LAYOUTS = Object.freeze({
  macos: Object.freeze({
    bundleSuffix: ".app",
    executableRelative: path.join("Contents", "MacOS", "RoleWeave"),
    resourcesRelative: path.join("Contents", "Resources", "app"),
    bundleRequiredEntries: Object.freeze([
      path.join("Contents", "Info.plist"),
      path.join("Contents", "MacOS", "RoleWeave"),
    ]),
  }),
  windows: Object.freeze({
    bundleSuffix: "win-unpacked",
    executableRelative: "RoleWeave.exe",
    resourcesRelative: path.join("resources", "app"),
    // Electron's internal default_app.asar name is not a Workbench product
    // contract. Verify only our executable plus the exact resources/app tree.
    bundleRequiredEntries: Object.freeze(["RoleWeave.exe"]),
  }),
});

const FORBIDDEN_RUNTIME_PATH_PATTERNS = Object.freeze([
  /(^|\/)\.(?:env(?:\.|$)|git(?:\/|$)|npmrc$)/i,
  /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/i,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/i,
  /\.(?:map|pem|key|p12|pfx|crt|cer)$/i,
  /(?:^|\/)(?:credentials?|secrets?|id_rsa)(?:\.|$)/i,
  /^(?:scripts|apps\/desktop\/packaging)(?:\/|$)/i,
]);

function isForbiddenRuntimePath(relative) {
  const normalized = String(relative).replaceAll("\\", "/");
  return FORBIDDEN_RUNTIME_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function platformLayout(platform) {
  const layout = PLATFORM_LAYOUTS[platform];
  if (!layout) throw new Error(`unsupported staging platform: ${platform}`);
  return layout;
}

module.exports = {
  APP_RESOURCE_REQUIRED_ENTRIES,
  DESKTOP_RUNTIME_FILES,
  EXAMPLE_RUNTIME_FILES,
  FORBIDDEN_RUNTIME_PATH_PATTERNS,
  PLATFORM_LAYOUTS,
  RUNTIME_FILE_SETS,
  SERVER_RUNTIME_FILES,
  SHARED_RUNTIME_FILES,
  isForbiddenRuntimePath,
  platformLayout,
};
