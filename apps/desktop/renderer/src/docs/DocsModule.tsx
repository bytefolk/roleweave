import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Tabs,
  message,
} from "antd";
import { MAX_DOC_CREATE_BYTES } from "@roleweave/shared/docs";
import { useT } from "@roleweave/ui";
import { Plus } from "lucide-react";
import type {
  DocPlaneDetailResponse,
  DocPlaneListResponse,
  DocsCreateResponse,
  DocsFileListResponse,
  DocsFileResponse,
} from "@roleweave/shared";
import type { PositionMentionOption } from "../turns/types";
import { DocPlanePanel } from "./DocPlanePanel";
import type {
  DocPlaneDetailLoadResult,
  DocPlaneListLoadResult,
} from "./DocPlanePanel";
import { DocsPanel } from "./DocsPanel";

/**
 * Document module surface (#35 S3/S4 + R2, DS-35-001 rev-1 §3/§5/§6):
 * connects the ModuleRail "文档" entry to two document surfaces:
 *
 *  - the frozen position-scoped file surface (S2/S4 DocsPanel + creator), and
 *  - the new external doc-plane bridge (R2 MVP) that talks to
 *    `bytefolk/doc` through the shell-owned proxy. The proxy fails closed
 *    when the doc URL or PAT is unset, and this module surfaces the matching
 *    unconfigured state instead of pretending everything is fine.
 */
export interface DocsModuleProps {
  surface?: "position" | "plane";
  workspaceOpen: boolean;
  positions: PositionMentionOption[];
  selectedPositionId: string | null;
  /** When composed by the employee-memory surface, omit the duplicate page header. */
  embedded?: boolean;
}

function apiErrorMessage(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof (body as { message: unknown }).message === "string"
  ) {
    return (body as { message: string }).message;
  }
  return fallback;
}

function apiErrorCode(body: unknown): string | null {
  if (
    body &&
    typeof body === "object" &&
    "code" in body &&
    typeof (body as { code: unknown }).code === "string"
  ) {
    return (body as { code: string }).code;
  }
  return null;
}

