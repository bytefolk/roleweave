import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Select, Tabs, message } from "antd";
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
import type { DocPlaneDetailLoadResult, DocPlaneListLoadResult } from "./DocPlanePanel";
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

export function DocsModule({ workspaceOpen, positions, selectedPositionId, embedded = false }: DocsModuleProps) {
  const t = useT();
  const [positionId, setPositionId] = useState<string | null>(selectedPositionId);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (selectedPositionId !== null) setPositionId(selectedPositionId);
  }, [selectedPositionId]);

  const listDocs = useCallback(async (id: string): Promise<DocsFileListResponse> => {
    const res = await window.owb.positionDocs(id);
    if (res.status >= 400 || !res.body) {
      throw new Error(apiErrorMessage(res.body, t("docs.listFail")));
    }
    return res.body;
  }, [t]);

  const readDoc = useCallback(async (id: string, path: string): Promise<DocsFileResponse> => {
    const res = await window.owb.positionDocFile(id, path);
    if (res.status >= 400 || !res.body) {
      throw new Error(apiErrorMessage(res.body, t("docs.readFail")));
    }
    return res.body;
  }, [t]);

  const docPlaneList = useCallback(async (query: string): Promise<DocPlaneListLoadResult> => {
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
  }, []);

  const docPlaneDetail = useCallback(async (id: string): Promise<DocPlaneDetailLoadResult> => {
    const res = await window.owb.docPlaneDetail(id);
    if (res.status >= 200 && res.status < 300 && res.body) {
      return { kind: "ok", response: res.body as DocPlaneDetailResponse };
    }
    return {
      kind: "error",
      message: apiErrorMessage(res.body, t("docs.planeReadError")),
    };
  }, []);

  const submitCreate = async () => {
    if (positionId === null) return;
    const name = createName.trim();
    if (name === "") {
      setCreateError(t("docs.nameRequired"));
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await window.owb.createPositionDoc({ positionId, path: name, content: "" });
      if (res.status >= 400 || !res.body) {
        throw new Error(apiErrorMessage(res.body, t("docs.createFail")));
      }
      const created: DocsCreateResponse = res.body;
      message.success(t("docs.created", { path: created.path }));
      setCreateOpen(false);
      setCreateName("");
      setReloadToken((token) => token + 1);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  if (!workspaceOpen) {
    return (
      <section className={`owb-docs-module${embedded ? " owb-docs-module--embedded" : ""}`} aria-label={t("docs.moduleAria")}>
        <Empty description={t("tree.notOpened")} />
      </section>
    );
  }

  const positionSurface = (
    <div className="owb-docs-module__position-surface">
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
          options={positions.map((position) => ({ value: position.id, label: position.name }))}
          popupMatchSelectWidth={false}
        />
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
      </div>
      <DocsPanel positionId={positionId} listDocs={listDocs} readDoc={readDoc} reloadToken={reloadToken} />
    </div>
  );

  return (
    <section className={`owb-docs-module${embedded ? " owb-docs-module--embedded" : ""}`} aria-label={t("docs.moduleAria")}>
      {!embedded ? (
        <header className="owb-docs-module__header">
          <h1>{t("docs.moduleTitle")}</h1>
        </header>
      ) : null}
      <Tabs
        defaultActiveKey="position"
        items={[
          { key: "position", label: t("docs.moduleTitle"), children: positionSurface },
          {
            key: "plane",
            label: t("docs.tabPlane"),
            children: <DocPlanePanel listDocs={docPlaneList} readDoc={docPlaneDetail} />,
          },
        ]}
      />
      <Modal
        title={t("docs.create")}
        open={createOpen}
        okText={t("docs.createAction")}
        cancelText={t("dlg.cancel")}
        confirmLoading={creating}
        onOk={submitCreate}
        onCancel={() => setCreateOpen(false)}
      >
        <p className="owb-docs-module__create-hint">{t("docs.noEditorHint")}</p>
        <Input
          aria-label={t("docs.fileNameAria")}
          placeholder="handbook.md"
          value={createName}
          onChange={(event) => setCreateName(event.target.value)}
          onPressEnter={submitCreate}
        />
        {createError !== null ? <Alert type="error" message={createError} /> : null}
      </Modal>
    </section>
  );
}
