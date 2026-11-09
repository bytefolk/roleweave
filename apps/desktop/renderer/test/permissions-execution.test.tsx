import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PermissionPolicyEditor } from "../src/org/PermissionsEditor";
import type { HirePermissions } from "@roleweave/shared";

for (const variant of ["default", "compact"] as const) describe(`native permission consent (${variant})`, () => {
  const permissions: HirePermissions = { tools: ["Read"], rules: [{ scope: "workspace", resource: "./repos/project/**", actions: ["read"], approval: true }] };
  it("requires separate execution and network opt-ins and exposes approval revocation", () => {
    const onChange = vi.fn();
    render(<PermissionPolicyEditor permissions={permissions} onChange={onChange} variant={variant} />);
    const execution = screen.getByRole("checkbox", { name: "允许本机终端执行" });
    expect(execution).not.toBeChecked(); fireEvent.click(execution);
    expect(onChange).toHaveBeenLastCalledWith({ ...permissions, nativeExecution: true });
    const network = screen.getByRole("checkbox", { name: "允许 Codex 工具联网" });
    expect(network).not.toBeChecked(); fireEvent.click(network);
    expect(onChange).toHaveBeenLastCalledWith({ ...permissions, network: "host_policy" });
    fireEvent.click(screen.getByRole("checkbox", { name: "逐次审批" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...permissions, rules: [{ ...permissions.rules[0], approval: false }] });
  });
  it("allows revocation and disables new consent while saving", () => {
    const onChange = vi.fn();
    const current = { ...permissions, nativeExecution: true, network: "host_policy" as const };
    const view = render(<PermissionPolicyEditor permissions={current} onChange={onChange} variant={variant} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "允许本机终端执行" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...current, nativeExecution: false });
    view.rerender(<PermissionPolicyEditor permissions={current} onChange={onChange} variant={variant} disabled />);
    expect(screen.getByRole("checkbox", { name: "允许本机终端执行" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "允许 Codex 工具联网" })).toBeDisabled();
  });
});
