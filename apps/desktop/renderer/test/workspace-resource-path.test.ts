import { describe, expect, it } from "vitest";
import { workspaceResourcePath } from "../src/workspace-resource-path";

describe("workspace source paths", () => {
  it("retains relative source paths and maps absolute POSIX paths inside the workspace", () => {
    expect(workspaceResourcePath("/home/user/project", "apps/server/src/index.ts")).toBe("apps/server/src/index.ts");
    expect(workspaceResourcePath("/home/user/project/", "/home/user/project/work/研发.md")).toBe("work/研发.md");
  });
  it("maps native Windows and UNC source paths without losing spaces or filename case", () => {
    expect(workspaceResourcePath("C:\\Users\\User\\Project", "c:\\users\\user\\project\\src\\My File.ts")).toBe("src/My File.ts");
    expect(workspaceResourcePath("\\\\wsl.localhost\\Ubuntu\\home\\user\\project", "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\\src\\index.ts")).toBe("src/index.ts");
    expect(workspaceResourcePath("\\\\wsl.localhost\\Ubuntu\\home\\user\\project", "\\\\wsl.localhost\\Ubuntu\\home\\User\\project\\src\\index.ts")).toBeUndefined();
  });
  it.each(["/home/user/project-copy/private.ts", "/etc/passwd", "../secret.ts", "src/../../secret.ts", "file:///home/user/project/src/index.ts", "https://example.test/src/index.ts", "C:\\outside\\secret.ts", ".env", "src/./index.ts", "src/line\nname.ts"])("refuses outside or unroutable source %s", source => {
    expect(workspaceResourcePath("/home/user/project", source)).toBeUndefined();
  });
});
