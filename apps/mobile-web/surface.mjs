import fs from "node:fs";
import path from "node:path";

const MOBILE_UA = /Android|iPhone|iPod|iPad|Mobile|ASteamApp|webOS|BlackBerry|IEMobile|Opera Mini/i;
const SKILL_EXCERPT_CHARS = 480;

export function isMobileUserAgent(userAgent) {
  return typeof userAgent === "string" && MOBILE_UA.test(userAgent);
}

export function chooseSurface({ userAgent, searchParams }) {
  const requested = searchParams instanceof URLSearchParams ? searchParams.get("surface") : null;
  if (requested === "desktop" || requested === "mobile") return requested;
  return isMobileUserAgent(userAgent) ? "mobile" : "desktop";
}

function safeJoin(root, relative) {
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

export function resolvePublicAsset(urlPath, { webDir, userAgent, searchParams }) {
  const surface = chooseSurface({ userAgent, searchParams });
  if (urlPath === "/" || urlPath === "/mobile" || urlPath === "/mobile/") {
    if (urlPath === "/" && surface === "desktop") return null;
    return path.join(webDir, "index.html");
  }
  if (urlPath === "/app.css") return path.join(webDir, "app.css");
  if (urlPath === "/app.mjs") return path.join(webDir, "app.mjs");
  return null;
}

function findNamedDirectory(root, name) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (entry.name === name) return full;
      stack.push(full);
    }
  }
  return null;
}

function skillExcerpt(positionDir) {
  const skillPath = path.join(positionDir, "SKILL.md");
  if (!fs.existsSync(skillPath)) return "";
  const text = fs.readFileSync(skillPath, "utf8").replace(/\r\n/g, "\n").trim();
  if (text.length <= SKILL_EXCERPT_CHARS) return text;
  return `${text.slice(0, SKILL_EXCERPT_CHARS).trimEnd()}…`;
}

export function loadWorkspaceSnapshot(workspaceDir) {
  const workspaceFile = path.join(workspaceDir, "workspace.json");
  const orgFile = path.join(workspaceDir, "organization.v1alpha1.json");
  if (!fs.existsSync(workspaceFile) || !fs.existsSync(orgFile)) {
    throw new Error("directory is not a RoleWeave workspace");
  }
  const workspace = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
  const org = JSON.parse(fs.readFileSync(orgFile, "utf8"));
  if (!workspace || typeof workspace.name !== "string" || !org || !Array.isArray(org.roles)) {
    throw new Error("directory is not a RoleWeave workspace");
  }
  const positionsRoot = path.join(workspaceDir, "positions");
  const roles = org.roles.map((role) => {
    const id = typeof role.id === "string" ? role.id : "";
    const positionDir = findNamedDirectory(positionsRoot, id);
    return {
      id,
      name: typeof role.name === "string" ? role.name : id,
      description: typeof role.description === "string" ? role.description : "",
      reportTo: role.reportTo ?? null,
      budget: role.budget && typeof role.budget === "object" ? {
        perTask: role.budget.perTask ?? null,
        perDay: role.budget.perDay ?? null,
      } : null,
      skillExcerpt: positionDir ? skillExcerpt(positionDir) : "",
    };
  });
  return {
    name: workspace.name,
    description: typeof workspace.description === "string" ? workspace.description : "",
    owner: typeof org.owner === "string" ? org.owner : null,
    roles,
  };
}

export function defaultExampleDir(productDir) {
  return safeJoin(productDir, path.join("examples", "oss-maintainer"));
}
