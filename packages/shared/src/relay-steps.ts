import { createRequire } from "node:module";
import type { RelayStepInstruction } from "./groups.js";
const contract = createRequire(import.meta.url)("../relay-steps.cjs") as {
  MAX_RELAY_INSTRUCTION_BYTES: number;
  MAX_RELAY_INSTRUCTIONS_BYTES: number;
  isRelaySteps(value: unknown, mentions: readonly string[], mode: unknown): value is RelayStepInstruction[];
};
export const { MAX_RELAY_INSTRUCTION_BYTES, MAX_RELAY_INSTRUCTIONS_BYTES, isRelaySteps } = contract;
