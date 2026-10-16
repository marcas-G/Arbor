import {
  P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
  P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
} from "../../adapters/persistence-sqlite/src/index.js";

/** The version-42 suffix is retained for historical migration qualification. */
export const HISTORICAL_SCHEMA42_SUFFIX_IDS = [40, 41, 42] as const;
export const HISTORICAL_SCHEMA42_SUFFIX_MIGRATIONS = [
  P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
  P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
] as const;

/** Current registered schema suffix after schema-42 activation. */
export const CURRENT_SCHEMA44_SUFFIX_IDS = [40, 41, 42, 43, 44] as const;
