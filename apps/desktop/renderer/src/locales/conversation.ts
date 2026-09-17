import { useOwbLocale } from "@roleweave/ui";

const en = {
  copy: "Copy", copied: "Copied", copyFailed: "Copy failed", copyPlain: "Copy plain text", copyMarkdown: "Copy original Markdown",
  code: "Code", imageFailed: "Image unavailable", openFailed: "Could not open this link", edit: "Edit again", expand: "Show full message", collapse: "Collapse",
  replaceTitle: "Replace the current draft?", replaceBody: "Your existing draft will be replaced with this message. The original conversation stays unchanged.",
  replace: "Replace draft", keep: "Keep draft", newMessages: "New messages · Back to latest", latest: "Back to latest",
  focus: "Focus conversation", exitFocus: "Exit focus", history: "Session history", currentSession: "Current session", session: "Session", locked: "Agent fixed",
  preparing: "Loading conversation…", model: "Model", modelLoading: "Loading models…", modelFailed: "Could not load models", modelRetry: "Reload models",
  modelUnavailable: "This Host chooses its model", modelRunning: "Switch after this task ends", modelSaving: "Saving model…", modelSaved: "The next task will use this model",
  mapping: "Configured mapping", cancelled: "Cancelled · result unconfirmed",
  modelReadonly: "Model selection is unavailable for this Host", modelMissing: "Model configuration was not provided", requested: "Requested option", actual: "Reported model",
  modEnterHint: "⌘/Ctrl+Enter sends · Shift+Enter adds a line", emptySend: "Enter a message to send", sendFailed: "Could not send. Your draft has been kept.",
  profile: "Employee details", directory: "Employee directory", close: "Close", resizeDirectory: "Resize employee directory", unavailableHistory: "No session history",
  restart: "New conversation", restartTitle: "Start a new conversation? The current conversation moves to session history and stays readable.",
  restartOk: "Start", restartCancel: "Not now",
};
const zh: typeof en = {
  copy: "复制", copied: "已复制", copyFailed: "复制失败", copyPlain: "复制纯文本", copyMarkdown: "复制原始 Markdown",
  code: "代码", imageFailed: "图片加载失败", openFailed: "无法打开此链接", edit: "重新编辑", expand: "展开全文", collapse: "收起",
  replaceTitle: "替换当前草稿？", replaceBody: "当前草稿将替换成这条消息。原有对话记录保持不变。", replace: "替换草稿", keep: "保留草稿",
  newMessages: "有新消息 · 回到最新", latest: "回到最新", focus: "专注对话", exitFocus: "退出专注", history: "会话历史", currentSession: "当前会话", session: "会话", locked: "Agent 已固定",
  preparing: "正在加载会话…", model: "模型", modelLoading: "正在加载模型…", modelFailed: "加载模型失败", modelRetry: "重新加载模型",
  modelUnavailable: "由 Host 决定", modelRunning: "任务结束后可切换", modelSaving: "正在保存模型…", modelSaved: "下次任务使用此模型",
  mapping: "配置映射", cancelled: "已取消 · 结果未确认",
  modelReadonly: "此 Host 不支持选择模型", modelMissing: "未提供模型配置", requested: "请求的选项", actual: "实际回执模型",
  modEnterHint: "⌘/Ctrl+Enter 发送 · Shift+Enter 换行", emptySend: "输入消息后可发送", sendFailed: "发送失败，已保留草稿。",
  profile: "岗位信息", directory: "员工目录", close: "关闭", resizeDirectory: "调整员工目录宽度", unavailableHistory: "暂无会话历史",
  restart: "新对话", restartTitle: "开始新对话？当前对话会转入会话历史，仍可随时查看。",
  restartOk: "开始", restartCancel: "先不用",
};
export function useConversationCopy() { return useOwbLocale() === "en" ? en : zh; }
