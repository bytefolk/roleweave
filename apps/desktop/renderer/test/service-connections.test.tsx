import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ServiceConnectionView, ServiceConnectionInput } from "@roleweave/shared";
import { ServiceConnections } from "../src/settings/ServiceConnections";
import { ServiceLaunch } from "../src/settings/ServiceLaunch";

function installBridge(configured = true) {
  let connection: ServiceConnectionView = { kind: "doc", apiUrl: configured ? "https://docs.example" : null,
    webUrl: configured ? "https://docs.example/work" : null, configured, tokenConfigured: configured, workspaceId: null };
  const services = {
    list: vi.fn(async () => ({ status: 200, body: { connections: [connection] } })),
    configure: vi.fn(async (request: ServiceConnectionInput) => {
      connection = { ...connection, configured: true, apiUrl: request.apiUrl, webUrl: request.webUrl || request.apiUrl,
        tokenConfigured: request.token === "" ? false : !!request.token || connection.tokenConfigured };
      return { status: 200, body: connection };
    }),
    disconnect: vi.fn(async () => { connection = { ...connection, configured: false, apiUrl: null, webUrl: null, tokenConfigured: false }; return { status: 200, body: connection }; }),
    probe: vi.fn(async () => ({ status: 200, body: { kind: "doc", state: "ready", version: null, apiVersion: "v1", checkedAt: "2026-09-13T00:00:00.000Z" } })),
    release: vi.fn(async () => ({ status: 200, body: { kind: "doc", state: "unpublished", artifact: "source", version: null } })),
    open: vi.fn(async () => ({ status: 200, body: { opened: true } })),
    openRelease: vi.fn(async () => ({ status: 200, body: { opened: true } })),
  };
  Object.defineProperty(window, "owb", { configurable: true, value: { services } });
  return services;
}

describe("independent service connections", () => {
  it("submits a PAT once, clears the password field, and leaves an unchanged saved token omitted", async () => {
    const services = installBridge();
    render(<ServiceConnections kind="doc" />);
    const token = await screen.findByLabelText("个人访问令牌（PAT）");
    fireEvent.change(token, { target: { value: "fresh-pat" } });
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await screen.findByText("连接已保存，可以检查服务是否可访问。");
    expect(services.configure).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "doc", token: "fresh-pat" }));
    expect(token).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() => expect(services.configure).toHaveBeenCalledTimes(2));
    expect(services.configure.mock.calls[1][0]).not.toHaveProperty("token");
  });

  it("requires explicit token removal and probes the saved service by kind", async () => {
    const services = installBridge();
    render(<ServiceConnections kind="doc" />);
    fireEvent.click(await screen.findByLabelText("保存时移除已有令牌"));
    fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
    await waitFor(() => expect(services.configure).toHaveBeenCalledWith(expect.objectContaining({ token: "" })));
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await screen.findByText("服务 API 可访问，授权有效");
    expect(services.probe).toHaveBeenCalledWith("doc");
    expect(screen.getByText(/服务未报告/)).toBeInTheDocument();
  });

  it("reports unpublished source releases without claiming an installed server update", async () => {
    const services = installBridge();
    render(<ServiceConnections kind="doc" />);
    fireEvent.click(await screen.findByRole("button", { name: "查询上游版本" }));
    await screen.findByText(/暂无已发布版本，请查看项目源码与部署说明/);
    expect(services.release).toHaveBeenCalledWith("doc");
    expect(screen.getByText(/查询上游不会自动更新正在运行的服务/)).toBeInTheDocument();
  });

  it("opens native Doc only through its enumerated saved connection", async () => {
    const services = installBridge();
    render(<ServiceLaunch kind="doc" />);
    fireEvent.click(await screen.findByRole("button", { name: "打开 Doc" }));
    await waitFor(() => expect(services.open).toHaveBeenCalledWith("doc"));
    expect(services.open.mock.calls[0]).toEqual(["doc"]);
  });

  it("connects from the memory source and updates its launch action immediately", async () => {
    const services = installBridge(false);
    render(<ServiceLaunch kind="doc" />);
    fireEvent.click(screen.getByRole("button", { name: "连接 Doc" }));
    const dialog = await screen.findByRole("dialog");
    const api = await within(dialog).findByLabelText("API 基础地址");
    fireEvent.change(api, { target: { value: "http://localhost:3100" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存连接" }));
    await within(dialog).findByText("连接已保存，可以检查服务是否可访问。");
    await waitFor(() => expect(services.list.mock.calls.length).toBeGreaterThan(2));
    expect(screen.getAllByRole("button", { name: "打开 Doc" }).length).toBe(2);
  });
});
