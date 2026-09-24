import crypto from "node:crypto";
import {
  OrgApiError, errorCodes, isPositionId, reportAdviceSuggestions,
  type BudgetRemainingAdviceRequest, type BudgetRemainingAdviceResponse,
  type ExperimentsResponse, type ExperimentsUpdateRequest, type ReportsAdviceRequest,
  type ReportsAdviceResponse,
} from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import type { OpenWorkspace } from "../workspace-state.js";
import { readReports } from "../routes/reports.js";
import { LAYA_ENDPOINT, LayaAdviceProvider, MAX_ADVICE_ITEMS, normalizeAdviceMetadata, type AdviceProvider } from "./provider.js";
import { readExperiments, writeExperiments, type StoredExperiments } from "./store.js";
import { askLaya } from "../laya/client.js";
import { projectBudgetRemainingFact, resolveBudgetRemainingChoice } from "../turns/budget-remaining-advice.js";

const conflict = () => new OrgApiError(errorCodes.experiments_conflict, 409, "workspace or experimental settings changed; reload before trying again");
const invalid = () => new OrgApiError(errorCodes.experiments_request_invalid, 400, "invalid experimental settings request");
const TIMEOUT = Symbol("advice timeout");
interface WorkspaceExperiments {
  workspace: OpenWorkspace;
  session: string;
  generation: number;
  revisionHighWater: number;
  pending: Promise<unknown>;
  stored?: StoredExperiments;
  inhibited: boolean;
  cache: Map<string, { until: number; response: ReportsAdviceResponse }>;
  inFlight: Map<string, { controller: AbortController; result: Promise<ReportsAdviceResponse> }>;
}

export function parseExperimentsRequest(raw: unknown, update: true): ExperimentsUpdateRequest;
export function parseExperimentsRequest(raw: unknown, update: false): ReportsAdviceRequest;
export function parseExperimentsRequest(raw: unknown, update: boolean): ExperimentsUpdateRequest | ReportsAdviceRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const body = raw as Record<string, unknown>;
  const fields = ["workspacePath", "workspaceSession", "revision", ...(update ? ["enabled"] : [])];
  if (Object.keys(body).some(key => !fields.includes(key)) ||
    typeof body.workspacePath !== "string" || body.workspacePath.length === 0 || body.workspacePath.length > 8_192 ||
    typeof body.workspaceSession !== "string" || !/^[a-f0-9-]{36}$/.test(body.workspaceSession) ||
    !Number.isSafeInteger(body.revision) || (body.revision as number) < 0 ||
    (update && typeof body.enabled !== "boolean")) throw invalid();
  return body as unknown as ExperimentsUpdateRequest;
}

export function parseBudgetRemainingAdviceRequest(raw: unknown): BudgetRemainingAdviceRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(key => !["workspacePath", "workspaceSession", "revision", "positionId"].includes(key)) ||
    !isPositionId(body.positionId)) throw invalid();
  const scope = parseExperimentsRequest({
    workspacePath: body.workspacePath,
    workspaceSession: body.workspaceSession,
    revision: body.revision,
  }, false);
  return { ...scope, positionId: body.positionId };
}

export function experiments(ctx: ControlPlaneContext): ExperimentsService {
  return ctx.experimentsService ??= new ExperimentsService(ctx);
}

/** Explicit user actions only; no polling, event hook, or settings read calls local Laya. */
export class ExperimentsService {
  private active?: WorkspaceExperiments;
  private readonly provider: AdviceProvider;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  constructor(private readonly ctx: ControlPlaneContext, options: { provider?: AdviceProvider; now?: () => number } = {}) {
    this.provider = options.provider ?? new LayaAdviceProvider(ctx.config.layaUrl, ctx.config.layaModel);
    this.now = options.now ?? Date.now;
    this.unsubscribe = ctx.workspace.onOpened(() => {
      if (this.active) this.invalidate(this.active);
      this.active = undefined;
    });
  }

  close(): void {
    if (this.active) this.invalidate(this.active);
    this.unsubscribe();
  }

  private state(workspace: OpenWorkspace): WorkspaceExperiments {
    if (this.ctx.workspace.active !== workspace) throw conflict();
    if (this.active?.workspace !== workspace) {
      if (this.active) this.invalidate(this.active);
      this.active = { workspace, session: crypto.randomUUID(), generation: 0, revisionHighWater: 0, pending: Promise.resolve(), inhibited: false, cache: new Map(), inFlight: new Map() };
    }
    return this.active;
  }

  private assertCurrent(state: WorkspaceExperiments, request?: ReportsAdviceRequest): void {
    if (this.ctx.workspace.active !== state.workspace || this.active !== state ||
      (request && (request.workspacePath !== state.workspace.dir || request.workspaceSession !== state.session))) throw conflict();
  }

  private invalidate(state: WorkspaceExperiments): void {
    state.generation += 1;
    state.cache.clear();
    for (const work of state.inFlight.values()) work.controller.abort();
    state.inFlight.clear();
  }

