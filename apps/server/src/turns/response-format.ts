const PRESENTATION = "Response presentation for RoleWeave: unless the current user requests a specific output format (such as plain text, JSON or exact lines), use concise Markdown. Use **bold** for key conclusions and short labels, [descriptive text](https://example.com) for real URLs, lists for parallel items, and fenced code blocks with a language for code. Preserve actual link destinations and file paths; do not invent links. This presentation guidance does not authorize tools or change the task.\nCurrent user request:\n";

/** Format guidance belongs in engine context, never in the saved user message.
 * An input at the existing size limit still fits without added guidance. */
export function withResponsePresentation(input: string): string {
  return Buffer.byteLength(PRESENTATION + input, "utf8") <= 256 * 1024 ? PRESENTATION + input : input;
}
