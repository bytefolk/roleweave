/** Platform-owned capability catalog used by conversational hire.
 *
 * A selected capability is only a reference. It never grants filesystem,
 * workspace, project, or network access by itself; the generated
 * permissions.json remains the source of truth for that decision.
 */

export interface HireSkillDefinition {
  id: string;
  name: string;
  description: string;
  instruction: string;
}

export const hireSkillCatalog = [
  {
    id: "issue-research",
    name: "Issue 调研",
    description: "梳理 Issue / PR，输出带证据的研究结论。",
    instruction: "先读取绑定的本地仓库与知识资料，再区分事实、推断和待确认项；结论必须带文件或记录依据。",
  },
  {
    id: "docs-review",
    name: "文档审校",
    description: "检查文档的准确性、结构和可执行性。",
    instruction: "逐条核对术语、链接、示例和版本信息；只对有依据的问题提出修改建议。",
  },
  {
    id: "release-notes",
    name: "发布说明",
    description: "从变更记录整理面向用户的发布说明。",
    instruction: "从本地变更记录提取影响范围、升级提示和已知限制，不补写没有证据的变化。",
  },
] as const satisfies readonly HireSkillDefinition[];

export type HireSkillId = (typeof hireSkillCatalog)[number]["id"];

export interface HireSkillGrant {
  id: HireSkillId;
  version?: string;
}

export interface HireMcpDefinition {
  id: string;
  name: string;
  description: string;
  tools: readonly string[];
}

/** Only platform-registered MCP servers are selectable by a hire request. */
export const hireMcpCatalog = [
  {
    id: "workspace-drive",
    name: "工作区网盘",
    description: "读取已接入的组织共享资料。",
    tools: ["list", "read"],
  },
  {
    id: "issue-tracker",
    name: "Issue 跟踪",
    description: "搜索和读取已接入的 Issue / PR 数据。",
    tools: ["search", "read"],
  },
  {
    id: "repository",
    name: "代码仓库",
    description: "搜索和读取已接入的代码仓库内容。",
    tools: ["search", "read"],
  },
] as const satisfies readonly HireMcpDefinition[];

export type HireMcpId = (typeof hireMcpCatalog)[number]["id"];

export interface HireMcpGrant {
  id: HireMcpId;
  /** Tool-level allowlist. An empty list intentionally means no MCP tool access. */
  tools: string[];
}
