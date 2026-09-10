import http from "node:http";
import { OrgApiError, errorCodes, routes } from "@roleweave/shared";
import { bearerAuthorized } from "./auth.js";
import type { ControlPlaneContext } from "./context.js";
import { sendError, sendJson } from "./http.js";
import { handleAssetsCreate, handleAssetsList, handleAssetsRead } from "./routes/assets.js";
import { handleDocPlaneDetail, handleDocPlaneList } from "./routes/doc-plane.js";
import { handleDocsCreate, handleDocsList, handleDocsRead, handleDocsResolve } from "./routes/docs.js";
import { handleDriveDetail, handleDriveList, handleDriveUpload } from "./routes/drive.js";
import { handleEvents } from "./routes/events.js";
import {
  handleGroupAddMember,
  handleGroupCreate,
  handleGroupGet,
  handleGroupList,
  handleGroupTimeline,
  handleGroupTurnPost,
} from "./routes/groups.js";
import { handleHealth } from "./routes/health.js";
import { handleHirePost } from "./routes/hire.js";
import { handleOrgApply, handleOrgBackups, handleOrgRestore, handleOrgTree, handleOrgUndo } from "./routes/org.js";
import { handlePositionGet } from "./routes/positions.js";
import { handleReports } from "./routes/reports.js";
import {
  handleSessionCreate,
  handleSessionContextPatch,
  handleSessionGet,
  handleSessionList,
  handleSessionRotate,
  handleSessionTurnHistory,
  handleSessionTurnPost,
} from "./routes/sessions.js";
import { handleTurnCancel, handleTurnHistory, handleTurnPost } from "./routes/turns.js";
import { handleWorkspaceCreate, handleWorkspaceGet, handleWorkspaceOpen } from "./routes/workspace.js";

/**
 * Loopback-only control-plane HTTP server (frozen v0 contract).
 * Auth: every endpoint except /health requires `Authorization: Bearer <boot-token>`.
 */
export function createControlPlane(ctx: ControlPlaneContext): http.Server {
  return http.createServer((req, res) => {
    void dispatch(ctx, req, res);
  });
}

