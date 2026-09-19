import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.png";
import qoderIcon from "../assets/qoder.png";
import geminiIcon from "../assets/gemini.svg";
import workbuddyIcon from "../assets/workbuddy.svg";
import type { TurnEngine } from "./types";

const ENGINE_ICON_SRC: Record<TurnEngine, string> = {
  qoder: qoderIcon,
  "claude-code": claudeIcon,
  "claude-local": claudeIcon,
  codex: codexIcon,
  "codex-local": codexIcon,
  workbuddy: workbuddyIcon,
  gemini: geminiIcon,
};

/** Per-agent-host brand mark (#57): Qoder app mark / Claude starburst.
 * Sources: qoder.com official favicon (app-mark raster), claude.ai favicon,
 * and for Codex (#206) the official OpenAI mark as published by OpenAI's own
 * GitHub organisation avatar. WorkBuddy uses the product's official logo.svg
 * served by workbuddy.ai. */
export function EngineIcon({ engine }: { engine: TurnEngine }) {
  return <img src={ENGINE_ICON_SRC[engine]} alt="" aria-hidden="true" className={`owb-engine-icon owb-engine-icon--${engine}`} draggable={false} />;
}
