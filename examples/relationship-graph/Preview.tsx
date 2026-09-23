import React, { useEffect, useState } from "react";
import { ConfigProvider, Button, Alert, theme } from "antd";
import { OwbI18nProvider } from "@roleweave/ui";
import type { RelationshipGraphResponse, RelationshipKind, RelationshipNodeKind } from "@roleweave/shared/relationship-graph";
import { RelationshipGraph } from "../../apps/desktop/renderer/src/graph/RelationshipGraph";
import "antd/dist/reset.css";
import "./preview.css";

const at = "2026-09-22T00:00:00.000Z";
const evidence = (locator: string, basis: "declared" | "observed" = "declared") => ({ source: "synthetic-preview", locator, basis, observedAt: at });
const node = (id: string, kind: RelationshipNodeKind, label: string, extra = {}) => ({ id, kind, label, state: "configured" as const, evidence: evidence(id), ...extra });
const edge = (source: string, target: string, kind: RelationshipKind, observed = false) => ({ id: `${source}:${kind}:${target}`, source, target, kind, evidence: evidence(`${source}/${kind}`, observed ? "observed" : "declared"), permission: kind.startsWith("declares_") ? "declaration_only" as const : "not_applicable" as const });
const fixture: RelationshipGraphResponse = {
  schemaVersion: "relationship-graph.v1", workspaceId: "synthetic-demo", revision: "demo-1", generatedAt: at,
  nodes: [
    node("workspace", "workspace", "产品协作空间"),
    node("qoder", "host", "Qoder"),
    node("researcher", "agent", "需求分析员", { positionId: "researcher" }),
    node("builder", "agent", "研发工程师", { positionId: "builder" }),
    node("docs", "source", "岗位知识库"),
    node("mem", "source", "共享记忆服务", { state: "available" }),
    node("brief", "resource", "客户需求记录", { positionId: "researcher", resourcePath: "knowledge/customer-needs.md", state: "ready" }),
    node("schema", "resource", "需求结构定义", { positionId: "researcher", resourcePath: "schemas/requirement.json", state: "ready" }),
    node("search", "capability", "文档检索"),
    node("policy", "policy", "知识访问声明"),
    node("goal", "goal", "梳理客户需求"),
    node("task", "task", "评估研发可行性"),
  ],
  edges: [edge("workspace", "researcher", "contains", true), edge("workspace", "builder", "contains", true), edge("researcher", "qoder", "bound_to"), edge("builder", "qoder", "bound_to"), edge("builder", "researcher", "reports_to"), edge("researcher", "docs", "declares_source"), edge("mem", "workspace", "available_in"), edge("docs", "brief", "contains_resource", true), edge("docs", "schema", "contains_resource", true), edge("researcher", "search", "declares_allow"), edge("researcher", "policy", "has_policy"), edge("goal", "researcher", "assigned_to"), edge("task", "builder", "assigned_to"), edge("task", "researcher", "requested_by")],
  coverage: [{ source: "演示数据", state: "complete", count: 12 }, { source: "真实访问血缘", state: "not_connected" }],
  truncated: false, limits: { nodes: 400, edges: 800 },
};

export default function Preview() {
  const [notice, setNotice] = useState("");
  const [locale, setLocale] = useState<"zh-CN" | "en">("zh-CN");
  const [data, setData] = useState(fixture);
  const [dark, setDark] = useState(false);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { colorPrimary: "#315be8", borderRadius: 7, fontFamily: "Inter, system-ui, sans-serif" } }}><OwbI18nProvider locale={locale}>
    <header className="preview-header"><div><b>RoleWeave</b><span>关系图谱 · 可交互预览</span></div><div><Button onClick={() => setDark(!dark)}>{dark ? "浅色" : "深色"}</Button> <Button onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}>中文 / English</Button></div></header>
    <Alert type="info" title="此预览使用合成数据，复用正式图谱组件。连接、权限、访问和跳转均不代表真实工作区状态。" />
    {notice ? <Alert closable afterClose={() => setNotice("")} title={notice} /> : null}
    <RelationshipGraph workspaceKey="synthetic-preview" data={data} loading={false}
      onReload={() => setData({ ...data, generatedAt: new Date().toISOString(), revision: String(Date.now()) })}
      onOpenAgent={id => setNotice(`演示动作：打开员工 ${id} 的工作台；正式版保留图谱上下文。`)}
      onOpenResource={(id, path) => setNotice(`演示动作：打开 ${id} / ${path}；正式版进入这份文档。`)} />
    <footer className="preview-footer">AntV G6 5.1.1 · MIT · 图谱只解释关系，授权与执行由原业务服务判定</footer>
  </OwbI18nProvider></ConfigProvider>;
}