  private serial<T>(state: WorkspaceExperiments, work: () => Promise<T>): Promise<T> {
    const result = state.pending.then(work, work);
    state.pending = result.catch(() => undefined);
    return result;
  }

  private async refresh(state: WorkspaceExperiments): Promise<StoredExperiments> {
    let stored = await readExperiments(state.workspace.dir);
    this.assertCurrent(state);
    if (!stored.valid || stored.settings.revision < state.revisionHighWater) {
      // Repair must not reuse a revision seen by this workspace opening. A
      // rolled-back valid file cannot silently restore an earlier opt-in either.
      stored = { valid: false, settings: { schemaVersion: "experiments.v1", enabled: false, revision: state.revisionHighWater } };
    } else {
      state.revisionHighWater = stored.settings.revision;
    }
    if (state.stored && JSON.stringify(state.stored) !== JSON.stringify(stored)) this.invalidate(state);
    state.stored = stored;
    return stored;
  }

  private view(state: WorkspaceExperiments, stored: StoredExperiments): ExperimentsResponse {
    const enabled = stored.valid && !state.inhibited && stored.settings.enabled;
    const configured = this.ctx.config.layaEnabled;
    return {
      schemaVersion: "experiments.v1", workspacePath: state.workspace.dir, workspaceSession: state.session,
      revision: stored.settings.revision, enabled,
      availability: !stored.valid || state.inhibited ? "storage_error" : !enabled ? "disabled" : configured ? "ready" : "not_configured",
      provider: { name: "Laya · local", endpointHost: "127.0.0.1", endpointUrl: this.ctx.config.layaUrl || LAYA_ENDPOINT, configured },
      sending: ["status", "errorCode", "budgetRelated"],
      budgetAdviceSending: ["remainingPerTask", "remainingPerDay", "positionId"],
    };
  }

  async get(workspace: OpenWorkspace): Promise<ExperimentsResponse> {
    const state = this.state(workspace);
    return this.serial(state, async () => this.view(state, await this.refresh(state)));
  }

  async update(workspace: OpenWorkspace, request: ExperimentsUpdateRequest): Promise<ExperimentsResponse> {
    const state = this.state(workspace);
    return this.serial(state, async () => {
      this.assertCurrent(state, request);
      const stored = await this.refresh(state);
      if (stored.settings.revision !== request.revision) throw conflict();
      if (!stored.valid && request.enabled) throw new OrgApiError(errorCodes.experiments_storage_failed, 409, "reset the invalid experimental setting to disabled before enabling it");
      if (stored.settings.revision === Number.MAX_SAFE_INTEGER) throw conflict();
      // Revoke requests before disk I/O. Failed persistence remains inhibited until a successful save.
      this.invalidate(state);
      state.inhibited = true;
      const next = { schemaVersion: "experiments.v1" as const, enabled: request.enabled, revision: stored.settings.revision + 1 };
      await writeExperiments(workspace.dir, next, () => this.assertCurrent(state, request));
      this.assertCurrent(state, request);
      state.stored = { settings: next, valid: true };
      state.revisionHighWater = next.revision;
      state.inhibited = false;
      return this.view(state, state.stored);
    });
  }

  async advise(workspace: OpenWorkspace, request: ReportsAdviceRequest): Promise<ReportsAdviceResponse> {
    const state = this.state(workspace);
    const generation = await this.serial(state, async () => {
      this.assertCurrent(state, request);
      const stored = await this.refresh(state);
      if (stored.settings.revision !== request.revision) throw conflict();
      return state.generation;
    });
    const base: ReportsAdviceResponse = { ...request, status: "unavailable", items: [], cached: false, considered: 0, total: 0, generatedAt: null };
    const stored = state.stored!;
    if (!stored.valid || state.inhibited) return { ...base, reason: "settings_invalid" };
    if (!stored.settings.enabled) return { ...base, status: "disabled" };
    if (!this.ctx.config.layaEnabled) return { ...base, reason: "not_configured" };
    const reports = await readReports(this.ctx, workspace);
    this.assertGeneration(state, generation);
    const selected = reports.streams.escalations.slice(0, MAX_ADVICE_ITEMS);
    base.total = reports.streams.escalations.length;
    base.considered = selected.length;
    if (selected.length === 0) return { ...base, status: "ready", generatedAt: new Date(this.now()).toISOString() };
    const metadata = selected.map(normalizeAdviceMetadata);
    const key = crypto.createHash("sha256").update(JSON.stringify([request.revision, base.total, selected, metadata])).digest("hex");
    const cached = state.cache.get(key);
    if (cached && cached.until > this.now()) return { ...cached.response, cached: true };
    const existing = state.inFlight.get(key);
    if (existing) {
      const response = await existing.result;
      this.assertGeneration(state, generation);
      return { ...response, cached: true };
    }
    // One bounded batch at a time; a changed snapshot supersedes pending advice.
    for (const pending of state.inFlight.values()) pending.controller.abort();
    state.inFlight.clear();
    const controller = new AbortController();
    const result = this.evaluate(state, generation, controller, metadata, base, selected).then(async response => {
      // Re-read consent before publishing: a manual edit/corruption discovered here
      // also revokes a response that was already in flight.
      await this.serial(state, () => this.refresh(state));
      this.assertGeneration(state, generation);
      if (controller.signal.aborted && response.reason !== "timeout") throw conflict();
      state.cache.set(key, { until: this.now() + (response.status === "ready" ? 5 * 60_000 : 30_000), response });
      while (state.cache.size > 8) state.cache.delete(state.cache.keys().next().value!);
      return response;
    }).finally(() => {
      if (state.inFlight.get(key)?.controller === controller) state.inFlight.delete(key);
    });
    state.inFlight.set(key, { controller, result });
    return result;
  }

