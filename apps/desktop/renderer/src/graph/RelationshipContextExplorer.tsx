import { useMemo } from "react";
import { ArrowRight, FileSearch, Layers3, Network, ShieldCheck, UserRound } from "lucide-react";
import type { RelationshipEdge, RelationshipKind, RelationshipNode, RelationshipNodeKind } from "@roleweave/shared/relationship-graph";
import { useT } from "@roleweave/ui";
import { useRelationshipContextCopy } from "../locales/relationship-context";

export interface RelationshipContextExplorerProps {
  nodes: RelationshipNode[];
  edges: RelationshipEdge[];
  focusId?: string;
  focusMissing?: boolean;
  onFocus: (id: string) => void;
  onSelectEdge: (id: string) => void;
}

const relationOrder: RelationshipKind[] = ["declares_source", "contains_resource", "available_in", "has_policy", "declares_allow", "declares_deny", "bound_to", "reports_to", "contains", "assigned_to", "requested_by", "budget_owner"];

function isSelector(node: RelationshipNode) {
  return node.facts?.some(fact => fact.key === "kind" && fact.value === "selector") ?? false;
}

/** A bounded, readable view of the same projection used by the graph and list. */
export function RelationshipContextExplorer({ nodes, edges, focusId, focusMissing = false, onFocus, onSelectEdge }: RelationshipContextExplorerProps) {
  const t = useT();
  const copy = useRelationshipContextCopy();
  const nodesById = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const focus = focusId ? nodesById.get(focusId) : undefined;
  const directEdges = useMemo(() => focus ? edges.filter(edge => (edge.source === focus.id || edge.target === focus.id) && nodesById.has(edge.source) && nodesById.has(edge.target)) : [], [edges, focus, nodesById]);
  const groups = useMemo(() => relationOrder.flatMap(kind => ["outgoing", "incoming"].flatMap(direction => {
    const matching = directEdges.filter(edge => edge.kind === kind && (direction === "outgoing" ? edge.source === focus?.id : edge.target === focus?.id && edge.source !== focus?.id));
    return matching.length ? [{ kind, direction, edges: matching }] : [];
  })), [directEdges, focus]);

  const typeHelp: Record<RelationshipNodeKind, string> = {
    workspace: copy.workspaceHelp, agent: copy.agentHelp, host: copy.hostHelp,
    source: copy.sourceHelp, resource: copy.resourceHelp, capability: copy.capabilityHelp,
    policy: copy.policyHelp, goal: copy.goalHelp, task: copy.taskHelp,
  };

  if (focusId && !focus) {
    return <section className="owb-rgraph__context" aria-label={copy.contextTitle}>
      <div className="owb-rgraph__context-empty" role="status"><Network size={28} aria-hidden="true" /><strong>{t(focusMissing ? "graph.deletedSelection" : "graph.filteredSelection")}</strong>{!focusMissing ? <p>{copy.filteredFocusHelp}</p> : null}</div>
    </section>;
  }

  if (!focus) {
    const employee = nodes.find(node => node.kind === "agent" && edges.some(edge => edge.kind === "declares_source" && edge.source === node.id)) ?? nodes.find(node => node.kind === "agent");
    const resource = nodes.find(node => node.kind === "resource" && !isSelector(node) && edges.some(edge => edge.kind === "contains_resource" && edge.target === node.id))
      ?? nodes.find(node => node.kind === "resource" && !isSelector(node)) ?? nodes.find(node => node.kind === "source");
    const permission = nodes.find(node => node.kind === "policy") ?? nodes.find(node => node.kind === "capability")
      ?? nodes.find(node => node.kind === "agent" && edges.some(edge => edge.source === node.id && ["declares_allow", "declares_deny", "has_policy"].includes(edge.kind)));
    const starters = [
      { icon: UserRound, title: copy.employeeQuestion, help: copy.employeeQuestionHelp, node: employee },
      { icon: FileSearch, title: copy.sourceQuestion, help: copy.sourceQuestionHelp, node: resource },
      { icon: ShieldCheck, title: copy.permissionQuestion, help: copy.permissionQuestionHelp, node: permission },
    ];
    return <section className="owb-rgraph__context owb-rgraph__welcome" aria-label={copy.contextTitle}>
      <div className="owb-rgraph__welcome-intro"><span className="owb-rgraph__focus-eyebrow"><Layers3 size={16} aria-hidden="true" />{copy.guideTitle}</span><h2>{copy.welcomeTitle}</h2><p>{copy.welcomeIntro}</p></div>
      <div className="owb-rgraph__schema-example"><small>{copy.example}</small><div className="owb-rgraph__schema-chain">
        <span className="owb-rgraph__schema-node"><UserRound size={16} aria-hidden="true" />{copy.exampleEmployee}</span>
        <span className="owb-rgraph__schema-relation">{t("graph.relation.declares_source")}<ArrowRight size={16} aria-hidden="true" /></span>
        <span className="owb-rgraph__schema-node">{copy.exampleSource}</span>
        <span className="owb-rgraph__schema-relation">{t("graph.relation.contains_resource")}<ArrowRight size={16} aria-hidden="true" /></span>
        <span className="owb-rgraph__schema-node">{copy.exampleResource}</span>
      </div></div>
      <div className="owb-rgraph__question-starters"><h2>{copy.startersTitle}</h2>{starters.map(({ icon: Icon, title, help, node }) => <button className="owb-rgraph__question-starter" key={title} type="button" disabled={!node} onClick={() => node && onFocus(node.id)}>
        <Icon size={19} aria-hidden="true" /><span><strong>{title}</strong><small>{help}</small><em>{node?.label ?? copy.starterUnavailable}</em></span><ArrowRight size={16} aria-hidden="true" />
      </button>)}</div>
      {!nodes.length ? <p className="owb-rgraph__context-empty" role="status">{copy.emptyObjects}</p> : null}
    </section>;
  }

  const nodeType = (node: RelationshipNode) => isSelector(node) ? copy.selector : t(`graph.kind.${node.kind}`);
  const endpoint = (node: RelationshipNode) => node.id === focus.id
    ? <span className="owb-rgraph__relation-endpoint is-focus"><strong>{node.label}</strong><small>{nodeType(node)}</small></span>
    : <button type="button" className="owb-rgraph__neighbor-button" aria-label={`${copy.exploreObject}: ${node.label}`} onClick={() => onFocus(node.id)}><strong>{node.label}</strong><small>{nodeType(node)}</small></button>;

  return <section className="owb-rgraph__context" aria-label={copy.contextTitle}>
    <div className="owb-rgraph__focus-card">
      <span className="owb-rgraph__focus-eyebrow"><Network size={15} aria-hidden="true" />{copy.focusLabel}</span>
      <div className="owb-rgraph__focus-identity"><strong>{focus.label}</strong><span>{nodeType(focus)}</span><span>{t(`graph.state.${focus.state}`)}</span></div>
      {focus.resourcePath && !isSelector(focus) ? <p className="owb-rgraph__resource-path">{focus.resourcePath}</p> : null}
      <p className="owb-rgraph__focus-help">{isSelector(focus) ? copy.selectorHelp : focus.kind === "source" && focus.facts?.some(fact => fact.key === "kind" && fact.value === "context_provider") ? copy.contextProviderHelp : typeHelp[focus.kind]}</p>
      <div className="owb-rgraph__context-metrics"><span><strong>{directEdges.length}</strong> {copy.relatedCount}</span><span title={focus.evidence.basis === "declared" ? copy.declaredHelp : copy.observedHelp}>{t(`graph.${focus.evidence.basis}`)}</span></div>
    </div>
    {groups.length ? <>
      <p className="owb-rgraph__context-hint"><ArrowRight size={14} aria-hidden="true" />{copy.continueExploring}</p>
      <div className="owb-rgraph__relation-groups">{groups.map(group => <section className="owb-rgraph__relation-group" key={`${group.direction}:${group.kind}`}>
        <header className="owb-rgraph__relation-group-header"><h3>{t(`graph.relation.${group.kind}`)}</h3><span>{group.direction === "outgoing" ? copy.outgoing : copy.incoming} · {group.edges.length}</span></header>
        <ul className="owb-rgraph__relation-cards">{group.edges.map(edge => <li className="owb-rgraph__relation-card" key={edge.id}>
          <div className="owb-rgraph__relation-statement">{endpoint(nodesById.get(edge.source)!)}<span className="owb-rgraph__relation-arrow" aria-hidden="true">→</span><span className="owb-rgraph__relation-label">{t(`graph.relation.${edge.kind}`)}</span><span className="owb-rgraph__relation-arrow" aria-hidden="true">→</span>{endpoint(nodesById.get(edge.target)!)}</div>
          <div className="owb-rgraph__relation-evidence"><span title={edge.evidence.basis === "declared" ? copy.declaredHelp : copy.observedHelp}><span>{t(`graph.${edge.evidence.basis}`)}</span><small>{edge.evidence.source}</small></span><button type="button" className="owb-rgraph__evidence-button" aria-label={`${copy.evidenceButton}: ${nodesById.get(edge.source)!.label} → ${t(`graph.relation.${edge.kind}`)} → ${nodesById.get(edge.target)!.label}`} onClick={() => onSelectEdge(edge.id)}><FileSearch size={14} aria-hidden="true" />{copy.evidenceButton}</button></div>
        </li>)}</ul>
      </section>)}</div>
    </> : <p className="owb-rgraph__context-empty" role="status">{copy.noDirectRelations}</p>}
  </section>;
}
