// Compatibility for existing internal/test imports. New code uses the owning module.
export {
  type SubmittedDecisionBindingFailureCode,
  classifySubmittedDecisionBindingFailure,
  isPinnedSubmittedDecisionReplay,
} from "./decision/submitted-replay.js";
