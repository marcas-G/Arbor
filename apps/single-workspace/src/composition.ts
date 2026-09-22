import { AgentDriverLive } from "@arbor/agent-runtime";
import {
  type CommandGateway,
  CommandGatewayLive,
  type CommandHandlerRegistry,
} from "@arbor/application";
import { BlobStorePortLive } from "@arbor/blob-local";
import { ProjectEnvironmentPortLive } from "@arbor/environment-local";
import {
  ExecutionSchedulerLive,
  FenceStopCheckLive,
  RuntimeSafetyGateLive,
  type RuntimeSafetyPolicy,
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
  FormationProposalStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  LeaseServiceLive,
  layer,
  MessageStoreLive,
  P7_MIGRATIONS,
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
  type ExecutionDriverPort,
  type ExecutionScheduler,
  ModelCapabilityPort,
  type ReconciliationSource,
  type RunnableWorkSource,
  type SecretRef,
  SkillRegistry,
} from "@arbor/ports";
import { FakeProviderLive } from "@arbor/provider-fake";
import { ProviderRuntimeLive } from "@arbor/provider-runtime";
import { SandboxPortLive } from "@arbor/sandbox-local";
import { SecretEnvLive } from "@arbor/secret-env";
import { SecretFileLive } from "@arbor/secret-file";
import {
  BUILTIN_EXECUTORS,
  ReconciliationSourceLive,
  ResourceAdmissionLive,
  ToolCatalogPortLive,
  ToolDefinitionStoreLive,
  ToolRuntimeLive,
} from "@arbor/tool-runtime";
import { WorkerDispatchPortLive } from "@arbor/worker-local";
import { Effect, Layer } from "effect";
import {
  SliceDirectiveHandlers,
  SliceDirectiveHandlersLive,
} from "./directives.js";
import { SliceCommandHandlerRegistryLive } from "./registry.js";
import { ProvisionalRunnableWorkSourceLive } from "./runnable-source.js";

/** P12 `03` §3: secret adapter selection is Composition-Root config. */
export type SecretStoreConfig =
  | { readonly _tag: "Env" }
  | { readonly _tag: "File"; readonly root: string };

export interface SliceConfig {
  readonly databaseFile: string;
  readonly providerTurns?: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>;
  readonly modelRef?: string;
  /** The credential reference bound to ProviderTurns. The raw credential is
   * resolved by ProviderRuntime at the execution boundary; absent means the
   * provider needs no credential (e.g. the deterministic fake). */
  readonly secretRef?: SecretRef;
  /** Which real secret adapter backs `SecretStorePort` (default `Env`). */
  readonly secretStore?: SecretStoreConfig;
  /** P12 `08` §6 (E-03): the Runtime Safety Envelope thresholds supplied at
   * composition. Absent falls back to a finite default policy. */
  readonly runtimeSafetyPolicy?: RuntimeSafetyPolicy;
}

export type SliceServices =
  | CommandGateway
  | ExecutionScheduler
  | RunnableWorkSource
  | ExecutionDriverPort
  | CommandHandlerRegistry
  | ReconciliationSource;

/** The single-workspace composition root: wires P1–P4 into one runtime. */
export const buildSliceLayer = (
  config: SliceConfig,
): Layer.Layer<SliceServices> => {
  const base = layer({ filename: config.databaseFile });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const repo = Layer.provide(ExecutionRepositoryLive, infra);
  const fence = Layer.provide(FenceStopCheckLive, Layer.merge(infra, repo));

  const secretStore =
    config.secretStore?._tag === "File"
      ? SecretFileLive({ root: config.secretStore.root })
      : SecretEnvLive();

  const provider = FakeProviderLive({ turns: config.providerTurns ?? [] });
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive(3),
    Layer.mergeAll(
      provider,
      Layer.provide(ProviderTurnStoreLive, infra),
      Layer.provide(TransactionPortLive, infra),
      secretStore,
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
    Layer.provide(FormationProposalStoreLive, infra),
    Layer.provide(MessageStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
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
  const registry = Layer.provide(SliceCommandHandlerRegistryLive, repos);
  const gateway = Layer.provide(
    CommandGatewayLive,
    Layer.mergeAll(infra, registry, repos, fence),
  );
  const directiveHandlers = Layer.provide(
    SliceDirectiveHandlersLive,
    Layer.mergeAll(toolRuntime, skills, repos, infra, registry, gateway),
  );
  const driver = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const handlers = yield* SliceDirectiveHandlers;
        return Layer.provide(
          AgentDriverLive(
            handlers,
            config.secretRef !== undefined
              ? { secretRef: config.secretRef }
              : {},
          ),
          Layer.mergeAll(
            modelContext,
            providerRuntime,
            capability,
            repos,
            infra,
          ),
        );
      }),
    ),
    directiveHandlers,
  );
  const runnableSource = Layer.provide(
    ProvisionalRunnableWorkSourceLive,
    Layer.mergeAll(repos, infra, Layer.provide(TransactionPortLive, infra)),
  );
  const reconciliation = Layer.provide(ReconciliationSourceLive, repos);
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
    secretStore,
    modelContext,
    driver,
    toolRuntime,
    scheduler,
    admission,
    runnableSource,
    WorkerDispatchPortLive,
    RuntimeSafetyGateLive(config.runtimeSafetyPolicy),
    capability,
    registry,
    gateway,
    reconciliation,
  );
  return Layer.mergeAll(
    all,
    Layer.provide(CommandGatewayLive, all),
  ) as Layer.Layer<SliceServices>;
};

export { P7_MIGRATIONS, runMigrations };
