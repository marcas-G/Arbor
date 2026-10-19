import {
  AgentLoopDriverLive,
  type AgentLoopQualificationProbe,
  ControlActionAuthorizer,
  ControlToolRegistry,
  ControlToolRegistryLive,
} from "@arbor/agent-runtime";
import {
  type AttentionPollPolicyConfig,
  type AttentionPollQualificationProbe,
  type AuthorityResolverPort,
  AuthorityResolverPortLive,
  type CommandGateway,
  type CommandGatewayQualificationProbe,
  type CommandHandlerRegistry,
  type DecideSandboxPolicyPreparation,
  type InputPromotionQualificationProbe,
  type InputPromotionService,
  InputPromotionServiceLive,
  InputPromotionServiceWithQualificationProbe,
  makeCommandGatewayLive,
  type ParentUserGovernanceFacts,
  type RemoteWorkerMediationPort,
  RemoteWorkerMediationPortLive,
  type WorkflowSignalConsumer,
  WorkflowSignalConsumerLive,
} from "@arbor/application";
import { BlobStorePortLive } from "@arbor/blob-local";
import { Principal, type ProjectId, parse } from "@arbor/domain";
import {
  EnvironmentResolverLocalLive,
  ProjectEnvironmentPortFromResolverLive,
} from "@arbor/environment-resolver-local";
import {
  type ExecutionLeaseQualificationProbe,
  ExecutionSchedulerLive,
  type ExecutionSettlementQualificationProbe,
  FenceStopCheckLive,
  makeReconciliationEscalationRecorder,
  RuntimeSafetyGateLive,
  type RuntimeSafetyPolicy,
  type SubmittedDecisionRecoveryQualificationProbe,
} from "@arbor/execution-runtime";
import {
  DEFAULT_MODEL_CATALOG,
  ModelCapabilityPortLive,
  type ModelCatalog,
  ModelContextLive,
  resolveModelCatalogEntry,
  TurnProfileResolver,
  TurnProfileResolverLive,
} from "@arbor/model-context";
import {
  AcceptanceRepositoryLive,
  AgentExecutionStateStoreLive,
  AgentLoopStepStoreLive,
  ArtifactMetadataRepositoryLive,
  AssignWorkTargetBindingRepositoryLive,
  AttentionPollStoreLive,
  type AttentionProjectionQualificationProbe,
  acquireP39RuntimeWriterPermit,
  ClockLive,
  CommandStoreLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  ControlApprovalStoreLive,
  ConversationAttemptStoreLive,
  ConversationCheckpointStoreLive,
  ConversationResponseJobStoreLive,
  CURRENT_MIGRATION_BASELINE,
  CURRENT_MIGRATIONS,
  CURRENT_SCHEMA_VERSION,
  DecisionRequestStoreLive,
  DeliverableRepositoryLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  EvidenceRepositoryLive,
  ExecutableApprovalStoreLive,
  ExecutionRepositoryLive,
  FormationFulfillmentStoreLive,
  FormationProposalStoreLive,
  HumanMessageStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  LeaseServiceLive,
  LocalPlanStoreLive,
  layer,
  MessageStoreLive,
  makeAttentionProjectionStoreLive,
  makeP39RecoveryEvidenceStoreLive,
  makeRecoveryAttentionFactStoreLive,
  makeTransactionPortLive,
  OwnershipWriteServiceLive,
  OwnershipWriteServiceWithQualificationProbe,
  P4SandboxOutcomeReadPortLive,
  P12_MIGRATIONS,
  P16_MIGRATIONS,
  P17_MIGRATIONS,
  P20_MIGRATIONS,
  P21_MIGRATIONS,
  P22_MIGRATIONS,
  type P39RecoveryBindingQualificationProbe,
  PermissionGrantRepositoryLive,
  ProjectDirectoryLive,
  ProjectionStoreLive,
  ProjectRepositoryLive,
  ProjectToolRegistryLive,
  ProviderDeploymentBreakerLive,
  ProviderTurnStoreLive,
  p39UnsupportedDeployment,
  p39WriterLockFilename,
  p39WriterLockLayer,
  prepareP39PrimaryDatabasePath,
  RecordEnvironmentChangeLive,
  type RecoveryAttentionFactQualificationProbe,
  ResourceOwnershipRepositoryLive,
  RetryVerificationOriginRepositoryLive,
  RuntimeClockLive,
  releaseP39WriterPermit,
  runMigrations,
  SandboxPolicyDecisionStoreLive,
  SandboxPolicyRequirementReadPortLive,
  SandboxProviderUnavailableAttentionQueueLive,
  SandboxProviderUnavailableStoreLive,
  SchedulerTimerStoreLive,
  SessionRepositoryLive,
  sqliteAdapterError,
  ToolInvocationStoreLive,
  ToolObservationEvidenceStoreLive,
  ToolReconciliationFactStoreLive,
  type TransactionBeginQualificationProbe,
  VerificationRepositoryLive,
  WorkReadmissionGateStoreLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  type WorkspaceResourceActivationQualificationProbe,
  WorkspaceResourceActivationStoreLive,
  WorktreeStoreLive,
  WorkWaitStoreLive,
} from "@arbor/persistence-sqlite";
import {
  type AgentLoopStepStore,
  type CanonicalProviderEvent,
  Clock,
  type CommandStore,
  type CurrentSandboxAuthoritySnapshotPort,
  type DecisionRequestStore,
  type DeliverableRepository,
  DomainEventJournal,
  EnvironmentResolverPort,
  type ExecutionDriverPort,
  ExecutionRepository,
  type ExecutionScheduler,
  type HealthPort,
  type HumanMessageStore,
  IdGenerator,
  type InboxProjectionStore,
  LeaseService,
  type MessageStore,
  type ModelDeployment,
  makeProviderRegistry,
  makeToolReconciliationProfileRegistry,
  type PermissionGrantRepository,
  type PersistenceHealthProbe,
  type ProjectDirectory,
  type ProjectionQueryPort,
  type ProjectRepository,
  ProjectResourceProfilePort,
  type ProjectResourceProfilePortService,
  type ProviderFailureKind,
  type ProviderPort,
  type ReconciliationSource,
  type ResolvedModelBinding,
  ResourceOwnershipRepository,
  type RetryVerificationOriginRepository,
  type RunnableWorkSource,
  resolvedModelBindingFingerprint,
  resolveModelBinding,
  SandboxPolicyDecisionStore,
  type SandboxPolicyRequirementReadPort,
  SandboxProcessPort,
  SecretMaterial,
  type SecretRef,
  SecretStorePort,
  type SessionRepository,
  SkillRegistry,
  type ToolCatalogPort,
  ToolReconciliationPort,
  type ToolReconciliationPortService,
  type ToolReconciliationProfile,
  ToolReconciliationProfileRegistry,
  TransactionPort,
  type TrustedHostConfigurationSourceService,
  type WorkReadmissionGateStore,
  type WorkRepository,
  type WorkspaceKnowledgePort,
  type WorkspacePlacementPort,
  WorkspaceRepository,
  WorktreeStore,
  type WorkWaitStore,
} from "@arbor/ports";
import { type UsageService, UsageServiceLive } from "@arbor/projection-runtime";
import type { OpenAISdkClient } from "@arbor/provider-openai";
import {
  type ProviderRuntimeConfig,
  ProviderRuntimeLive,
} from "@arbor/provider-runtime";
import {
  SandboxPortLive,
  TrustedLocalProcessPortLive,
} from "@arbor/sandbox-local";
import { makeNativePosixSandboxProcessPort } from "@arbor/sandbox-native-posix";
import {
  makeWindowsSandboxProcessPort,
  WINDOWS_SANDBOX_PROVIDER_IDS,
} from "@arbor/sandbox-windows";
import { SecretEnvLive } from "@arbor/secret-env";
import { SecretFileLive } from "@arbor/secret-file";
import {
  ArtifactServiceLive,
  BUILTIN_EXECUTORS,
  ReconciliationSourceLive,
  ResourceAdmissionLive,
  ToolCatalogPortLive,
  ToolDefinitionStoreLive,
  type ToolExecutor,
  ToolRuntimeLive,
  type ToolRuntimeQualificationProbe,
} from "@arbor/tool-runtime";
import { WorkerDispatchPortLive } from "@arbor/worker-local";
import { Effect, Layer } from "effect";
import {
  SqlClient,
  type SqlClient as SqlClientService,
} from "effect/unstable/sql/SqlClient";
import { ControlActionAuthorizerLive } from "./control-action-authorizer.js";
import {
  type AssignWorkBindingAttentionQualificationProbe,
  type DeliverReplayQualificationProbe,
  SingleWorkspaceControlActionHandlers,
  SingleWorkspaceControlActionHandlersLive,
  SingleWorkspaceControlActionHandlersWithQualificationProbes,
} from "./control-actions.js";
import { CurrentSandboxAuthoritySnapshotPortLive } from "./current-sandbox-authority-snapshot-port.js";
import {
  ExecutableToolHandler,
  ExecutableToolHandlerLive,
  type ExecutableToolHandlerQualificationProbe,
} from "./executable-tool-handler.js";
import {
  PersistenceHealthProbeSqliteLive,
  ProductionHealthPortLive,
  T1RecoveryStateLive,
} from "./health.js";
import {
  type ConversationResponseQualificationProbe,
  type ExecutableApprovalExpiryQualificationProbe,
  type ProductionDaemonService,
  ProductionDaemonServiceLive,
  type ProductionDaemonServices,
  type SnapshotRetention,
  SnapshotRetentionLive,
  type TransportBoundary,
  TransportBoundaryLive,
} from "./production.js";
import { makeProjectResourceProfilePort } from "./project-resource-profiles.js";
import { ProjectionQueryPortLive } from "./projection-query.js";
import { INLINE_SECRET_REF } from "./provider-config.js";
import { PROVIDER_REGISTRY_TABLE } from "./provider-registry.table.js";
import { makeSingleWorkspaceCommandHandlerRegistryLive } from "./registry.js";
import { DependencyAwareRunnableWorkSourceLive } from "./runnable-source-p7.js";
import {
  SandboxAuthoritySnapshot,
  SandboxAuthoritySnapshotLive,
  sandboxIssuerSnapshotOf,
} from "./sandbox-authority-bundle.js";
import { makeSandboxPolicyDecisionPreparation } from "./sandbox-policy-decision-preparation.js";
import { ToolAuthorityResolverLive } from "./tool-authority-resolver.js";
import {
  type AuthenticatorService,
  LOCAL_PRINCIPAL,
  makeLocalAuthenticator,
} from "./transport/auth.js";
import type { CreateProjectPostCommitBeforeActivationQualificationProbe } from "./transport/composition.js";
import { publishConversationProgress } from "./transport/conversation-progress-bridge.js";
import { WorkspaceKnowledgePortLive } from "./workspace-knowledge.js";
import { WorkspacePlacementPortLive } from "./workspace-placement.js";

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
  /** P5 startup-only source. Production must inject the OS-protected trusted
   * host configuration source; absence or invalid data disables sandbox
   * policy authority. This is never loaded from environment or a request. */
  readonly trustedHostConfigurationSource?: TrustedHostConfigurationSourceService;
  /** Accepted V21 P4/P11 preparation seam. Production without a validated
   * materializer remains fail-closed and exposes no local-default fallback. */
  readonly sandboxPolicyDecisionPreparation?: DecideSandboxPolicyPreparation;
  /** Test-only startup trace; absent from ordinary production composition. */
  readonly startupDiagnosticProbe?: (phase: string) => void;
  /** Test-only pre-BEGIN barrier; ordinary production composition leaves it absent. */
  readonly transactionBeginQualificationProbe?: TransactionBeginQualificationProbe;
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
  /** P12 host-owned immutable startup snapshot for project bootstrap. */
  readonly projectResourceProfiles?: ProjectResourceProfilePortService;
  /** B-7: the system principal the production daemon submits recovery /
   * consumer commands as (default `runtime:system`). */
  readonly principalRef?: string;
  /** B-7: the per-consumer batch size for the offset-driven loops. */
  readonly consumerBatchSize?: number;
  /** P12 v1.43 deployment-pinned Attention poll settings. */
  readonly attentionPollPolicy?: AttentionPollPolicyConfig;
  /** B-7: the content-addressed blob root used by the snapshot-retention ops
   * action (defaults to the local blob adapter root). */
  readonly blobRoot?: string;
  /** Explicit test-only in-process fault probe; never loaded from env or a
   * public request. Production startup leaves this absent. */
  readonly qualificationProbe?: AgentLoopQualificationProbe;
  readonly assignWorkAuthorizedBeforeCommandProbe?: AgentLoopQualificationProbe;
  /** Explicit process-local Inbox promotion crash qualification seam; absent
   * in ordinary production startup and never model/public-request supplied. */
  readonly inputPromotionQualificationProbe?: InputPromotionQualificationProbe;
  /** Test-only process-local Gateway transaction probe; production startup
   * leaves this absent. It is not configured from environment or HTTP. */
  readonly gatewayQualificationProbe?: CommandGatewayQualificationProbe;
  readonly assignWorkBindingAttentionQualificationProbe?: AssignWorkBindingAttentionQualificationProbe;
  readonly recoveryAttentionFactQualificationProbe?: RecoveryAttentionFactQualificationProbe;
  /** Test-only P9 Deliver replay pause point. Ordinary startup leaves this absent. */
  readonly deliverReplayQualificationProbe?: DeliverReplayQualificationProbe;
  /** Test-only P10 consumer pause point after row write but before commit. */
  readonly attentionProjectionQualificationProbe?: AttentionProjectionQualificationProbe;
  /** Test-only P10 poll pause point after its marker/ACK/offset transaction commits. */
  readonly attentionPollQualificationProbe?: AttentionPollQualificationProbe;
  /** Test-only process-local probe around P11 activation transaction commit. */
  readonly workspaceResourceActivationQualificationProbe?: WorkspaceResourceActivationQualificationProbe;
  /** Test-only process-local P12 pause after the CreateProject receipt commits,
   * before P11 activation is entered. Never loaded from environment/HTTP. */
  readonly createProjectPostCommitBeforeActivationQualificationProbe?: CreateProjectPostCommitBeforeActivationQualificationProbe;
  readonly executionSettlementQualificationProbe?: ExecutionSettlementQualificationProbe;
  readonly executionLeaseQualificationProbe?: ExecutionLeaseQualificationProbe;
  /** Test-only trace of P41 Stop recovery branch decisions. */
  readonly submittedDecisionRecoveryQualificationProbe?: SubmittedDecisionRecoveryQualificationProbe;
  readonly conversationResponseQualificationProbe?: ConversationResponseQualificationProbe;
  /** Test-only process-local pause point around the Executable TTL transaction. */
  readonly executableApprovalExpiryQualificationProbe?: ExecutableApprovalExpiryQualificationProbe;
  readonly toolQualificationProbe?: ToolRuntimeQualificationProbe;
  /** Explicit test-child-only injection for AH7 proof/recovery process tests.
   * Ordinary production startup leaves this absent; no profile or external
   * reconciliation source is registered by default. */
  readonly testOnlyToolReconciliation?: {
    readonly profiles: ReadonlyArray<ToolReconciliationProfile>;
    readonly port: ToolReconciliationPortService;
    readonly executors?: ReadonlyArray<ToolExecutor>;
  };
  /** Test-only catalog visibility diagnostic; ordinary startup leaves absent. */
  readonly executableToolQualificationProbe?: ExecutableToolHandlerQualificationProbe;
  /** Test-only P39 claim branch trace; ordinary startup leaves absent. */
  readonly p39RecoveryBindingQualificationProbe?: P39RecoveryBindingQualificationProbe;
  readonly providerQualificationProbe?: ProviderRuntimeConfig["qualificationProbe"];
}

