import type { TurnEngine } from "@roleweave/shared";

/** The local execution Hosts currently understood by the control plane. */
export type AgentHostId = TurnEngine;

export type AgentHostAvailabilityStatus = "available" | "unavailable";
export type AgentHostLocalProbeStatus =
  | "ready"
  | "unavailable"
  | "timed_out"
  | "unsupported_version"
  | "unknown";

/**
 * Readiness is deliberately split into three signals:
 * - localProbe: whether the Host's local binary preflight succeeded;
 * - configured: whether the Host's local prerequisites are configured;
 * - ready: whether this Host can accept a turn now.
 *
 * `engine.available` is only an execution-pipeline gate. It is not copied to
 * `configured`, and it never represents a provider account entitlement.
 */
export interface AgentHostAvailability {
  status: AgentHostAvailabilityStatus;
  localProbe: AgentHostLocalProbeStatus;
  configured: boolean;
  ready: boolean;
}

/** Stable, display-safe description of one local Agent Host. */
export interface AgentHostDescriptor {
  readonly id: AgentHostId;
  readonly label: string;
  readonly engine: TurnEngine;
  readonly availability: Readonly<AgentHostAvailability>;
  readonly reason: string | null;
  readonly capabilities: ReadonlyArray<string>;
  readonly version: string | null;
}

export interface AgentHostLocalProbeInput {
  installed: boolean;
  supported: boolean;
  version?: string | null;
  failure?: string;
  status?: string;
}

export interface AgentHostHealthInput {
  configured: boolean;
  ready: boolean;
  nextStep?: string;
  version?: string | null;
  localProbe?: AgentHostLocalProbeInput;
}

/**
 * A health-shaped input accepted by this pure registry. The function also
 * accepts a full GET /health response (the same `engine`/`hosts` fields) and
 * an optional `health` wrapper used by callers that carry other state beside
 * the snapshot.
 */
export interface AgentHostRegistryInput {
  engine: { available: boolean; version?: string };
  hosts: Partial<Record<AgentHostId, AgentHostHealthInput>>;
  localProbe?: Partial<Record<AgentHostId, AgentHostLocalProbeInput>>;
}

export type AgentHostRegistryErrorCode =
  | "agent_host_input_invalid"
  | "agent_host_unknown"
  | "agent_host_unavailable";

/** Stable error surface for Host selection; callers should branch on `code`. */
export class AgentHostRegistryError extends Error {
  readonly code: AgentHostRegistryErrorCode;
  readonly hostId?: string;

