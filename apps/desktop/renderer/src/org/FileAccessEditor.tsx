import { useEffect, useState } from "react";
import { Checkbox, Input, Select } from "antd";
import { Folder, Plus, Trash2 } from "lucide-react";
import { useT } from "@roleweave/ui";
import type { HirePermissionAction, HirePermissionRule, HirePermissions } from "@roleweave/shared";

const ACCESS_LEVELS = {
  read: ["read"],
  edit: ["read", "create", "update"],
  run: ["read", "create", "update", "execute"],
  native: ["read", "create", "update", "delete", "execute"],
} satisfies Record<string, HirePermissionAction[]>;
type AccessLevel = keyof typeof ACCESS_LEVELS | "custom";

const ACTION_TOOLS: Record<HirePermissionAction, string[]> = {
  read: ["Read", "Grep", "Glob"],
  create: ["Write"],
  update: ["Edit"],
  delete: ["Delete"],
  execute: ["Exec"],
};

function isFolderRule(rule: HirePermissionRule): boolean {
  return (rule.effect ?? "allow") === "allow"
    && (rule.resource.endsWith("/**") || rule.resource === "./" || rule.resource === "");
}

function folderPath(resource: string): string {
  return resource.endsWith("/**") ? resource.slice(0, -3) || "/" : resource;
}

function folderResource(path: string): string {
  if (path.trim().length === 0) return "";
  const relative = !path.startsWith(".") && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) ? `./${path}` : path;
  return `${relative.replace(/\/+$/, "")}/**`;
}

/** Keep the typed path intact while normalizing the saved recursive grant. */
function FolderPathInput({ id, resource, disabled, onChange }: {
  id: string; resource: string; disabled: boolean; onChange: (resource: string) => void;
}) {
  const t = useT();
  const [path, setPath] = useState(() => folderPath(resource));
  useEffect(() => {
    setPath((current) => folderResource(current) === resource ? current : folderPath(resource));
  }, [resource]);
  return <Input id={id} value={path} disabled={disabled} maxLength={509}
    status={resource.trim().length === 0 ? "error" : undefined}
    aria-invalid={resource.trim().length === 0} aria-describedby={`${id}-hint`}
    placeholder={t("profile.folderPlaceholder")}
    onChange={(event) => {
      setPath(event.target.value);
      onChange(folderResource(event.target.value));
    }} />;
}

function accessLevel(rule: HirePermissionRule, nativeHost: boolean): AccessLevel {
  if (nativeHost && ACCESS_LEVELS.native.every((action) => rule.actions.includes(action)) && rule.approval === false) return "native";
  if (nativeHost) return rule.actions.length === 1 && rule.actions[0] === "read" ? "read" : "custom";
  if (rule.actions.includes("delete") && !rule.actions.includes("update")) return "custom";
  const actions = rule.actions.filter((action) => action !== "delete");
  for (const level of ["read", "edit", "run"] as const) {
    const expected = ACCESS_LEVELS[level];
    if (actions.length === expected.length && expected.every((action) => actions.includes(action))) return level;
  }
  return "custom";
}

