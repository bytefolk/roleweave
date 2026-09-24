import { useEffect, useMemo, useRef, useState } from "react";
import { parseDocRef, type AssetRecord, type DocRef } from "@roleweave/shared/docs";
import { useT } from "@roleweave/ui";
import { useWorkspaceExperiments } from "../experiments/useWorkspaceExperiments";
import {
  evaluateDeliveryPreflightItem,
  type DeliveryMaterialCheck,
  type DeliveryPreflightItem,
} from "./delivery-preflight";

export interface DeliveryPreflightPanelProps {
  workspacePath?: string;
  workspaceScope?: symbol;
  goalId: string;
  acceptanceCriteria: string[];
}

function criterionId(index: number): string {
  return `criterion-${index + 1}`;
}

function sameRef(left: DocRef, right: DocRef): boolean {
  return left.uri === right.uri && left.version === right.version && left.anchor === right.anchor;
}

export function DeliveryPreflightPanel({
  workspacePath,
  workspaceScope,
  goalId,
  acceptanceCriteria,
}: DeliveryPreflightPanelProps) {
  const t = useT();
  const settings = useWorkspaceExperiments({ workspacePath, workspaceScope });
  const enabled = settings.snapshot?.enabled === true;
  const owner = useMemo(() => ({}), [settings.owner, goalId]);
  const activeOwner = useRef(owner);
  activeOwner.current = owner;
  const request = useRef(0);
  const [materials, setMaterials] = useState<AssetRecord[]>([]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [results, setResults] = useState<Record<string, DeliveryPreflightItem>>({});
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const id = ++request.current;
    setMaterials([]);
    setSelected({});
    setResults({});
    setRunning(false);
    setLoadFailed(false);
    if (!enabled || !workspacePath) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.owb.assetsList().then((response) => {
      if (request.current !== id || activeOwner.current !== owner) return;
      if (response.status !== 200) throw new Error("assets unavailable");
      setMaterials(response.body.assets.filter((asset) => asset.kind === "doc" && asset.docRef));
    }).catch(() => {
      if (request.current === id && activeOwner.current === owner) setLoadFailed(true);
    }).finally(() => {
      if (request.current === id && activeOwner.current === owner) setLoading(false);
    });
    return () => {
      if (request.current === id) request.current += 1;
    };
  }, [enabled, owner, workspacePath]);

  if (!enabled || !workspacePath) return null;

  const toggle = (id: string, materialId: string, checked: boolean) => {
    if (running) return;
    setSelected((current) => {
      const values = new Set(current[id] ?? []);
      if (checked) values.add(materialId);
      else values.delete(materialId);
      return { ...current, [id]: [...values] };
    });
    setResults((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const run = async () => {
    if (running) return;
    const id = ++request.current;
    const snapshot = selected;
    setRunning(true);
    const chosenIds = new Set(Object.values(snapshot).flat());
    const checks = new Map<string, DeliveryMaterialCheck>();
    await Promise.all(materials.filter((material) => chosenIds.has(material.assetId)).map(async (material) => {
      const parsed = parseDocRef(material.docRef);
      if (!parsed.ok) {
        checks.set(material.assetId, { materialId: material.assetId, ref: material.docRef!, resolved: null });
        return;
      }
      const ref = parsed.ref;
      let resolved: DeliveryMaterialCheck["resolved"] = null;
      if (ref.version) {
        try {
          const response = await window.owb.resolveDocRef(ref);
          if (
            response.status === 200 &&
            sameRef(response.body.ref, ref) &&
            typeof response.body.resolved.modifiedAt === "string"
          ) {
            resolved = { modifiedAt: response.body.resolved.modifiedAt };
          }
        } catch {
          resolved = null;
        }
      }
      checks.set(material.assetId, { materialId: material.assetId, ref, resolved });
    }));
    if (request.current !== id || activeOwner.current !== owner || !settings.current()) return;
    const next: Record<string, DeliveryPreflightItem> = {};
    acceptanceCriteria.forEach((_criterion, index) => {
      const key = criterionId(index);
      const selectedChecks = (snapshot[key] ?? []).flatMap((materialId) => {
        const check = checks.get(materialId);
        return check ? [check] : [];
      });
      next[key] = evaluateDeliveryPreflightItem({ criterionId: key, materials: selectedChecks });
    });
    setResults(next);
    setRunning(false);
  };

  return (
    <section className="owb-delivery-preflight" data-testid="delivery-preflight-panel" aria-label={t("goals.preflight.title")}>
      <header>
        <div>
          <h3>{t("goals.preflight.title")}</h3>
          <p>{t("goals.preflight.intro")}</p>
        </div>
        <button type="button" data-testid="delivery-preflight-run" disabled={loading || running || loadFailed} onClick={() => void run()}>
          {running ? t("goals.preflight.running") : t("goals.preflight.run")}
        </button>
      </header>
      {loading ? <p role="status">{t("goals.preflight.loading")}</p> : null}
      {loadFailed ? <p role="alert">{t("goals.preflight.loadError")}</p> : null}
      {!loading && !loadFailed && acceptanceCriteria.length === 0 ? <p>{t("goals.preflight.noCriteria")}</p> : null}
      {!loading && !loadFailed && acceptanceCriteria.map((criterion, index) => {
        const id = criterionId(index);
        const result = results[id];
        return (
          <fieldset key={id} className="owb-delivery-preflight__criterion">
            <legend><code>{id}</code> {criterion}</legend>
            {materials.length === 0 ? <p>{t("goals.preflight.noMaterials")}</p> : materials.map((material) => (
              <label key={material.assetId}>
                <input
                  type="checkbox"
                  disabled={running}
                  checked={(selected[id] ?? []).includes(material.assetId)}
                  onChange={(event) => toggle(id, material.assetId, event.currentTarget.checked)}
                />
                <span>{material.title} · <code>{material.assetId}</code></span>
              </label>
            ))}
            {result ? (
              <p data-testid={`delivery-preflight-status-${id}`} className={`owb-delivery-preflight__result owb-delivery-preflight__result--${result.status}`}>
                {t(`goals.preflight.status.${result.status}`)} · {t(`goals.preflight.reason.${result.reason}`)}
                {result.materialIds.length > 0 ? ` · ${result.materialIds.join(", ")}` : ""}
              </p>
            ) : null}
          </fieldset>
        );
      })}
    </section>
  );
}
