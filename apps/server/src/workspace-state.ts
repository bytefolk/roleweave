import fs from "node:fs/promises";
import path from "node:path";
import {
  ORG_LAYOUT_SCHEMA_VERSION,
  ORG_TREE_SCHEMA_VERSION,
  OrgApiError,
  WORKSPACE_MANIFEST_SCHEMA_VERSION,
  WORKSPACE_ORG_SCHEMA_VERSION,
  errorCodes,
} from "@roleweave/shared";
import type {
  OrganizationFile,
  OrgLayoutFile,
  OrgRole,
  OrgTreeNodeV1,
  OrgTreeSnapshot,
  OrgTreeVersion,
  WorkspaceManifest,
} from "@roleweave/shared";
import { emptyLayout, orderChildren, parentKey, readLayout, reconcileLayout, writeLayoutAtomic } from "./org/layout.js";

export const ORGANIZATION_FILE = "organization.v1alpha1.json";
export const MANIFEST_FILE = "workspace.json";
export const POSITIONS_DIR = "positions";
/** Applied-state model written by the engine `org apply` (0600). */
export const APPLIED_MODEL_FILE = ".digital-employee/org.json";

export interface OpenWorkspace {
  dir: string;
  manifest: WorkspaceManifest;
  organization: OrganizationFile;
  version: OrgTreeVersion;
}

/**
 * Current workspace holder + org-tree snapshot builder. Structural checks only:
 * budget lawfulness and apply validation belong to digital-employee, never here.
 */
export class WorkspaceState {
  private current: OpenWorkspace | null = null;
  private layout: OrgLayoutFile = emptyLayout();
  private seq = 0;

  /** Currently open workspace, or null. */
  get active(): OpenWorkspace | null {
    return this.current;
  }