async function dispatch(
  ctx: ControlPlaneContext,
  req: IncomingMessageLike,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    if (pathname !== routes.health && !bearerAuthorized(req, ctx.config.token)) {
      sendJson(
        res,
        401,
        new OrgApiError(errorCodes.unauthorized, 401, "missing or invalid bearer token").toBody(),
      );
      return;
    }

    if (pathname === routes.health && method === "GET") {
      await handleHealth(ctx, res);
      return;
    }
    if (pathname === routes.workspace && method === "GET") {
      await handleWorkspaceGet(ctx, res);
      return;
    }
    if (pathname === routes.workspaceOpen && method === "POST") {
      await handleWorkspaceOpen(ctx, req, res);
      return;
    }
    if (pathname === routes.workspaceCreate && method === "POST") {
      await handleWorkspaceCreate(ctx, req, res);
      return;
    }
    if (pathname === routes.orgTree && method === "GET") {
      await handleOrgTree(ctx, res);
      return;
    }
    if (pathname === routes.orgApply && method === "POST") {
      await handleOrgApply(ctx, req, res);
      return;
    }
    if (pathname === routes.orgBackups && method === "GET") {
      await handleOrgBackups(ctx, res);
      return;
    }
    if (pathname === routes.orgRestore && method === "POST") {
      await handleOrgRestore(ctx, req, res);
      return;
    }
    if (pathname === routes.orgUndo && method === "POST") {
      await handleOrgUndo(ctx, res);
      return;
    }
    if (pathname === routes.hire && method === "POST") {
      await handleHirePost(ctx, req, res);
      return;
    }
    if (pathname === routes.reports && method === "GET") {
      await handleReports(ctx, res);
      return;
    }
    if (pathname === routes.sessions && method === "POST") {
      await handleSessionCreate(ctx, req, res);
      return;
    }
    if (pathname === routes.sessions && method === "GET") {
      await handleSessionList(ctx, res, url);
      return;
    }
    const sessionMatch = pathname.match(/^\/sessions\/([^/]+)(?:\/(rotate|turns|context))?$/);
    if (sessionMatch) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(sessionMatch[1]!);
      } catch {
        throw new OrgApiError(errorCodes.session_request_invalid, 400, "malformed session id");
      }
      const operation = sessionMatch[2];
      if (operation === undefined && method === "GET") {
        await handleSessionGet(ctx, res, sessionId);
        return;
      }
      if (operation === "context" && method === "PATCH") {
        await handleSessionContextPatch(ctx, req, res, sessionId);
        return;
      }
      if (operation === "rotate" && method === "POST") {
        await handleSessionRotate(ctx, req, res, sessionId);
        return;
      }
      if (operation === "turns" && method === "POST") {
        await handleSessionTurnPost(ctx, req, res, sessionId);
        return;
      }
      if (operation === "turns" && method === "GET") {
        await handleSessionTurnHistory(ctx, res, sessionId);
        return;
      }
      sendJson(
        res,
        405,
        new OrgApiError(errorCodes.method_not_allowed, 405, `method ${method} not allowed`).toBody(),
      );
      return;
    }
    if (pathname === routes.groups && method === "POST") {
      await handleGroupCreate(ctx, req, res);
      return;
    }
    if (pathname === routes.groups && method === "GET") {
      await handleGroupList(ctx, res);
      return;
    }
    const groupMatch = pathname.match(/^\/groups\/([^/]+)(?:\/(members|turns))?$/);
    if (groupMatch) {
      let conversationRef: string;
      try {
        conversationRef = decodeURIComponent(groupMatch[1]!);
      } catch {
        throw new OrgApiError(errorCodes.group_request_invalid, 400, "malformed conversationRef");
      }
      const operation = groupMatch[2];
      if (operation === undefined && method === "GET") {
        await handleGroupGet(ctx, res, conversationRef);
        return;
      }
      if (operation === "members" && method === "POST") {
        await handleGroupAddMember(ctx, req, res, conversationRef);
        return;
      }
      if (operation === "turns" && method === "POST") {
        await handleGroupTurnPost(ctx, req, res, conversationRef);
        return;
      }
      if (operation === "turns" && method === "GET") {
        await handleGroupTimeline(ctx, res, conversationRef);
        return;
      }
      sendJson(
        res,
        405,
        new OrgApiError(errorCodes.method_not_allowed, 405, `method ${method} not allowed`).toBody(),
      );
      return;
    }
    if (pathname === routes.turnsCancel && method === "POST") {
      await handleTurnCancel(ctx, req, res);
      return;
    }
    if (pathname === routes.turns && method === "POST") {
      await handleTurnPost(ctx, req, res);
      return;
    }
    if (pathname === routes.turns && method === "GET") {
      await handleTurnHistory(ctx, res, url);
      return;
    }
    if (pathname === routes.docsList && method === "GET") {
      await handleDocsList(ctx, res, url);
      return;
    }
    if (pathname === routes.docsRead && method === "GET") {
      await handleDocsRead(ctx, res, url);
      return;
    }
    if (pathname === routes.docsCreate && method === "POST") {
      await handleDocsCreate(ctx, req, res);
      return;
    }
    if (pathname === routes.docsResolve && method === "POST") {
      await handleDocsResolve(ctx, req, res);
      return;
    }
    if (pathname === routes.docPlaneList && method === "GET") {
      await handleDocPlaneList(ctx, res, url);
      return;
    }
    if (pathname === routes.docPlaneDetail && method === "GET") {
      await handleDocPlaneDetail(ctx, res, url);
      return;
    }
    if (pathname === routes.assetsList && method === "GET") {
      await handleAssetsList(ctx, res);
      return;
    }
    if (pathname === routes.assetsRead && method === "GET") {
      await handleAssetsRead(ctx, res, url);
      return;
    }
    if (pathname === routes.assetsCreate && method === "POST") {
      await handleAssetsCreate(ctx, req, res);
      return;
    }
    if (pathname === routes.driveList && method === "GET") {
      await handleDriveList(res, url);
      return;
    }
    if (pathname === routes.driveDetail && method === "GET") {
      await handleDriveDetail(res, url);
      return;
    }
    if (pathname === routes.driveUpload && method === "POST") {
      await handleDriveUpload(res);
      return;
    }
    if (pathname === routes.events && method === "GET") {
      handleEvents(ctx, req, res);
      return;
    }
    if (pathname.startsWith(`${routes.positions}/`) && method === "GET") {
      let positionId: string;
      try {
        positionId = decodeURIComponent(pathname.slice(routes.positions.length + 1));
      } catch {
        throw new OrgApiError(errorCodes.not_found, 404, "malformed position id");
      }
      await handlePositionGet(ctx, res, positionId);
      return;
    }

    const knownPaths = Object.values(routes) as string[];
    if (knownPaths.includes(pathname) || pathname.startsWith(`${routes.positions}/`)) {
      sendJson(
        res,
        405,
        new OrgApiError(errorCodes.method_not_allowed, 405, `method ${method} not allowed`).toBody(),
      );
      return;
    }
    sendJson(
      res,
      404,
      new OrgApiError(errorCodes.not_found, 404, `no route: ${method} ${pathname}`).toBody(),
    );
  } catch (err) {
    try {
      sendError(res, err);
    } catch {
      // Response already closed (e.g. SSE drop); nothing else to do.
    }
  }
}

type IncomingMessageLike = http.IncomingMessage;
