import { AgentDriverLive } from "@arbor/agent-runtime";
import { type CommandGateway, CommandGatewayLive } from "@arbor/application";
import { BlobStorePortLive } from "@arbor/blob-local";
import { ProjectEnvironmentPortLive } from "@arbor/environment-local";
import {
  ExecutionSchedulerLive,
  FenceStopCheckLive,
  P2CommandHandlerRegistryLive,
  RuntimeSafetyGateLive,
} from "@arbor/execution-runtime";
import { ModelContextLive } from "@arbor/model-context";
import {
  AgentExecutionStateStoreLive,
  ArtifactMetadataRepositoryLive,
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  LeaseServiceLive,
  layer,
  P4_MIGRATIONS,
  ProjectRepositoryLive,
  ProviderTurnStoreLive,
  ResourceOwnershipRepositoryLive,
  runMigrations,
  SchedulerTimerStoreLive,
  SessionRepositoryLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "@arbor/persistence-sqlite";
import {
  type CanonicalProviderEvent,
  type ExecutionScheduler,
  ModelCapabilityPort,
  type RunnableWorkSource,
  SkillRegistry,
} from "@arbor/ports";
import { FakeProviderLive } from "@arbor/provider-fake";
import { ProviderRuntimeLive } from "@arbor/provider-runtime";
import { SandboxPortLive } from "@arbor/sandbox-local";
import {
  BUILTIN_EXECUTORS,
  ResourceAdmissionLive,
  ToolCatalogPortLive,
  ToolDefinitionStoreLive,
  ToolRuntimeLive,
} from "@arbor/tool-runtime";
import { WorkerDispatchPortLive } from "@arbor/worker-local";
import { Effect, Layer } from "effect";
import { ProvisionalRunnableWorkSourceLive } from "./runnable-source.js";

export interface SliceConfig {
  readonly databaseFile: string;
  readonly providerTurns?: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>;
  readonly modelRef?: string;
}

export type SliceServices =
  | CommandGateway
  | ExecutionScheduler
  | RunnableWorkSource;

/** The single-workspace composition root: wires P1–P4 into one runtime. */
export const buildSliceLayer = (
  config: SliceConfig,
): Layer.Layer<SliceServices> => {
  const base = layer({ filename: config.databaseFile });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const repo = Layer.provide(ExecutionRepositoryLive, infra);
  const fence = Layer.provide(FenceStopCheckLive, Layer.merge(infra, repo));

  const provider = FakeProviderLive({ turns: config.providerTurns ?? [] });
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive(3),
    Layer.mergeAll(
      provider,
      Layer.provide(ProviderTurnStoreLive, infra),
      Layer.provide(TransactionPortLive, infra),
      infra,
    ),
  );
  const capability = Layer.succeed(ModelCapabilityPort, {
    resolve: () =>
      Effect.succeed({
        modelRef: config.modelRef ?? "model-a",
        family: "fake",
        contextWindow: 8000,
        outputCeiling: 512,
        toolProtocol: "json",
      }),
  });
  const skills = Layer.succeed(SkillRegistry, {
    available: () => Effect.succeed([]),
    load: () => Effect.die("no skills"),
  });
  const modelContext = Layer.provide(
    ModelContextLive,
    Layer.mergeAll(capability, ToolCatalogPortLive, skills),
  );
  const driver = Layer.provide(
    AgentDriverLive,
    Layer.mergeAll(modelContext, providerRuntime, capability),
  );

  const repos = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(AgentExecutionStateStoreLive, infra),
    Layer.provide(ProviderTurnStoreLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(ArtifactMetadataRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(SchedulerTimerStoreLive, infra),
    Layer.provide(ResourceOwnershipRepositoryLive, infra),
    Layer.provide(EnvironmentRevisionStoreLive, infra),
    repo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, repo)),
    ProjectEnvironmentPortLive,
    ToolCatalogPortLive,
    ToolDefinitionStoreLive,
    SandboxPortLive,
    BlobStorePortLive,
  );
  const admission = Layer.provide(ResourceAdmissionLive, repos);
  const toolRuntime = Layer.provide(
    ToolRuntimeLive(BUILTIN_EXECUTORS),
    Layer.mergeAll(
      repos,
      admission,
      ToolDefinitionStoreLive,
      SandboxPortLive,
      infra,
    ),
  );
  const runnableSource = Layer.provide(
    ProvisionalRunnableWorkSourceLive,
    Layer.mergeAll(repos, infra, Layer.provide(TransactionPortLive, infra)),
  );
  const scheduler = Layer.provide(
    ExecutionSchedulerLive,
    Layer.mergeAll(
      repos,
      runnableSource,
      infra,
      Layer.provide(TransactionPortLive, infra),
    ),
  );

  const all = Layer.mergeAll(
    infra,
    repos,
    fence,
    provider,
    providerRuntime,
    modelContext,
    driver,
    toolRuntime,
    scheduler,
    admission,
    runnableSource,
    WorkerDispatchPortLive,
    RuntimeSafetyGateLive(),
    capability,
    Layer.provide(P2CommandHandlerRegistryLive, repos),
  );
  return Layer.mergeAll(
    all,
    Layer.provide(CommandGatewayLive, all),
  ) as Layer.Layer<SliceServices>;
};

export { P4_MIGRATIONS, runMigrations };
