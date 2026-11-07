import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TurnPanel, type TurnPanelProps } from "../src/turns/TurnPanel";
import { inputFeedback, turnRequestError } from "../src/turns/input-feedback";
import { zhText, OwbI18nProvider } from "@roleweave/ui";
import { TurnComposer } from "../src/turns/TurnComposer";

const image = { id: "draft-image", serverId: "11111111-1111-4111-8111-111111111111", fileName: "image.png", mimeType: "image/png", sizeBytes: 4, status: "ready" as const };
const availability = Object.fromEntries(["qoder", "claude-code", "claude-local", "codex", "codex-local", "workbuddy"].map(id => [id, { ready: true, configured: true }])) as TurnPanelProps["engineAvailability"];
function props(overrides: Partial<TurnPanelProps> = {}): TurnPanelProps {
  return { workspaceOpen: true, workspaceKey: "workspace", positions: [{ id: "owner", name: "Owner" }], selectedPositionId: "owner", engine: "codex-local", engineAvailability: availability, turns: [], selectedSessionId: "session-a", sessions: [{ sessionId: "session-a", positionId: "owner", status: "active", createdAt: "2026-10-21T00:00:00Z" }], onCreateTurn: vi.fn(), ...overrides };
}
function file() {
  const image = new File(["data"], "image.png", { type: "image/png" });
  Object.defineProperty(image, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3, 4]).buffer });
  return image;
}

describe("attachment sending and actionable input feedback", () => {
  it("explains missing instructions in the chosen locale and prevents an empty attachment-only request", () => {
    const send = vi.fn();
    const { rerender } = render(<TurnComposer value="" onChange={() => {}} placeholder="Task" disabledReason={null} running={false} canCancel={false} onSend={send} onCancel={() => {}} attachments={[image]} />);
    expect(screen.getByRole("status")).toHaveTextContent("已添加附件，请补充说明后再发送");
    expect(screen.getByRole("button", { name: "发送任务" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    rerender(<OwbI18nProvider locale="en"><TurnComposer value="" onChange={() => {}} placeholder="Task" disabledReason={null} running={false} canCancel={false} onSend={send} onCancel={() => {}} attachments={[image]} /></OwbI18nProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Describe what to do with it");
  });

  it("distinguishes UTF-8 text size, legacy empty-input errors and unrelated errors", () => {
    expect(inputFeedback("汉".repeat(87381) + "x")).toBeNull();
    expect(inputFeedback("汉".repeat(87382))).toBe("turn.inputTooLarge");
    const old = { code: "turn_request_invalid", message: "input must be non-empty and no larger than 256 KiB" };
    expect(turnRequestError(old, "", true, zhText, "fallback")).toContain("补充说明");
    expect(turnRequestError(old, "汉".repeat(87382), true, zhText, "fallback")).toContain("文字内容超过");
    expect(turnRequestError({ code: "attachment_missing", message: "missing" }, "hello", true, zhText, "fallback")).toBe("missing");
    expect(turnRequestError({ code: "turn_input_too_large" }, "hello", true, zhText, "fallback")).toContain("文字内容超过");
  });

  it("waits for every upload and submits text with the same attachment manifest exactly once", async () => {
    let finish!: (value: unknown) => void;
    const upload = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    window.owb = { ...window.owb, uploadAttachment: upload } as typeof window.owb;
    const send = vi.fn().mockResolvedValue(true);
    const { container } = render(<TurnPanel {...props({ onCreateTurn: send })} />);
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "分析图片" } });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file()] } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("附件正在上传");
    expect(screen.getByRole("button", { name: "发送任务" })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("下达任务"), { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    const attachment = { id: image.serverId, fileName: image.fileName, mimeType: image.mimeType, sizeBytes: image.sizeBytes };
    await act(async () => finish({ status: 200, body: { attachment } }));
    fireEvent.click(screen.getByRole("button", { name: "发送任务" }));
    expect(send).toHaveBeenCalledExactlyOnceWith({ positionId: "owner", engine: "codex-local", input: "分析图片", attachmentIds: [image.serverId], attachments: [attachment] });
    await waitFor(() => expect(container.querySelector(".owb-attachment-card")).toBeNull());
  });

  it("retains a failed upload and its text without sending a partial request", async () => {
    window.owb = { ...window.owb, uploadAttachment: vi.fn().mockResolvedValue({ status: 413, body: { code: "attachment_too_large" } }) } as typeof window.owb;
    const send = vi.fn();
    const { container } = render(<TurnPanel {...props({ onCreateTurn: send })} />);
    fireEvent.change(screen.getByLabelText("下达任务"), { target: { value: "分析图片" } });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file()] } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("附件上传失败"));
    expect(screen.getByRole("status")).toHaveTextContent("单个文件不超过 10 MiB");
    expect(screen.getByLabelText("下达任务")).toHaveValue("分析图片");
    expect(container.querySelector(".owb-attachment-card")).not.toBeNull();
    fireEvent.keyDown(screen.getByLabelText("下达任务"), { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a delayed upload with its original session when switching conversations", async () => {
    let finish!: (value: unknown) => void;
    window.owb = { ...window.owb, uploadAttachment: vi.fn(() => new Promise(resolve => { finish = resolve; })) } as typeof window.owb;
    const sessions = props().sessions!;
    const all = [...sessions, { ...sessions[0]!, sessionId: "session-b" }];
    const { container, rerender } = render(<TurnPanel {...props({ sessions: all })} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file()] } });
    await waitFor(() => expect(window.owb.uploadAttachment).toHaveBeenCalled());
    rerender(<TurnPanel {...props({ sessions: all, selectedSessionId: "session-b" })} />);
    await act(async () => finish({ status: 200, body: { attachment: { id: image.serverId } } }));
    expect(container.querySelector(".owb-attachment-card")).toBeNull();
    rerender(<TurnPanel {...props({ sessions: all })} />);
    expect(container.querySelector(".owb-attachment-card")).toHaveTextContent("image.png");
    expect(screen.getByRole("status")).toHaveTextContent("补充说明");
  });
});
