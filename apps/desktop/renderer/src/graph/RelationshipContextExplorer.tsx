import { useMemo, type ReactNode } from "react";
import { ArrowRight, FileSearch, Network, UserRound } from "lucide-react";
import type { RelationshipEdge, RelationshipKind, RelationshipNode, RelationshipNodeKind } from "@roleweave/shared/relationship-graph";
import { useT } from "@roleweave/ui";
import { useRelationshipContextCopy } from "../locales/relationship-context";

export interface RelationshipContextExplorerProps {
  nodes: RelationshipNode[];
  edges: RelationshipEdge[];
  focusId?: string;
  focusMissing?: boolean;
  guideActive?: boolean;
  actions?: ReactNode;
  onFocus: (id: string) => void;
  onSelectEdge: (id: string) => void;
}

const relationOrder: RelationshipKind[] = ["declares_source", "contains_resource", "available_in", "has_policy", "declares_allow", "declares_deny", "bound_to", "reports_to", "contains", "assigned_to", "requested_by", "budget_owner"];

function isSelector(node: RelationshipNode) {
  return node.facts?.some(fact => fact.key === "kind" && fact.value === "selector") ?? false;
}

export function isRelationshipConfiguration(node: RelationshipNode): boolean {
  return isSelector(node)
    || ["capability", "policy", "host", "workspace"].includes(node.kind)
    || (node.kind === "source" && (node.facts?.some(fact => fact.key === "kind" && fact.value === "context_provider") ?? false));
}

/** A bounded, readable view of the same projection used by the graph and list. */
export function RelationshipContextExplorer({ nodes, edges, focusId, focusMissing = false, actions, onFocus, onSelectEdge }: RelationshipContextExplorerProps) {
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
    const starters = [
      { icon: UserRound, title: copy.employeeQuestion, action: copy.employeeShortcut, node: employee },
      { icon: FileSearch, title: copy.sourceQuestion, action: copy.sourceShortcut, node: resource },
    ];
    return <section className="owb-rgraph__context owb-rgraph__welcome" aria-label={copy.contextTitle}>
      <div className="owb-rgraph__welcome-intro"><p>{copy.browseObject}</p></div>
      <div className="owb-rgraph__question-starters">{starters.map(({ icon: Icon, title, action, node }) => <button className="owb-rgraph__question-starter" key={title} type="button" aria-label={`${title} ${action}: ${node?.label ?? copy.starterUnavailable}`} disabled={!node} onClick={() => node && onFocus(node.id)}>
        <Icon size={19} aria-hidden="true" /><span><strong>{action}</strong><small>{node ? `${copy.guideTryEmployee} ${node.label}` : copy.starterUnavailable}</small></span><ArrowRight size={16} aria-hidden="true" />
      </button>)}</div>
      {!nodes.length ? <p className="owb-rgraph__context-empty" role="status">{copy.emptyObjects}</p> : null}
    </section>;
  }

  const nodeType = (node: RelationshipNode) => isSelector(node) ? copy.selector : t(`graph.kind.${node.kind}`);
  const rows = groups.flatMap(group => group.edges.map(edge => ({
    edge,
    neighbor: nodesById.get(edge.source === focus.id ? edge.target : edge.source)!,
    relationship: group.direction === "outgoing" ? copy.outgoingRelations[edge.kind] : copy.incomingRelations[edge.kind],
  })));
  const primaryRows = rows.filter(row => !isRelationshipConfiguration(row.neighbor));
  const configurationRows = rows.filter(row => isRelationshipConfiguration(row.neighbor));
  const renderRows = (items: typeof rows, label: string) => <ul className="owb-rgraph__relation-cards" aria-label={label}>{items.map(({ edge, neighbor, relationship }) => <li className="owb-rgraph__relation-card" key={edge.id}>
    <div className="owb-rgraph__relation-row">
      <button type="button" className="owb-rgraph__neighbor-button" aria-label={`${copy.exploreObject}: ${neighbor.label}`} onClick={() => onFocus(neighbor.id)}><strong>{neighbor.label}</strong><small>{nodeType(neighbor)}</small></button>
      <span className="owb-rgraph__relation-label">{relationship}</span>
      <button type="button" className="owb-rgraph__evidence-button" aria-label={`${copy.evidenceButton}: ${nodesById.get(edge.source)!.label} → ${t(`graph.relation.${edge.kind}`)} → ${nodesById.get(edge.target)!.label}`} onClick={() => onSelectEdge(edge.id)}><FileSearch size={14} aria-hidden="true" />{copy.evidenceButton}</button>
    </div>
  </li>)}</ul>;

  return <section className="owb-rgraph__context" aria-label={copy.contextTitle}>
    <div className="owb-rgraph__focus-card">
      <header className="owb-rgraph__focus-header"><h2>{focus.label}</h2>{actions}</header>
      <p className="owb-rgraph__focus-help">{isSelector(focus) ? copy.selectorHelp : focus.kind === "source" && focus.facts?.some(fact => fact.key === "kind" && fact.value === "context_provider") ? copy.contextProviderHelp : typeHelp[focus.kind]}</p>
    </div>
    {primaryRows.length ? <>
      <header className="owb-rgraph__relation-group-header"><h3>{copy.relatedObjects}</h3></header>
      {renderRows(primaryRows, copy.relatedObjects)}
    </> : !configurationRows.length ? <p className="owb-rgraph__context-empty" role="status">{copy.noDirectRelations}</p> : null}
    {configurationRows.length ? <details key={focus.id} className="owb-rgraph__configuration">
      <summary>{copy.capabilitiesConfiguration}<span>{configurationRows.length}</span></summary>
      {renderRows(configurationRows, copy.capabilitiesConfiguration)}
    </details> : null}
  </section>;
}
