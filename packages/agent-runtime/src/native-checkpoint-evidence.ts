// Compatibility for existing internal/test imports. New code uses the owning module.
export {
  containsNativeCheckpointInput,
  decodeUniqueNativePortableFrontier,
  nativeCheckpointOwnerExecutionId,
  nativeCompactionProviderTurnId,
  portableRequestHasNativeCheckpoint,
} from "./checkpoint/native-evidence.js";
