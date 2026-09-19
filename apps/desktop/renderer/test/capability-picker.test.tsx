import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HirePermissions } from "@roleweave/shared";
import { CapabilityPicker } from "../src/org/PermissionsEditor";

const EMPTY: HirePermissions = {
  tools: ["Read"],
  rules: [{ scope: "position", resource: "./knowledge/**", actions: ["read"] }],
  skills: [],
  mcpServers: [],
};

function Harness({ initial = EMPTY }: { initial?: HirePermissions }) {
  const [permissions, setPermissions] = useState(initial);
  return <CapabilityPicker permissions={permissions} onChange={setPermissions} />;
}

describe("CapabilityPicker MCP hire warning (#314)", () => {
  it("does not warn until an MCP connector is bound", () => {
    render(<Harness />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("warns that bundled engines reject employee MCP as soon as a server is bound", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /工作区网盘/ }));
    expect(screen.getByRole("status")).toHaveTextContent("qoder.mcp_binding_unsupported");
    expect(screen.getByRole("status")).toHaveTextContent("第一回合");
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
    expect(screen.getByRole("status")).toHaveTextContent("qoder.mcp_binding_unsupported");
  });
});