/** Match the native adapter's expressible grants without weakening its checks. */
export function nativePermissionIssue(permissions: HirePermissions): { key: string; path?: string } | null {
  if (!permissions.nativeExecution) return null;
  const required = ["Read", "Write", "Edit", "Delete", "Exec"];
  if (required.some((tool) => !permissions.tools.includes(tool))) return { key: "profile.nativeToolsIssue" };
  const roots = new Set<string>();
  for (const rule of permissions.rules) {
    const path = folderPath(rule.resource);
    if (/^skill:\/\//.test(rule.resource)) return { key: "profile.nativeSkillsIssue" };
    if (rule.effect === "deny") return { key: "profile.nativeCustomIssue" };
    if (rule.approval === true) return { key: "profile.nativeApprovalIssue", path };
    if (rule.actions.every((action) => action === "read")) continue;
    if (rule.scope !== "workspace" || rule.approval !== false || !ACCESS_LEVELS.native.every((action) => rule.actions.includes(action))) {
      return { key: "profile.nativeFolderIssue", path };
    }
    const relative = rule.resource.startsWith("./") && rule.resource.endsWith("/**") ? rule.resource.slice(2, -3) : "";
    const parts = relative.split("/");
    if (!relative || /[\\:*?\[\]{}\u0000-\u001f]/.test(relative)
      || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))
      || ["positions", ".roleweave", ".digital-employee", ".workbench", ".codex", ".git"].includes(parts[0]?.toLowerCase() ?? "")) {
      return { key: "profile.nativePathIssue", path };
    }
    roots.add(relative);
  }
  if (roots.size === 0 || roots.size > 16) return { key: "profile.nativeFoldersRequired" };
  return null;
}