/** Resolve the human membership fact owned by Composition Root. Only the
 * implicit no-authenticator deployment is the loopback local single-user
 * identity; any configured authenticator needs explicit governance membership
 * (or a direct-parent edge), and explicit governance always remains exact. */
export const resolveCompositionGovernance = (
  config: Pick<SingleWorkspaceConfig, "authenticator" | "governance">,
): ParentUserGovernanceFacts =>
  config.governance ??
  (config.authenticator === undefined
    ? {
        authenticatedHumans: [parse(Principal)(LOCAL_PRINCIPAL)],
        directParentOf: [],
      }
    : { authenticatedHumans: [], directParentOf: [] });

export type SingleWorkspaceServices =
  | CommandGateway
  | CommandStore
  | Clock
  | DeliverableRepository
  | DomainEventJournal
  | IdGenerator
  | InboxProjectionStore
  | MessageStore
  | TransactionPort
  | SqlClientService
  | ExecutionRepository
  | PermissionGrantRepository
  | RetryVerificationOriginRepository
  | ProjectRepository
  | ResourceOwnershipRepository
  | WorktreeStore
  | SessionRepository
  | WorkRepository
  | WorkspaceRepository
  | AgentLoopStepStore
  | ExecutionScheduler
  | RunnableWorkSource
  | WorkWaitStore
  | WorkReadmissionGateStore
  | DecisionRequestStore
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
  | ProjectResourceProfilePort
  | SandboxProcessPort
  | SandboxPolicyRequirementReadPort
  | CurrentSandboxAuthoritySnapshotPort
  | HumanMessageStore
  | InputPromotionService
  | WorkflowSignalConsumer
  | ProductionDaemonService
  | ProductionDaemonServices
  | SnapshotRetention
  | WorkspaceKnowledgePort
  | WorkspacePlacementPort;

