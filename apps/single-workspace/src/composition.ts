import {
  AgentLoopDriverLive,
  ControlToolRegistry,
  ControlToolRegistryLive,
} from "@arbor/agent-runtime";
import {
  type AuthorityResolverPort,
  AuthorityResolverPortLive,
  type CommandGateway,
  CommandGatewayLive,
  type CommandHandlerRegistry,
  type InputPromotionService,
  InputPromotionServiceLive,
  type ParentUserGovernanceFacts,
  type RemoteWorkerMediationPort,
  RemoteWorkerMediationPortLive,
} from "@arbor/application";
import { BlobStorePortLive } from "@arbor/blob-local";
import { Principal, type ProjectId, parse } from "@arbor/domain";
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
  AcceptanceRepositoryLive,
  AgentExecutionStateStoreLive,
  AgentLoopStepStoreLive,
  ArtifactMetadataRepositoryLive,
  ClockLive,
  CommandStoreLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  EvidenceRepositoryLive,
  ExecutionRepositoryLive,
  FormationProposalStoreLive,
  HumanMessageStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  LeaseServiceLive,
  layer,
  MessageStoreLive,
  P12_MIGRATIONS,
  P16_MIGRATIONS,
  P17_MIGRATIONS,
  P20_MIGRATIONS,
  PermissionGrantRepositoryLive,
  ProjectDirectoryLive,
  ProjectionStoreLive,
  ProjectRepositoryLive,
  ProjectToolRegistryLive,
  ProviderTurnStoreLive,
  RecordEnvironmentChangeLive,
  ResourceOwnershipRepositoryLive,
  RuntimeClockLive,
  runMigrations,
  SchedulerTimerStoreLive,
  SessionRepositoryLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "@arbor/persistence-sqlite";
import {
  type AgentLoopStepStore,
  type CanonicalProviderEvent,
  type ExecutionDriverPort,
  type ExecutionScheduler,
  type HealthPort,
  type HumanMessageStore,
  type ModelDeployment,
  makeProviderRegistry,
  type PersistenceHealthProbe,
  type ProjectDirectory,
  type ProjectionQueryPort,
  type ProviderFailureKind,
  type ProviderPort,
  type ReconciliationSource,
  type ResolvedModelBinding,
  type RunnableWorkSource,
  resolvedModelBindingFingerprint,
  resolveModelBinding,
  SecretMaterial,
  type SecretRef,
  SecretStorePort,
  SkillRegistry,
  type ToolCatalogPort,
  type WorkWaitStore,
} from "@arbor/ports";
import { type UsageService, UsageServiceLive } from "@arbor/projection-runtime";
import type { OpenAISdkClient } from "@arbor/provider-openai";
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
  SingleWorkspaceControlActionHandlers,
  SingleWorkspaceControlActionHandlersLive,
} from "./control-actions.js";
import {
  ExecutableToolHandler,
  ExecutableToolHandlerLive,
} from "./executable-tool-handler.js";
import {
  PersistenceHealthProbeSqliteLive,
  ProductionHealthPortLive,
  T1RecoveryStateLive,
} from "./health.js";
import {
  type ProductionDaemonService,
  ProductionDaemonServiceLive,
  type ProductionDaemonServices,
  type SnapshotRetention,
  SnapshotRetentionLive,
  type TransportBoundary,
  TransportBoundaryLive,
} from "./production.js";
import { ProjectionQueryPortLive } from "./projection-query.js";
import { INLINE_SECRET_REF } from "./provider-config.js";
import { PROVIDER_REGISTRY_TABLE } from "./provider-registry.table.js";
import { SingleWorkspaceCommandHandlerRegistryLive } from "./registry.js";
import { DependencyAwareRunnableWorkSourceLive } from "./runnable-source-p7.js";
import { ToolAuthorityResolverLive } from "./tool-authority-resolver.js";
import {
  type AuthenticatorService,
  makeLocalAuthenticator,
} from "./transport/auth.js";
import { publishConversationProgress } from "./transport/conversation-progress-bridge.js";

/** P12 `03` §3: secret adapter selection is Composition-Root config. */
export type SecretStoreConfig =
  | { readonly _tag: "Env" }
  | { readonly _tag: "File"; readonly root: string }
  /** Inline credential from arbor.config.json — materialized into a
   * process-local SecretStore (single sentinel ref); the deployment itself
   * still carries only a SecretRef. */
  | { readonly _tag: "Inline"; readonly material: string };

/** P12 `12` §2 → P16 `01` §6: provider adapter selection is Composition-Root
 * config resolved through the static ProviderRegistry. The legacy closed
 * union remains as the test-facing seam; a real adapter is never
 * auto-discovered and never chosen by a runtime/LLM decision. */
