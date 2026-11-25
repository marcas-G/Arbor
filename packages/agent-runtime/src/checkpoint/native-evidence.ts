import { type Execution, ExecutionId, ProviderTurnId, parse } from "@arbor/domain";
import type { PortableInputItem, PortableModelRequestV2 } from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";

export const nativeCompactionProviderTurnId = (value: string): ProviderTurnId | null =>
  (() => {
    try {
      const decoded = parse(ProviderTurnId)(value);
      return /_native_compact_(?:0|[1-9][0-9]*)$/u.test(decoded)
        ? decoded
        : null;
    } catch {
      return null;
    }
  })();

/**
 * Return the execution that durably owns an ordinary Native checkpoint.
 *
 * A Work Session can carry a checkpoint into a later Work execution.  The
 * checkpoint's manifest and source step therefore identify the producing
 * execution, which is deliberately different from the execution currently
 * rebuilding the Session context.  Malformed evidence is left unknown so the
 * caller can fail closed instead of treating it as inherited context.
 */
export const nativeCheckpointOwnerExecutionId = (
  manifestJson: string,
): Execution["executionId"] | undefined => {
  try {
    const parsed = JSON.parse(manifestJson) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const manifest = parsed as Record<string, unknown>;
    const source = manifest.sourceAgentLoopStep;
    if (
      typeof manifest.executionId !== "string" ||
      typeof source !== "object" ||
      source === null ||
      Array.isArray(source) ||
      typeof (source as Record<string, unknown>).executionId !== "string" ||
      (source as Record<string, unknown>).executionId !== manifest.executionId
    ) {
      return undefined;
    }
    try {
      return parse(ExecutionId)(manifest.executionId);
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
};

interface NativePortableFrontier {
  readonly manifest: Record<string, unknown>;
  readonly request: PortableModelRequestV2;
  readonly inputFrontier: {
    readonly firstSequence: number | null;
    readonly lastSequence: number | null;
  };
  readonly contextRefs: ReadonlyArray<string>;
  readonly inputItems: ReadonlyArray<PortableInputItem>;
}

export const containsNativeCheckpointInput = (
  inputItems: ReadonlyArray<unknown>,
): boolean =>
  inputItems.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "_tag" in item &&
      item._tag === "CompactionCheckpoint" &&
      "implementation" in item &&
      item.implementation === "ProviderNative",
  );

export const portableRequestHasNativeCheckpoint = (portableRequestJson: string) => {
  try {
    const value = JSON.parse(portableRequestJson) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("inputItems" in value) ||
      !Array.isArray(value.inputItems)
    ) {
      return false;
    }
    return containsNativeCheckpointInput(value.inputItems);
  } catch {
    return false;
  }
};

export const decodeUniqueNativePortableFrontier = (
  manifestJson: string,
  portableRequestJson: string,
): NativePortableFrontier | null => {
  try {
    const manifestValue = JSON.parse(manifestJson) as unknown;
    const requestValue = JSON.parse(portableRequestJson) as unknown;
    if (
      typeof manifestValue !== "object" ||
      manifestValue === null ||
      Array.isArray(manifestValue) ||
      typeof requestValue !== "object" ||
      requestValue === null ||
      Array.isArray(requestValue)
    ) {
      return null;
    }
    const manifest = manifestValue as Record<string, unknown>;
    const request = requestValue as Record<string, unknown>;
    const frontierValue = manifest.inputFrontier;
    const contextRefsValue = manifest.contextRefs;
    const inputItemsValue = request.inputItems;
    if (
      typeof frontierValue !== "object" ||
      frontierValue === null ||
      Array.isArray(frontierValue) ||
      !Array.isArray(contextRefsValue) ||
      !contextRefsValue.every(
        (ref): ref is string => typeof ref === "string" && ref.length > 0,
      ) ||
      contextRefsValue.length === 0 ||
      new Set(contextRefsValue).size !== contextRefsValue.length ||
      !Array.isArray(inputItemsValue) ||
      inputItemsValue.length === 0 ||
      !Array.isArray(request.instructions) ||
      !Array.isArray(request.toolDefinitions) ||
      typeof request.budget !== "object" ||
      request.budget === null ||
      typeof (request.budget as Record<string, unknown>).maxOutputTokens !==
        "number" ||
      !Array.isArray(request.cacheHints)
    ) {
      return null;
    }
    if (containsNativeCheckpointInput(inputItemsValue)) {
      return null;
    }
    const frontier = frontierValue as Record<string, unknown>;
    const firstSequence = frontier.firstSequence;
    const lastSequence = frontier.lastSequence;
    const emptyFrontier = firstSequence === null && lastSequence === null;
    const validNonEmptyFrontier =
      typeof firstSequence === "number" &&
      Number.isSafeInteger(firstSequence) &&
      firstSequence >= 0 &&
      typeof lastSequence === "number" &&
      Number.isSafeInteger(lastSequence) &&
      lastSequence >= firstSequence;
    if (
      (!emptyFrontier && !validNonEmptyFrontier) ||
      request.requestVersion !== 2 ||
      request.operationKind !== "CompactionNative" ||
      request.outputContractRef !== "provider-native-compaction-v1" ||
      typeof manifest.compiledRequestHash !== "string" ||
      manifest.compiledRequestHash !== sha256Hex(portableRequestJson)
    ) {
      return null;
    }
    return {
      manifest,
      request: request as unknown as PortableModelRequestV2,
      inputFrontier: emptyFrontier
        ? { firstSequence: null, lastSequence: null }
        : {
            firstSequence: firstSequence as number,
            lastSequence: lastSequence as number,
          },
      contextRefs: contextRefsValue,
      inputItems: inputItemsValue as ReadonlyArray<PortableInputItem>,
    };
  } catch {
    return null;
  }
};
