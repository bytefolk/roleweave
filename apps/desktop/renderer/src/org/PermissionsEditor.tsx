/**
 * The grant editor shared by the hire drawer and the employee profile drawer.
 *
 * Both surfaces edit the SAME `HirePermissions` projection, so they must render
 * the same controls and the same derived rules: a second copy would let hire
 * and edit disagree about what a selected Skill means. The default variant
 * keeps the hire skin; the compact variant presents the same grants in the
 * employee settings drawer.
 */
import { Checkbox, Select } from "antd";
import { Check, ChevronDown, Plus, Shield, Trash2 } from "lucide-react";
import { Input as OwbInput } from "@fullstack-ai-infra/ui";
import { useT } from "@roleweave/ui";
import { hireMcpCatalog, hireSkillCatalog } from "@roleweave/shared/capabilities";
import type { HireMcpGrant, HireSkillGrant } from "@roleweave/shared/capabilities";
import type { HirePermissionAction, HirePermissionRule, HirePermissions } from "@roleweave/shared";

/** Tool chips offered by both surfaces; the package contract bounds the list. */
export const PERMISSION_TOOLS = ["Read", "Grep", "Glob", "Write", "Edit", "Delete", "Exec"] as const;

const ACTIONS: Array<{ value: HirePermissionAction; labelKey: string }> = [
  { value: "read", labelKey: "hire.actionRead" },
  { value: "create", labelKey: "hire.actionCreate" },
  { value: "update", labelKey: "hire.actionUpdate" },
  { value: "delete", labelKey: "hire.actionDelete" },
  { value: "execute", labelKey: "hire.actionExecute" },
];

const SCOPES = [
  { value: "position", labelKey: "hire.scopePosition" },
  { value: "workspace", labelKey: "hire.scopeWorkspace" },
  { value: "project", labelKey: "hire.scopeProject" },
] as const;

export function toggleAction(rule: HirePermissionRule, action: HirePermissionAction): HirePermissionRule {
  const actions = rule.actions.includes(action) ? rule.actions.filter((item) => item !== action) : [...rule.actions, action];
  return { ...rule, actions: actions.length > 0 ? actions : ["read"] };
}

/** A capability binding is only a reference; the matching `skill://` /
 * `mcp://` resource rule is what makes it reachable, so the two move together. */
export function capabilityRules(skills: HireSkillGrant[], mcpServers: HireMcpGrant[]): HirePermissionRule[] {
  return [
    ...skills.map((skill) => ({ scope: "position" as const, resource: `skill://${skill.id}`, actions: ["execute" as const] })),
    ...mcpServers.map((server) => ({ scope: "workspace" as const, resource: `mcp://${server.id}`, actions: ["execute" as const], approval: true })),
  ];
}

export function replaceCapabilityRules(permissions: HirePermissions, skills: HireSkillGrant[], mcpServers: HireMcpGrant[]): HirePermissions {
  return {
    ...permissions,
    skills,
    mcpServers,
    rules: [
      ...permissions.rules.filter((rule) => !rule.resource.startsWith("skill://") && !rule.resource.startsWith("mcp://")),
      ...capabilityRules(skills, mcpServers),
    ],
  };
}

export function toggleSkillGrant(permissions: HirePermissions, id: HireSkillGrant["id"]): HirePermissions {
  const skills = permissions.skills ?? [];
  const nextSkills = skills.some((skill) => skill.id === id) ? skills.filter((skill) => skill.id !== id) : [...skills, { id }];
  return replaceCapabilityRules(permissions, nextSkills, permissions.mcpServers ?? []);
}

export function toggleMcpServerGrant(permissions: HirePermissions, id: HireMcpGrant["id"]): HirePermissions {
  const mcpServers = permissions.mcpServers ?? [];
  const existing = mcpServers.find((server) => server.id === id);
  const nextServers = existing
    ? mcpServers.filter((server) => server.id !== id)
    : [...mcpServers, { id, tools: [...(hireMcpCatalog.find((server) => server.id === id)?.tools ?? [])] }];
  return replaceCapabilityRules(permissions, permissions.skills ?? [], nextServers);
}

export function toggleMcpToolGrant(permissions: HirePermissions, id: HireMcpGrant["id"], tool: string): HirePermissions {
  return {
    ...permissions,
    mcpServers: (permissions.mcpServers ?? []).map((server) =>
      server.id !== id
        ? server
        : { ...server, tools: server.tools.includes(tool) ? server.tools.filter((item) => item !== tool) : [...server.tools, tool] },
    ),
  };
}

