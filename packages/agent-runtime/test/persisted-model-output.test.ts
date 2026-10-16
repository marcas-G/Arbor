import { sha256Hex } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { matchesPersistedModelOutput } from "../src/persisted-model-output.js";

const makeFixture = () => {
  const input = {
    providerTurnId: "ptn_p41_output",
    outputContractRef: "contract:p41-output",
    text: "selection made",
    finishReason: "Stop",
    toolInvocations: [
      {
        providerTurnId: "ptn_p41_output",
        outputPosition: 0,
        callRef: "call_p41_output",
        toolName: "select_current_work",
        argumentsJson: '{"workId":"wrk_selected"}',
      },
    ],
  };
  const expectedOutput = {
    providerTurnId: input.providerTurnId,
    outputContractRef: input.outputContractRef,
    decoderVersion: "decode-turn-v1",
    text: input.text,
    finishReason: input.finishReason,
    toolInvocations: input.toolInvocations,
  };
  const decodedOutputHash = sha256Hex(JSON.stringify(expectedOutput));
  const entry = {
    sessionId: "ses_p41_output" as never,
    sequence: 20,
    entryKind: "ModelOutput" as const,
    payload: {
      _tag: "AssistantMessage",
      providerTurnId: input.providerTurnId,
      contentRef: `provider:${input.providerTurnId}:assistant`,
      text: input.text,
      finishReason: input.finishReason,
    },
    createdAt: "2026-10-16T00:00:00.000Z",
    source: {
      kind: "ProviderTurn",
      ref: `${input.providerTurnId}:assistant`,
      contentHash: "p41-model-output-content-hash",
    },
  };
  return {
    input: {
      ...input,
      decodedOutputHash,
      modelOutputSessionSequence: 20,
      entry,
    },
    entry,
    expectedOutput,
  };
};

describe("shared persisted ModelOutput binding", () => {
  it("accepts the current typed AssistantMessage representation", () => {
    const fixture = makeFixture();
    expect(matchesPersistedModelOutput(fixture.input)).toBe(true);
  });

  it("accepts the legacy complete decoded-output representation", () => {
    const fixture = makeFixture();
    expect(
      matchesPersistedModelOutput({
        ...fixture.input,
        entry: { ...fixture.entry, payload: fixture.expectedOutput },
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "ProviderTurn source identity",
      change: (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture.input,
        entry: {
          ...fixture.entry,
          source: {
            ...fixture.entry.source,
            ref: "ptn_other:assistant",
          },
        },
      }),
    },
    {
      name: "ModelOutput sequence",
      change: (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture.input,
        modelOutputSessionSequence: 21,
      }),
    },
    {
      name: "ProviderTurn identity",
      change: (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture.input,
        providerTurnId: "ptn_other",
      }),
    },
    {
      name: "output-contract identity from the Manifest",
      change: (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture.input,
        outputContractRef: "contract:other",
      }),
    },
    {
      name: "decoded-output hash",
      change: (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture.input,
        decodedOutputHash: "0".repeat(64),
      }),
    },
    {
      name: "decoded text",
      change: (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture.input,
        text: "different text",
      }),
    },
    {
      name: "finish reason",
      change: (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture.input,
        finishReason: "Length",
      }),
    },
    {
      name: "missing persisted source",
      change: (fixture: ReturnType<typeof makeFixture>) => {
        const { source: _source, ...entryWithoutSource } = fixture.entry;
        return { ...fixture.input, entry: entryWithoutSource };
      },
    },
  ])("fails closed on a $name mismatch", ({ change }) => {
    expect(matchesPersistedModelOutput(change(makeFixture()))).toBe(false);
  });
});
