const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDeploymentSessionStore } = require("../src/deployment-session.cjs");

function createMockSafeStorage() {
  const encrypted = new Map();
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "cryptorium",
    encryptString: (plain) => {
      const buf = Buffer.from(`enc:${plain}`);
      encrypted.set(buf.toString("base64"), plain);
      return buf;
    },
    decryptString: (buf) => {
      const base64 = buf.toString("base64");
      const plain = encrypted.get(base64);
      if (!plain) throw new Error("decrypt failed");
      return plain;
    },
  };
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deployment-session-test-"));
}

const VALID_SESSION = {
  deploymentUrl: "https://example.com/workspace",
  provider: "remote",
  accountIdentity: "alice@example.com",
  token: "secret-token-123",
  expiresAt: null,
};

test("deployment session store saves and lists sessions without exposing tokens", () => {
  const userDataPath = createTempDir();
  const safeStorage = createMockSafeStorage();
  const store = createDeploymentSessionStore({ userDataPath, safeStorage });

  const saveResult = store.save(VALID_SESSION);
  assert.equal(saveResult.ok, true);

  const listResult = store.list();
  assert.equal(listResult.ok, true);
  assert.equal(listResult.sessions.length, 1);
  assert.equal(listResult.sessions[0].deploymentUrl, "https://example.com/workspace");
  assert.equal(listResult.sessions[0].provider, "remote");
  assert.equal(listResult.sessions[0].accountIdentity, "alice@example.com");
  assert.equal(listResult.sessions[0].token, undefined, "list must not return tokens");

  fs.rmSync(userDataPath, { recursive: true, force: true });
});

test("deployment session store removes sessions by URL", () => {
  const userDataPath = createTempDir();
  const safeStorage = createMockSafeStorage();
  const store = createDeploymentSessionStore({ userDataPath, safeStorage });

  store.save(VALID_SESSION);
  store.save({ ...VALID_SESSION, deploymentUrl: "https://other.com", accountIdentity: "bob" });

  const removeResult = store.remove("https://example.com/workspace");
  assert.equal(removeResult.ok, true);

  const listResult = store.list();
  assert.equal(listResult.sessions.length, 1);
  assert.equal(listResult.sessions[0].deploymentUrl, "https://other.com");

  fs.rmSync(userDataPath, { recursive: true, force: true });
});

test("deployment session store clears all sessions", () => {
  const userDataPath = createTempDir();
  const safeStorage = createMockSafeStorage();
  const store = createDeploymentSessionStore({ userDataPath, safeStorage });

  store.save(VALID_SESSION);
  store.save({ ...VALID_SESSION, deploymentUrl: "https://other.com" });

  const clearResult = store.clear();
  assert.equal(clearResult.ok, true);

  const listResult = store.list();
  assert.equal(listResult.sessions.length, 0);

  fs.rmSync(userDataPath, { recursive: true, force: true });
});

test("deployment session store rejects invalid URLs", () => {
  const userDataPath = createTempDir();
  const safeStorage = createMockSafeStorage();
  const store = createDeploymentSessionStore({ userDataPath, safeStorage });

  const cases = [
    { ...VALID_SESSION, deploymentUrl: "" },
    { ...VALID_SESSION, deploymentUrl: "not-a-url" },
    { ...VALID_SESSION, deploymentUrl: "ftp://example.com" },
    { ...VALID_SESSION, deploymentUrl: "https://user:pass@example.com" },
    { ...VALID_SESSION, deploymentUrl: "https://example.com#hash" },
  ];

  for (const candidate of cases) {
    const result = store.save(candidate);
    assert.equal(result.ok, false, JSON.stringify(candidate));
    assert.equal(result.code, "invalid_url");
  }

  fs.rmSync(userDataPath, { recursive: true, force: true });
});

test("deployment session store rejects invalid providers", () => {
  const userDataPath = createTempDir();
  const safeStorage = createMockSafeStorage();
  const store = createDeploymentSessionStore({ userDataPath, safeStorage });

  const cases = [
    { ...VALID_SESSION, provider: "saas" },
    { ...VALID_SESSION, provider: "oidc" },
    { ...VALID_SESSION, provider: "" },
    { ...VALID_SESSION, provider: null },
  ];

  for (const candidate of cases) {
    const result = store.save(candidate);
    assert.equal(result.ok, false, JSON.stringify(candidate));
    assert.equal(result.code, "invalid_provider");
  }

  fs.rmSync(userDataPath, { recursive: true, force: true });
});

test("deployment session store rejects invalid tokens", () => {
  const userDataPath = createTempDir();
  const safeStorage = createMockSafeStorage();
  const store = createDeploymentSessionStore({ userDataPath, safeStorage });

  const cases = [
    { ...VALID_SESSION, token: "" },
    { ...VALID_SESSION, token: "has spaces" },
    { ...VALID_SESSION, token: "has\nnewline" },
    { ...VALID_SESSION, token: "a".repeat(8193) },
  ];

  for (const candidate of cases) {
    const result = store.save(candidate);
    assert.equal(result.ok, false, JSON.stringify(candidate));
    assert.equal(result.code, "invalid_token");
  }

  fs.rmSync(userDataPath, { recursive: true, force: true });
});

test("deployment session store enforces session limit", () => {
  const userDataPath = createTempDir();
  const safeStorage = createMockSafeStorage();
  const store = createDeploymentSessionStore({ userDataPath, safeStorage });

  for (let i = 0; i < 50; i++) {
    const result = store.save({ ...VALID_SESSION, deploymentUrl: `https://site${i}.com` });
    assert.equal(result.ok, true);
  }

  const result = store.save({ ...VALID_SESSION, deploymentUrl: "https://site51.com" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "too_many_sessions");

  fs.rmSync(userDataPath, { recursive: true, force: true });
});

test("deployment session store normalizes URLs", () => {
  const userDataPath = createTempDir();
  const safeStorage = createMockSafeStorage();
  const store = createDeploymentSessionStore({ userDataPath, safeStorage });

  store.save({ ...VALID_SESSION, deploymentUrl: "https://example.com/workspace/" });
  store.save({ ...VALID_SESSION, deploymentUrl: "https://example.com/workspace" });

  const listResult = store.list();
  assert.equal(listResult.sessions.length, 1, "duplicate URLs should be merged");

  fs.rmSync(userDataPath, { recursive: true, force: true });
});
