/** A breadcrumb is the active route, not a log of every click.
 * Returning to an object erases the detour after it. Identity is the node ID;
 * different employees can legitimately have sources with the same label. */
export function normalizeRelationshipTrail(trail: readonly string[]): string[] {
  const route: string[] = [];
  for (const id of trail) {
    const visited = route.indexOf(id);
    if (visited >= 0) route.length = visited + 1;
    else route.push(id);
    if (route.length > 16) route.shift();
  }
  return route;
}
