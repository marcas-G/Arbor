import type {
  ModelFacingControlToolDefinition,
  ModelFacingToolDefinition,
  PortableInputItem,
  PortableLegacyMessage,
} from "@arbor/ports";
import type { InstructionFragment } from "./prompt.js";

export const estimateTextTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

export const estimateFixedRequestTokens = (input: {
  readonly instructions: ReadonlyArray<InstructionFragment>;
  readonly instructionContents?: ReadonlyMap<string, string>;
  readonly messages: ReadonlyArray<PortableLegacyMessage>;
  readonly inputItems?: ReadonlyArray<PortableInputItem>;
  readonly excludedInputItemIndexes?: ReadonlyArray<number>;
  readonly tools: ReadonlyArray<ModelFacingToolDefinition>;
  readonly controlTools: ReadonlyArray<ModelFacingControlToolDefinition>;
}): number => {
  const instructionTokens = input.instructions.reduce(
    (sum, fragment) =>
      sum +
      estimateTextTokens(
        input.instructionContents?.get(fragment.contentRef) ??
          fragment.contentRef,
      ),
    0,
  );
  const messageTokens = input.messages.reduce(
    (sum, message) => sum + 4 + estimateTextTokens(message.text),
    0,
  );
  const excludedInputItemIndexes = new Set(
    input.excludedInputItemIndexes ?? [],
  );
  const inputItemTokens = (input.inputItems ?? []).reduce(
    (sum, item, index) =>
      excludedInputItemIndexes.has(index)
        ? sum
        : sum + 4 + estimateTextTokens(JSON.stringify(item)),
    0,
  );
  const toolTokens = [...input.tools, ...input.controlTools].reduce(
    (sum, tool) =>
      sum +
      estimateTextTokens(tool.name) +
      estimateTextTokens(tool.description) +
      estimateTextTokens(tool.schemaJson),
    0,
  );
  return instructionTokens + messageTokens + inputItemTokens + toolTokens;
};
