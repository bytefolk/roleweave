import type { RelayStepInstruction } from "@roleweave/shared";
// Mirror the public request limits; contract parity is covered by renderer tests.
export const RELAY_INSTRUCTION_BYTES = 4096;
export const RELAY_INSTRUCTIONS_BYTES = 32768;
export const instructionBytes = (text: string): number => new TextEncoder().encode(text).length;
export function selectedRelaySteps(mentions: readonly string[], instructions: Record<string, string>): RelayStepInstruction[] {
  return mentions.flatMap(positionId => {
    const instruction = (instructions[positionId] ?? "").trim();
    return instruction ? [{ positionId, instruction }] : [];
  });
}
export function relayStepsTooLarge(steps: readonly RelayStepInstruction[]): boolean {
  return steps.some(step => instructionBytes(step.instruction) > RELAY_INSTRUCTION_BYTES)
    || steps.reduce((sum, step) => sum + instructionBytes(step.instruction), 0) > RELAY_INSTRUCTIONS_BYTES;
}