export type ProviderAdapterConfig =
  | {
      readonly adapterId: "provider-fake";
      readonly turns?: ReadonlyArray<ReadonlyArray<CanonicalProviderEvent>>;
      /** Deterministic transient-failure injection: fail the first N calls
       * with these kinds, then succeed (P12 `08` D1 / B-4 tests). */
      readonly failures?: ReadonlyArray<ProviderFailureKind>;
    }
  | { readonly adapterId: "provider-openai"; readonly client: OpenAISdkClient };

/** P16 `01` §6: the Composition-Root registry (single construction site). */
export const providerRegistry = makeProviderRegistry(PROVIDER_REGISTRY_TABLE);

/** The single Composition-Root mapping from adapterId -> adapter `Layer`,
 * now routed through the ProviderRegistry (semantic-equivalent refactor of
 * the P12 `12` §2 selector; no production package may construct a provider
 * adapter elsewhere). */
export const selectProviderLayer = (
  config: ProviderAdapterConfig,
): Layer.Layer<ProviderPort> => {
  const adapter = providerRegistry.find(config.adapterId);
  if (adapter === undefined) {
    throw new Error(
      `provider registry: unknown adapterId "${config.adapterId}"`,
    );
  }
  const transportOverride =
    config.adapterId === "provider-openai"
      ? config.client
      : {
          ...(config.turns !== undefined ? { turns: config.turns } : {}),
          ...(config.failures !== undefined
            ? { failures: config.failures }
            : {}),
        };
  return adapter.layerFor({ transportOverride });
};

export interface SingleWorkspaceConfig {
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
  /** P16 `01` §5: an explicit ModelDeployment (env-constructed in main.ts).
   * Takes precedence over `provider`; resolution failure throws (no silent
   * fallback — INV-P16-4). */
  readonly deployment?: ModelDeployment;
  /** The credential reference bound to ProviderTurns. The raw credential is
   * resolved by ProviderRuntime at the execution boundary; absent means the
   * provider needs no credential (e.g. the deterministic fake). */
  readonly secretRef?: SecretRef;
  /** Which real secret adapter backs `SecretStorePort` (default `Env`). */
  readonly secretStore?: SecretStoreConfig;
  /** P12 `08` §6 (E-03): the Runtime Safety Envelope thresholds supplied at
   * composition. Absent falls back to a finite default policy. */
  readonly runtimeSafetyPolicy?: RuntimeSafetyPolicy;
  /** B-7: the parent/user governance facts the Authority Resolver consumes
   * (`02` §2). Absent means no external governance override is configured. */
  readonly governance?: ParentUserGovernanceFacts;
  /** B-7: the transport-boundary authenticator. Absent selects the local
   * single-user loopback principal; remote deployments must configure an
   * authenticator explicitly. */
  readonly authenticator?: AuthenticatorService;
  /** B-7: the system principal the production daemon submits recovery /
   * consumer commands as (default `runtime:system`). */
  readonly principalRef?: string;
  /** B-7: the per-consumer batch size for the offset-driven loops. */
  readonly consumerBatchSize?: number;
  /** B-7: the content-addressed blob root used by the snapshot-retention ops
   * action (defaults to the local blob adapter root). */
  readonly blobRoot?: string;
}

export type SingleWorkspaceServices =
  | CommandGateway
  | AgentLoopStepStore
  | ExecutionScheduler
  | RunnableWorkSource
  | WorkWaitStore
  | ExecutionDriverPort
  | CommandHandlerRegistry
  | ReconciliationSource
  | AuthorityResolverPort
  | RemoteWorkerMediationPort
  | ProjectionQueryPort
  | ProjectDirectory
  | ToolCatalogPort
  | HealthPort
  | PersistenceHealthProbe
  | UsageService
  | TransportBoundary
  | HumanMessageStore
  | InputPromotionService
  | ProductionDaemonService
  | ProductionDaemonServices
  | SnapshotRetention;

