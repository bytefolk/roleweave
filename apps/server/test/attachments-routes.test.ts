import assert from "node:assert/strict";
import test from "node:test";
import { routes, type TurnRecord, type WorkbenchSession } from "@roleweave/shared";
import { api, copyExampleWorkspace, startTestServer } from "./helpers.js";

async function openWorkspace(baseUrl: string, token: string, dir: string): Promise<void> {
  const opened = await api(baseUrl, "/workspace/open", {
    method: "POST",
    token,
    body: { path: dir },
  });
  assert.equal(opened.status, 200);
}

test("attachment upload/read bind to a real session and reject illegal base64 and cross-session ids", async () => {
  const server = await startTestServer();
  const workspace = await copyExampleWorkspace();
  try {
    await openWorkspace(server.baseUrl, server.token, workspace);
    const missingSession = await api(server.baseUrl, routes.attachmentsUpload, {
      method: "POST",
      token: server.token,
      body: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        fileName: "note.png",
        mimeType: "image/png",
        dataBase64: Buffer.from("abcd").toString("base64"),
      },
    });
    assert.equal(missingSession.status, 404);

    const created = await api(server.baseUrl, "/sessions", {
      method: "POST",
      token: server.token,
      body: { positionId: "repo-owner" },
    });
    assert.equal(created.status, 201);
    const session = created.body as WorkbenchSession;
    const other = await api(server.baseUrl, "/sessions", {
      method: "POST",
      token: server.token,
      body: { positionId: "release-engineer" },
    });
    assert.equal(other.status, 201);
    const otherSession = other.body as WorkbenchSession;

    const badB64 = await api(server.baseUrl, routes.attachmentsUpload, {
      method: "POST",
      token: server.token,
      body: {
        sessionId: session.sessionId,
        fileName: "note.png",
        mimeType: "image/png",
        dataBase64: "!!!!",
      },
    });
    assert.equal(badB64.status, 400);

    const uploaded = await api(server.baseUrl, routes.attachmentsUpload, {
      method: "POST",
      token: server.token,
      body: {
        sessionId: session.sessionId,
        fileName: "note.png",
        mimeType: "image/png",
        dataBase64: Buffer.from("abcd").toString("base64"),
      },
    });
    assert.equal(uploaded.status, 200);
    const attachment = (uploaded.body as { attachment: { id: string; extractedText?: unknown } }).attachment;
    assert.equal(attachment.extractedText, undefined);

    const same = await api(
      server.baseUrl,
      `${routes.attachmentsRead}?sessionId=${session.sessionId}&attachmentId=${attachment.id}`,
      { token: server.token },
    );
    assert.equal(same.status, 200);

    const cross = await api(
      server.baseUrl,
      `${routes.attachmentsRead}?sessionId=${otherSession.sessionId}&attachmentId=${attachment.id}`,
      { token: server.token },
    );
    assert.equal(cross.status, 400);

    const bare = await api(server.baseUrl, "/turns", {
      method: "POST",
      token: server.token,
      body: {
        positionId: "repo-owner",
        input: "with file",
        engine: "qoder",
        attachmentIds: [attachment.id],
      },
    });
    assert.equal(bare.status, 400);

    const turned = await api(server.baseUrl, `/sessions/${session.sessionId}/turns`, {
      method: "POST",
      token: server.token,
      body: {
        input: "with file",
        engine: "qoder",
        attachmentIds: [attachment.id],
      },
    });
    assert.equal(turned.status, 200);
    const record = turned.body as TurnRecord;
    assert.equal(record.attachments?.length, 1);
    assert.equal(record.attachments?.[0]?.id, attachment.id);
  } finally {
    await server.ctx.contextExporter.waitForIdle();
    await server.close();
  }
});
