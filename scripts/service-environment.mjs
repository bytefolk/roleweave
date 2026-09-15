import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFINITIONS = Object.freeze({
  doc: {
    template: ".env.example",
    required: ["AUTH_SECRET", "COLLABORATE_API_AUTH_KEY", "COLLABORATE_INTERNAL_API_KEY"],
  },
  mem: {
    template: "deploy/compose/.env.example",
    required: ["MEM_POSTGRES_PASSWORD", "MEM_REDIS_PASSWORD", "MEM_S3_ACCESS_KEY", "MEM_S3_SECRET_KEY", "MEM_WORKER_AUTH_KEY_B64", "MEM_BIND_ADDRESS"],
  },
});

async function inspect(file) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Environment paths must not contain symbolic links: ${file}`);
    return stat;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectory(directory, create = false) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat = await inspect(current);
    if (!stat && create) {
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      stat = await inspect(current);
    }
    if (!stat?.isDirectory()) throw new Error(`Environment parent must be an existing directory: ${current}`);
  }
}

async function existingEnvironment(envFile) {
  const stat = await inspect(envFile);
  if (stat && !stat.isFile()) throw new Error(`Environment file must be a regular file: ${envFile}`);
  return stat !== null;
}

function generateValues(kind) {
  if (kind === "doc") {
    const unique = new Set();
    while (unique.size < 3) unique.add(randomBytes(32).toString("base64url"));
    return Object.fromEntries(DEFINITIONS.doc.required.map((key, index) => [key, [...unique][index]]));
  }
  return {
    MEM_POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
    MEM_REDIS_PASSWORD: randomBytes(24).toString("hex"),
    MEM_S3_ACCESS_KEY: randomBytes(12).toString("hex"),
    MEM_S3_SECRET_KEY: randomBytes(36).toString("base64"),
    MEM_WORKER_AUTH_KEY_B64: randomBytes(32).toString("base64"),
    MEM_BIND_ADDRESS: "127.0.0.1",
  };
}

function renderEnvironment(template, kind) {
  const eol = template.includes("\r\n") ? "\r\n" : "\n";
  const lines = template.replace(/^\uFEFF/, "").split(/\r?\n/);
  const assignments = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) throw new Error("Upstream environment template contains unsupported .env syntax");
    if (assignments.has(match[1])) throw new Error(`Upstream environment template contains duplicate key: ${match[1]}`);
    assignments.set(match[1], index);
  }
  const missing = DEFINITIONS[kind].required.filter((key) => !assignments.has(key));
  if (missing.length) throw new Error(`Upstream ${kind} environment template is missing required keys: ${missing.join(", ")}`);
  const values = generateValues(kind);
  for (const [key, value] of Object.entries(values)) lines[assignments.get(key)] = `${key}=${value}`;
  const content = lines.join(eol);
  return content.endsWith(eol) ? content : `${content}${eol}`;
}

/** Initialize a private runtime environment without executing upstream code or exposing secrets. */
export async function initializeServiceEnvironment({ kind, sourcePath, envFile }) {
  if (!Object.hasOwn(DEFINITIONS, kind)) throw new Error("Service environment kind must be doc or mem");
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath) || typeof envFile !== "string" || !path.isAbsolute(envFile)) throw new Error("Source and environment paths must be absolute");
  sourcePath = path.resolve(sourcePath);
  envFile = path.resolve(envFile);
  const directory = path.dirname(envFile);
  // Existing configuration wins. Do not read its contents, rewrite defaults, or rotate secrets.
  await ensureDirectory(directory, true);
  if (await existingEnvironment(envFile)) return { created: false, envFile };

  await ensureDirectory(sourcePath);
  const templateFile = path.join(sourcePath, DEFINITIONS[kind].template);
  await ensureDirectory(path.dirname(templateFile));
  const templateStat = await inspect(templateFile);
  if (!templateStat?.isFile()) throw new Error(`Upstream environment template must be a regular file: ${templateFile}`);
  if (templateStat.size > 1024 * 1024) throw new Error("Upstream environment template exceeds the size limit");
  const content = renderEnvironment(await fs.readFile(templateFile, "utf8"), kind);
  const temporary = path.join(directory, `.roleweave-env-${randomUUID()}.tmp`);
  let handle;
  let temporaryCreated = false;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await ensureDirectory(directory);
    try {
      // Hard-link publication is atomic and cannot replace a concurrently created env file.
      // The temporary name is removed below, leaving the published file with one link.
      await fs.link(temporary, envFile);
    } catch (error) {
      if (error.code === "EEXIST" && await existingEnvironment(envFile)) return { created: false, envFile };
      if (["ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error.code)) throw new Error("This filesystem cannot publish an environment atomically; run local-services inside the filesystem's native Windows or WSL environment");
      throw error;
    }
    return { created: true, envFile };
  } finally {
    await handle?.close();
    if (temporaryCreated) await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
