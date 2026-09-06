import type { IncomingMessage, ServerResponse } from "node:http";
import type { SseEventEnvelope } from "@roleweave/shared";
import { API_VERSION, API_VERSION_HEADER } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";

const HEARTBEAT_MS = 15_000;

/**
 * GET /events — SSE stream with version-stamped events. Fresh connections only
 * receive future events; reconnecting clients send Last-Event-ID and receive
 * the ring-buffer replay from that stamp onward (frozen v0 contract).
 */
export function handleEvents(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    [API_VERSION_HEADER]: API_VERSION,
  });
  res.write(": org-workbench event stream v0\n\n");

  const lastEventId = req.headers["last-event-id"];
  const resumeFrom =
    typeof lastEventId === "string" && /^\d+$/.test(lastEventId)
      ? Number.parseInt(lastEventId, 10)
      : ctx.bus.currentSeq;
  for (const event of ctx.bus.since(resumeFrom)) {
    writeEvent(res, event);
  }

  const unsubscribe = ctx.bus.subscribe((event) => writeEvent(res, event));
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function writeEvent(res: ServerResponse, event: SseEventEnvelope): void {
  res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
