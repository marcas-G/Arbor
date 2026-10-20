import type {
  AgentLoopStepIdentity,
  AgentLoopStepProviderTurnLink,
  AgentLoopStepRecord,
  SettledProviderTurnResult,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";
import {
  fnv1aHash,
  isP20OverflowReplacementManifestBound,
  p20OverflowReplacementManifestBindingFailures,
  resolveP20OverflowReplacementChain,
} from "../src/agent-loop-step-recovery.js";

const executionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789f2";
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789f3";
const identity = {
  executionId,
  logicalStepNo: 0,
  repairAttempt: 0,
} as AgentLoopStepIdentity;
const inferenceId = `ptn_${executionId}_0`;
const compactionId = `ptn_${executionId}_0_native_compact_0`;
const replacementId = `ptn_${executionId}_0_overflow_0`;

const links = (): AgentLoopStepProviderTurnLink[] => [
  {
    identity,
    overflowOrdinal: 0,
    role: "Inference",
    providerTurnId:
      inferenceId as AgentLoopStepProviderTurnLink["providerTurnId"],
    contextEpoch: 0 as AgentLoopStepProviderTurnLink["contextEpoch"],
    state: "SettledFailure",
    createdAt: "2026-10-21T00:00:00.000Z",
  },
  {
    identity,
    overflowOrdinal: 0,
    role: "OverflowCompaction",
    providerTurnId:
      compactionId as AgentLoopStepProviderTurnLink["providerTurnId"],
    predecessorProviderTurnId:
      inferenceId as AgentLoopStepProviderTurnLink["providerTurnId"],
    contextEpoch: 0 as AgentLoopStepProviderTurnLink["contextEpoch"],
    state: "Prepared",
    createdAt: "2026-10-21T00:00:01.000Z",
  },
  {
    identity,
    overflowOrdinal: 0,
    role: "OverflowReplacement",
    providerTurnId:
      replacementId as AgentLoopStepProviderTurnLink["providerTurnId"],
    predecessorProviderTurnId:
      compactionId as AgentLoopStepProviderTurnLink["providerTurnId"],
    contextEpoch: 1 as AgentLoopStepProviderTurnLink["contextEpoch"],
    state: "Prepared",
    createdAt: "2026-10-21T00:00:02.000Z",
  },
];

const portableRequestJson = JSON.stringify({
  requestVersion: 2,
  operationKind: "Inference",
  modelRef: "model-ah19-native-test",
  outputContractRef: "conversation-response-v1",
  toolRoutes: [],
});
const manifestId = "mft_018f2b3c-4d5e-7abc-8def-0123456789f4";
const manifestJson = JSON.stringify({
  providerTurnId: replacementId,
  executionId,
  sessionId,
  logicalStepNo: 0,
  repairAttempt: 0,
  contextEpoch: 1,
  operationKind: "Inference",
  modelRef: "model-ah19-native-test",
  outputContractRef: "conversation-response-v1",
  toolRoutes: [],
  resolvedModelBindingFingerprint: `p16fp_${"a".repeat(64)}`,
  compiledRequestHash: fnv1aHash(
    JSON.stringify({
      request: JSON.parse(portableRequestJson),
      toolRoutes: [],
    }),
  ),
});

const step = (): AgentLoopStepRecord => ({
  identity,
  providerTurnId: inferenceId as AgentLoopStepRecord["providerTurnId"],
  manifestId,
  state: "StepEffectsCommitted",
  nextActionIndex: 0,
  revision: 3,
  updatedAt: "2026-10-21T00:00:03.000Z",
});

const manifest = (json = manifestJson) => ({
  manifestId,
  manifestJson: json,
  portableRequestJson,
});

const settled = (): SettledProviderTurnResult =>
  ({
    _tag: "SettledSuccess",
    turn: {
      providerTurnId: replacementId,
      executionId,
      sessionId,
      contextEpoch: 1,
      modelRef: "model-ah19-native-test",
      outputContractRef: "conversation-response-v1",
      manifestId,
    },
    manifestId,
    manifestJson,
    canonicalEvents: [],
    attemptNo: 0,
    finishReason: "Stop",
    usageJson: "{}",
    evidenceVersion: "provider-success-v1",
  }) as unknown as SettledProviderTurnResult;

const chain = () => {
  const resolved = resolveP20OverflowReplacementChain(
    links(),
    identity,
    inferenceId,
  );
  if (resolved === undefined) throw new Error("test P20 chain is invalid");
  return resolved;
};

const bound = (input: {
  step?: AgentLoopStepRecord;
  links?: ReadonlyArray<AgentLoopStepProviderTurnLink>;
  persistedManifest?: ReturnType<typeof manifest> | null;
  result?: SettledProviderTurnResult;
}) => {
  const p20Chain = resolveP20OverflowReplacementChain(
    input.links ?? links(),
    identity,
    inferenceId,
  );
  return (
    p20Chain !== undefined &&
    isP20OverflowReplacementManifestBound({
      step: input.step ?? step(),
      sessionId,
      chain: p20Chain,
      manifest:
        input.persistedManifest === undefined
          ? manifest()
          : input.persistedManifest,
      settled: input.result ?? settled(),
    })
  );
};

describe("P20 overflow replacement AgentLoopStep manifest binding", () => {
  it("resolves one exact contiguous inference-compaction-replacement chain", () => {
    expect(chain()).toMatchObject({
      inference: { providerTurnId: inferenceId, role: "Inference" },
      compaction: {
        providerTurnId: compactionId,
        predecessorProviderTurnId: inferenceId,
      },
      replacement: {
        providerTurnId: replacementId,
        predecessorProviderTurnId: compactionId,
        contextEpoch: 1,
      },
    });
  });

  it("rejects missing, duplicate, wrong-step, wrong-link, wrong-epoch, or failed links", () => {
    const base = links();
    const cases: ReadonlyArray<ReadonlyArray<AgentLoopStepProviderTurnLink>> = [
      base.slice(0, 2),
      [...base, base[2] as AgentLoopStepProviderTurnLink],
      base.map((link, index) =>
        index === 2
          ? { ...link, identity: { ...identity, logicalStepNo: 1 } }
          : link,
      ),
      base.map((link, index) =>
        index === 2
          ? { ...link, predecessorProviderTurnId: inferenceId as never }
          : link,
      ),
      base.map((link, index) =>
        index === 2 ? { ...link, contextEpoch: 2 as never } : link,
      ),
      base.map((link, index) =>
        index === 2 ? { ...link, state: "SettledFailure" as const } : link,
      ),
    ];
    for (const candidate of cases) {
      expect(
        resolveP20OverflowReplacementChain(candidate, identity, inferenceId),
      ).toBeUndefined();
    }
  });

  it("binds the step to the exact completed replacement manifest and receipt", () => {
    const p20Chain = chain();
    expect(
      p20OverflowReplacementManifestBindingFailures({
        step: step(),
        sessionId,
        chain: p20Chain,
        manifest: manifest(),
        settled: settled(),
      }),
    ).toEqual([]);
    expect(bound({})).toBe(true);
  });

  it("rejects step, manifest, receipt, and unsettled-result mismatches", () => {
    expect(bound({ step: { ...step(), manifestId: "mft_wrong" } })).toBe(false);
    expect(
      bound({
        step: { ...step(), identity: { ...identity, logicalStepNo: 1 } },
      }),
    ).toBe(false);
    expect(
      bound({
        persistedManifest: {
          ...manifest(),
          manifestJson: manifestJson.replace(executionId, "exe_wrong"),
        },
      }),
    ).toBe(false);
    expect(
      bound({
        result: {
          ...settled(),
          manifestId: "mft_wrong",
        } as unknown as SettledProviderTurnResult,
      }),
    ).toBe(false);
    expect(
      bound({
        result: {
          _tag: "Unsettled",
          turn: (
            settled() as Extract<
              SettledProviderTurnResult,
              { _tag: "SettledSuccess" }
            >
          ).turn,
        } as SettledProviderTurnResult,
      }),
    ).toBe(false);
  });
});
