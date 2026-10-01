export { SpaceModule, SPACE_SPINE_FILE } from "./SpaceModule.js";
export type { SpaceModuleProps, SpaceAgent } from "./SpaceModule.js";
export { SpaceHost } from "./SpaceHost.js";
export type { SpaceHostProps } from "./SpaceHost.js";
export { useSpaceFiles } from "./useSpaceFiles.js";
export type { SpaceFilesState } from "./useSpaceFiles.js";
export { AcceptanceGate } from "./AcceptanceGate.js";
export type { AcceptanceGateProps } from "./AcceptanceGate.js";
export {
  buildAcceptanceRecord,
  buildVerdicts,
  canAccept,
  canReject,
  untickedCriteria,
} from "./acceptance-gate-model.js";
export type { GateDraft, GateEvidence, GateTicks } from "./acceptance-gate-model.js";
