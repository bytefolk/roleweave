import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HireValidateDriver,
  OrgApplyDriver,
  TurnRunDriver,
  TurnRunRequest,
  TurnRunResult,
} from "@roleweave/shared";
import { EventBus } from "../src/bus.js";
import type { ControlPlaneContext } from "../src/context.js";
import { createControlPlane } from "../src/server.js";
import { WorkspaceState } from "../src/workspace-state.js";
import { TurnStore } from "../src/turns/store.js";
import { RunningTurnRegistry } from "../src/turns/running.js";
import { SessionStore } from "../src/sessions/store.js";
import { GroupStore } from "../src/groups/store.js";
import { ContextExportService, type ContextAdapterClient } from "../src/context-export/exporter.js";

export const TEST_TOKEN = "test-boot-token-0123456789abcdef";

/**
 * Assert POSIX permission bits on a file, skipping Windows: NTFS models
 * permissions as ACLs, and Node reports synthetic 0o666/0o444 mode bits there
 * regardless of the mode a file was written with, so the assertion only has
 * meaning on platforms that model permission bits.
 */
export async function assertPosixMode(file: string, expected: number): Promise<void> {
  if (process.platform === "win32") return;
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, expected, `${file} must carry mode 0${expected.toString(8)}`);
}

export const EXAMPLE_WORKSPACE = fileURLToPath(
  new URL("../../../../examples/oss-maintainer", import.meta.url),
);

export type FakeOutcome = Awaited<ReturnType<OrgApplyDriver["apply"]>>;
export type FakeHireOutcome = Awaited<ReturnType<HireValidateDriver["hireValidate"]>>;

export class FakeDriver implements OrgApplyDriver, HireValidateDriver {
  calls: string[] = [];
  hireCalls: string[] = [];
  hireEnvelopes: Array<Record<string, unknown>> = [];
  hireOutcome: FakeHireOutcome = { status: "valid" };

  constructor(
    public outcome: FakeOutcome = { status: "applied" },
    private readonly beforeReturn?: (workspaceDir: string) => Promise<void>,
  ) {}

  async apply(workspaceDir: string): Promise<FakeOutcome> {
    this.calls.push(workspaceDir);
    await this.beforeReturn?.(workspaceDir);
    return this.outcome;
  }

  async hireValidate(file: string): Promise<FakeHireOutcome> {
    this.hireCalls.push(file);
    try {
      this.hireEnvelopes.push(JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>);
    } catch {
      // The envelope is transient; capture failures must not mask the outcome.
    }
    return this.hireOutcome;
  }
}

export class DefaultFakeTurnDriver implements TurnRunDriver {
  async turnRun(request: TurnRunRequest): Promise<TurnRunResult> {
    const runId = "fake-run";
    const timestamp = new Date().toISOString();
    const events: TurnRunResult["events"] = [
      { type: "run.started", runId, timestamp },
      {
        type: "run.completed",
        runId,
        timestamp,
        output: "fake turn output",
        terminalReason: "goal_met",
      },
    ];
    for (const event of events) request.onEvent?.(event);
    return { status: "trusted", events, diagnostic: "" };
  }
}

export interface TestServer {
  baseUrl: string;
  /** Actual bound address — asserts must verify loopback here, not in the URL. */
  boundAddress: string;
  boundPort: number;
  token: string;
  ctx: ControlPlaneContext;
  close(): Promise<void>;
}

export async function startTestServer(
  driver?: OrgApplyDriver & HireValidateDriver,
  turnDriver: TurnRunDriver = new DefaultFakeTurnDriver(),
  contextExporter: ContextExportService = new ContextExportService(new UnavailableTestContextAdapter()),
): Promise<TestServer> {
  const orgDriver = driver ?? new FakeDriver();
  const ctx: ControlPlaneContext = {
    config: {
      host: "127.0.0.1",
      port: 0,
      token: TEST_TOKEN,
      cliCommand: "digital-employee",
      bundledElectronEngine: false,
      contextCliCommand: "context",
      serverVersion: "0.0.0-test",
      docPlaneUrl: undefined,
      docPlaneToken: undefined,
      docPlaneMock: false,
    },
    workspace: new WorkspaceState(),
    bus: new EventBus(),
    driver: orgDriver,
    turnDriver,
    hireDriver: orgDriver,
    turnStore: new TurnStore(),
    runningTurns: new RunningTurnRegistry(),
    sessionStore: new SessionStore(),
    groupStore: new GroupStore(),
    contextExporter,
  };
  const server = createControlPlane(ctx);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("test server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    boundAddress: address.address,
    boundPort: address.port,
    token: TEST_TOKEN,
    ctx,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

class UnavailableTestContextAdapter implements ContextAdapterClient {
  async ingest(): Promise<never> {
    throw new Error("context adapter unavailable in unrelated server test");
  }

  async distill(): Promise<never> {
    throw new Error("context adapter unavailable in unrelated server test");
  }
}

export async function copyExampleWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owb-workspace-"));
  await fs.cp(EXAMPLE_WORKSPACE, dir, { recursive: true });
  return dir;
}

export interface ApiResponse {
  status: number;
  header(name: string): string | undefined;
  body: unknown;
}

export async function api(
  baseUrl: string,
  pathname: string,
  options: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<ApiResponse> {
  const { method = "GET", token, body } = options;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return {
    status: res.status,
    header: (name: string) => res.headers.get(name) ?? undefined,
    body: parsed,
  };
}

export interface SseClient {
  events: Array<{ id?: string; event?: string; data: string }>;
  waitForEvent(type: string, timeoutMs?: number): Promise<{ id?: string; data: string }>;
  close(): void;
}

export function connectSse(baseUrl: string, token: string, lastEventId?: string): SseClient {
  const events: SseClient["events"] = [];
  const waiters: Array<(value: void) => void> = [];
  const req = http.get(
    `${baseUrl}/events`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
        ...(lastEventId !== undefined ? { "last-event-id": lastEventId } : {}),
      },
    },
    (res) => {
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += String(chunk);
        let sep = buffer.indexOf("\n\n");
        while (sep >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf("\n\n");
          const frame: { id?: string; event?: string; data: string } = { data: "" };
          for (const line of raw.split("\n")) {
            if (line.startsWith("id: ")) frame.id = line.slice(4);
            else if (line.startsWith("event: ")) frame.event = line.slice(7);
            else if (line.startsWith("data: ")) frame.data += line.slice(6);
          }
          if (frame.data.length > 0 || frame.event !== undefined) {
            events.push(frame);
            for (const waiter of waiters.splice(0)) waiter();
          }
        }
      });
    },
  );
  return {
    events,
    waitForEvent(type, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        const check = (): void => {
          const found = events.find((frame) => frame.event === type);
          if (found) {
            clearTimeout(deadline);
            resolve({ id: found.id, data: found.data });
            return;
          }
          waiters.push(() => check());
        };
        check();
      });
    },
    close: () => req.destroy(),
  };
}
