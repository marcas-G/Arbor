import { readFileSync } from "node:fs";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  CommandStoreLive,
  DeliverableRepositoryLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  EvidenceRepositoryLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  layer,
  P8_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  assertProgramGate,
  evalAllPrograms,
  evaluateProgramContent,
  PROGRAM_REGISTRY,
  type ProgramRegistryEntry,
  programFilePath,
  sha256Hex,
} from "../../packages/agent-runtime/src/prompt-programs.js";
import {
  type AcceptWorkOutcomePayload,
  makeAcceptWorkOutcomeHandler,
  makeCompleteWorkHandler,
} from "../../packages/application/src/commands/accept-complete.js";
import {
  type ConcludeVerificationPayload,
  type CriterionResultInput,
  makeConcludeVerificationHandler,
  makeRecordVerificationEvidenceHandler,
  type RecordVerificationEvidencePayload,
} from "../../packages/application/src/commands/conclude-verification.js";
import {
  makeStartVerificationHandler,
  type StartVerificationPayload,
} from "../../packages/application/src/commands/start-verification.js";
import {
  completionCommandId,
  runCompletionConsumer,
} from "../../packages/application/src/completion-consumer.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  makeP1CommandHandlers,
  semanticRequestFingerprint,
} from "../../packages/application/src/index.js";
import {
  runVerificationConsumer,
  verificationSpawnIds,
} from "../../packages/application/src/verification-consumer.js";
import {
  deliverVerificationWake,
  type VerificationWakeDependencies,
} from "../../packages/application/src/verification-wake.js";
import {
  ensureVerifierSpawned,
  type VerifierSpawnDependencies,
} from "../../packages/application/src/verifier-spawn.js";
import {
  AcceptanceId,
  ArtifactId,
  CommandId,
  type CommandSubmissionContext,
  DeliverableId,
  EvidenceId,
  ExecutionId,
  LeaseGeneration,
  Principal,
  parse,
  type Verification,
  VerificationId,
  type VerificationMission,
  type VerificationVerdict,
  WorkId,
  WorkRevision,
  type WorkspaceId,
} from "../../packages/domain/dist/index.js";
import { makeP2CommandHandlers } from "../../packages/execution-runtime/src/index.js";
import {
  AcceptanceRepository,
  Clock,
  DeliverableRepository,
  EnvironmentRevisionStore,
  EvidenceRepository,
  ExecutionRepository,
  ExecutionScheduler,
  ProjectRepository,
  type SchedulerDecision,
  SessionRepository,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
} from "../support/p7-app.js";
import {
  VERIFIER_PRINCIPAL,
  WREV,
  missionDigestOf,
} from "./support.js";

export const fingerprintOf = (commandType: string, payload: unknown) =>
  semanticRequestFingerprint({
    commandType,
    projectId: p7Project,
    actor: p7TestActor,
    schemaVersion: commandType === "ConcludeVerification" ? "2" : "1",
    payload,
  });

export const envelopeOf = <P>(
  commandType: string,
  commandId: CommandId,
  payload: P,
): GatewayEnvelope<P> => ({
  commandType,
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

export const externalContext: CommandSubmissionContext = {
  _tag: "External",
  principal: p7TestPrincipal,
};

export const verifierContextOf = (
  executionId: ExecutionId,
): CommandSubmissionContext => ({
  _tag: "ExecutionOrigin",
  principal: p7TestPrincipal,
  executionId,
  fencingGeneration: parse(LeaseGeneration)(0),
});

export const startPayload = (
  verificationId: VerificationId,
  workId: WorkId,
  observedWorkRevision: number,
  missionSnapshot: VerificationMission,
  verifierExecutionId: ExecutionId,
  overrides: {
    targetDeliverables?: ReadonlyArray<DeliverableId>;
    executableMission?: boolean;
  } = {},
): StartVerificationPayload => ({
  verificationId,
  workId,
  observedWorkRevision: WREV(observedWorkRevision),
  missionSnapshot,
  verifierExecutionId,
  executableMission: false,
  ...overrides,
});

export const recordPayload = (
  verificationId: VerificationId,
  evidenceId: EvidenceId,
  criterionId: string,
): RecordVerificationEvidencePayload => ({
  verificationId,
  evidence: {
    evidenceId,
    criterionId,
    kind: "ToolObservation",
    toolInvocationId: "tin_00000000-0000-7000-8000-000000000001" as never,
    observationRef: `observation:${criterionId}`,
    callRef: `call:${criterionId}`,
    recordedAt: "t",
  },
});

export const submitStart = (
  commandId: CommandId,
  payload: StartVerificationPayload,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<StartVerificationPayload, unknown>(
      envelopeOf("StartVerification", commandId, payload),
      externalContext,
      {
        _tag: "StartVerificationAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf("StartVerification", payload),
        projectId: p7Project,
        targetWorkspaceId: p7RootWorkspace,
        workId: payload.workId,
      },
    );
  });

export const submitRecord = (
  commandId: CommandId,
  payload: RecordVerificationEvidencePayload,
  executionId: ExecutionId,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<RecordVerificationEvidencePayload, unknown>(
      envelopeOf("RecordVerificationEvidence", commandId, payload),
      verifierContextOf(executionId),
      {
        _tag: "VerifierExecutionAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf(
          "RecordVerificationEvidence",
          payload,
        ),
        projectId: p7Project,
        verificationId: payload.verificationId,
        executionId,
      },
    );
  });

