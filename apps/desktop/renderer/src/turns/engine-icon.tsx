import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import qoderIcon from "../assets/qoder.png";
import type { TurnEngine } from "./types";

const ENGINE_ICON_SRC: Record<TurnEngine, string> = {
  qoder: qoderIcon,
  "claude-code": claudeIcon,
  "claude-local": claudeIcon,
  codex: codexIcon,
};

/** Per-agent-host brand mark (#57): Qoder app mark / Claude starburst.
 * Sources: qoder.com official favicon (app-mark raster), claude.ai favicon.
 * #206: the Codex mark is a neutral in-repo glyph, not the vendor trademark. */
export function EngineIcon({ engine }: { engine: TurnEngine }) {
  return <img src={ENGINE_ICON_SRC[engine]} alt="" aria-hidden="true" className="owb-engine-icon" draggable={false} />;
}