  constructor(code: AgentHostRegistryErrorCode, message: string, hostId?: string) {
    super(message);
    this.name = "AgentHostRegistryError";
    this.code = code;
    if (hostId !== undefined) this.hostId = hostId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface HostDefinition {
  readonly label: string;
  readonly capabilities: readonly string[];
}

const HOST_ORDER = ["qoder", "claude-code", "claude-local"] as const satisfies readonly AgentHostId[];

/**
 * Capabilities describe the control-plane contract, not provider account
 * state. No executable path, token, or raw CLI output is ever part of this
 * catalog.
 */
const HOST_DEFINITIONS: Readonly<Record<AgentHostId, HostDefinition>> = {
  qoder: {
    label: "Qoder",
    capabilities: ["turns", "streaming", "sessions", "groups", "approvals"],
  },
  "claude-code": {
    label: "Claude Code",
    capabilities: ["turns", "streaming", "sessions", "groups", "approvals"],
  },
  "claude-local": {
    label: "Claude Code（本地登录）",
    capabilities: ["turns", "streaming", "sessions", "groups", "approvals"],
  },
};

const LOCAL_PROBE_FAILURES = new Set<AgentHostLocalProbeStatus>([
  "timed_out",
  "unsupported_version",
  "unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownHostId(value: unknown): value is AgentHostId {
  return typeof value === "string" && (HOST_ORDER as readonly string[]).includes(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function safeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Keep only a semver-looking version. This strips labels, paths, raw stderr,
  // and any accidental account/credential text that followed the version.
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(value);
  return match?.[1] ?? null;
}

function safeReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (reason.length === 0 || reason.length > 240 || /[\0\r\n]/u.test(reason)) return null;
  // Health reasons are display text, never a place to echo arbitrary probe
  // output. Reject values that look like a path or an assigned secret.
  if (/(?:^|\s)(?:\/|~\/|[A-Za-z]:[\\/])/.test(reason)) return null;
  if (/(?:token|secret|password|credential|api[_-]?key)\s*[:=]/iu.test(reason)) return null;
  return reason;
}

function normalizeLocalProbe(value: unknown): {
  status: AgentHostLocalProbeStatus;
  version: string | null;
} {
  if (!isRecord(value) || !isBoolean(value.installed) || !isBoolean(value.supported)) {
    return { status: "unknown", version: null };
  }

  const explicitStatus = typeof value.status === "string" ? value.status : undefined;
  const explicitFailure = typeof value.failure === "string" ? value.failure : undefined;
  let status: AgentHostLocalProbeStatus;
  if (explicitStatus === "ready" || explicitStatus === "unavailable" || explicitStatus === "timed_out" || explicitStatus === "unsupported_version") {
    status = explicitStatus;
  } else if (explicitFailure !== undefined && LOCAL_PROBE_FAILURES.has(explicitFailure as AgentHostLocalProbeStatus)) {
    status = explicitFailure as AgentHostLocalProbeStatus;
  } else if (value.installed && value.supported) {
    status = "ready";
  } else {
    status = "unavailable";
  }
  return {
    status,
    version: safeVersion(value.version),
  };
}

function reasonForHost(
  health: { configured: boolean; ready: boolean; nextStep?: unknown },
  engineAvailable: boolean,
  localProbe: AgentHostLocalProbeStatus,
): string | null {
  if (engineAvailable && health.configured && health.ready) return null;
  if (!engineAvailable) return "本地执行引擎不可用";
  if (localProbe === "timed_out") return "本地版本探测超时";
  if (localProbe === "unsupported_version") return "本地主机版本不受支持";
  if (localProbe === "unavailable") return "未检测到可用的本地主机";
  if (!health.configured) return "主机尚未配置";
  return safeReason(health.nextStep) ?? "主机尚未就绪";
}

function unwrapInput(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  if (isRecord(input.health)) return input.health;
  return input;
}

function readInput(input: unknown): {
  engineAvailable: boolean;
  hosts: Record<string, unknown>;
  localProbe: Record<string, unknown>;
} | null {
  const root = unwrapInput(input);
  if (root === null || !isRecord(root.engine) || !isBoolean(root.engine.available) || !isRecord(root.hosts)) {
    return null;
  }
  for (const id of HOST_ORDER) {
    const host = root.hosts[id];
    if (!isRecord(host) || !isBoolean(host.configured) || !isBoolean(host.ready)) return null;
  }
  const localProbe = isRecord(root.localProbe)
    ? root.localProbe
    : isRecord(root.localProbes)
      ? root.localProbes
      : {};
  return {
    engineAvailable: root.engine.available,
    hosts: root.hosts,
    localProbe,
  };
}

/**
 * Build the fixed local Host catalog from an already completed health probe.
 * Invalid snapshots return an empty list; no Host is guessed or discovered.
 */
export function listRegisteredAgentHosts(input: unknown): AgentHostDescriptor[] {
  const parsed = readInput(input);
  if (parsed === null) return [];

  const descriptors: AgentHostDescriptor[] = [];
  for (const id of HOST_ORDER) {
    const rawHealth = parsed.hosts[id];
    if (!isRecord(rawHealth) || !isBoolean(rawHealth.configured) || !isBoolean(rawHealth.ready)) return [];

    const probeValue = rawHealth.localProbe ?? parsed.localProbe[id];
    const probe = normalizeLocalProbe(probeValue);
    const configured = rawHealth.configured;
    const probeProvided = probeValue !== undefined;
    // The pipeline gate can only make an otherwise-ready Host unavailable;
    // it cannot make an unconfigured Host configured. A provided but malformed
    // or failed local probe also fails closed; an absent probe remains unknown
    // because normal service-backed Hosts do not require a local binary probe.
    const ready = parsed.engineAvailable && configured && rawHealth.ready && (!probeProvided || probe.status === "ready");
    const availability: AgentHostAvailability = {
      status: ready ? "available" : "unavailable",
      localProbe: probe.status,
      configured,
      ready,
    };
    const descriptor: AgentHostDescriptor = {
      id,
      label: HOST_DEFINITIONS[id].label,
      engine: id,
      availability: Object.freeze(availability),
      reason: reasonForHost(
        { configured, ready, nextStep: rawHealth.nextStep },
        parsed.engineAvailable,
        probe.status,
      ),
      capabilities: getAgentHostCapabilities({ id, engine: id }),
      version: probe.version ?? safeVersion(rawHealth.version),
    };
    descriptors.push(Object.freeze(descriptor));
  }
  return descriptors;
}

function isDescriptor(value: unknown): value is AgentHostDescriptor {
  if (!isRecord(value) || !isKnownHostId(value.id) || value.engine !== value.id || !isRecord(value.availability)) return false;
  return value.availability.status === "available" && value.availability.ready === true;
}

function safeErrorHostId(value: string): string | undefined {
  return /^[a-z0-9-]{1,64}$/iu.test(value) ? value : undefined;
}

/** Select only a Host that has passed both local and configured readiness. */
export function selectAgentHost(hosts: unknown, id: unknown): AgentHostDescriptor {
  if (!Array.isArray(hosts) || typeof id !== "string" || id.trim().length === 0) {
    throw new AgentHostRegistryError("agent_host_input_invalid", "Agent Host selection input is invalid");
  }
  const selected = hosts.find((host) => isRecord(host) && host.id === id);
  if (selected === undefined) {
    const safeId = safeErrorHostId(id);
    throw new AgentHostRegistryError(
      "agent_host_unknown",
      safeId === undefined ? "Unknown Agent Host" : `Unknown Agent Host: ${safeId}`,
      safeId,
    );
  }
  if (!isDescriptor(selected)) {
    const safeId = safeErrorHostId(id);
    throw new AgentHostRegistryError(
      "agent_host_unavailable",
      safeId === undefined ? "Agent Host is not ready" : `Agent Host is not ready: ${safeId}`,
      safeId,
    );
  }
  return selected;
}

/**
 * Return a fresh frozen capability summary. It is derived from the registry
 * catalog rather than trusting mutable caller-supplied fields.
 */
export function getAgentHostCapabilities(host: Pick<AgentHostDescriptor, "id" | "engine"> | unknown): ReadonlyArray<string> {
  if (!isRecord(host) || !isKnownHostId(host.id) || host.engine !== host.id) return Object.freeze([]);
  return Object.freeze([...HOST_DEFINITIONS[host.id].capabilities]);
}
