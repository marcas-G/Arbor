import {
  ExecutionId,
  parse,
  providerTurnNativeCompactionId,
} from "@arbor/domain";
import { sha256Hex } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import {
  decodeUniqueNativePortableFrontier,
  nativeCheckpointOwnerExecutionId,
  nativeCompactionProviderTurnId,
  portableRequestHasNativeCheckpoint,
} from "../src/native-checkpoint-evidence.js";

const executionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000001",
);

const request = {
  requestVersion: 2,
  operationKind: "CompactionNative",
  outputContractRef: "provider-native-compaction-v1",
  inputItems: [{ _tag: "Text", text: "original context" }],
  instructions: [],
  toolDefinitions: [],
  budget: { maxOutputTokens: 100 },
  cacheHints: [],
};

const manifestFor = (json: string) => ({
  inputFrontier: { firstSequence: 1, lastSequence: 2 },
  contextRefs: ["entry-1", "entry-2"],
  compiledRequestHash: sha256Hex(json),
});

describe("native checkpoint evidence parsing", () => {
  it("preserves the producer execution, not the current execution", () => {
    const evidence = {
      executionId,
      sourceAgentLoopStep: { executionId },
    };
    expect(nativeCheckpointOwnerExecutionId(JSON.stringify(evidence))).toBe(
      executionId,
    );
    expect(
      nativeCheckpointOwnerExecutionId(
        JSON.stringify({
          ...evidence,
          sourceAgentLoopStep: { executionId: "foreign" },
        }),
      ),
    ).toBeUndefined();
    expect(nativeCheckpointOwnerExecutionId("{")).toBeUndefined();
  });

  it("recognizes canonical native compaction turn identities", () => {
    const turn = providerTurnNativeCompactionId(executionId, 0, 0);
    expect(nativeCompactionProviderTurnId(turn)).toBe(turn);
    expect(nativeCompactionProviderTurnId("invalid")).toBeNull();
  });

  it("accepts the unique frontier and rejects stale hashes and duplicate refs", () => {
    const json = JSON.stringify(request);
    const manifest = manifestFor(json);
    expect(
      decodeUniqueNativePortableFrontier(JSON.stringify(manifest), json)
        ?.inputFrontier,
    ).toEqual(manifest.inputFrontier);
    expect(
      decodeUniqueNativePortableFrontier(
        JSON.stringify({ ...manifest, compiledRequestHash: "stale" }),
        json,
      ),
    ).toBeNull();
    expect(
      decodeUniqueNativePortableFrontier(
        JSON.stringify({ ...manifest, contextRefs: ["same", "same"] }),
        json,
      ),
    ).toBeNull();
  });

  it("rejects nested native checkpoint input even with a matching hash", () => {
    const json = JSON.stringify({
      ...request,
      inputItems: [
        { _tag: "CompactionCheckpoint", implementation: "ProviderNative" },
      ],
    });
    expect(portableRequestHasNativeCheckpoint(json)).toBe(true);
    expect(
      decodeUniqueNativePortableFrontier(
        JSON.stringify(manifestFor(json)),
        json,
      ),
    ).toBeNull();
    expect(portableRequestHasNativeCheckpoint("{")).toBe(false);
  });
});
