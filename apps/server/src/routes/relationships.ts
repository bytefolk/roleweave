import type { ServerResponse } from "node:http";
import type { ControlPlaneContext } from "../context.js";
import { sendJson } from "../http.js";
import { projectRelationships } from "../relationships/project.js";

export async function handleRelationships(ctx: ControlPlaneContext, res: ServerResponse, url: URL): Promise<void> {
  sendJson(res, 200, await projectRelationships(ctx, url.searchParams.get("expectedWorkspacePath") ?? undefined));
}