/** Common folder choices update the resource grant and its required tools together. */
export function FileAccessEditor({ permissions, readOnly, disabled, nativeHost = false, onChange, onEnableChanges }: {
  permissions: HirePermissions;
  readOnly: boolean;
  disabled: boolean;
  nativeHost?: boolean;
  onChange: (permissions: HirePermissions) => void;
  onEnableChanges: () => void;
}) {
  const t = useT();
  const folders = permissions.rules.flatMap((rule, index) => isFolderRule(rule) ? [{ rule, index }] : []);
  const customCount = permissions.rules.filter((rule) => !isFolderRule(rule) && !/^(skill|mcp):\/\//.test(rule.resource)).length;
  const hasChanges = folders.some(({ rule }) => rule.actions.some((action) => action !== "read"));
  const hasSkills = (permissions.skills ?? []).length > 0;
  const removeFolder = (index: number) => {
    const rules = permissions.rules.filter((_, currentIndex) => currentIndex !== index);
    const hasRemainingExecution = rules.some((rule) => rule.actions.includes("execute") && !/^(skill|mcp):\/\//.test(rule.resource));
    onChange({
      ...permissions,
      rules,
      ...(nativeHost && permissions.nativeExecution && !hasRemainingExecution ? { nativeExecution: false } : {}),
    });
  };
  const update = (index: number, rule: HirePermissionRule, configureTools = false) => {
    const rules = permissions.rules.map((current, currentIndex) => currentIndex === index ? rule : current);
    onChange({
      ...permissions,
      tools: configureTools
        ? [...new Set([...permissions.tools, ...rule.actions.flatMap((action) => ACTION_TOOLS[action])])]
        : permissions.tools,
      rules,
      ...(nativeHost && configureTools ? { nativeExecution: rules.some((current) => current.actions.includes("execute") && !/^(skill|mcp):\/\//.test(current.resource)) } : {}),
    });
    if (configureTools && rule.actions.some((action) => action !== "read")) onEnableChanges();
  };

  return (
    <section className="owb-profile-section owb-profile-files" aria-label={t("profile.fileAccess")}>
      <div className="owb-profile-section__head"><h4>{t("profile.fileAccess")}</h4></div>
      <p className="owb-profile-help">{t(nativeHost ? "profile.nativeFileAccessHint" : "profile.fileAccessHint")}</p>
      {nativeHost && hasSkills ? <p className="owb-profile-notice">{t("profile.nativeSkillsBeforeSelect")}</p> : null}
      {readOnly && hasChanges ? <p className="owb-profile-notice">
        {t("profile.readOnlyFolders")}
        <button type="button" disabled={disabled} onClick={onEnableChanges}>{t("profile.enableChanges")}</button>
      </p> : null}
      <div className="owb-profile-rules">
        {folders.map(({ rule, index }) => {
          const level = accessLevel(rule, nativeHost);
          const missingTools = rule.actions.some((action) => ACTION_TOOLS[action].some((tool) => !permissions.tools.includes(tool)));
          const pathId = `profile-folder-${index}`;
          return <div className="owb-profile-folder" key={index}>
            <div className="owb-profile-folder__heading">
              <label htmlFor={pathId}><Folder size={15} aria-hidden="true" />{t("profile.folder")}</label>
              <button type="button" className="owb-profile-icon-button" disabled={disabled}
                aria-label={t("profile.removeFolder", { path: folderPath(rule.resource) })}
                onClick={() => removeFolder(index)}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
            <FolderPathInput id={pathId} resource={rule.resource} disabled={disabled}
              onChange={(resource) => update(index, { ...rule, resource })} />
            <p id={`${pathId}-hint`} className={rule.resource.trim().length === 0 ? "owb-profile-error" : "owb-profile-folder__scope"}>
              {t(rule.resource.trim().length === 0 ? "profile.folderRequired" : `profile.folderScope.${rule.scope}`)}
            </p>
            <label className="owb-profile-folder__access">
              <span>{t("profile.allowedOperations")}</span>
              <Select<AccessLevel> value={level} disabled={disabled} aria-label={t("profile.folderAccess", { path: folderPath(rule.resource) })}
                options={[
                  { value: "read", label: t("profile.accessRead") },
                  ...(nativeHost ? [{ value: "native", label: t("profile.accessNative"), disabled: rule.scope !== "workspace" || hasSkills }]
                    : [{ value: "edit", label: t("profile.accessEdit") }, { value: "run", label: t("profile.accessRun") }]),
                  ...(level === "custom" ? [{ value: "custom", label: t("profile.accessCustom"), disabled: true }] : []),
                ]}
                onChange={(value) => { if (value !== "custom") update(index, {
                  ...rule,
                  actions: [...ACCESS_LEVELS[value], ...(value !== "read" && value !== "native" && rule.actions.includes("delete") ? ["delete" as const] : [])],
                  approval: value === "native" ? false : rule.approval ?? true,
                }, true); }} />
            </label>
            {nativeHost && rule.scope !== "workspace" ? <p className="owb-profile-folder__scope">{t("profile.nativePositionFolder")}</p> : null}
            {level === "native" ? <p className="owb-profile-folder__scope">{t("profile.nativeFolderConsent")}</p> : null}
            {level !== "native" && (level !== "read" || (nativeHost && rule.approval === true)) ? <div className="owb-profile-folder__options">
              {!nativeHost ? <>
              <Checkbox disabled={disabled} checked={rule.actions.includes("delete")} onChange={(event) => update(index, {
                ...rule,
                actions: event.target.checked ? [...rule.actions, "delete"] : rule.actions.filter((action) => action !== "delete"),
              }, true)}>{t("profile.allowDelete")}</Checkbox>
              </> : null}
              <Checkbox disabled={disabled} checked={rule.approval === true} onChange={(event) => update(index, { ...rule, approval: event.target.checked })}>
                {t("profile.askBeforeOperation")}
              </Checkbox>
            </div> : null}
            {missingTools && !(nativeHost && level === "custom") ? <p className="owb-profile-notice">
              {t("profile.folderToolsMissing")}
              <button type="button" disabled={disabled} onClick={() => update(index, rule, true)}>{t("profile.applyFolderAccess")}</button>
            </p> : null}
          </div>;
        })}
        {folders.length === 0 ? <p className="owb-profile-empty">{t("profile.noFolders")}</p> : null}
      </div>
      <button type="button" className="owb-profile-add-rule" disabled={disabled} onClick={() => onChange({
        ...permissions,
        tools: [...new Set([...permissions.tools, ...ACTION_TOOLS.read])],
        rules: [...permissions.rules, { scope: "workspace", resource: "", actions: ["read"], approval: !nativeHost }],
      })}><Plus size={14} aria-hidden="true" />{t("profile.addFolder")}</button>
      {customCount > 0 ? <p className="owb-profile-help">{t("profile.customRulesHint", { count: customCount })}</p> : null}
    </section>
  );
}
