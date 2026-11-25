// Compatibility for existing internal/test imports. New code uses the owning module.
export {
  nativeCompactionProviderTurnId,
  nativeCheckpointOwnerExecutionId,
  containsNativeCheckpointInput,
  portableRequestHasNativeCheckpoint,
  decodeUniqueNativePortableFrontier,
} from "./checkpoint/native-evidence.js";
