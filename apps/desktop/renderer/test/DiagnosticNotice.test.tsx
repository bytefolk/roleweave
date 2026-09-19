import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticNotice } from "../src/DiagnosticNotice";

describe("availability actions", () => {
  it("copies diagnostics only on explicit request, with no raw text anywhere in the DOM", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const diagnostic = "Check PRIVATE_PATH / LONG_ENV_NAME before starting";
    const { container, rerender } = render(<DiagnosticNotice message="Agent unavailable" diagnostic={diagnostic} diagnosticKey="employee-a" />);
    expect(container.innerHTML).not.toContain(diagnostic);
    expect(container.querySelector("details, pre")).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "重新检查" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制诊断" }));
    await waitFor(() => expect(screen.getByText("诊断已复制")).toBeVisible());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(diagnostic);
    expect(container.innerHTML).not.toContain(diagnostic);
    rerender(<DiagnosticNotice message="Agent unavailable" diagnostic={diagnostic} diagnosticKey="employee-b" />);
    expect(screen.queryByText("诊断已复制")).not.toBeInTheDocument();
  });

  it("handles clipboard rejection without displaying its technical error or submitting a surrounding form", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("PRIVATE_PATH denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const submit = vi.fn();
    render(<form onSubmit={submit}><DiagnosticNotice message="Unavailable" diagnostic="RAW_DIAGNOSTIC" /></form>);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制诊断" })));
    expect(screen.getByText("复制失败，请重试")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/PRIVATE_PATH|RAW_DIAGNOSTIC/);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("primary repair action", () => {
  it("offers the repair action ahead of recheck and reports its outcome", async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <DiagnosticNotice message="Qoder CLI 尚未登录" primaryAction={{ label: "一键登录", onClick }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "一键登录" }));
    expect(onClick).toHaveBeenCalledExactlyOnceWith();
    rerender(
      <DiagnosticNotice
        message="Qoder CLI 尚未登录"
        primaryAction={{ label: "登录中…", busy: true, onClick }}
        linkAction={{ label: "在浏览器打开登录页", onClick }}
        primaryFeedback="登录未完成，请重试或手动运行 qodercli login"
      />,
    );
    expect(screen.getByRole("button", { name: /登录中…/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "在浏览器打开登录页" }));
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(screen.getByText("登录未完成，请重试或手动运行 qodercli login")).toBeVisible();
  });
});
