/** A legacy model may print a tool protocol marker as ordinary answer text.
 * Quoted code examples remain text, but bare markers are not execution evidence.
 * This predicate never interprets or executes the purported command. */
export function hasUnexecutedToolText(output: unknown): boolean {
  if (typeof output !== "string") return false;
  const unquoted = output.replace(/```[\s\S]*?```|`[^`]*`/g, "");
  return /<tool_call>\s*\S/i.test(unquoted);
}
