export interface DismissHandoffCandidate {
  id: string;
  name: string;
  mode?: string;
}

export interface DismissHandoffFacts {
  runningTurns: number;
  boundGoals: number;
  pendingApprovals: number;
}

export function presentDismissHandoff(input: {
  flagOn: boolean;
  dismissingId: string;
  facts: DismissHandoffFacts;
  candidates: DismissHandoffCandidate[];
}): {
  visible: boolean;
  facts: DismissHandoffFacts;
  suggestion: DismissHandoffCandidate | null;
} {
  if (!input.flagOn) {
    return {
      visible: false,
      facts: { runningTurns: 0, boundGoals: 0, pendingApprovals: 0 },
      suggestion: null,
    };
  }
  const suggestion = input.candidates.find((candidate) => candidate.id !== input.dismissingId) ?? null;
  return { visible: true, facts: input.facts, suggestion };
}
