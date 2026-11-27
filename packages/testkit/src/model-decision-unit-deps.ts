// biome-ignore-all lint/suspicious/noExplicitAny: test assembly helper —
// the unused-service channels are intentionally loose (same discipline as
// driver-layer.ts).
import type { ControlBasisResolver } from "@arbor/agent-runtime";
import { ModelContext, TurnProfileResolver } from "@arbor/model-context";
import {
  BlobStorePort,
  ConversationAttemptStore,
  ConversationCheckpointStore,
  ConversationResponseJobStore,
  DecisionRequestStore,
  ExecutionRepository,
  HumanMessageStore,
  LocalPlanStore,
  type ModelCapabilityPort,
  ProviderRuntime,
  RecoveryAttentionFactStore,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceKnowledgePort,
  WorkspacePlacementPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Layer } from "effect";

/**
 * ModelDecisionService unit-test dependencies (test-effectiveness B1/B3):
 * provisions every typed requirement of `ModelDecisionServiceLive` exactly
 * once so a unit test states only its deltas — the recording capability
 * counter and the ControlBasis under test. Every service the decision path
 * does not touch in these tests is an inert double; adding a requirement to
 * ModelDecisionServiceLive is fixed here instead of per test file (the PR #4
 * missed-assembly failure mode).
 */
export const modelDecisionServiceUnitDependencies = (input: {
  readonly modelCapability: Layer.Layer<ModelCapabilityPort, any, never>;
  readonly controlBasisResolver: Layer.Layer<ControlBasisResolver, any, never>;
}): Layer.Layer<any, any, never> => {
  return Layer.mergeAll(
    Layer.succeed(ModelContext, {} as never),
    Layer.succeed(ProviderRuntime, {} as never),
    input.modelCapability,
    input.controlBasisResolver,
    Layer.succeed(SessionRepository, {} as never),
    Layer.succeed(TransactionPort, {} as never),
    Layer.succeed(ConversationCheckpointStore, {} as never),
    Layer.succeed(BlobStorePort, {} as never),
    Layer.succeed(TurnProfileResolver, {} as never),
    Layer.succeed(WorkRepository, {} as never),
    Layer.succeed(DecisionRequestStore, {} as never),
    Layer.succeed(WorkspaceRepository, {} as never),
    Layer.succeed(LocalPlanStore, {} as never),
    Layer.succeed(WorkspaceKnowledgePort, {} as never),
    Layer.succeed(WorkspacePlacementPort, {} as never),
    Layer.succeed(RecoveryAttentionFactStore, {} as never),
    Layer.succeed(HumanMessageStore, {} as never),
    Layer.succeed(ConversationResponseJobStore, {} as never),
    Layer.succeed(ConversationAttemptStore, {} as never),
    Layer.succeed(ExecutionRepository, {} as never),
  );
};