export function DocsModule({
  workspaceOpen,
  positions,
  selectedPositionId,
  embedded = false,
  surface,
}: DocsModuleProps) {
  const t = useT();
  const [positionId, setPositionId] = useState<string | null>(
    selectedPositionId,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createContent, setCreateContent] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const createVersion = useRef(0);
  const createLock = useRef(false);
  const [requestedPath, setRequestedPath] = useState<{
    positionId: string;
    path: string;
  } | null>(null);

  useEffect(() => {
    setPositionId(selectedPositionId);
  }, [selectedPositionId]);

  useEffect(() => {
    createVersion.current += 1;
    createLock.current = false;
    setRequestedPath(null);
    setCreateOpen(false);
    setCreating(false);
    setCreateError(null);
    setCreateName("");
    setCreateContent("");
    return () => {
      createVersion.current += 1;
    };
  }, [positionId, workspaceOpen]);

  const listDocs = useCallback(
    async (id: string): Promise<DocsFileListResponse> => {
      const res = await window.owb.positionDocs(id);
      if (res.status >= 400 || !res.body) {
        throw new Error(apiErrorMessage(res.body, t("docs.listFail")));
      }
      return res.body;
    },
    [t],
  );

  const readDoc = useCallback(
    async (id: string, path: string): Promise<DocsFileResponse> => {
      const res = await window.owb.positionDocFile(id, path);
      if (res.status >= 400 || !res.body) {
        throw new Error(apiErrorMessage(res.body, t("docs.readFail")));
      }
      return res.body;
    },
    [t],
  );

  const docPlaneList = useCallback(
    async (query: string): Promise<DocPlaneListLoadResult> => {
      const res = await window.owb.docPlaneList(query);
      if (res.status >= 200 && res.status < 300 && res.body) {
        return { kind: "ok", response: res.body as DocPlaneListResponse };
      }
      const code = apiErrorCode(res.body);
      if (code === "doc_plane_unconfigured") {
        return {
          kind: "unconfigured",
          message: apiErrorMessage(res.body, t("docs.planeUnconfigured")),
        };
      }
      return {
        kind: "error",
        message: apiErrorMessage(res.body, t("docs.planeListError")),
      };
    },
    [],
  );

  const docPlaneDetail = useCallback(
    async (id: string): Promise<DocPlaneDetailLoadResult> => {
      const res = await window.owb.docPlaneDetail(id);
      if (res.status >= 200 && res.status < 300 && res.body) {
        return { kind: "ok", response: res.body as DocPlaneDetailResponse };
      }
      return {
        kind: "error",
        message: apiErrorMessage(res.body, t("docs.planeReadError")),
      };
    },
    [],
  );

  const submitCreate = async () => {
    if (positionId === null || createLock.current) return;
    const name = createName.trim();
    if (name === "") {
      setCreateError(t("docs.nameRequired"));
      return;
    }
    const docPath = !name.includes("/") ? `knowledge/${name}` : name;
    if (
      docPath.length > 512 ||
      !docPath
        .split("/")
        .every((segment) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment)) ||
      !/\.(md|markdown|txt|json|yaml|yml)$/i.test(docPath)
    ) {
      setCreateError(t("reading.docs.invalidPath"));
      return;
    }
    if (
      new TextEncoder().encode(createContent).byteLength > MAX_DOC_CREATE_BYTES
    ) {
      setCreateError(t("reading.docs.contentLimit"));
      return;
    }
    createLock.current = true;
    setCreating(true);
    const version = createVersion.current;
    setCreateError(null);
    try {
      const res = await window.owb.createPositionDoc({
        positionId,
        path: docPath,
        content: createContent,
      });
      if (version !== createVersion.current) return;
      if (res.status !== 201 || !res.body) {
        throw new Error(apiErrorMessage(res.body, t("docs.createFail")));
      }
      const created: DocsCreateResponse = res.body;
      message.success(t("docs.created", { path: created.path }));
      setCreateOpen(false);
      setCreateName("");
      setCreateContent("");
      setRequestedPath({ positionId, path: created.path });
      setReloadToken((token) => token + 1);
    } catch (error) {
      if (version === createVersion.current)
        setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === createVersion.current) {
        createLock.current = false;
        setCreating(false);
      }
    }
  };

  if (!workspaceOpen) {
    return (
      <section
        className={`owb-docs-module${embedded ? " owb-docs-module--embedded" : ""}`}
        aria-label={t("docs.moduleAria")}
      >
        <Empty description={t("tree.notOpened")} />
      </section>
    );
  }

  const createButton = (
    <Button
      className="owb-docs-module__create"
      disabled={positionId === null}
      icon={<Plus aria-hidden="true" size={14} />}
      onClick={() => {
        setCreateError(null);
        setCreateOpen(true);
      }}
    >
      {t("docs.create")}
    </Button>
  );

  const positionSurface = (
    <div className="owb-docs-module__position-surface">
      {!embedded ? (
        <div className="owb-docs-module__picker">
          <div className="owb-docs-module__picker-copy">
            <span>{t("docs.pickerTitle")}</span>
          </div>
          <Select
            className="owb-docs-module__select"
            aria-label={t("docs.pickPosition")}
            placeholder={t("docs.pickPosition")}
            showSearch
            optionFilterProp="label"
            allowClear
            value={positionId ?? undefined}
            onChange={(value) => setPositionId(value ?? null)}
            options={positions.map((position) => ({
              value: position.id,
              label: position.name,
            }))}
            popupMatchSelectWidth={false}
          />
          {createButton}
        </div>
      ) : null}
      <DocsPanel
        positionId={positionId}
        listDocs={listDocs}
        readDoc={readDoc}
        reloadToken={reloadToken}
        requestedPath={
          requestedPath?.positionId === positionId ? requestedPath.path : null
        }
        knowledgeFirst={embedded}
        toolbar={embedded ? createButton : undefined}
      />
    </div>
  );

  return (
    <section
      className={`owb-docs-module${embedded ? " owb-docs-module--embedded" : ""}`}
      aria-label={t("docs.moduleAria")}
    >
      {!embedded ? (
        <header className="owb-docs-module__header">
          <h1>{t("docs.moduleTitle")}</h1>
        </header>
      ) : null}
      {surface === "position" ? (
        positionSurface
      ) : surface === "plane" ? (
        <DocPlanePanel listDocs={docPlaneList} readDoc={docPlaneDetail} />
      ) : (
        <Tabs
          defaultActiveKey="position"
          items={[
            {
              key: "position",
              label: t("docs.moduleTitle"),
              children: positionSurface,
            },
            {
              key: "plane",
              label: t("docs.tabPlane"),
              children: (
                <DocPlanePanel
                  listDocs={docPlaneList}
                  readDoc={docPlaneDetail}
                />
              ),
            },
          ]}
        />
      )}
      <Modal
        title={t("docs.create")}
        open={createOpen}
        width={600}
        keyboard={!creating}
        maskClosable={!creating}
        closable={!creating}
        cancelButtonProps={{ disabled: creating }}
        okText={t("docs.createAction")}
        cancelText={t("dlg.cancel")}
        confirmLoading={creating}
        onOk={submitCreate}
        onCancel={() => {
          if (!creating) setCreateOpen(false);
        }}
      >
        <p className="owb-docs-module__create-hint">
          {t("reading.docs.createOwner", {
            name:
              positions.find((candidate) => candidate.id === positionId)
                ?.name ??
              positionId ??
              "",
          })}
        </p>
        <p>{t("reading.docs.pathHint")}</p>
        <Input
          aria-label={t("docs.fileNameAria")}
          placeholder="handbook.md"
          value={createName}
          maxLength={512}
          disabled={creating}
          onChange={(event) => setCreateName(event.target.value)}
          onPressEnter={submitCreate}
        />
        <Input.TextArea
          disabled={creating}
          style={{ marginTop: 12 }}
          rows={8}
          aria-label={t("memory.content")}
          placeholder={t("memory.contentHint")}
          value={createContent}
          onChange={(event) => setCreateContent(event.target.value)}
        />
        {createError !== null ? (
          <Alert type="error" message={createError} />
        ) : null}
      </Modal>
    </section>
  );
}
