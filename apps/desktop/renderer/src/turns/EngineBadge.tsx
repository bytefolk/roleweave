import { EngineIcon } from "./engine-icon";
import { useEngineLabel } from "./engine-select";
import type { TurnEngine } from "./types";

/** Runtime identity, without implying that the employee can switch Hosts here. */
export function EngineBadge({ engine }: { engine: TurnEngine }) {
  const labelOf = useEngineLabel();
  return <span className="owb-engine-badge"><EngineIcon engine={engine} /><span>{labelOf(engine)}</span></span>;
}
