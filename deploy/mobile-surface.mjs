import fs from "node:fs";
import path from "node:path";

const MOBILE_UA = /Android|iPhone|iPod|iPad|Mobile|ASteamApp|webOS|BlackBerry|IEMobile|Opera Mini/i;
const SKILL_EXCERPT_CHARS = 480;
const PHONE_PLATFORMS = new Set(["ios", "android", "harmony"]);

export function isMobileUserAgent(userAgent) {
  return typeof userAgent === "string" && MOBILE_UA.test(userAgent);
}

export function detectPlatform(userAgent) {
  const ua = typeof userAgent === "string" ? userAgent : "";
  if (/OpenHarmony|ArkWeb|HarmonyOS/i.test(ua)) return "harmony";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (isMobileUserAgent(ua)) return "android";
  return "desktop";
}

export function choosePlatform({ userAgent, searchParams }) {
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams();
  const requestedPlatform = params.get("platform");
  if (requestedPlatform === "desktop" || PHONE_PLATFORMS.has(requestedPlatform)) return requestedPlatform;
  if (params.get("surface") === "desktop") return "desktop";
  const detected = detectPlatform(userAgent);
  if (params.get("surface") === "mobile" && detected === "desktop") return "android";
  return detected;
}

export function chooseSurface({ userAgent, searchParams }) {
  return choosePlatform({ userAgent, searchParams }) === "desktop" ? "desktop" : "mobile";
}

function safeJoin(root, relative) {
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

function phoneDir(deployDir, platform) {
  return path.join(deployDir, "mobile", PHONE_PLATFORMS.has(platform) ? platform : "android");
}

export function resolvePublicAsset(urlPath, { deployDir, noVncDir, userAgent, searchParams }) {
  const platform = choosePlatform({ userAgent, searchParams });
  if (urlPath === "/") {
    return platform === "desktop"
      ? path.join(deployDir, "index.html")
      : path.join(phoneDir(deployDir, platform), "index.html");
  }
  if (urlPath === "/mobile" || urlPath === "/mobile/") {
    return path.join(phoneDir(deployDir, platform === "desktop" ? "android" : platform), "index.html");
  }
  if (urlPath === "/desktop" || urlPath === "/desktop/") return path.join(deployDir, "index.html");
  const phoneAsset = /^\/(ios|android|harmony)\/(index\.html|app\.css|app\.mjs)$/.exec(urlPath);
  if (phoneAsset) return path.join(deployDir, "mobile", phoneAsset[1], phoneAsset[2]);
  if (urlPath === "/ios" || urlPath === "/ios/") return path.join(deployDir, "mobile", "ios", "index.html");
  if (urlPath === "/android" || urlPath === "/android/") return path.join(deployDir, "mobile", "android", "index.html");
  if (urlPath === "/harmony" || urlPath === "/harmony/") return path.join(deployDir, "mobile", "harmony", "index.html");
  if (urlPath === "/shared/shell.mjs") return path.join(deployDir, "mobile", "shared", "shell.mjs");
  if (urlPath === "/mobile/app.css") return path.join(phoneDir(deployDir, platform === "desktop" ? "android" : platform), "app.css");
  if (urlPath === "/mobile/app.mjs") return path.join(phoneDir(deployDir, platform === "desktop" ? "android" : platform), "app.mjs");
  if (urlPath === "/command" || urlPath === "/command.html") return path.join(deployDir, "command.html");
  if (urlPath === "/command.css") return path.join(deployDir, "command.css");
  if (urlPath === "/command.mjs") return path.join(deployDir, "command.mjs");
  if (urlPath === "/client.mjs") return path.join(deployDir, "client.mjs");
  if (!urlPath.startsWith("/novnc/")) return null;
  const relative = decodeURIComponent(urlPath.slice("/novnc/".length));
  if (relative.includes("\0") || relative.split(/[\\/]/).includes("..")) return null;
  const candidate = path.resolve(noVncDir, relative);
  return candidate.startsWith(`${noVncDir}${path.sep}`) ? candidate : null;
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

export function closedOrgSnapshot() {
  return { open: false, source: "closed", name: "", description: "", owner: null, roles: [] };
}

export function previewOrgSnapshot(snapshot) {
  return { ...snapshot, open: false, source: "preview" };
}

export function liveOrgSnapshot(snapshot, workspacePath) {
  const live = { ...snapshot, open: true, source: "live" };
  if (typeof workspacePath === "string" && workspacePath.length > 0 && JSON.stringify(live).includes(workspacePath)) {
    throw new Error("snapshot_leaks_path");
  }
  return live;
}

export function defaultExampleDir(productDir) {
  return safeJoin(productDir, path.join("examples", "oss-maintainer"));
}
