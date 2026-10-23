import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HirePermissions } from "@roleweave/shared";
import { CapabilityPicker, removeMcpGrants } from "../src/org/PermissionsEditor";

const EMPTY: HirePermissions = {
  tools: ["Read"],
  rules: [{ scope: "position", resource: "./knowledge/**", actions: ["read"] }],
  skills: [],
  mcpServers: [],
};

function Harness({ initial = EMPTY, variant = "default" }: { initial?: HirePermissions; variant?: "default" | "compact" }) {
  const [permissions, setPermissions] = useState(initial);
  return <CapabilityPicker variant={variant} permissions={permissions} onChange={setPermissions} />;
}

describe("CapabilityPicker MCP hire warning (#314)", () => {
  it("does not warn until an MCP connector is bound", () => {
    render(<Harness />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("prevents choosing unavailable connectors instead of rejecting them on save", () => {
    render(<Harness />);
    const connector = screen.getByRole("button", { name: /工作区网盘/ });
    expect(connector).toBeDisabled();
    expect(connector).toHaveTextContent("暂不可用");
    fireEvent.click(connector);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("also warns when editing an employee that already has a binding", () => {
    render(
      <Harness
        initial={{
          ...EMPTY,
          mcpServers: [{ id: "issue-tracker", tools: ["search"] }],
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("移除后即可继续");
    fireEvent.click(screen.getByRole("button", { name: "移除不可用的连接器" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /Issue 跟踪/ })).toBeDisabled();
  });

  it("also disables unsupported choices in the employee settings", () => {
    render(<Harness variant="compact" />);
    expect(screen.queryByRole("button", { name: /代码仓库/ })).not.toBeInTheDocument();
    expect(screen.getByText(/当前执行引擎还不能连接/)).toBeInTheDocument();
  });

  it("removes connector rules without regenerating custom Skill or filesystem constraints", () => {
    const custom = { scope: "position" as const, resource: "skill://docs-review", actions: ["execute" as const], effect: "deny" as const, approval: true };
    const policy: HirePermissions = {
      ...EMPTY,
      skills: [{ id: "docs-review", version: "1" }],
      rules: [...EMPTY.rules, custom, { scope: "workspace", resource: "mcp://repository", actions: ["execute"] }],
      mcpServers: [{ id: "repository", tools: ["read"] }],
    };
    expect(removeMcpGrants(policy)).toEqual({ ...policy, mcpServers: [], rules: [...EMPTY.rules, custom] });
  });
});
