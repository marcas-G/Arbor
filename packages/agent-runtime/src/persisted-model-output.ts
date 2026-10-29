import type { SessionEntryRecord } from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";

export interface PersistedModelOutputInput {
  readonly providerTurnId: string;
  readonly outputContractRef: string;
  readonly text: string;
  readonly finishReason: unknown;
  readonly toolInvocations: ReadonlyArray<unknown>;
  readonly decodedOutputHash: string | undefined;
  readonly modelOutputSessionSequence: number | undefined;
  readonly entry: SessionEntryRecord | undefined;
}

/** Shared P3/P41 check for a decoded Provider result and its durable Session
 * ModelOutput. Both the current typed AssistantMessage row and the legacy
 * fully-decoded payload are accepted; source, sequence and content identity
 * remain exact. */
export const matchesPersistedModelOutput = (
  input: PersistedModelOutputInput,
): boolean => {
  const expectedOutput = {
    providerTurnId: input.providerTurnId,
    outputContractRef: input.outputContractRef,
    decoderVersion: "decode-turn-v1",
    text: input.text,
    finishReason: input.finishReason,
    toolInvocations: input.toolInvocations,
  };
  const { entry } = input;
  if (
    input.decodedOutputHash === undefined ||
    input.modelOutputSessionSequence === undefined ||
    sha256Hex(JSON.stringify(expectedOutput)) !== input.decodedOutputHash ||
    entry?.entryKind !== "ModelOutput" ||
    entry.sequence !== input.modelOutputSessionSequence ||
    entry.source?.kind !== "ProviderTurn" ||
    entry.source.ref !== `${input.providerTurnId}:assistant`
  ) {
    return false;
  }

  const payload = entry.payload;
  const typedOutputMatches =
    typeof payload === "object" &&
    payload !== null &&
    "_tag" in payload &&
    payload._tag === "AssistantMessage" &&
    "providerTurnId" in payload &&
    payload.providerTurnId === input.providerTurnId &&
    "contentRef" in payload &&
    payload.contentRef === `provider:${input.providerTurnId}:assistant` &&
    "text" in payload &&
    payload.text === input.text &&
    "finishReason" in payload &&
    payload.finishReason === input.finishReason;
  const legacyOutputMatches =
    JSON.stringify(payload) === JSON.stringify(expectedOutput);
  return typedOutputMatches || legacyOutputMatches;
};
