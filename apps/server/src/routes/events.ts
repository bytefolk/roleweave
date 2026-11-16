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
   * Additive #639: receives a force-close hook once the stream is wired up
   * and returns the matching unregister (or void when the authority cleans
   * up on its own). The supervisor surface uses the hook so revoking a
   * pairing can immediately end already-established connections —
   * authenticating only at connect time does not cover a long-lived stream.
   * Review round 2: the returned unregister must actually be kept and
   * invoked on every finish path, otherwise normally closed streams keep
   * their socket references alive in the pairing registry until revocation.
   */
  register?: (close: () => void) => (() => void) | void;
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
  // Additive #639 (review round 2): the unregister for the force-close hook.
  // Kept and invoked exactly once from finish() so every teardown path —
  // normal close, revoked pairing, server shutdown — drains the connection
  // registry instead of leaking closers per reconnect.
  let unregisterConnection: (() => void) | undefined;
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unregisterConnection?.();
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
  // the stream closed. finish() is idempotent and now also unregisters the
  // hook below, so the normal close handlers stay the single cleanup path.
  const registered = options.register?.(() => {
    finish();
    res.destroy();
  });
  unregisterConnection = typeof registered === "function" ? registered : undefined;
  req.on("close", finish);
  res.on("close", finish);
}

function writeEvent(res: ServerResponse, event: SseEventEnvelope): void {
  res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
