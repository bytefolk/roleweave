/** Shared storage limits for turn history and group context. */
export const MAX_TURNS_PER_POSITION = 256;
export const MAX_GROUP_MEMBERS = 32;

// All members' history, plus one omission per corrupt member source.
export const THREAD_CONTEXT_MAX_OMITTED_TURNS =
  MAX_TURNS_PER_POSITION * MAX_GROUP_MEMBERS + MAX_GROUP_MEMBERS;