  async openWorkspace(rawDir: string): Promise<OpenWorkspace> {
    const dir = path.resolve(rawDir);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      throw new OrgApiError(errorCodes.workspace_invalid, 422, `workspace directory not found: ${dir}`);
    }
    if (!stat.isDirectory()) {
      throw new OrgApiError(errorCodes.workspace_invalid, 422, `not a directory: ${dir}`);
    }
    const manifest = await this.readJson<WorkspaceManifest>(
      path.join(dir, MANIFEST_FILE),
      "workspace manifest missing (workspace.json)",
    );
    if (manifest.schemaVersion !== WORKSPACE_MANIFEST_SCHEMA_VERSION) {
      throw new OrgApiError(
        errorCodes.workspace_invalid,
        422,
        `unsupported workspace manifest schemaVersion: ${String(manifest.schemaVersion)}`,
      );
    }
    const organization = await this.readOrganizationFile(dir);
    this.assertOrganizationStructure(organization, errorCodes.workspace_invalid, 422);
    let positionsStat;
    try {
      positionsStat = await fs.stat(path.join(dir, POSITIONS_DIR));
    } catch {
      throw new OrgApiError(errorCodes.workspace_invalid, 422, "positions/ directory missing");
    }
    if (!positionsStat.isDirectory()) {
      throw new OrgApiError(errorCodes.workspace_invalid, 422, "positions/ is not a directory");
    }
    await this.loadAndReconcileLayout(dir, organization.roles);
    this.seq += 1;
    this.current = {
      dir,
      manifest,
      organization,
      version: { seq: this.seq, updatedAt: organization.updatedAt },
    };
    return this.current;
  }

  requireOpen(): OpenWorkspace {
    if (!this.current) {
      throw new OrgApiError(
        errorCodes.workspace_not_open,
        422,
        "no workspace is open; POST /workspace/open first",
      );
    }
    return this.current;
  }

  /** Replace the organization file after an atomic publish; bumps the version stamp. */
  replaceOrganization(organization: OrganizationFile, updatedAt: string): OrgTreeVersion {
    const ws = this.requireOpen();
    ws.organization = organization;
    this.seq += 1;
    ws.version = { seq: this.seq, updatedAt };
    return ws.version;
  }

  /** Reload the engine-owned applied model after a successful org apply. */
  async reloadAppliedOrganization(): Promise<OrgTreeVersion> {
    const ws = this.requireOpen();
    let text: string;
    try {
      text = await fs.readFile(path.join(ws.dir, APPLIED_MODEL_FILE), "utf8");
    } catch {
      throw new OrgApiError(
        errorCodes.engine_failed,
        500,
        "engine reported applied but .digital-employee/org.json is unavailable",
      );
    }
    let organization: OrganizationFile;
    try {
      organization = JSON.parse(text) as OrganizationFile;
    } catch {
      throw new OrgApiError(
        errorCodes.engine_failed,
        500,
        "engine wrote an invalid .digital-employee/org.json",
      );
    }
    if (organization.schemaVersion !== WORKSPACE_ORG_SCHEMA_VERSION) {
      throw new OrgApiError(
        errorCodes.engine_failed,
        500,
        `engine wrote unsupported organization schemaVersion: ${String(organization.schemaVersion)}`,
      );
    }
    this.assertOrganizationStructure(organization, errorCodes.engine_failed, 500);
    const version = this.replaceOrganization(organization, organization.updatedAt);
    await this.loadAndReconcileLayout(ws.dir, organization.roles);
    return version;
  }

  /** Bump version stamp without changing organization content (e.g. workspace open). */
  touch(): OrgTreeVersion | null {
    if (!this.current) return null;
    this.seq += 1;
    this.current.version = { seq: this.seq, updatedAt: this.current.organization.updatedAt };
    return this.current.version;
  }

  /**
   * org-tree.v1 snapshot (frozen minimal shape, mirror of the engine's
   * buildOrgTree): nested tree from applied-state roles, children ordered by
   * the org-layout.v1 overlay (#32 D-32-1, alphabetical fallback), depth from
   * 1, updatedAt from the organization model. Budget is required on every
   * node (REQ-006 fail-closed mirror): a budget-less position makes the org
   * invalid rather than emitting a schema-violating tree.
   */
  snapshot(): OrgTreeSnapshot {
    const ws = this.requireOpen();
    const roles = ws.organization.roles;
    for (const role of roles) {
      if (!role.budget) {
        throw new OrgApiError(
          errorCodes.organization_invalid,
          422,
          `position lacks a budget declaration: ${role.id} (REQ-006; mirror of the engine budget gate)`,
        );
      }
    }
    const childrenByParent = new Map<string | null, OrgRole[]>();
    for (const role of roles) {
      const list = childrenByParent.get(role.reportTo) ?? [];
      list.push(role);
      childrenByParent.set(role.reportTo, list);
    }
    const orderedChildren = new Map<string | null, OrgRole[]>();
    for (const [parent, list] of childrenByParent) {
      const byId = new Map(list.map((role) => [role.id, role]));
      const orderedIds = orderChildren(
        list.map((role) => role.id),
        this.layout,
        parentKey(parent),
      );
      orderedChildren.set(
        parent,
        orderedIds.map((id) => byId.get(id)!),
      );
    }
    let depth = 0;
    const build = (role: OrgRole, level: number): OrgTreeNodeV1 => {
      depth = Math.max(depth, level);
      return {
        id: role.id,
        reportTo: role.reportTo,
        budget: role.budget,
        children: (orderedChildren.get(role.id) ?? []).map((child) =>
          build(child, level + 1),
        ),
      };
    };
    const tree = (orderedChildren.get(null) ?? []).map((root) => build(root, 1));
    return {
      schemaVersion: ORG_TREE_SCHEMA_VERSION,
      business: ws.organization.business,
      owner: ws.organization.owner,
      updatedAt: ws.organization.updatedAt,
      positionCount: roles.length,
      depth,
      tree,
    };
  }

  /** Current org-layout overlay (in-memory; authoritative copy lives on disk). */
  getLayout(): OrgLayoutFile {
    return this.layout;
  }

  /** Persist a caller-validated overlay order (reorder op / undo) atomically. */
  async setLayoutOrder(order: Record<string, string[]>): Promise<OrgLayoutFile> {
    const ws = this.requireOpen();
    const next: OrgLayoutFile = {
      schemaVersion: ORG_LAYOUT_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      order,
    };
    await writeLayoutAtomic(ws.dir, next);
    this.layout = next;
    return next;
  }

  private async loadAndReconcileLayout(dir: string, roles: OrgRole[]): Promise<void> {
    const loaded = await readLayout(dir);
    const reconciled = reconcileLayout(roles, loaded);
    if (!reconciled.changed) {
      this.layout = loaded;
      return;
    }
    const stamped: OrgLayoutFile = {
      ...reconciled.layout,
      updatedAt: new Date().toISOString(),
    };
    await writeLayoutAtomic(dir, stamped);
    this.layout = stamped;
  }

  /**
   * Read the organization model with applied-state precedence (V2 model):
   * `.digital-employee/org.json` (written by the engine `org apply`, 0600)
   * when present, else the init declaration `organization.v1alpha1.json`
   * (pre-apply, mirrors the engine's loadOrgModel bootstrap).
   */
  private async readOrganizationFile(dir: string): Promise<OrganizationFile> {
    let text: string | null = null;
    try {
      text = await fs.readFile(path.join(dir, APPLIED_MODEL_FILE), "utf8");
    } catch {
      text = null;
    }
    if (text === null) {
      try {
        text = await fs.readFile(path.join(dir, ORGANIZATION_FILE), "utf8");
      } catch {
        throw new OrgApiError(
          errorCodes.workspace_invalid,
          422,
          "organization file missing (organization.v1alpha1.json)",
        );
      }
    }
    let organization: OrganizationFile;
    try {
      organization = JSON.parse(text) as OrganizationFile;
    } catch {
      throw new OrgApiError(
        errorCodes.workspace_invalid,
        422,
        "organization file is not valid JSON",
      );
    }
    if (organization.schemaVersion !== WORKSPACE_ORG_SCHEMA_VERSION) {
      throw new OrgApiError(
        errorCodes.workspace_invalid,
        422,
        `unsupported organization schemaVersion: ${String(organization.schemaVersion)}`,
      );
    }
    return organization;
  }

  private async readJson<T>(file: string, missingMessage: string): Promise<T> {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new OrgApiError(errorCodes.workspace_invalid, 422, missingMessage);
      }
      throw new OrgApiError(
        errorCodes.workspace_invalid,
        422,
        `unreadable workspace file: ${path.basename(file)}`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OrgApiError(
        errorCodes.workspace_invalid,
        422,
        `workspace file is not valid JSON: ${path.basename(file)}`,
      );
    }
  }

  private assertOrganizationStructure(
    organization: OrganizationFile,
    code: string,
    status: number,
  ): void {
    if (
      typeof organization.business !== "string" ||
      typeof organization.owner !== "string" ||
      typeof organization.updatedAt !== "string" ||
      !Array.isArray(organization.roles)
    ) {
      throw new OrgApiError(
        code,
        status,
        "organization file failed structural checks (business/owner/updatedAt/roles)",
      );
    }
  }
}
