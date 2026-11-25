// Compatibility for existing internal/test imports. New code uses the owning module.
export {
  type ConversationAnsweredSource,
  type ConversationCheckpointProjection,
  type ConversationCheckpointProjectionResult,
  projectConversationCheckpointHistory,
} from "./checkpoint/conversation/projection.js";
