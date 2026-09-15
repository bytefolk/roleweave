import type { IncomingMessage, ServerResponse } from "node:http";
import { routes } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";
import { readJsonBody, sendJson } from "../http.js";
import { configureService, disconnectService, resolveServiceConnection, serviceKind, serviceView } from "../services/connections.js";
import { latestServiceRelease, probeService } from "../services/probes.js";

export async function handleServices(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method?.toUpperCase();
  if (url.pathname === routes.services && method === "GET") {
    sendJson(res, 200, { connections: (["doc", "mem"] as const).map(kind => serviceView(kind, resolveServiceConnection(ctx, kind))) });
  } else if (url.pathname === routes.servicesConfigure && method === "PUT") {
    sendJson(res, 200, configureService(ctx, await readJsonBody(req)));
  } else if (url.pathname === routes.servicesDisconnect && method === "POST") {
    const input = await readJsonBody<{kind?: unknown} | null>(req);
    sendJson(res, 200, disconnectService(ctx, serviceKind(input?.kind)));
  } else if (url.pathname === routes.servicesProbe && method === "GET") {
    sendJson(res, 200, await probeService(ctx, serviceKind(url.searchParams.get("kind"))));
  } else if (url.pathname === routes.servicesRelease && method === "GET") {
    sendJson(res, 200, await latestServiceRelease(serviceKind(url.searchParams.get("kind"))));
  } else return false;
  return true;
}