/** The single-workspace composition root: wires P1–P4 into one runtime. */
export const buildSingleWorkspaceLayer = (
  config: SingleWorkspaceConfig,
): Layer.Layer<SingleWorkspaceServices> => {
  const governance = resolveCompositionGovernance(config);
  try {
    config.startupDiagnosticProbe?.("p39.layer-path-validation.before");
  } catch {
    // Test-only startup diagnostics are non-authoritative.
  }
  const preparedDatabase =
    config.databaseFile === ":memory:"
      ? undefined
      : prepareP39PrimaryDatabasePath(config.databaseFile);
  try {
    config.startupDiagnosticProbe?.("p39.layer-path-validation.after");
  } catch {
    // Test-only startup diagnostics are non-authoritative.
  }
  if (
    preparedDatabase !== undefined &&
    !("databaseFilename" in preparedDatabase)
  ) {
    throw p39UnsupportedDeployment(preparedDatabase.code);
  }
  const primaryDatabaseFilename =
    preparedDatabase?.databaseFilename ?? config.databaseFile;
  const base = layer({ filename: primaryDatabaseFilename });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const sandboxAuthoritySnapshotLayer = Layer.provide(
    SandboxAuthoritySnapshotLive(config.trustedHostConfigurationSource),
    infra,
  );
  const currentAuthoritySnapshotPortLayer = Layer.provide(
    CurrentSandboxAuthoritySnapshotPortLive(
      config.trustedHostConfigurationSource,
    ),
    infra,
  );
  const transactionPortLayer = Layer.provide(
    makeTransactionPortLive(config.transactionBeginQualificationProbe),
    infra,
  );
  // P12 `09` §5: production wires the REAL resolver (not the fake
  // `environment-local` adapter). `ProjectEnvironmentPort` — consumed by
  // ownership writes and tool admission — is the resolver projection.
  const environmentResolver = Layer.provide(EnvironmentResolverLocalLive, base);
  const projectEnvironment = Layer.provide(
    ProjectEnvironmentPortFromResolverLive,
    environmentResolver,
  );
  const nativePosixSandbox = makeNativePosixSandboxProcessPort();
  const windowsSandbox = makeWindowsSandboxProcessPort();
  const windowsSandboxProviderIds = new Set<string>(
    Object.values(WINDOWS_SANDBOX_PROVIDER_IDS),
  );
  const nativeSandboxProcessPort = Layer.succeed(SandboxProcessPort, {
    capabilities: () =>
      Effect.all([
        nativePosixSandbox.capabilities(),
        windowsSandbox.capabilities(),
      ]).pipe(Effect.map((groups) => groups.flat())),
    run: (request) =>
      windowsSandboxProviderIds.has(request.policy.providerId)
        ? windowsSandbox.run(request)
        : nativePosixSandbox.run(request),
  });
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
  // P16's complete deployment identity is the binding used by AgentStepContext
  // and Native compaction eligibility. It deliberately excludes SecretRef and
  // resolved SecretMaterial; only the stable non-secret binding fingerprint
  // crosses into model capability metadata.
  const deploymentFingerprint =
    deploymentBinding === undefined
      ? undefined
      : resolvedModelBindingFingerprint(deploymentBinding);
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
      ...(config.providerQualificationProbe !== undefined
        ? { qualificationProbe: config.providerQualificationProbe }
        : {}),
      ...(deploymentBinding !== undefined && deploymentFingerprint !== undefined
        ? {
            adapterUsageConstraints: {
              reportsCacheTokens:
                deploymentBinding.adapter.profile.capabilityFlags
                  .reportsCacheTokens,
            },
            continuationBinding: {
              adapterId: deploymentBinding.adapter.adapterId,
              bindingFingerprint: deploymentFingerprint,
            },
          }
        : {}),
    }),
    Layer.mergeAll(
      provider,
      Layer.provide(ProviderTurnStoreLive, infra),
      transactionPortLayer,
      secretStore,
      infra,
    ),
  );
  // P12 `12` §4: the real `ModelCapabilityPort` backed by the catalog replaces
  // the test-only static layer at the Composition Root.
  const capability = ModelCapabilityPortLive(
    catalog,
    deploymentBinding?.deployment.modelRef,
    deploymentFingerprint,
    deploymentBinding?.adapter.profile.capabilityFlags.supportsContinuation ??
      false,
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
  const domainEventJournal = Layer.provide(DomainEventJournalLive, infra);
  const inboxProjection = Layer.provide(InboxProjectionStoreLive, infra);
  const executableApprovalStore = Layer.provide(
    ExecutableApprovalStoreLive,
    Layer.mergeAll(infra, domainEventJournal, inboxProjection),
  );
  const repos = Layer.mergeAll(
    transactionPortLayer,
    currentAuthoritySnapshotPortLayer,
    Layer.provide(CommandStoreLive, infra),
    domainEventJournal,
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(ProjectDirectoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(WorkspaceResourceActivationStoreLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(WorkReadmissionGateStoreLive, infra),
    Layer.provide(LocalPlanStoreLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(AgentExecutionStateStoreLive, infra),
    Layer.provide(AgentLoopStepStoreLive, infra),
    Layer.provide(ProviderTurnStoreLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(ToolReconciliationFactStoreLive, infra),
    Layer.provide(
      makeP39RecoveryEvidenceStoreLive(
        config.p39RecoveryBindingQualificationProbe,
      ),
      infra,
    ),
    Layer.provide(ToolObservationEvidenceStoreLive, infra),
    Layer.provide(P4SandboxOutcomeReadPortLive, infra),
    Layer.provide(ArtifactMetadataRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(SchedulerTimerStoreLive, infra),
    Layer.provide(ResourceOwnershipRepositoryLive, infra),
    Layer.provide(WorktreeStoreLive, infra),
    Layer.provide(EnvironmentRevisionStoreLive, infra),
    Layer.provide(FormationProposalStoreLive, infra),
    Layer.provide(FormationFulfillmentStoreLive, infra),
    Layer.provide(MessageStoreLive, infra),
    inboxProjection,
    executableApprovalStore,
    Layer.provide(DependencyRepositoryLive, infra),
    Layer.provide(DeliverableRepositoryLive, infra),
    Layer.provide(DecisionRequestStoreLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(RetryVerificationOriginRepositoryLive, infra),
    Layer.provide(EvidenceRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
    Layer.provide(PermissionGrantRepositoryLive, infra),
    Layer.provide(SandboxPolicyDecisionStoreLive, infra),
    Layer.provide(SandboxPolicyRequirementReadPortLive, infra),
    Layer.provide(HumanMessageStoreLive, infra),
    Layer.provide(ConversationResponseJobStoreLive, infra),
    Layer.provide(ConversationCheckpointStoreLive, infra),
    Layer.provide(ControlApprovalStoreLive, infra),
    Layer.provide(AssignWorkTargetBindingRepositoryLive, infra),
    Layer.provide(
      makeRecoveryAttentionFactStoreLive(
        config.recoveryAttentionFactQualificationProbe,
      ),
      Layer.mergeAll(infra, Layer.provide(DomainEventJournalLive, infra)),
    ),
    Layer.provide(
      SandboxProviderUnavailableStoreLive,
      Layer.mergeAll(infra, domainEventJournal),
    ),
    Layer.provide(SandboxProviderUnavailableAttentionQueueLive, infra),
    Layer.provide(ConversationAttemptStoreLive, infra),
    Layer.provide(ProviderDeploymentBreakerLive, infra),
    Layer.provide(ConsumerOffsetStoreLive, infra),
    Layer.provide(ConsumerDeadLetterStoreLive, infra),
    Layer.provide(AttentionPollStoreLive, infra),
    Layer.provide(
      makeAttentionProjectionStoreLive(
        config.attentionProjectionQualificationProbe,
      ),
      infra,
    ),
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
  const workspaceKnowledge = Layer.provide(WorkspaceKnowledgePortLive, repos);
  const workspacePlacement = Layer.provide(WorkspacePlacementPortLive, repos);
  const ownershipWrite = Layer.provide(
    config.workspaceResourceActivationQualificationProbe === undefined
      ? OwnershipWriteServiceLive
      : OwnershipWriteServiceWithQualificationProbe(
          config.workspaceResourceActivationQualificationProbe,
        ),
    Layer.mergeAll(repos, infra),
  );
  const inputPromotion = Layer.provide(
    config.inputPromotionQualificationProbe === undefined
      ? InputPromotionServiceLive
      : InputPromotionServiceWithQualificationProbe(
          config.inputPromotionQualificationProbe,
        ),
    repos,
  );
  const authorityResolver = AuthorityResolverPortLive;
  const toolAuthority = Layer.provide(
    ToolAuthorityResolverLive(governance),
    Layer.mergeAll(repos, authorityResolver),
  );
  const artifactService = Layer.provide(
    ArtifactServiceLive,
    Layer.mergeAll(repos, infra),
  );
  const toolRuntime = Layer.provide(
    ToolRuntimeLive(
      config.testOnlyToolReconciliation?.executors ?? BUILTIN_EXECUTORS,
      {
        ...(config.toolQualificationProbe === undefined
          ? {}
          : { qualificationProbe: config.toolQualificationProbe }),
      },
    ),
    Layer.mergeAll(
      repos,
      admission,
      ToolDefinitionStoreLive,
      Layer.succeed(
        ToolReconciliationProfileRegistry,
        makeToolReconciliationProfileRegistry(
          config.testOnlyToolReconciliation?.profiles ?? [],
        ),
      ),
      ...(config.testOnlyToolReconciliation === undefined
        ? []
        : [
            Layer.succeed(
              ToolReconciliationPort,
              config.testOnlyToolReconciliation.port,
            ),
          ]),
      SandboxPortLive,
      TrustedLocalProcessPortLive,
      nativeSandboxProcessPort,
      infra,
      toolAuthority,
      artifactService,
    ),
  );
  const projectResourceProfilePort = Layer.succeed(
    ProjectResourceProfilePort,
    config.projectResourceProfiles ?? makeProjectResourceProfilePort([]),
  );
  const registry = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const authoritySnapshot = yield* SandboxAuthoritySnapshot;
        const preparation =
          config.sandboxPolicyDecisionPreparation ??
          makeSandboxPolicyDecisionPreparation({
            transaction: yield* TransactionPort,
            workspaces: yield* WorkspaceRepository,
            executions: yield* ExecutionRepository,
            decisions: yield* SandboxPolicyDecisionStore,
            ownership: yield* ResourceOwnershipRepository,
            worktrees: yield* WorktreeStore,
            environmentResolver: yield* EnvironmentResolverPort,
            authoritySnapshot:
              authoritySnapshot._tag === "Available"
                ? authoritySnapshot.snapshot
                : undefined,
          });
        return makeSingleWorkspaceCommandHandlerRegistryLive(
          governance,
          sandboxIssuerSnapshotOf(authoritySnapshot),
          preparation,
        );
      }),
    ),
    Layer.mergeAll(
      repos,
      infra,
      projectResourceProfilePort,
      sandboxAuthoritySnapshotLayer,
    ),
  );
  const gateway = Layer.provide(
    makeCommandGatewayLive(config.gatewayQualificationProbe),
    Layer.mergeAll(infra, registry, repos, fence),
  );
  const controlActionHandlers = Layer.provide(
    config.assignWorkBindingAttentionQualificationProbe === undefined &&
      config.qualificationProbe === undefined &&
      config.assignWorkAuthorizedBeforeCommandProbe === undefined &&
      config.deliverReplayQualificationProbe === undefined
      ? SingleWorkspaceControlActionHandlersLive
      : SingleWorkspaceControlActionHandlersWithQualificationProbes({
          ...(config.assignWorkBindingAttentionQualificationProbe === undefined
            ? {}
            : {
                bindingAttention:
                  config.assignWorkBindingAttentionQualificationProbe,
              }),
          ...(config.assignWorkAuthorizedBeforeCommandProbe === undefined
            ? {}
            : {
                assignWorkAuthorizedBeforeCommand:
                  config.assignWorkAuthorizedBeforeCommandProbe,
              }),
          ...(config.deliverReplayQualificationProbe === undefined
            ? {}
            : { deliverReplay: config.deliverReplayQualificationProbe }),
        }),
    Layer.mergeAll(repos, infra, gateway, registry, workspacePlacement),
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
  const controlAuthorizer = Layer.provide(
    ControlActionAuthorizerLive,
    Layer.mergeAll(repos, infra, registry),
  );
  const executableInvocation = Layer.provide(
    ExecutableToolHandlerLive(
      governance,
      config.executableToolQualificationProbe,
      config.trustedHostConfigurationSource,
    ),
    Layer.mergeAll(
      toolRuntime,
      infra,
      toolCatalog,
      repos,
      authorityResolver,
      environmentResolver,
    ),
  );
  const turnProfiles = Layer.provide(
    TurnProfileResolverLive,
    Layer.mergeAll(toolCatalog, controlRegistry, repos),
  );
  const modelContext = Layer.provide(
    ModelContextLive,
    Layer.mergeAll(capability, skills),
  );
  const driver = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const registryService = yield* ControlToolRegistry;
        const executableHandler = yield* ExecutableToolHandler;
        const turnProfileResolver = yield* TurnProfileResolver;
        const authorizer = yield* ControlActionAuthorizer;
        const reconciliationEscalationRecorder =
          makeReconciliationEscalationRecorder({
            tx: yield* TransactionPort,
            repository: yield* ExecutionRepository,
            leases: yield* LeaseService,
            journal: yield* DomainEventJournal,
            clock: yield* Clock,
            ids: yield* IdGenerator,
          });
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
            controlAuthorizer: authorizer,
            turnProfileResolver,
            executableInvocationHandler: executableHandler,
            recordReconciliationEscalation: reconciliationEscalationRecorder,
            ...(config.provider !== undefined
              ? { providerRef: config.provider.adapterId }
              : {}),
            ...(deploymentBinding !== undefined
              ? { providerRef: deploymentBinding.adapter.adapterId }
              : {}),
            onProviderProgress: publishConversationProgress,
            ...(config.qualificationProbe !== undefined
              ? { qualificationProbe: config.qualificationProbe }
              : {}),
          }),
          Layer.mergeAll(
            modelContext,
            providerRuntime,
            capability,
            repos,
            workspaceKnowledge,
            workspacePlacement,
            inputPromotion,
            infra,
          ),
        );
      }),
    ),
    Layer.mergeAll(
      controlRegistry,
      controlAuthorizer,
      executableInvocation,
      turnProfiles,
      repos,
      infra,
    ),
  );
  const runnableSource = Layer.provide(
    DependencyAwareRunnableWorkSourceLive,
    Layer.mergeAll(repos, infra, transactionPortLayer),
  );
  const reconciliation = Layer.provide(ReconciliationSourceLive, repos);
  const scheduler = Layer.provide(
    ExecutionSchedulerLive,
    Layer.mergeAll(repos, runnableSource, infra, transactionPortLayer),
  );
  const workflowSignals = Layer.provide(
    WorkflowSignalConsumerLive,
    Layer.mergeAll(repos, scheduler),
  );

  const coreAll = Layer.mergeAll(
    infra,
    repos,
    fence,
    provider,
    providerRuntime,
    secretStore,
    modelContext,
    workspaceKnowledge,
    workspacePlacement,
    turnProfiles,
    driver,
    toolRuntime,
    scheduler,
    workflowSignals,
    admission,
    ownershipWrite,
    runnableSource,
    WorkerDispatchPortLive,
    RuntimeSafetyGateLive(config.runtimeSafetyPolicy),
    capability,
    registry,
    gateway,
    reconciliation,
    projectResourceProfilePort,
    nativeSandboxProcessPort,
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
  const projectionQuery = Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const authoritySnapshot = yield* SandboxAuthoritySnapshot;
        return ProjectionQueryPortLive(
          config.projectId,
          sandboxIssuerSnapshotOf(authoritySnapshot),
        );
      }),
    ),
    Layer.mergeAll(coreAll, toolCatalog, sandboxAuthoritySnapshotLayer),
  );
  const transportBoundary = Layer.provide(
    TransportBoundaryLive(
      // Local single-user form: no configured authenticator = localhost
      // desktop process (every request is the local principal, no login).
      config.authenticator ?? makeLocalAuthenticator(),
      governance,
      config.authenticator !== undefined,
      config.createProjectPostCommitBeforeActivationQualificationProbe,
    ),
    Layer.mergeAll(
      coreAll,
      authorityResolver,
      projectionQuery,
      sandboxAuthoritySnapshotLayer,
    ),
  );
  const productionDaemon = Layer.provide(
    ProductionDaemonServiceLive({
      ...(config.projectId !== undefined
        ? { projectId: config.projectId }
        : {}),
      principal: parse(Principal)(config.principalRef ?? "runtime:system"),
      ...(config.startupDiagnosticProbe === undefined
        ? {}
        : { startupDiagnosticProbe: config.startupDiagnosticProbe }),
      bindingFingerprint:
        deploymentBinding === undefined
          ? `legacy:${modelRef}`
          : (deploymentFingerprint ?? `legacy:${modelRef}`),
      configurationRevision:
        deploymentBinding === undefined
          ? `legacy:${modelRef}`
          : (deploymentFingerprint ?? `legacy:${modelRef}`),
      ...(config.consumerBatchSize !== undefined
        ? { batchSize: config.consumerBatchSize }
        : {}),
      ...(config.attentionPollPolicy !== undefined
        ? { attentionPollPolicy: config.attentionPollPolicy }
        : {}),
      ...(config.attentionPollQualificationProbe === undefined
        ? {}
        : {
            attentionPollQualificationProbe:
              config.attentionPollQualificationProbe,
          }),
      ...(config.executionSettlementQualificationProbe === undefined
        ? {}
        : {
            executionSettlementQualificationProbe:
              config.executionSettlementQualificationProbe,
          }),
      ...(config.executionLeaseQualificationProbe === undefined
        ? {}
        : {
            executionLeaseQualificationProbe:
              config.executionLeaseQualificationProbe,
          }),
      ...(config.submittedDecisionRecoveryQualificationProbe === undefined
        ? {}
        : {
            submittedDecisionRecoveryQualificationProbe:
              config.submittedDecisionRecoveryQualificationProbe,
          }),
      ...(config.conversationResponseQualificationProbe === undefined
        ? {}
        : {
            conversationResponseQualificationProbe:
              config.conversationResponseQualificationProbe,
          }),
      ...(config.executableApprovalExpiryQualificationProbe === undefined
        ? {}
        : {
            executableApprovalExpiryQualificationProbe:
              config.executableApprovalExpiryQualificationProbe,
          }),
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
  const latestSupportedSchema = CURRENT_MIGRATION_BASELINE;
  const currentSchemaGate = Layer.provide(
    Layer.effectDiscard(
      Effect.gen(function* () {
        try {
          config.startupDiagnosticProbe?.("p39.schema-validation.before");
        } catch {
          // Test-only startup diagnostics are non-authoritative.
        }
        if (preparedDatabase !== undefined) {
          const currentLockPath = p39WriterLockFilename(
            primaryDatabaseFilename,
          );
          if (
            typeof currentLockPath !== "string" ||
            currentLockPath !== preparedDatabase.writerLockFilename
          ) {
            return yield* Effect.die({
              _tag: "P39MaintenanceFailure",
              code: "P39_UNSUPPORTED_DEPLOYMENT",
            });
          }
        }
        const sql = yield* SqlClient;
        const versions = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const current = Number(versions[0]?.user_version ?? 0);
        if (current > latestSupportedSchema) {
          return yield* Effect.die(
            sqliteAdapterError(
              `database user_version ${current} is newer than latest migration ${latestSupportedSchema}`,
            ),
          );
        }
        if (current !== CURRENT_SCHEMA_VERSION) {
          return yield* Effect.die(
            sqliteAdapterError(
              `database user_version ${current} requires an offline upgrade to schema ${CURRENT_SCHEMA_VERSION}`,
            ),
          );
        }
        try {
          config.startupDiagnosticProbe?.("p39.schema-validation.after");
        } catch {
          // Test-only startup diagnostics are non-authoritative.
        }
      }),
    ),
    base,
  );

  if (preparedDatabase === undefined) {
    return Layer.provide(
      all,
      currentSchemaGate,
    ) as Layer.Layer<SingleWorkspaceServices>;
  }
  const p39WriterPermit = Layer.provide(
    Layer.effectDiscard(
      Effect.acquireRelease(acquireP39RuntimeWriterPermit(), (permit) =>
        releaseP39WriterPermit(permit).pipe(Effect.orDie),
      ),
    ),
    p39WriterLockLayer(preparedDatabase.writerLockFilename),
  );
  const p39StartupGate = Layer.provide(currentSchemaGate, p39WriterPermit);
  return Layer.provide(
    all,
    p39StartupGate,
  ) as Layer.Layer<SingleWorkspaceServices>;
};

export {
  CURRENT_MIGRATIONS,
  P12_MIGRATIONS,
  P16_MIGRATIONS,
  P17_MIGRATIONS,
  P20_MIGRATIONS,
  P21_MIGRATIONS,
  P22_MIGRATIONS,
  runMigrations,
};