export function PermissionPolicyEditor({
  permissions,
  onChange,
  variant = "default",
  disabled = false,
}: {
  permissions: HirePermissions;
  onChange: (next: HirePermissions) => void;
  variant?: "default" | "compact";
  disabled?: boolean;
}) {
  const t = useT();
  const setRule = (index: number, next: HirePermissionRule): void =>
    onChange({ ...permissions, rules: permissions.rules.map((item, itemIndex) => (itemIndex === index ? next : item)) });
  const executionControls = (
    <section className="owb-profile-section" aria-label={t("permissions.nativeTitle")}>
      <h4>{t("permissions.nativeTitle")}</h4>
      <Checkbox disabled={disabled} checked={permissions.nativeExecution === true}
        onChange={(event) => onChange({ ...permissions, nativeExecution: event.target.checked })}>
        {t("permissions.nativeExecution")}
      </Checkbox>
      <p>{t("permissions.nativeHint")}</p>
      <Checkbox disabled={disabled} checked={permissions.network === "host_policy"}
        onChange={(event) => onChange({ ...permissions, network: event.target.checked ? "host_policy" : "deny" })}>
        {t("permissions.network")}
      </Checkbox>
      <p>{t("permissions.networkHint")}</p>
    </section>
  );
  if (variant === "compact") {
    return (
      <>
        <section className="owb-profile-section" aria-label={t("profile.tools")}>
          <div className="owb-profile-section__head"><h4>{t("profile.tools")}</h4></div>
          <div className="owb-profile-tools">
            {PERMISSION_TOOLS.map((tool) => (
              <button
                type="button"
                className={permissions.tools.includes(tool) ? "is-selected" : ""}
                aria-pressed={permissions.tools.includes(tool)}
                key={tool}
                onClick={() => onChange({
                  ...permissions,
                  tools: permissions.tools.includes(tool)
                    ? permissions.tools.filter((item) => item !== tool)
                    : [...permissions.tools, tool],
                })}
              >
                {tool}
              </button>
            ))}
          </div>
        </section>
        {executionControls}
        <section className="owb-profile-section" aria-label={t("profile.resources")}>
          <div className="owb-profile-section__head"><h4>{t("profile.resources")}</h4></div>
          <div className="owb-profile-rules">
            {permissions.rules.map((rule, index) => (
              <div className="owb-profile-rule" key={index}>
                <div className="owb-profile-rule__fields">
                  <label>
                    <span>{t("profile.scope")}</span>
                    <Select
                      aria-label={t("profile.scope")}
                      disabled={disabled}
                      value={rule.scope}
                      onChange={(value: HirePermissionRule["scope"]) => setRule(index, { ...rule, scope: value })}
                      options={SCOPES.map((scope) => ({ value: scope.value, label: t(scope.labelKey) }))}
                    />
                  </label>
                  <label>
                    <span>{t("profile.resource")}</span>
                    <OwbInput
                      aria-label={t("profile.resource")}
                      value={rule.resource}
                      onChange={(event) => setRule(index, { ...rule, resource: event.target.value })}
                    />
                  </label>
                </div>
                <Checkbox disabled={disabled} checked={rule.approval !== false}
                  onChange={(event) => setRule(index, { ...rule, approval: event.target.checked })}>
                  {t("permissions.requireApproval")}
                </Checkbox>
                <div className="owb-profile-rule__actions">
                  <div className="owb-profile-action-chips">
                    {ACTIONS.map((action) => (
                      <button
                        type="button"
                        className={rule.actions.includes(action.value) ? "is-selected" : ""}
                        aria-pressed={rule.actions.includes(action.value)}
                        key={action.value}
                        onClick={() => setRule(index, toggleAction(rule, action.value))}
                      >
                        {t(action.labelKey)}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="owb-profile-icon-button"
                    aria-label={t("hire.removeRule")}
                    onClick={() => onChange({ ...permissions, rules: permissions.rules.filter((_item, itemIndex) => itemIndex !== index) })}
                  >
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="owb-profile-add-rule"
              onClick={() => onChange({
                ...permissions,
                rules: [...permissions.rules, { scope: "workspace", resource: "./", actions: ["read"], approval: true }],
              })}
            >
              <Plus aria-hidden="true" size={14} />{t("hire.addRule")}
            </button>
          </div>
        </section>
      </>
    );
  }
  return (
    <>
      <div className="owb-hire-section-head">
        <div>
          <h4><Shield aria-hidden="true" size={15} />{t("hire.permissionsTitle")}</h4>
          <p>{t("hire.permissionsHint")}</p>
        </div>
      </div>
      <div className="owb-hire-tool-chips">
        {PERMISSION_TOOLS.map((tool) => (
          <button
            type="button"
            className={permissions.tools.includes(tool) ? "is-selected" : ""}
            key={tool}
            onClick={() => onChange({
              ...permissions,
              tools: permissions.tools.includes(tool)
                ? permissions.tools.filter((item) => item !== tool)
                : [...permissions.tools, tool],
            })}
          >
            {tool}
          </button>
        ))}
      </div>
      {executionControls}
      <div className="owb-hire-rules">
        {permissions.rules.map((rule, index) => (
          <div className="owb-hire-rule" key={`${rule.scope}-${rule.resource}-${index}`}>
            <Select
              disabled={disabled}
              value={rule.scope}
              onChange={(value: HirePermissionRule["scope"]) => setRule(index, { ...rule, scope: value })}
              options={SCOPES.map((scope) => ({ value: scope.value, label: t(scope.labelKey) }))}
            />
            <OwbInput
              value={rule.resource}
              onChange={(event) => setRule(index, { ...rule, resource: event.target.value })}
            />
            <Checkbox disabled={disabled} checked={rule.approval !== false}
              onChange={(event) => setRule(index, { ...rule, approval: event.target.checked })}>
              {t("permissions.requireApproval")}
            </Checkbox>
            <div className="owb-hire-action-chips">
              {ACTIONS.map((action) => (
                <button
                  type="button"
                  className={rule.actions.includes(action.value) ? "is-selected" : ""}
                  key={action.value}
                  onClick={() => setRule(index, toggleAction(rule, action.value))}
                >
                  {t(action.labelKey)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="owb-hire-icon-button"
              aria-label={t("hire.removeRule")}
              onClick={() => onChange({ ...permissions, rules: permissions.rules.filter((_item, itemIndex) => itemIndex !== index) })}
            >
              <Trash2 aria-hidden="true" size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="owb-hire-add-rule"
          onClick={() => onChange({
            ...permissions,
            rules: [...permissions.rules, { scope: "workspace", resource: "./", actions: ["read"], approval: true }],
          })}
        >
          <Plus aria-hidden="true" size={14} />{t("hire.addRule")}
        </button>
      </div>
    </>
  );
}

export function CapabilityPicker({
  permissions,
  onChange,
  variant = "default",
}: {
  permissions: HirePermissions;
  onChange: (next: HirePermissions) => void;
  variant?: "default" | "compact";
}) {
  const t = useT();
  if (variant === "compact") {
    const skillCount = (permissions.skills ?? []).length;
    const connectorCount = (permissions.mcpServers ?? []).length;
    return (
      <>
        <section className="owb-profile-section" aria-label={t("hire.skillsTitle")}>
          <div className="owb-profile-section__head">
            <h4>{t("hire.skillsTitle")}</h4>
            <span className={skillCount > 0 ? "owb-profile-count" : "owb-profile-empty"}>{skillCount > 0 ? skillCount : t("profile.noSkills")}</span>
          </div>
          <div className="owb-profile-skills">
            {hireSkillCatalog.map((skill) => {
              const selected = (permissions.skills ?? []).some((item) => item.id === skill.id);
              return (
                <button
                  type="button"
                  className={`owb-profile-skill${selected ? " is-selected" : ""}`}
                  aria-pressed={selected}
                  key={skill.id}
                  onClick={() => onChange(toggleSkillGrant(permissions, skill.id))}
                  title={skill.description}
                >
                  {selected ? <Check aria-hidden="true" size={14} /> : null}
                  {skill.name}
                </button>
              );
            })}
          </div>
        </section>
        <section className="owb-profile-section" aria-label={t("hire.mcpTitle")}>
          <div className="owb-profile-section__head">
            <h4>{t("hire.mcpTitle")}</h4>
            <span className={connectorCount > 0 ? "owb-profile-count" : "owb-profile-empty"}>{connectorCount > 0 ? connectorCount : t("profile.noConnectors")}</span>
          </div>
          <div className="owb-profile-connectors">
            {hireMcpCatalog.map((server) => {
              const grant = (permissions.mcpServers ?? []).find((item) => item.id === server.id);
              return (
                <div className={`owb-profile-mcp${grant ? " is-selected" : ""}`} key={server.id}>
                  <button
                    type="button"
                    className="owb-profile-mcp__select"
                    aria-pressed={Boolean(grant)}
                    onClick={() => onChange(toggleMcpServerGrant(permissions, server.id))}
                    title={server.description}
                  >
                    <span className="owb-profile-checkbox" aria-hidden="true">{grant ? <Check size={12} /> : null}</span>
                    <span>{server.name}</span>
                  </button>
                  {grant ? (
                    <details className="owb-profile-mcp__tools">
                      <summary>
                        {t("profile.connectorTools", { count: grant.tools.length })}
                        <ChevronDown aria-hidden="true" size={14} />
                      </summary>
                      <div className="owb-profile-mcp__tool-chips" aria-label={t("hire.mcpToolsAria")}>
                        {server.tools.map((tool) => (
                          <button
                            type="button"
                            className={grant.tools.includes(tool) ? "is-selected" : ""}
                            aria-pressed={grant.tools.includes(tool)}
                            key={tool}
                            onClick={() => onChange(toggleMcpToolGrant(permissions, server.id, tool))}
                          >
                            {tool}
                          </button>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
          {connectorCount > 0 ? <p className="owb-profile-mcp__unsupported" role="status">{t("profile.connectorUnsupported")}</p> : null}
        </section>
      </>
    );
  }
  return (
    <section className="owb-hire-capability-panel" aria-label={t("hire.capabilityTitle")}>
      <div className="owb-hire-capability-panel__head">
        <div>
          <p className="owb-hire-eyebrow">{t("hire.capabilityStep")}</p>
          <h3>{t("hire.capabilityTitle")}</h3>
          <p>{t("hire.capabilityHint")}</p>
        </div>
        <span className="owb-hire-capability-panel__count">{(permissions.skills ?? []).length + (permissions.mcpServers ?? []).length} {t("hire.capabilityCount")}</span>
      </div>
      <div className="owb-hire-capability-grid">
        <section className="owb-hire-capability">
          <div className="owb-hire-capability__head"><strong>{t("hire.skillsTitle")}</strong><span>{t("hire.skillsHint")}</span></div>
          <div className="owb-hire-capability__options">
            {hireSkillCatalog.map((skill) => (
              <button
                type="button"
                className={(permissions.skills ?? []).some((item) => item.id === skill.id) ? "is-selected" : ""}
                key={skill.id}
                onClick={() => onChange(toggleSkillGrant(permissions, skill.id))}
                title={skill.description}
              >
                <b>{skill.name}</b>
              </button>
            ))}
          </div>
        </section>
        <section className="owb-hire-capability">
          <div className="owb-hire-capability__head"><strong>{t("hire.mcpTitle")}</strong><span>{t("hire.mcpHint")}</span></div>
          <div className="owb-hire-capability__options">
            {hireMcpCatalog.map((server) => {
              const grant = (permissions.mcpServers ?? []).find((item) => item.id === server.id);
              return (
                <div className={`owb-hire-mcp ${grant ? "is-selected" : ""}`} key={server.id}>
                  <button type="button" className="owb-hire-mcp__select" onClick={() => onChange(toggleMcpServerGrant(permissions, server.id))} title={server.description}>
                    <b>{server.name}</b><small>{grant ? t("hire.mcpBound") : t("hire.mcpAvailable")}</small>
                  </button>
                  {grant ? <div className="owb-hire-mcp__tools" aria-label={t("hire.mcpToolsAria")}>
                    {server.tools.map((tool) => (
                      <button
                        type="button"
                        className={grant.tools.includes(tool) ? "is-selected" : ""}
                        key={tool}
                        onClick={() => onChange(toggleMcpToolGrant(permissions, server.id, tool))}
                      >
                        {tool}
                      </button>
                    ))}
                  </div> : null}
                </div>
              );
            })}
          </div>
        </section>
      </div>
      {(permissions.mcpServers ?? []).length > 0 ? (
        <p className="owb-hire-mcp-unsupported" role="status">
          {t("hire.mcpUnsupportedHint")}
        </p>
      ) : null}
      <p className="owb-hire-capability-note">{t("hire.capabilityPermissionHint")}</p>
    </section>
  );
}