/** The single-workspace composition root: wires P1–P4 into one runtime. */
export const buildSingleWorkspaceLayer = (
  config: SingleWorkspaceConfig,
): Layer.Layer<SingleWorkspaceServices> => {
  const base = layer({ filename: config.databaseFile });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
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
      : config.secretStore?._tag === "Inline"
        ? Layer.succeed(SecretStorePort, {
            resolve: (ref) =>
              ref === INLINE_SECRET_REF
                ? Effect.succeed(
                    SecretMaterial.of(
                      config.secretStore?._tag === "Inline"
                        ? config.secretStore.material
                        : "",
                    ),
                  )
                : Effect.fail({
                    _tag: "SecretNotFound" as const,
                    secretRef: ref,
                  }),
          })
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
  // P16 `01` §5: explicit deployment resolution (no silent fallback). A
  // deployment mismatch with the effective modelRef is a hard failure.
  let deploymentBinding: ResolvedModelBinding | undefined;
  if (config.deployment !== undefined) {
    const resolved = resolveModelBinding(
      providerRegistry,
      catalog,
      config.deployment,
    );
    if ("_tag" in resolved) {
      throw new Error(
        `provider deployment resolution failed: ${JSON.stringify(resolved)}`,
      );
    }
    deploymentBinding = resolved;
    if (deploymentBinding.deployment.modelRef !== modelRef) {
      throw new Error(
        `provider deployment "${config.deployment.deploymentId}" serves modelRef "${config.deployment.modelRef}" but the slice selects "${modelRef}"`,
      );
    }
  }
  const provider =
    deploymentBinding !== undefined
      ? deploymentBinding.adapter.layerFor({
          ...(deploymentBinding.deployment.endpoint !== undefined
            ? { endpoint: deploymentBinding.deployment.endpoint }
            : {}),
          ...(deploymentBinding.deployment.wireModelName !== undefined
            ? { wireModelName: deploymentBinding.deployment.wireModelName }
            : {}),
          ...(deploymentBinding.deployment.secretRef !== undefined
            ? { secretRef: deploymentBinding.deployment.secretRef }
            : {}),
          ...(deploymentBinding.deployment.extraHeaders !== undefined
            ? { extraHeaders: deploymentBinding.deployment.extraHeaders }
            : {}),
        })
      : config.provider !== undefined
        ? selectProviderLayer(config.provider)
        : selectProviderLayer({
            adapterId: "provider-fake",
            turns: config.providerTurns ?? [],
            ...(config.providerFailures !== undefined
              ? { failures: config.providerFailures }
              : {}),
          });
  // Gate C C1/C2: the adapter's declared usage capabilities and the binding
  // identity for continuation checkpoints ride the ProviderRuntime config
  // (single adapter per runtime — single-deployment v1 semantics).
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive({
      ...(deploymentBinding !== undefined
        ? {
            adapterUsageConstraints: {
              reportsCacheTokens:
                deploymentBinding.adapter.profile.capabilityFlags
                  .reportsCacheTokens,
            },
            continuationBinding: {
              adapterId: deploymentBinding.adapter.adapterId,
              bindingFingerprint:
                resolvedModelBindingFingerprint(deploymentBinding),
            },
          }
        : {}),
    }),
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
  const capability = ModelCapabilityPortLive(
    catalog,
    deploymentBinding?.deployment.modelRef,
  );
  // P3 `02` §7: an empty-but-valid registry. No skill is available, so
  // `load` fails through the typed `SkillRegistryError` channel (never a
  // defect); `LoadSkill` maps that to the "skill unavailable" observation.
  const skills = Layer.succeed(SkillRegistry, {
    available: () => Effect.succeed([]),
    load: (skillId) =>
      Effect.fail({
        _tag: "SkillRegistryError" as const,
        cause: `skill not available: ${skillId}`,
      }),
  });
  const projectToolRegistry = Layer.provide(ProjectToolRegistryLive, infra);
  const toolCatalog = Layer.provide(
    ToolCatalogPortLive(
      config.projectId !== undefined ? { projectId: config.projectId } : {},
    ),
    projectToolRegistry,
  );
  const repos = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(ProjectDirectoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(AgentExecutionStateStoreLive, infra),
    Layer.provide(AgentLoopStepStoreLive, infra),
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
    Layer.provide(DependencyRepositoryLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(EvidenceRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
    Layer.provide(PermissionGrantRepositoryLive, infra),
    Layer.provide(HumanMessageStoreLive, infra),
    Layer.provide(ConsumerOffsetStoreLive, infra),
    Layer.provide(ConsumerDeadLetterStoreLive, infra),
    Layer.provide(ProjectionStoreLive, infra),
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
  const inputPromotion = Layer.provide(InputPromotionServiceLive, repos);
  const authorityResolver = AuthorityResolverPortLive;
  const toolAuthority = Layer.provide(
    ToolAuthorityResolverLive(
      config.governance ?? { authenticatedHumans: [], directParentOf: [] },
    ),
    Layer.mergeAll(repos, authorityResolver),
  );
  const toolRuntime = Layer.provide(
    ToolRuntimeLive(BUILTIN_EXECUTORS),
    Layer.mergeAll(
      repos,
      admission,
      ToolDefinitionStoreLive,
      SandboxPortLive,
      infra,
      toolAuthority,
    ),
  );
  const registry = Layer.provide(
    SingleWorkspaceCommandHandlerRegistryLive,
    repos,
  );
  const gateway = Layer.provide(
    CommandGatewayLive,
    Layer.mergeAll(infra, registry, repos, fence),
  );
  const controlActionHandlers = Layer.provide(
    SingleWorkspaceControlActionHandlersLive,
    Layer.mergeAll(repos, infra, gateway),
  );
  const controlRegistry = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const handlers = yield* SingleWorkspaceControlActionHandlers;
        return ControlToolRegistryLive(handlers);
      }),
    ),
    controlActionHandlers,
  );
  const executableInvocation = Layer.provide(
    ExecutableToolHandlerLive,
    Layer.mergeAll(toolRuntime, infra),
  );
  const modelContext = Layer.provide(
    ModelContextLive,
    Layer.mergeAll(capability, toolCatalog, skills, controlRegistry),
  );
  const driver = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const registryService = yield* ControlToolRegistry;
        const executableHandler = yield* ExecutableToolHandler;
        return Layer.provide(
          AgentLoopDriverLive({
            ...(config.secretRef !== undefined
              ? { secretRef: config.secretRef }
              : {}),
            ...(deploymentBinding?.deployment.secretRef !== undefined
              ? { secretRef: deploymentBinding.deployment.secretRef }
              : {}),
            ...(deploymentBinding?.deployment.executionPolicyOverrides !==
            undefined
              ? {
                  executionPolicyOverrides:
                    deploymentBinding.deployment.executionPolicyOverrides,
                }
              : {}),
            controlRegistry: registryService,
            executableInvocationHandler: executableHandler,
            ...(config.provider !== undefined
              ? { providerRef: config.provider.adapterId }
              : {}),
            ...(deploymentBinding !== undefined
              ? { providerRef: deploymentBinding.adapter.adapterId }
              : {}),
            onProviderProgress: publishConversationProgress,
          }),
          Layer.mergeAll(
            modelContext,
            providerRuntime,
            capability,
            repos,
            inputPromotion,
            infra,
          ),
        );
      }),
    ),
    Layer.mergeAll(controlRegistry, executableInvocation),
  );
  const runnableSource = Layer.provide(
    DependencyAwareRunnableWorkSourceLive,
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

  const coreAll = Layer.mergeAll(
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

  // --- B-7 production deployment surfaces (composition-root wiring) ---------
  //
  // The authority resolver is the pure fact producer; the remote-worker
  // mediation is the control-plane fenced submission entry point; the
  // projection query port binds the P10 read faces; the transport boundary
  // assembles the P12 shells over the composition-root submission face; the
  // production daemon drives migrate -> T1 recovery -> offset consumer loops;
  // health/usage are the operational plane (B-8).
  const recordEnvironmentChange = Layer.provide(
    RecordEnvironmentChangeLive,
    Layer.mergeAll(infra, repos),
  );
  const t1Recovery = T1RecoveryStateLive;
  const mediation = Layer.provide(RemoteWorkerMediationPortLive, coreAll);
  const persistenceHealthProbe = Layer.provide(
    PersistenceHealthProbeSqliteLive,
    Layer.mergeAll(coreAll, t1Recovery),
  );
  const health = Layer.provide(
    ProductionHealthPortLive,
    persistenceHealthProbe,
  );
  const projectionQuery = Layer.provide(ProjectionQueryPortLive, coreAll);
  const transportBoundary = Layer.provide(
    TransportBoundaryLive(
      // Local single-user form: no configured authenticator = localhost
      // desktop process (every request is the local principal, no login).
      config.authenticator ?? makeLocalAuthenticator(),
      config.governance ?? { authenticatedHumans: [], directParentOf: [] },
    ),
    Layer.mergeAll(coreAll, authorityResolver, projectionQuery),
  );
  const productionDaemon = Layer.provide(
    ProductionDaemonServiceLive({
      ...(config.projectId !== undefined
        ? { projectId: config.projectId }
        : {}),
      principal: parse(Principal)(config.principalRef ?? "runtime:system"),
      ...(config.consumerBatchSize !== undefined
        ? { batchSize: config.consumerBatchSize }
        : {}),
    }),
    Layer.mergeAll(coreAll, t1Recovery, recordEnvironmentChange),
  );
  const snapshotRetention = Layer.provide(
    SnapshotRetentionLive(config.blobRoot),
    coreAll,
  );
  const usage = UsageServiceLive;

  const all = Layer.mergeAll(
    coreAll,
    inputPromotion,
    authorityResolver,
    mediation,
    t1Recovery,
    persistenceHealthProbe,
    health,
    projectionQuery,
    transportBoundary,
    productionDaemon,
    recordEnvironmentChange,
    snapshotRetention,
    usage,
  );
  return all as Layer.Layer<SingleWorkspaceServices>;
};

export {
  P12_MIGRATIONS,
  P16_MIGRATIONS,
  P17_MIGRATIONS,
  P20_MIGRATIONS as CURRENT_MIGRATIONS,
  runMigrations,
};
