const assert = require("node:assert/strict");
const test = require("node:test");
const {
  collectLiveOrgSnapshot,
  dispatchPhoneCommand,
  firstPositionId,
  firstReadyEngine,
  summarizeTurn,
} = require("../src/phone-link-host.cjs");

test("picks the first org-tree position unless one is bound", () => {
  const tree = { tree: [{ id: "repo-owner", children: [{ id: "issue-researcher" }] }] };
  assert.equal(firstPositionId(tree, "issue-researcher"), "issue-researcher");
  assert.equal(firstPositionId(tree), "repo-owner");
});

test("picks a ready engine without inventing host ids", () => {
  assert.equal(firstReadyEngine({ hosts: { qoder: { ready: false }, "claude-local": { ready: true } } }), "claude-local");
  assert.equal(firstReadyEngine({ hosts: { qoder: { ready: false } } }), null);
});

test("summarizes a completed turn from visible text", () => {
  assert.equal(summarizeTurn({ output: { text: "合了 #198" } }), "合了 #198");
});

test("dispatch creates a session and posts a turn", async () => {
  const calls = [];
  const apiRequest = async (pathname, options = {}) => {
    calls.push({ pathname, method: options.method ?? "GET", body: options.body ?? null });
    if (pathname === "/workspace") return { status: 200, body: { open: true } };
    if (pathname === "/org/tree") return { status: 200, body: { tree: [{ id: "repo-owner" }] } };
    if (pathname === "/health") return { status: 200, body: { hosts: { qoder: { ready: true } } } };
    if (pathname.startsWith("/sessions?")) return { status: 200, body: { activeSessionId: null, sessions: [] } };
    if (pathname === "/sessions") return { status: 201, body: { sessionId: "sess-1" } };
    if (pathname === "/sessions/sess-1/turns") {
      return { status: 200, body: { status: "completed", output: { text: "好的，我去处理" } } };
    }
    throw new Error(pathname);
  };
  const result = await dispatchPhoneCommand(apiRequest, "看一下 PR");
  assert.equal(result.state, "completed");
  assert.equal(result.summary, "好的，我去处理");
  assert.equal(calls.some((call) => call.pathname === "/sessions/sess-1/turns" && call.body.input === "看一下 PR"), true);
});

test("dispatch uses the selected position id", async () => {
  const paths = [];
  const apiRequest = async (pathname, options = {}) => {
    paths.push(pathname);
    if (pathname === "/workspace") return { status: 200, body: { open: true } };
    if (pathname === "/org/tree") return { status: 200, body: { tree: [{ id: "repo-owner", children: [{ id: "issue-researcher" }] }] } };
    if (pathname === "/health") return { status: 200, body: { hosts: { qoder: { ready: true } } } };
    if (pathname.startsWith("/sessions?")) return { status: 200, body: { activeSessionId: "sess-r" } };
    if (pathname === "/sessions/sess-r/turns") {
      assert.equal(options.body.input, "去调研");
      return { status: 200, body: { status: "completed", output: "ok" } };
    }
    throw new Error(pathname);
  };
  const result = await dispatchPhoneCommand(apiRequest, "去调研", "issue-researcher");
  assert.equal(result.state, "completed");
  assert.equal(paths.includes("/sessions?positionId=issue-researcher"), true);
});

test("live org snapshot omits the workspace path", async () => {
  const closed = await collectLiveOrgSnapshot(async () => ({ status: 200, body: { open: false } }));
  assert.equal(closed.source, "closed");
  const dir = "/secret/workspace-path";
  const live = await collectLiveOrgSnapshot(
    async () => ({ status: 200, body: { open: true, path: dir } }),
    async () => ({ name: "current", owner: "repo-owner", description: "", roles: [{ id: "repo-owner", name: "仓库负责人" }] }),
  );
  assert.equal(live.source, "live");
  assert.equal(live.name, "current");
  assert.equal(JSON.stringify(live).includes(dir), false);
});

test("busy employee is reported instead of queued", async () => {
  const apiRequest = async (pathname) => {
    if (pathname === "/workspace") return { status: 200, body: { open: true } };
    if (pathname === "/org/tree") return { status: 200, body: { tree: [{ id: "repo-owner" }] } };
    if (pathname === "/health") return { status: 200, body: { hosts: { qoder: { ready: true } } } };
    if (pathname.startsWith("/sessions?")) return { status: 200, body: { activeSessionId: "sess-1" } };
    if (pathname === "/sessions/sess-1/turns") return { status: 409, body: { code: "session_conflict" } };
    throw new Error(pathname);
  };
  const result = await dispatchPhoneCommand(apiRequest, "再来一条");
  assert.equal(result.state, "busy");
});
