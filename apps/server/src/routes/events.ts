import type { IncomingMessage, ServerResponse } from "node:http";
import type { SseEventEnvelope } from "@roleweave/shared";
import { API_VERSION, API_VERSION_HEADER } from "@roleweave/shared";
import type { ControlPlaneContext } from "../context.js";

const HEARTBEAT_MS = 15_000;

export interface EventsStreamOptions {
  /**
   * Additive #639: server-side projection for restricted readers. Applied to
   * both the Last-Event-ID replay and the live subscription; returning null
   * drops the event for this consumer. The operator stream passes no
   * projection — the frozen v0 contract semantics are untouched.
   */
  project?: (event: SseEventEnvelope) => SseEventEnvelope | null;
  /**
   * Additive #639: receives a force-close hook once the stream is wired up.
   * The supervisor surface uses it so revoking a pairing can immediately end
   * already-established connections — authenticating only at connect time
   * does not cover a long-lived stream.
   */
  register?: (close: () => void) => void;
}

/**
 * GET /events — SSE stream with version-stamped events. Fresh connections only
 * receive future events; reconnecting clients send Last-Event-ID and receive
 * the ring-buffer replay from that stamp onward (frozen v0 contract).
 */
export function handleEvents(ctx: ControlPlaneContext, req: IncomingMessage, res: ServerResponse, options: EventsStreamOptions = {}): void {
  const project = options.project ?? ((event: SseEventEnvelope) => event);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    [API_VERSION_HEADER]: API_VERSION,
  });
  res.write(": org-workbench event stream v0\n\n");

  let closed = false;
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (ctx.bus.listenerCount === 0) ctx.relayStop.continueAll("disconnect");
  };

  const lastEventId = req.headers["last-event-id"];
  const resumeFrom =
    typeof lastEventId === "string" && /^\d+$/.test(lastEventId)
      ? Number.parseInt(lastEventId, 10)
      : ctx.bus.currentSeq;
  for (const event of ctx.bus.since(resumeFrom)) {
    const projected = project(event);
    if (projected !== null) writeEvent(res, projected);
  }

  const unsubscribe = ctx.bus.subscribe((event) => {
    const projected = project(event);
    if (projected !== null) writeEvent(res, projected);
  });

  // Additive #639: a revoked pairing (or any registered authority) can force
  // the stream closed. finish() is idempotent, so the normal close handlers
  // below stay the single cleanup path.
  options.register?.(() => {
    finish();
    res.destroy();
  });
  req.on("close", finish);
  res.on("close", finish);
}

function writeEvent(res: ServerResponse, event: SseEventEnvelope): void {
  res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