export const submitConclude = (
  commandId: CommandId,
  payload: ConcludeVerificationPayload,
  executionId: ExecutionId,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<ConcludeVerificationPayload, unknown>(
      envelopeOf("ConcludeVerification", commandId, payload),
      verifierContextOf(executionId),
      {
        _tag: "VerifierExecutionAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf(
          "ConcludeVerification",
          payload,
        ),
        projectId: p7Project,
        verificationId: payload.verificationId,
        executionId,
      },
    );
  });

export const submitConcludeOrphaned = (
  commandId: CommandId,
  payload: ConcludeVerificationPayload,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<ConcludeVerificationPayload, unknown>(
      envelopeOf("ConcludeVerification", commandId, payload),
      externalContext,
      {
        _tag: "OrphanConclusionAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf(
          "ConcludeVerification",
          payload,
        ),
        projectId: p7Project,
        targetWorkspaceId: p7RootWorkspace,
        verificationId: payload.verificationId,
      },
    );
  });

export const submitAccept = (
  commandId: CommandId,
  payload: AcceptWorkOutcomePayload,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<AcceptWorkOutcomePayload, unknown>(
      envelopeOf("AcceptWorkOutcome", commandId, payload),
      externalContext,
      {
        _tag: "AcceptanceAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf("AcceptWorkOutcome", payload),
        projectId: p7Project,
        targetWorkspaceId: p7RootWorkspace,
        workId: payload.workId,
        verificationId: payload.verificationId,
      },
    );
  });

export interface ReceiptLike {
  readonly resolution: {
    readonly _tag: string;
    readonly error?: { readonly _tag: string };
  };
}

export const expectTerminalRejected = (receipt: ReceiptLike, tag: string) => {
  expect(receipt.resolution._tag).toBe("TerminalRejected");
  if (
    receipt.resolution._tag === "TerminalRejected" &&
    receipt.resolution.error
  ) {
    expect(receipt.resolution.error._tag).toBe(tag);
  }
};

export const makeConsumerADeps = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const tx = yield* TransactionPort;
  const verifications = yield* VerificationRepository;
  const works = yield* WorkRepository;
  const workspaces = yield* WorkspaceRepository;
  return {
    gateway,
    verifications: {
      findOpenByWorkRevision: (workId: WorkId, targetWorkRevision: number) =>
        tx.transact(
          verifications.findOpenByWorkRevision(workId, targetWorkRevision),
        ),
      findById: (verificationId: VerificationId) =>
        tx.transact(verifications.findById(verificationId)),
      listByWork: (workId: WorkId) =>
        tx.transact(verifications.listByWork(workId)),
    },
    works: {
      findById: (workId: WorkId) => tx.transact(works.findById(workId)),
    },
    workspaces: {
      findById: (workspaceId: WorkspaceId) =>
        tx.transact(workspaces.findById(workspaceId)),
    },
  };
});

export const makeConsumerBDeps = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const tx = yield* TransactionPort;
  const verifications = yield* VerificationRepository;
  const acceptances = yield* AcceptanceRepository;
  const works = yield* WorkRepository;
  return {
    gateway,
    verifications: {
      findById: (verificationId: VerificationId) =>
        tx.transact(verifications.findById(verificationId)),
    },
    acceptances: {
      findByWorkRevision: (workId: WorkId, targetWorkRevision: number) =>
        tx.transact(acceptances.findByWorkRevision(workId, targetWorkRevision)),
    },
    works: {
      findById: (workId: WorkId) => tx.transact(works.findById(workId)),
    },
  };
});

export const makeWakeDeps = Effect.gen(function* () {
  return {
    tx: yield* TransactionPort,
    waits: yield* WorkWaitStore,
    works: yield* WorkRepository,
    scheduler: yield* ExecutionScheduler,
  } satisfies VerificationWakeDependencies;
});

export const makeSpawnDeps = Effect.gen(function* () {
  return {
    gateway: yield* CommandGateway,
    verifications: yield* VerificationRepository,
    executions: yield* ExecutionRepository,
    tx: yield* TransactionPort,
    clock: yield* Clock,
    principal: VERIFIER_PRINCIPAL,
  } satisfies VerifierSpawnDependencies;
});

export const spawnFor = (
  verification: Verification,
  verifierExecutionId: ExecutionId,
) =>
  Effect.gen(function* () {
    const deps = yield* makeSpawnDeps;
    return yield* ensureVerifierSpawned(
      {
        verification,
        projectId: p7Project,
        ownerWorkspaceId: p7RootWorkspace,
        verifierExecutionId,
        missionDigest: missionDigestOf(verification.missionSnapshot),
      },
      deps,
    );
  });

export const deliverConclusion = (
  verdict: VerificationVerdict,
  workId: WorkId,
  verificationId: VerificationId,
) =>
  Effect.gen(function* () {
    const deps = yield* makeWakeDeps;
    return yield* deliverVerificationWake(
      {
        workId,
        targetWorkRevision: WREV(0),
        verdict,
        verificationId,
        ownerWorkspaceId: p7RootWorkspace,
      },
      deps,
    );
  });
