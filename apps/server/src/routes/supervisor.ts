import { OrgApiError, errorCodes } from "@roleweave/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { buildBudgets } from "./reports.js";
import { readPositionAgentBinding } from "../agent-binding.js";
import { MAX_SUPERVISOR_PAIRINGS } from "../supervisor/store.js";
import path from "node:path";

/**
 * Additive #635: read-only supervisor surface for external fleet dashboards.
 *
 * Three operator-managed endpoints (boot token only) plus one snapshot read
 * that accepts either credential. Every response is derived strictly from
 * existing stores — this module introduces no persistence and no write path.
 */

const PAIRING_LABEL_MAX_BYTES = 64;

interface PairingRequestBody {
  label?: unknown;
}

export async function handleSupervisorPair(
  ctx: ControlPlaneContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireStore(ctx);
  const body = await readJsonBody<PairingRequestBody>(req);
  const label = readLabel(body);
  if (store.list().length >= MAX_SUPERVISOR_PAIRINGS) {
    throw new OrgApiError(errorCodes.supervisor_pairing_limit, 409, "supervisor pairing limit reached; revoke a pairing first");
  }
  const pairing = store.pair(label);
  sendJson(res, 201, {
    schemaVersion: "supervisor-pairing.v1alpha1",
    id: pairing.id,
    label,
    token: pairing.token,
    createdAt: pairing.createdAt,
  });
}

export async function handleSupervisorPairingsList(
  ctx: ControlPlaneContext,
  res: ServerResponse,
): Promise<void> {
  const store = requireStore(ctx);
  sendJson(res, 200, {
    schemaVersion: "supervisor-pairing-list.v1alpha1",
    pairings: store.list(),
    max: MAX_SUPERVISOR_PAIRINGS,
  });
}

export async function handleSupervisorPairingRevoke(
  ctx: ControlPlaneContext,
  res: ServerResponse,
  pairingId: string,
): Promise<void> {
  const store = requireStore(ctx);
  if (!store.revoke(pairingId)) {
    throw new OrgApiError(errorCodes.supervisor_pairing_missing, 404, "no such supervisor pairing");
  }
  sendJson(res, 200, { status: "revoked", id: pairingId });
}

export async function handleSupervisorSnapshot(
  ctx: ControlPlaneContext,
  res: ServerResponse,
): Promise<void> {
  requireStore(ctx); // fail closed when the surface is not wired up
  const active = ctx.workspace.active;
  if (!active) {
    sendJson(res, 200, {
      schemaVersion: "supervisor-snapshot.v1alpha1",
      workspace: { open: false },
      orgTree: null,
      positions: [],
    });
    return;
  }

  // Reuse the frozen org-tree projection (org-tree.v1) verbatim.
  const orgTree = ctx.workspace.snapshot();
  // Reuse the reports budget projection (declared vs recorded, per position).
  const records = await ctx.turnStore.reportRecords(active.dir);
  const budgets = buildBudgets(active.organization.roles, records);
  const budgetByPosition = new Map(budgets.map((entry) => [entry.positionId, entry]));
  const running = new Map(
    ctx.runningTurns.listRunning().map((entry) => [`${path.resolve(entry.workspace)}\0${entry.positionId}`, entry]),
  );

  const positions = [];
  for (const role of active.organization.roles) {
    const [activeSessionId, binding] = await Promise.all([
      ctx.sessionStore.list(active.dir, role.id).then((state) => state.activeSessionId),
      readPositionAgentBinding(active, role.id).catch(() => null),
    ]);
    const runningEntry = running.get(`${path.resolve(active.dir)}\0${role.id}`);
    positions.push({
      id: role.id,
      name: role.name,
      mode: role.mode,
      reportTo: role.reportTo,
      engineBinding: binding?.engine ?? null,
      activeSessionId,
      runningTurn: runningEntry
        ? { turnId: runningEntry.turnId ?? null }
        : null,
      budget: budgetByPosition.get(role.id) ?? null,
    });
  }

  sendJson(res, 200, {
    schemaVersion: "supervisor-snapshot.v1alpha1",
    workspace: {
      open: true,
      path: active.dir,
      business: orgTree.business,
      owner: orgTree.owner,
      version: active.version,
    },
    orgTree,
    positions,
  });
}

function requireStore(ctx: ControlPlaneContext): NonNullable<ControlPlaneContext["supervisorStore"]> {
  if (!ctx.supervisorStore) {
    throw new OrgApiError(errorCodes.internal, 500, "supervisor surface is not wired up");
  }
  return ctx.supervisorStore;
}

function readLabel(body: PairingRequestBody): string {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "label" || typeof body.label !== "string") {
    throw new OrgApiError(errorCodes.supervisor_request_invalid, 400, "supervisor pairing requires exactly { label: string }");
  }
  const label = body.label.trim();
  if (label.length === 0 || Buffer.byteLength(label, "utf8") > PAIRING_LABEL_MAX_BYTES) {
    throw new OrgApiError(errorCodes.supervisor_request_invalid, 400, `supervisor pairing label must be 1..${PAIRING_LABEL_MAX_BYTES} bytes`);
  }
  return label;
}
