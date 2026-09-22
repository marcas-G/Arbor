import { AgentDriverLive } from "@arbor/agent-runtime";
import {
  type CommandGateway,
  CommandGatewayLive,
  type CommandHandlerRegistry,
} from "@arbor/application";
import { BlobStorePortLive } from "@arbor/blob-local";
import type { ProjectId } from "@arbor/domain";
import {
  EnvironmentResolverLocalLive,
  ProjectEnvironmentPortFromResolverLive,
} from "@arbor/environment-resolver-local";
import {
  ExecutionSchedulerLive,
  FenceStopCheckLive,
  RuntimeSafetyGateLive,
  type RuntimeSafetyPolicy,
} from "@arbor/execution-runtime";
import {
  DEFAULT_MODEL_CATALOG,
  ModelCapabilityPortLive,
  type ModelCatalog,
  ModelContextLive,
  resolveModelCatalogEntry,
} from "@arbor/model-context";
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
  P12_MIGRATIONS,
  ProjectRepositoryLive,
  ProjectToolRegistryLive,
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
  type ProviderFailureKind,
  type ProviderPort,
  type ReconciliationSource,
  type RunnableWorkSource,
  type SecretRef,
  SkillRegistry,
} from "@arbor/ports";
import { FakeProviderLive } from "@arbor/provider-fake";
import {
  OpenAIProviderLive,
  type OpenAISdkClient,
} from "@arbor/provider-openai";
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

/** P12 `12` §2: provider adapter selection is Composition-Root config. The
 * `adapterId` is the model catalog entry's `adapterId` (`12` §3); a real
 * adapter is never auto-discovered and never chosen by a runtime/LLM decision. */
export type ProviderAdapterConfig =
  | {
      readonly adapterId: "provider-fake";
      readonly turns?: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>;
      /** Deterministic transient-failure injection: fail the first N calls
       * with these kinds, then succeed (P12 `08` D1 / B-4 tests). */
      readonly failures?: ReadonlyArray<ProviderFailureKind>;
    }
  | { readonly adapterId: "provider-openai"; readonly client: OpenAISdkClient };

/** The single Composition-Root mapping from catalog `adapterId` -> adapter
 * `Layer`. No production package may construct a provider adapter elsewhere. */
export const selectProviderLayer = (
  config: ProviderAdapterConfig,
): Layer.Layer<ProviderPort> =>
  config.adapterId === "provider-openai"
    ? OpenAIProviderLive(config.client)
    : FakeProviderLive({
        turns: config.turns ?? [],
        ...(config.failures !== undefined ? { failures: config.failures } : {}),
      });

export interface SliceConfig {
  readonly databaseFile: string;
  /** P12 cross-contract completeness correction: the runtime project whose
   * committed Project-tool registrations are unioned into the model-facing
   * catalog. Absent => the catalogued set is the builtins only. */
  readonly projectId?: ProjectId;
  readonly providerTurns?: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>;
  /** Deterministic transient-failure injection for the default fake provider
   * (P12 `08` D1 / B-4 integration tests). */
  readonly providerFailures?: ReadonlyArray<ProviderFailureKind>;
  readonly modelRef?: string;
  /** P12 `12` §3/§4: the declarative catalog used for model -> adapter and
   * model capability resolution (defaults to `DEFAULT_MODEL_CATALOG`). */
  readonly modelCatalog?: ModelCatalog;
  /** P12 `12` §2: the provider adapter selected at the Composition Root. When
   * absent the deterministic `provider-fake` is used (CI never needs network). */
  readonly provider?: ProviderAdapterConfig;
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
  // P12 `09` §5: production wires the REAL resolver (not the fake
  // `environment-local` adapter). `ProjectEnvironmentPort` — consumed by
  // ownership writes and tool admission — is the resolver projection.
  const environmentResolver = Layer.provide(EnvironmentResolverLocalLive, base);
  const projectEnvironment = Layer.provide(
    ProjectEnvironmentPortFromResolverLive,
    environmentResolver,
  );
  const repo = Layer.provide(ExecutionRepositoryLive, infra);
  const fence = Layer.provide(FenceStopCheckLive, Layer.merge(infra, repo));

  const secretStore =
    config.secretStore?._tag === "File"
      ? SecretFileLive({ root: config.secretStore.root })
      : SecretEnvLive();

  // P12 `12` §3: modelRef -> adapter + capability is deterministic Runtime,
  // resolved here (the Composition Root), never an LLM decision.
  const catalog = config.modelCatalog ?? DEFAULT_MODEL_CATALOG;
  const modelRef = config.modelRef ?? catalog.defaultModelRef;
  const modelEntry = resolveModelCatalogEntry(catalog, modelRef);
  if (modelEntry === undefined) {
    throw new Error(`model catalog: unknown modelRef "${modelRef}"`);
  }
  if (
    config.provider !== undefined &&
    config.provider.adapterId !== modelEntry.adapterId
  ) {
    throw new Error(
      `provider adapter "${config.provider.adapterId}" does not serve modelRef "${modelRef}" (catalog adapter: "${modelEntry.adapterId}")`,
    );
  }
  const provider =
    config.provider !== undefined
      ? selectProviderLayer(config.provider)
      : selectProviderLayer({
          adapterId: "provider-fake",
          turns: config.providerTurns ?? [],
          ...(config.providerFailures !== undefined
            ? { failures: config.providerFailures }
            : {}),
        });
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
  // P12 `12` §4: the real `ModelCapabilityPort` backed by the catalog replaces
  // the test-only static layer at the Composition Root.
  const capability = ModelCapabilityPortLive(catalog);
  const skills = Layer.succeed(SkillRegistry, {
    available: () => Effect.succeed([]),
    load: () => Effect.die("no skills"),
  });
  const projectToolRegistry = Layer.provide(ProjectToolRegistryLive, infra);
  const toolCatalog = Layer.provide(
    ToolCatalogPortLive(
      config.projectId !== undefined ? { projectId: config.projectId } : {},
    ),
    projectToolRegistry,
  );
  const modelContext = Layer.provide(
    ModelContextLive,
    Layer.mergeAll(capability, toolCatalog, skills),
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
    projectEnvironment,
    environmentResolver,
    projectToolRegistry,
    toolCatalog,
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

export { P12_MIGRATIONS, runMigrations };