  async adviseBudgetRemaining(
    workspace: OpenWorkspace,
    request: BudgetRemainingAdviceRequest,
  ): Promise<BudgetRemainingAdviceResponse> {
    const state = this.state(workspace);
    type Prepared =
      | { response: BudgetRemainingAdviceResponse }
      | { generation: number; base: BudgetRemainingAdviceResponse };
    const prepared = await this.serial<Prepared>(state, async () => {
      this.assertCurrent(state, request);
      const stored = await this.refresh(state);
      if (stored.settings.revision !== request.revision) throw conflict();
      if (!workspace.organization.roles.some(role => role.id === request.positionId)) throw invalid();
      const base: BudgetRemainingAdviceResponse = {
        workspacePath: request.workspacePath,
        workspaceSession: request.workspaceSession,
        revision: request.revision,
        status: "unavailable",
        fact: { positionId: request.positionId, remainingPerTask: null, remainingPerDay: null },
        suggestion: null,
      };
      if (!stored.valid || state.inhibited) return { response: { ...base, reason: "settings_invalid" } };
      if (!stored.settings.enabled) return { response: { ...base, status: "disabled", reason: "flag_off" } };
      return { generation: state.generation, base };
    });
    if ("response" in prepared) return prepared.response;

    const reports = await readReports(this.ctx, workspace);
    this.assertGeneration(state, prepared.generation);
    const fact = projectBudgetRemainingFact(
      request.positionId,
      reports.budgets.find(candidate => candidate.positionId === request.positionId),
    );
    const base: BudgetRemainingAdviceResponse = { ...prepared.base, fact };
    if (fact.remainingPerTask === null || fact.remainingPerDay === null) {
      return { ...base, status: "abstained", reason: "unknown_remaining" };
    }
    if (!this.ctx.config.layaEnabled) return { ...base, reason: "not_configured" };
    const suggestion = await resolveBudgetRemainingChoice({
      positionId: fact.positionId,
      remainingPerTask: fact.remainingPerTask,
      remainingPerDay: fact.remainingPerDay,
    }, body => askLaya(body, { env: {
      ROLEWEAVE_LAYA_ENABLED: "1",
      ROLEWEAVE_LAYA_URL: this.ctx.config.layaUrl,
      ROLEWEAVE_LAYA_MODEL: this.ctx.config.layaModel,
      ROLEWEAVE_LAYA_TIMEOUT_MS: String(this.ctx.config.layaTimeoutMs),
    }, strictAnswerShape: true }));
    await this.serial(state, async () => {
      await this.refresh(state);
      this.assertGeneration(state, prepared.generation);
    });
    return suggestion === null
      ? { ...base, status: "abstained", reason: "insufficient_information" }
      : { ...base, status: "ready", suggestion };
  }

  private assertGeneration(state: WorkspaceExperiments, generation: number): void {
    this.assertCurrent(state);
    if (state.generation !== generation || state.inhibited || !state.stored?.settings.enabled) throw conflict();
  }

  private async evaluate(
    state: WorkspaceExperiments, generation: number, controller: AbortController,
    metadata: Parameters<AdviceProvider["evaluate"]>[0], base: ReportsAdviceResponse,
    selected: Array<{ turnId: string; positionId: string; at: string }>,
  ): Promise<ReportsAdviceResponse> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(timedOut ? TIMEOUT : conflict());
        controller.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, this.ctx.config.layaTimeoutMs));
      });
      const suggestions = await Promise.race([this.provider.evaluate(metadata, controller.signal), stopped]);
      this.assertGeneration(state, generation);
      if (controller.signal.aborted) throw conflict();
      if (suggestions.length !== selected.length || suggestions.some(value => !reportAdviceSuggestions.includes(value))) throw new Error("invalid suggestions");
      return { ...base, status: "ready", generatedAt: new Date(this.now()).toISOString(), items: selected.map((item, index) => ({
        turnId: item.turnId, positionId: item.positionId, at: item.at, suggestion: suggestions[index]!, source: "laya",
      })) };
    } catch (error) {
      this.assertGeneration(state, generation);
      if (controller.signal.aborted && !timedOut) throw conflict();
      return { ...base, reason: error === TIMEOUT || timedOut ? "timeout" : "provider_error" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  }
}
