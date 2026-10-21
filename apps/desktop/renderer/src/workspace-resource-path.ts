/** Convert an observed source path to the existing confined relative-file IPC.
 * This is a presentation adapter; the main process still validates the path. */
export function workspaceResourcePath(workspacePath: string | undefined, sourcePath: string): string | undefined {
  if (!workspacePath || !sourcePath || sourcePath.length > 8192 || /[\x00-\x1f]/.test(sourcePath)) return undefined;
  const windows = /^[A-Za-z]:[\\/]/.test(workspacePath) || /^\\\\/.test(workspacePath);
  const normalize = (value: string) => windows ? value.replace(/\\/g, "/") : value;
  const root = normalize(workspacePath).replace(/\/+$/, "");
  // WSL share components are Linux paths even though Windows displays them.
  // Preserve their case; only native drive paths use case-insensitive matching.
  const caseInsensitive = /^[A-Za-z]:\//.test(root);
  let resource = normalize(sourcePath);
  const absolute = resource.startsWith("/") || /^[A-Za-z]:\//.test(resource);
  if (absolute) {
    const prefix = `${root}/`;
    if (!(caseInsensitive ? resource.toLowerCase().startsWith(prefix.toLowerCase()) : resource.startsWith(prefix))) return undefined;
    resource = resource.slice(prefix.length);
  }
  if (!resource || resource.length > 1024 || resource.includes("\\") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(resource)
    || resource.startsWith("/") || resource.split("/").some(segment => !segment || segment.startsWith("."))) return undefined;
  return resource;
}
