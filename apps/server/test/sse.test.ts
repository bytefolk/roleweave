import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { OrganizationFile } from "@roleweave/shared";
import { FakeDriver, api, connectSse, copyExampleWorkspace, startTestServer } from "./helpers.js";

test("events: SSE delivers org.updated; reconnect resumes by version stamp", async () => {
  const dir = await copyExampleWorkspace();
  const runtime = path.join(dir, ".digital-employee");
  await fs.mkdir(runtime, { recursive: true });
  await fs.copyFile(
    path.join(dir, "organization.v1alpha1.json"),
    path.join(runtime, "org.json"),
  );
  const driver = new FakeDriver({ status: "applied" }, async (workspaceDir) => {
    const file = path.join(workspaceDir, ".digital-employee", "org.json");
    const model = JSON.parse(await fs.readFile(file, "utf8")) as OrganizationFile;
    const moved = model.roles.find((role) => role.id === "issue-researcher");
    assert.ok(moved);
    moved.reportTo = "release-engineer";
    moved.package.localReference = path.join(
      workspaceDir,
      "positions",
      "repo-owner",
      "release-engineer",
      "issue-researcher",
    );
    model.updatedAt = new Date(Date.now() + 1000).toISOString();
    await fs.writeFile(file, `${JSON.stringify(model, null, 2)}\n`, "utf8");
  });
  const server = await startTestServer(driver);
  const first = connectSse(server.baseUrl, server.token);
  try {
    await api(server.baseUrl, "/workspace/open", {
      method: "POST",
      token: server.token,
      body: { path: dir },
    });
    const seen = await first.waitForEvent("org.updated");
    assert.ok(seen.id, "every event must carry a version stamp (SSE id)");
    const parsed = JSON.parse(seen.data) as { seq: number; type: string };
    assert.equal(parsed.type, "org.updated");
    assert.equal(String(parsed.seq), seen.id);
    const firstSeq = parsed.seq;

    // A fresh connection without Last-Event-ID must NOT replay history.
    const fresh = connectSse(server.baseUrl, server.token);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fresh.events.filter((frame) => frame.event === "org.updated").length, 0);
    fresh.close();

    // Reconnect with the last stamp: replay starts strictly after it, so we
    // trigger one more event and expect exactly the newer one.
    first.close();
    await api(server.baseUrl, "/org/apply", {
      method: "POST",
      token: server.token,
      body: {
        schemaVersion: "change-manifest.v1",
        changes: [{ op: "move", id: "issue-researcher", reportTo: "release-engineer" }],
      },
    });
    const resumed = connectSse(server.baseUrl, server.token, String(firstSeq));
    const replayed = await resumed.waitForEvent("org.updated");
    const replayedParsed = JSON.parse(replayed.data) as { seq: number };
    assert.ok(replayedParsed.seq > firstSeq, "resume must replay only newer events");
    resumed.close();
  } finally {
    first.close();
    await server.close();
  }
});
