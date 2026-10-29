import type { PortableInputItem } from "@arbor/ports";
import { type ContextFragment, historicalContextFragment } from "./context.js";
import { estimateTextTokens } from "./request-budget.js";

export interface HistoryContextProjection {
  readonly contextFragments: ReadonlyArray<ContextFragment>;
  readonly compressibleInputItemIndexes: ReadonlyArray<number>;
}

/** Latest user/attachment input in the selected Session frontier is retained
 * outside the Compressible set. */
export const latestSessionInputIndex = (
  inputItems: ReadonlyArray<PortableInputItem>,
): number => {
  for (let index = inputItems.length - 1; index >= 0; index -= 1) {
    const item = inputItems[index];
    if (
      item?._tag === "AttachmentRef" ||
      (item?._tag === "Message" && item.role === "user")
    ) {
      return index;
    }
  }
  return -1;
};

/** Projects only caller-selected historical input items into C3 budget
 * fragments. Selection and source scoping stay with the caller, which owns
 * the bound Session/Workspace read. The current input is intentionally not
 * inferred from text or array position here. */
export const projectCompressibleHistory = (input: {
  readonly inputItems: ReadonlyArray<PortableInputItem>;
  readonly sourceRefs: ReadonlyArray<string>;
  readonly compressibleIndexes: ReadonlyArray<number>;
}): HistoryContextProjection => {
  const contextFragments: ContextFragment[] = [];
  const compressibleInputItemIndexes: number[] = [];
  for (const index of input.compressibleIndexes) {
    const item = input.inputItems[index];
    const sourceRef = input.sourceRefs[index];
    if (item === undefined || sourceRef === undefined) continue;
    const evidenceItem =
      item._tag === "ToolResult" ||
      item._tag === "ControlResult" ||
      item._tag === "ContextUpdate" ||
      item._tag === "AttachmentRef" ||
      (item._tag === "Message" && item.role === "tool");
    const provenanceKind =
      item._tag === "Message" && item.role === "user"
        ? "AuthenticatedHuman"
        : item._tag === "Message" && item.role === "assistant"
          ? "AuthenticatedAgent"
          : item._tag === "ToolResult" ||
              item._tag === "ControlResult" ||
              (item._tag === "Message" && item.role === "tool")
            ? "ToolObservation"
            : item._tag === "AttachmentRef"
              ? "ImportedArtifact"
              : "ModelDerived";
    contextFragments.push(
      historicalContextFragment(
        `history:${sourceRef}`,
        evidenceItem ? "C4" : "C3",
        4 + estimateTextTokens(JSON.stringify(item)),
        {
          provenanceKind,
          instructionCapability: "DataOnly",
          epistemicStatus:
            provenanceKind === "AuthenticatedHuman" ||
            provenanceKind === "AuthenticatedAgent"
              ? "Established"
              : "Unverified",
        },
      ),
    );
    compressibleInputItemIndexes.push(index);
  }
  return { contextFragments, compressibleInputItemIndexes };
};
