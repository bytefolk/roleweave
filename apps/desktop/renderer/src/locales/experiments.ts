import { useOwbLocale } from "@roleweave/ui";

const copy = {
  title: ["智能协作建议", "Collaboration suggestions"],
  preview: ["预览", "Preview"],
  description: ["在上报中心，为失败执行提供处理建议，帮助你决定先检查什么。", "Get suggestions for failed runs in Reports, so you can decide what to inspect next."],
  scope: ["仅当前项目 · 修改立即生效", "Current project only · Changes apply immediately"],
  empty: ["请先打开一个项目，再设置实验功能。", "Open a project to configure experimental features."],
  loading: ["读取项目设置…", "Loading project settings…"],
  loadError: ["无法读取实验功能设置，请重试。", "Could not load experiment settings. Try again."],
  saveError: ["设置未保存。请刷新状态后重试。", "Settings were not saved. Refresh the status and try again."],
  storageError: ["项目设置不可用，建议已停用。请检查项目设置文件后重试。", "Project settings are unavailable and suggestions are disabled. Check the project settings file and retry."],
  unavailable: ["服务不可用：本机尚未配置 Jev 服务凭据。请联系项目维护者配置后刷新状态。", "Service unavailable: Jev credentials are not configured on this host. Ask the project maintainer to configure them, then refresh the status."],
  ready: ["已开启 · 在上报中心点击“生成建议”后才会发送请求。", "Enabled · Requests are sent only when you choose Generate suggestions in Reports."],
  enabledUnavailable: ["已开启 · 服务尚不可用", "Enabled · Service is not yet available"],
  restoreOff: ["恢复为关闭", "Restore to off"],
  off: ["已关闭 · 不会发送新的判断请求", "Off · No new judgment requests will be sent"],
  disabledNotice: ["已关闭，已有执行和上报记录保留。", "Turned off. Existing execution and report records are retained."],
  enabledNotice: ["已为当前项目开启。你可以前往上报中心生成建议。", "Enabled for this project. Generate suggestions from Reports."],
  provider: ["服务提供方", "Provider"],
  sends: ["发送范围：执行状态、规范化错误码、是否与预算相关。", "Shared fields: run status, normalized error code, and whether the issue is budget related."],
  excludes: ["不发送消息、任务或附件正文、员工姓名、项目路径。", "Message, task and attachment contents, employee names and project paths are excluded."],
  advisory: ["建议仅供参考；查看记录和采取行动仍由你决定。", "Suggestions are advisory. You decide which records to inspect and which actions to take."],
  confirmTitle: ["为当前项目开启智能协作建议？", "Enable collaboration suggestions for this project?"],
  confirm: ["同意并开启", "Agree and enable"],
  cancel: ["取消", "Cancel"],
  retry: ["重试", "Retry"],
  refresh: ["刷新状态", "Refresh status"],
  openSettings: ["打开实验功能", "Open experimental features"],
  reportTitle: ["待我处理 · 智能协作建议", "Needs my attention · Collaboration suggestions"],
  generate: ["生成建议", "Generate suggestions"],
  generateAgain: ["重新生成", "Generate again"],
  generating: ["正在生成建议…", "Generating suggestions…"],
  adviceFailed: ["建议暂不可用。原始记录仍可查看；你可以稍后重试。", "Suggestions are temporarily unavailable. Original records remain available; try again later."],
  stale: ["项目设置已更新。请确认当前状态后重新生成建议。", "Project settings were refreshed. Check the current state before generating suggestions again."],
  reportOff: ["此预览功能默认关闭，可在当前项目的实验功能中开启。", "This preview is off by default. Enable it in this project's experimental features."],
  reportIntro: ["仅依据执行状态与错误类型提供建议。点击后将发送上述元数据至 Jev / TypeSafe。", "Suggestions use run status and error type only. Generating them shares this metadata with Jev / TypeSafe."],
  noFailures: ["当前没有失败或待确认的执行，无需生成建议。", "There are no failed or indeterminate runs to assess."],
  incomplete: ["信息不足时将保留原始记录，不会自动重试、派工或批准。", "Insufficient information leaves the original records intact. No retries, assignments or approvals are performed automatically."],
  results: ["已检查 {considered} / {total} 条记录 · {count} 条建议", "Assessed {considered} / {total} records · {count} suggestions"],
  cached: ["使用本项目最近的建议", "Using recent suggestions for this project"],
  suggestion: ["参考建议", "Suggestion"],
  inspect_budget: ["检查预算配置与用量", "Inspect budget settings and usage"],
  check_connection: ["检查 Agent 连接与凭据", "Check the Agent connection and credentials"],
  inspect_run: ["查看执行记录，确认失败原因", "Inspect the run to understand the failure"],
  insufficient_information: ["信息不足，请查看原始执行记录", "Insufficient information; inspect the original run"],
} as const;

export type ExperimentCopyKey = keyof typeof copy;
export function useExperimentCopy() {
  const english = useOwbLocale() === "en";
  return (key: ExperimentCopyKey) => copy[key][english ? 1 : 0];
}
