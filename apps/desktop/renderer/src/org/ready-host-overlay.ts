import type { TurnEngine } from "../turns/types";

/** Deterministic ready-host facts (#465). No prompts. */
export interface ReadyHostFact {
  positionId: string;
  engine: TurnEngine;
  ready: boolean;
}

export interface ReadyHostOverlayInput {
  overlayEnabled: boolean;
  selected: ReadyHostFact | null;
  positions: ReadyHostFact[];
}

export interface ReadyHostOverlayPresentation {
  visible: boolean;
  /** True only when overlay is on, the selection is unready, and 2+ ready hosts exist. */
  callJev: boolean;
  candidates: ReadyHostFact[];
}

export function presentReadyHostOverlay(input: ReadyHostOverlayInput): ReadyHostOverlayPresentation {
  const selectedUnready = input.selected !== null && input.selected.ready === false;
  const selectedId = input.selected?.positionId;
  const candidates = input.positions.filter(
    (position) => position.ready && position.positionId !== selectedId,
  );
  const callJev = input.overlayEnabled === true && selectedUnready && candidates.length >= 2;
  return {
    visible: input.overlayEnabled === true && selectedUnready && candidates.length > 0,
    callJev,
    candidates,
  };
}
