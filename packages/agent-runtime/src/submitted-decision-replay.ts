// Compatibility for existing internal/test imports. New code uses the owning module.
export {
  classifySubmittedDecisionBindingFailure,
  isPinnedSubmittedDecisionReplay,
  type SubmittedDecisionBindingFailureCode,
} from "./decision/submitted-replay.js";
