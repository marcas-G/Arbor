// biome-ignore-all lint/suspicious/noExplicitAny: test assembly helper —
// A-channels stay concrete while E/R channels are intentionally loose so
// Layer.mergeAll infers the member union instead of widening every member
// (docs/engineering/test-effectiveness.md, B1).
import { ControlBasisResolverLive } from "@arbor/agent-runtime";
import { InputPromotionServiceLive } from "@arbor/application";
import { BlobStorePortLive } from "@arbor/blob-local";
import {
  AcceptanceRepositoryLive,
  ConversationAttemptStoreLive,
  ConversationCheckpointStoreLive,
  ConversationResponseJobStoreLive,
  DecisionRequestStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  FormationFulfillmentStoreLive,
  FormationProposalStoreLive,
  HumanMessageStoreLive,
  InboxProjectionStoreLive,
  LocalPlanStoreLive,
  P39RecoveryEvidenceStoreLive,
  ProjectRepositoryLive,
  RecoveryAttentionFactStoreLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
} from "@arbor/persistence-sqlite";
import type {
  EnvironmentRevisionStore,
  SessionRepository,
  WorkspaceKnowledgePort,
  WorkspacePlacementPort,
} from "@arbor/ports";
import { Layer } from "effect";

/**
 * TestKit driver assembly (architecture-evolution object 6): one helper
 * that provisions every typed requirement of AgentLoopDriverLive, so a
 * test states only its deltas. Before this, each test file hand-built a
 * ~60-line Layer block; an architecture step that adds a service
 * requirement had to be replicated across every file (PR #4 missed one
 * assembly and 43 tests failed at runtime while typechecking clean).
 *
 * Defaults match production semantics: every durable store on the
 * test's sqlite infra, the blob store with no filesystem root. The two
 * app-root capability layers (WorkspaceKnowledge/Placement) and the
 * revision store stay explicit parameters — scripted revisions are the
 * most common DecisionStale scenario and the app-root layers do not
 * belong in a package dependency of the testkit.
 */
export const agentDriverTestDependencies = (input: {
  readonly infra: Layer.Layer<any, any, never>;
  readonly sessions: Layer.Layer<SessionRepository, any, never>;
  readonly environmentRevisions: Layer.Layer<
    EnvironmentRevisionStore,
    any,
    never
  >;
  readonly workspaceKnowledge: Layer.Layer<WorkspaceKnowledgePort, any, any>;
  readonly workspacePlacement: Layer.Layer<WorkspacePlacementPort, any, any>;
}) =>
  Layer.mergeAll(
    input.infra,
    Layer.provide(TransactionPortLive, input.infra),
    input.sessions,
    Layer.provide(ProjectRepositoryLive, input.infra),
    Layer.provide(WorkspaceRepositoryLive, input.infra),
    Layer.provide(WorkRepositoryLive, input.infra),
    Layer.provide(HumanMessageStoreLive, input.infra),
    Layer.provide(ExecutionRepositoryLive, input.infra),
    Layer.provide(ConversationResponseJobStoreLive, input.infra),
    Layer.provide(ConversationAttemptStoreLive, input.infra),
    Layer.provide(ConversationCheckpointStoreLive, input.infra),
    Layer.provide(InboxProjectionStoreLive, input.infra),
    BlobStorePortLive,
    Layer.provide(
      RecoveryAttentionFactStoreLive,
      Layer.mergeAll(
        input.infra,
        Layer.provide(DomainEventJournalLive, input.infra),
      ),
    ),
    Layer.provide(ToolInvocationStoreLive, input.infra),
    Layer.provide(P39RecoveryEvidenceStoreLive, input.infra),
    Layer.provide(LocalPlanStoreLive, input.infra),
    Layer.provide(DecisionRequestStoreLive, input.infra),
    Layer.provide(
      InputPromotionServiceLive,
      Layer.mergeAll(
        input.infra,
        Layer.provide(TransactionPortLive, input.infra),
        input.sessions,
        Layer.provide(InboxProjectionStoreLive, input.infra),
        Layer.provide(ExecutionRepositoryLive, input.infra),
      ),
    ),
    Layer.provide(
      ControlBasisResolverLive,
      Layer.mergeAll(
        input.infra,
        Layer.provide(TransactionPortLive, input.infra),
        Layer.provide(ProjectRepositoryLive, input.infra),
        Layer.provide(WorkspaceRepositoryLive, input.infra),
        Layer.provide(WorkRepositoryLive, input.infra),
        input.environmentRevisions,
      ),
    ),
    Layer.provide(
      input.workspaceKnowledge,
      Layer.mergeAll(
        input.infra,
        Layer.provide(TransactionPortLive, input.infra),
        Layer.provide(WorkRepositoryLive, input.infra),
        Layer.provide(VerificationRepositoryLive, input.infra),
        Layer.provide(AcceptanceRepositoryLive, input.infra),
        Layer.provide(FormationProposalStoreLive, input.infra),
        Layer.provide(FormationFulfillmentStoreLive, input.infra),
        Layer.provide(WorkspaceRepositoryLive, input.infra),
      ),
    ),
    Layer.provide(
      input.workspacePlacement,
      Layer.mergeAll(
        input.infra,
        Layer.provide(TransactionPortLive, input.infra),
        Layer.provide(WorkRepositoryLive, input.infra),
        Layer.provide(VerificationRepositoryLive, input.infra),
        Layer.provide(AcceptanceRepositoryLive, input.infra),
        Layer.provide(FormationProposalStoreLive, input.infra),
        Layer.provide(FormationFulfillmentStoreLive, input.infra),
        Layer.provide(WorkspaceRepositoryLive, input.infra),
      ),
    ),
  );
