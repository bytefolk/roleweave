import { useOwbLocale } from "@roleweave/ui";

const en = {
  glob: "Find files", read: "Read file", grep: "Search contents", write: "Write file", edit: "Edit file",
  terminal: "Run command", webSearch: "Search the web", webFetch: "Read web page", agent: "Run agent", todo: "Update task list",
  tool: "Run tool", details: "Show full details", collapseDetails: "Hide details", narration: "Progress note", running: "In progress", completed: "Completed", failed: "Failed",
  missingDetails: "No parameters were provided for this step.",
  pattern: "Pattern", files: "File scope", offset: "Start line", limit: "Read limit", path: "Path", resourceLink: "Document link: ",
};
const zh: typeof en = {
  glob: "查找文件", read: "读取文件", grep: "搜索内容", write: "写入文件", edit: "编辑文件",
  terminal: "执行命令", webSearch: "搜索网页", webFetch: "读取网页", agent: "执行子任务", todo: "更新任务列表",
  tool: "调用工具", details: "展开详情", collapseDetails: "收起详情", narration: "进展说明", running: "执行中", completed: "已完成", failed: "失败",
  missingDetails: "此步骤未提供参数详情。",
  pattern: "匹配规则", files: "文件范围", offset: "起始行", limit: "读取上限", path: "路径", resourceLink: "文档链接：",
};
export function useActivityCopy() { return useOwbLocale() === "en" ? en : zh; }

export function activityAction(title: string | undefined, copy: typeof en): string {
  const name = (title ?? "").toLowerCase().replace(/[\s_.-]/g, "");
  if (/^(glob|globsearch|findfiles)$/.test(name)) return copy.glob;
  if (/^(read|readfile|readfiles)$/.test(name)) return copy.read;
  if (/^(grep|search|searchfiles|searchcontents)$/.test(name)) return copy.grep;
  if (/^(write|writefile)$/.test(name)) return copy.write;
  if (/^(edit|editfile|multiedit|applypatch)$/.test(name)) return copy.edit;
  if (/^(terminal|bash|shell|exec|execcommand|runcommand)$/.test(name)) return copy.terminal;
  if (/^(websearch)$/.test(name)) return copy.webSearch;
  if (/^(webfetch|fetch)$/.test(name)) return copy.webFetch;
  if (/^(agent|task)$/.test(name)) return copy.agent;
  if (/^(todowrite|updatetodos)$/.test(name)) return copy.todo;
  return copy.tool;
}
