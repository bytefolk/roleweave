import type { ExternalServiceKind, ServiceProbe, ServiceRelease } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { requestService, resolveServiceConnection } from "./connections.js";
import { normalizeDocEntry } from "./doc-contract.js";
import { normalizeMemFile } from "./mem-contract.js";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const success = (status: number) => status >= 200 && status < 300;
/** Probe the contracts actually consumed, rather than assuming 0.x semver stability. */
export async function probeService(ctx: Pick<ControlPlaneContext, "config">, kind: ExternalServiceKind): Promise<ServiceProbe> {
  const result: ServiceProbe = { kind, state: "unconfigured", apiVersion: "v1", version: null, message: "Service is not configured", checkedAt: new Date().toISOString() };
  const connection = resolveServiceConnection(ctx, kind);
  if (!connection) return result;
  try {
    const paths = kind === "doc" ? ["/api/health", "/api/v1/me", "/api/v1/documents?limit=1"] : ["/v1/version", "/v1/capabilities", "/v1/files?limit=1"];
    const responses = await Promise.all(paths.map(path => requestService(connection, path)));
    const [health, auth, list] = responses;
    if (responses.some(response => response.status === 401 || response.status === 403)) {
      return { ...result, state: "unauthorized", message: "Check the service token, read permission and workspace access" };
    }
    if (responses.some(response => response.status >= 500)) return { ...result, state: "unavailable", message: "Service is not ready" };
    const healthBody = object(health!.body); const authBody = object(auth!.body); const listBody = object(list!.body);
    let compatible = responses.every(response => success(response.status));
    if (kind === "doc") {
      const identity = object(authBody.data);
      compatible &&= healthBody.service === "doc-web" && healthBody.status === "ok" && identity.authenticated === true && Array.isArray(identity.scopes) && Array.isArray(listBody.data) && listBody.data.length <= 1;
      if (compatible && !(identity.scopes as unknown[]).includes("documents:read")) return { ...result, state: "unauthorized", message: "The doc token requires documents:read" };
      compatible &&= (Array.isArray(listBody.data) ? listBody.data : []).every(item => normalizeDocEntry(item) !== null);
      // doc currently publishes no runtime version endpoint. Do not invent a deployed version.
    } else {
      const permissions = object(authBody.permissions);
      compatible &&= typeof healthBody.version === "string" && typeof permissions.read === "boolean" && (Array.isArray(listBody.files) || listBody.files === null);
      if (compatible && !permissions.read) return { ...result, state: "unauthorized", message: "The mem token requires read permission" };
      const files: unknown[] = Array.isArray(listBody.files) ? listBody.files : [];
      compatible &&= files.length <= 1 && files.every(file => normalizeMemFile(file) !== null);
      if (typeof healthBody.version === "string" && healthBody.version.length <= 80) result.version = healthBody.version;
    }
    return { ...result, state: compatible ? "ready" : "incompatible", message: compatible ? "Current v1 read contracts verified" : "This deployment does not match the supported v1 read contracts" };
  } catch {
    return { ...result, state: "unavailable", message: "Service could not be reached or its response exceeded the allowed limits" };
  }
}
/** Query only official release metadata; never forward service credentials to GitHub. */
export async function latestServiceRelease(kind: ExternalServiceKind): Promise<ServiceRelease> {
  const url = `https://github.com/bytefolk/${kind}/releases`;
  const result: ServiceRelease = { kind, state: "unavailable", version: null, url, publishedAt: null, artifact: kind === "mem" ? "mcp-client" : "source" };
  try {
    const response = await requestService({kind,apiUrl:"https://api.github.com",webUrl:url}, `/repos/bytefolk/${kind}/releases/latest`);
    if (response.status === 404) return { ...result, state: "unpublished" };
    const body = object(response.body);
    if (!success(response.status) || typeof body.tag_name !== "string" || body.tag_name.length > 128 || body.draft === true || body.prerelease === true) return result;
    return { ...result, state: "available", version: body.tag_name, publishedAt: typeof body.published_at === "string" ? body.published_at : null };
  } catch { return result; }
}
