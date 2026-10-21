import type {
  CommandId,
  EventId,
  InboxEntry,
  ProjectId,
  Verification,
  VerificationId,
  VerificationVerdict,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import { decodeSupportedEventPayload } from "@arbor/domain";
import type {
  CommandStoreService,
  DomainEventJournalService,
  ExecutionSchedulerService,
  InboxProjectionStoreService,
  ProjectRepositoryService,
  RetryVerificationOriginRepositoryService,
  TransactionPortService,
  TransactionScope,
  VerificationRepositoryService,
  VerificationSignalReconciliationCandidate,
  VerificationSignalReconciliationFailureCode,
  VerificationSignalReconciliationRow,
  VerificationSignalReconciliationStoreService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
  WorkWaitStoreService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option, Result } from "effect";
import { decodeRegisteredCommandReceipt } from "./command-result-codec.js";
import type { ConcludeVerificationResult } from "./commands/conclude-verification.js";
import type { RetryVerificationResult } from "./commands/retry-verification.js";
import { deriveVerificationConclusionEffectPlan } from "./verification-signal-plan.js";
import { deliverVerificationWake } from "./verification-wake.js";
import { deliverWakeSignal } from "./wake-sink.js";

export interface VerificationSignalReconciliationDependencies {
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly store: Pick<
    VerificationSignalReconciliationStoreService,
    | "listDeadLetterCandidates"
    | "activationHighwater"
    | "find"
    | "insertPending"
    | "claim"
    | "advance"
    | "recordAttention"
  >;
  readonly journal: Pick<DomainEventJournalService, "decodeRaw">;
  readonly commands: Pick<CommandStoreService, "findResolution">;
  readonly retryOrigins: Pick<
    RetryVerificationOriginRepositoryService,
    "findOrigin"
  >;
  readonly verifications: Pick<VerificationRepositoryService, "findById">;
  readonly works: Pick<WorkRepositoryService, "findById" | "listByWorkspace">;
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly projects: Pick<ProjectRepositoryService, "findById">;
  readonly waits: Pick<
    WorkWaitStoreService,
    "listActive" | "findByWork" | "clear"
  >;
  readonly scheduler: Pick<ExecutionSchedulerService, "reevaluate">;
  readonly inbox: Pick<
    InboxProjectionStoreService,
    "admitUpsert" | "findStoredByKey"
  >;
  readonly clock: { readonly now: () => Effect.Effect<string, unknown> };
  readonly qualificationProbe?: VerificationSignalReconciliationQualificationProbe;
}

export interface VerificationSignalReconciliationSweepResult {
  readonly scanned: number;
  readonly completed: number;
  readonly attention: number;
  readonly deferred: number;
}

export type VerificationSignalReconciliationQualificationBoundary =
  | "AfterSourceValidationBeforeClaim"
  | "AfterVerificationWakeEffectBeforeDisposition"
  | "AfterVerificationWakeDispositionCommit"
  | "BeforeParentInboxDispositionCommit"
  | "AfterParentInboxDispositionCommit"
  | "AfterParentWakeEffectBeforeDisposition"
  | "AfterParentWakeDispositionCommit"
  | "AfterCompletedDispositionCommit"
  | "AfterAttentionCommit";

export type VerificationSignalReconciliationQualificationProbe = (event: {
  readonly boundary: VerificationSignalReconciliationQualificationBoundary;
  readonly projectId: ProjectId;
  readonly eventSequence: number;
  readonly leaseGeneration: number;
}) => Promise<void>;

type Proof =
  | {
      readonly _tag: "Proven";
      readonly source: import("@arbor/ports").VerificationSignalReconciliationSource;
      readonly occurredAt: string;
      readonly legacyAbsentReason: boolean;
    }
  | {
      readonly _tag: "Rejected";
      readonly failureCode: VerificationSignalReconciliationFailureCode;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
};

const canonicalUtc = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;

const verifiedActivationHighwater = (
  projectId: ProjectId,
  raw: {
    readonly projectIdRaw: unknown;
    readonly maxEventSequenceRaw: unknown;
    readonly capturedAtRaw: unknown;
    readonly factDigestRaw: unknown;
  },
) => {
  if (
    raw.projectIdRaw !== projectId ||
    typeof raw.maxEventSequenceRaw !== "number" ||
    !Number.isSafeInteger(raw.maxEventSequenceRaw) ||
    raw.maxEventSequenceRaw < 0 ||
    !canonicalUtc(raw.capturedAtRaw) ||
    typeof raw.factDigestRaw !== "string"
  ) {
    return null;
  }
  const expectedDigest = sha256Hex(
    `f18-v2-activation-highwater-v1\0${projectId}\0${raw.maxEventSequenceRaw}\0${raw.capturedAtRaw}`,
  );
  return raw.factDigestRaw === expectedDigest
    ? {
        projectId,
        maxEventSequence: raw.maxEventSequenceRaw,
        capturedAt: raw.capturedAtRaw,
        factDigest: raw.factDigestRaw,
      }
    : null;
};

const payloadFieldsMatch = (
  payload: Record<string, unknown>,
  verification: Verification,
): boolean => {
  const canonicalEvidenceRefs =
    verification.criteriaResults?.flatMap(
      (criterion) => criterion.evidenceRefs,
    ) ?? [];
  return (
    payload.verificationId === verification.verificationId &&
    payload.workId === verification.workId &&
    payload.targetWorkRevision === verification.targetWorkRevision &&
    payload.verdict ===
      (verification.state.status === "Concluded"
        ? verification.state.verdict
        : null) &&
    payload.conclusionReason ===
      (verification.state.status === "Concluded"
        ? (verification.state.conclusionReason ?? null)
        : null) &&
    payload.summaryRef === verification.summaryRef &&
    stableJson(payload.evidenceRefs) === stableJson(canonicalEvidenceRefs) &&
    stableJson(payload.missionSnapshot) ===
      stableJson(verification.missionSnapshot) &&
    stableJson(payload.criteriaResults) ===
      stableJson(verification.criteriaResults ?? []) &&
    payload.snapshotStatus === verification.snapshotStatus
  );
};

const expectedWakeSignals = (
  verification: Verification,
  ownerWorkspaceId: WorkspaceId,
): ConcludeVerificationResult["wakeSignals"] => {
  if (verification.state.status !== "Concluded") return [];
  const plan = deriveVerificationConclusionEffectPlan(
    verification.state.verdict,
    null,
  );
  return plan.reevaluateOwner
    ? [
        {
          workspaceId: ownerWorkspaceId,
          reason: { _tag: "VerificationReturned" as const },
          detail: {
            verificationId: verification.verificationId,
            workId: verification.workId,
            workRevision: verification.targetWorkRevision,
            verdict: verification.state.verdict,
          },
        },
      ]
    : [];
};

const eventPayloadOf = (
  candidate: VerificationSignalReconciliationCandidate,
): Record<string, unknown> | null => {
  if (typeof candidate.payloadJsonRaw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(candidate.payloadJsonRaw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const receiptErrorIsCorruption = (failure: unknown): boolean =>
  isRecord(failure) && failure._tag === "PersistenceCorruption";

const validateCandidate = (
  candidate: VerificationSignalReconciliationCandidate,
  projectId: ProjectId,
  deps: VerificationSignalReconciliationDependencies,
): Effect.Effect<Proof, unknown, TransactionScope> =>
  Effect.gen(function* () {
    if (
      candidate.deadLetterReason !== "unsupported eventVersion 2" &&
      candidate.deadLetterReason !== "malformed event payload"
    ) {
      return {
        _tag: "Rejected",
        failureCode: "DeadLetterBindingMismatch",
      };
    }
    if (
      candidate.projectIdRaw !== projectId ||
      typeof candidate.sequenceRaw !== "number" ||
      !Number.isSafeInteger(candidate.sequenceRaw) ||
      candidate.sequenceRaw <= 0 ||
      candidate.eventTypeRaw !== "VerificationConcluded" ||
      candidate.eventVersionRaw !== 2
    ) {
      return { _tag: "Rejected", failureCode: "UnsupportedSourcePair" };
    }
    if (
      typeof candidate.eventIdRaw !== "string" ||
      candidate.eventIdRaw.length === 0 ||
      !canonicalUtc(candidate.occurredAtRaw) ||
      typeof candidate.aggregateRefRaw !== "string" ||
      typeof candidate.actorRaw !== "string" ||
      candidate.actorRaw.length === 0 ||
      typeof candidate.causedByCommandIdRaw !== "string" ||
      candidate.causedByEventIdRaw !== null ||
      candidate.correlationRefRaw !== null
    ) {
      return { _tag: "Rejected", failureCode: "EventEnvelopeMalformed" };
    }
    const rawPayload = eventPayloadOf(candidate);
    if (rawPayload === null) {
      return { _tag: "Rejected", failureCode: "EventEnvelopeMalformed" };
    }

    const rawDecode = yield* deps.journal.decodeRaw(candidate);
    let payload = rawPayload;
    let legacyAbsentReason = false;
    let legacyActivationHighwater: ReturnType<
      typeof verifiedActivationHighwater
    > = null;
    if (rawDecode._tag !== "Decoded") {
      if (
        candidate.deadLetterReason === "malformed event payload" &&
        rawPayload.conclusionReason === "" &&
        Object.hasOwn(rawPayload, "conclusionReason")
      ) {
        const highwaterRaw = yield* deps.store.activationHighwater(projectId);
        if (highwaterRaw !== null) {
          legacyActivationHighwater = verifiedActivationHighwater(
            projectId,
            highwaterRaw,
          );
          if (legacyActivationHighwater === null) {
            return { _tag: "Rejected", failureCode: "StateCorruption" };
          }
        }
        if (
          legacyActivationHighwater !== null &&
          candidate.sequenceRaw <= legacyActivationHighwater.maxEventSequence
        ) {
          payload = { ...rawPayload, conclusionReason: null };
          const compatibilityDecode = decodeSupportedEventPayload(
            "VerificationConcluded",
            2,
            payload,
          );
          legacyAbsentReason = compatibilityDecode._tag === "Decoded";
        }
      }
      if (!legacyAbsentReason) {
        return {
          _tag: "Rejected",
          failureCode:
            rawDecode.reason === "UnsupportedEventPair"
              ? "UnsupportedSourcePair"
              : "EventDecodeFailed",
        };
      }
    }

    const payloadId = payload.verificationId;
    const commandId = candidate.causedByCommandIdRaw;
    if (
      typeof payloadId !== "string" ||
      candidate.aggregateRefRaw !== payloadId ||
      typeof payload.workId !== "string" ||
      typeof payload.targetWorkRevision !== "number" ||
      !Number.isSafeInteger(payload.targetWorkRevision) ||
      typeof payload.verdict !== "string" ||
      (payload.verdict !== "Pass" &&
        payload.verdict !== "Fail" &&
        payload.verdict !== "Unknown")
    ) {
      return { _tag: "Rejected", failureCode: "EventDecodeFailed" };
    }
    const verificationResult = yield* deps.verifications.findById(
      payloadId as VerificationId,
    );
    if (Option.isNone(verificationResult)) {
      return { _tag: "Rejected", failureCode: "CanonicalMismatch" };
    }
    const verification = verificationResult.value;
    if (
      verification.state.status !== "Concluded" ||
      !payloadFieldsMatch(
        legacyAbsentReason ? { ...payload, conclusionReason: null } : payload,
        verification,
      ) ||
      (legacyAbsentReason &&
        (verification.state.conclusionReason !== undefined ||
          verification.snapshotStatus !== "Available" ||
          payload.conclusionReason !== "" ||
          verification.criteriaResults === null))
    ) {
      return { _tag: "Rejected", failureCode: "CanonicalMismatch" };
    }
    const workResult = yield* deps.works.findById(verification.workId);
    if (Option.isNone(workResult)) {
      return { _tag: "Rejected", failureCode: "RouteMismatch" };
    }
    const ownerWorkspaceId = verification.ownerWorkspaceId;
    if (
      ownerWorkspaceId === undefined ||
      ownerWorkspaceId !== workResult.value.workspaceId
    ) {
      return { _tag: "Rejected", failureCode: "RouteMismatch" };
    }
    const ownerResult = yield* deps.workspaces.findById(ownerWorkspaceId);
    const projectResult = yield* deps.projects.findById(projectId);
    if (
      Option.isNone(ownerResult) ||
      ownerResult.value.projectId !== projectId ||
      Option.isNone(projectResult) ||
      projectResult.value.rootWorkspaceId.length === 0
    ) {
      return { _tag: "Rejected", failureCode: "RouteMismatch" };
    }
    if (ownerResult.value.parentWorkspaceId !== null) {
      const parentResult = yield* deps.workspaces.findById(
        ownerResult.value.parentWorkspaceId,
      );
      if (
        Option.isNone(parentResult) ||
        parentResult.value.projectId !== projectId
      ) {
        return { _tag: "Rejected", failureCode: "RouteMismatch" };
      }
    }

    const receiptResult = yield* deps.commands.findResolution(
      commandId as CommandId,
    );
    if (Option.isNone(receiptResult)) {
      return { _tag: "Rejected", failureCode: "ReceiptMissing" };
    }
    const stored = receiptResult.value;
    if (
      stored.projectId !== projectId ||
      stored.resolution !== "Committed" ||
      stored.resultJson === null
    ) {
      return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
    }
    let receiptResultData: unknown;
    if (payload.conclusionReason === "Orphaned") {
      if (stored.schemaVersion !== "1") {
        return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
      }
      const decoded = yield* Effect.result(
        decodeRegisteredCommandReceipt<RetryVerificationResult>(
          stored,
          "RetryVerification",
          "1",
        ),
      );
      if (Result.isFailure(decoded)) {
        if (!receiptErrorIsCorruption(decoded.failure)) {
          return yield* Effect.fail(decoded.failure);
        }
        return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
      }
      const retryResult = decoded.success.resolution;
      if (retryResult._tag !== "Committed") {
        return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
      }
      const origin = yield* deps.retryOrigins.findOrigin(
        commandId as CommandId,
      );
      if (
        Option.isNone(origin) ||
        origin.value.projectId !== projectId ||
        origin.value.sourceVerificationId !== verification.verificationId ||
        origin.value.sourceWorkId !== verification.workId ||
        origin.value.actor !== candidate.actorRaw ||
        retryResult.result.state !== "OrphanedAndRetried" ||
        retryResult.result.workId !== verification.workId ||
        retryResult.result.orphanedVerificationId !==
          verification.verificationId ||
        retryResult.result.successorVerificationId !==
          origin.value.successorVerificationId ||
        retryResult.result.verifierExecutionId !==
          origin.value.successorVerifierExecutionId
      ) {
        return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
      }
      receiptResultData = {
        verificationId: verification.verificationId,
        state: "Concluded",
        verdict: verification.state.verdict,
        summaryRef: verification.summaryRef,
        conclusionReason: "Orphaned",
        wakeSignals: expectedWakeSignals(verification, ownerWorkspaceId),
        channel1Release: {
          workId: verification.workId,
          targetWorkRevision: verification.targetWorkRevision,
        },
      };
    } else if (legacyAbsentReason) {
      if (stored.schemaVersion !== "2") {
        return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stored.resultJson);
      } catch {
        return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
      }
      const expected = {
        verificationId: verification.verificationId,
        state: "Concluded",
        verdict: verification.state.verdict,
        summaryRef: verification.summaryRef,
        wakeSignals: expectedWakeSignals(verification, ownerWorkspaceId),
        channel1Release: {
          workId: verification.workId,
          targetWorkRevision: verification.targetWorkRevision,
        },
        missionSnapshot: verification.missionSnapshot,
        criteriaResults: verification.criteriaResults,
        snapshotStatus: verification.snapshotStatus,
      };
      if (!isRecord(parsed) || stableJson(parsed) !== stableJson(expected)) {
        return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
      }
      receiptResultData = { ...expected, conclusionReason: null };
    } else {
      if (stored.schemaVersion !== "2") {
        return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
      }
      const decoded = yield* Effect.result(
        decodeRegisteredCommandReceipt<ConcludeVerificationResult>(
          stored,
          "ConcludeVerification",
          "2",
        ),
      );
      if (Result.isFailure(decoded)) {
        if (!receiptErrorIsCorruption(decoded.failure)) {
          return yield* Effect.fail(decoded.failure);
        }
        return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
      }
      const committed = decoded.success.resolution;
      if (committed._tag !== "Committed") {
        return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
      }
      receiptResultData = committed.result;
    }
    const expectedReceipt = {
      verificationId: verification.verificationId,
      state: "Concluded",
      verdict: verification.state.verdict,
      summaryRef: verification.summaryRef,
      conclusionReason: verification.state.conclusionReason ?? null,
      wakeSignals: expectedWakeSignals(verification, ownerWorkspaceId),
      channel1Release: {
        workId: verification.workId,
        targetWorkRevision: verification.targetWorkRevision,
      },
      ...(stored.schemaVersion === "2"
        ? {
            missionSnapshot: verification.missionSnapshot,
            criteriaResults: verification.criteriaResults,
            snapshotStatus: verification.snapshotStatus,
          }
        : {}),
    };
    if (stableJson(receiptResultData) !== stableJson(expectedReceipt)) {
      return { _tag: "Rejected", failureCode: "ReceiptMismatch" };
    }
    const eventExpected = {
      verificationId: verification.verificationId,
      workId: verification.workId,
      targetWorkRevision: verification.targetWorkRevision,
      verdict: verification.state.verdict,
      conclusionReason: verification.state.conclusionReason ?? null,
      evidenceRefs:
        verification.criteriaResults?.flatMap(
          (criterion) => criterion.evidenceRefs,
        ) ?? [],
      summaryRef: verification.summaryRef,
      missionSnapshot: verification.missionSnapshot,
      criteriaResults: verification.criteriaResults ?? [],
      snapshotStatus: verification.snapshotStatus,
    };
    const normalizedEvent = legacyAbsentReason
      ? { ...payload, conclusionReason: null }
      : payload;
    if (stableJson(normalizedEvent) !== stableJson(eventExpected)) {
      return { _tag: "Rejected", failureCode: "CanonicalMismatch" };
    }
    const effectPlan = deriveVerificationConclusionEffectPlan(
      verification.state.verdict,
      ownerResult.value.parentWorkspaceId,
    );
    const sourceDigest = sha256Hex(
      stableJson({
        candidate,
        originalPayloadJson: candidate.payloadJsonRaw,
        legacyActivationHighwater,
        storedReceipt: stored,
        verification,
        ownerWorkspace: ownerResult.value,
      }),
    );
    const effectPlanDigest = sha256Hex(
      stableJson({
        version: 1,
        effectPlan,
        occurredAt: candidate.occurredAtRaw,
      }),
    );
    return {
      _tag: "Proven",
      source: {
        identity: {
          consumerId: "workflow-signals",
          projectId,
          eventSequence: candidate.sequenceRaw,
        },
        eventId: candidate.eventIdRaw as EventId,
        sourceCommandId: commandId,
        verificationId: verification.verificationId,
        workId: verification.workId,
        workRevision: verification.targetWorkRevision,
        verdict: verification.state.verdict,
        ownerWorkspaceId,
        parentWorkspaceId: ownerResult.value.parentWorkspaceId,
        sourceDigest,
        effectPlanDigest,
      },
      occurredAt: candidate.occurredAtRaw,
      legacyAbsentReason,
    };
  });

const exactChildResultInbox = (
  entry: InboxEntry,
  parentWorkspaceId: WorkspaceId,
  verificationId: VerificationId,
  workId: WorkId,
  workRevision: number,
  occurredAt: string,
): boolean =>
  entry.recipientWorkspaceId === parentWorkspaceId &&
  entry.entryKey === `child-result:${verificationId}:${workRevision}` &&
  entry.kind === "Message" &&
  entry.summary ===
    `Child result ready for Work ${workId} revision ${workRevision}` &&
  entry.admittedAt === occurredAt &&
  entry.correlationId === undefined;

const advance = (
  deps: VerificationSignalReconciliationDependencies,
  row: VerificationSignalReconciliationRow,
  expectedPhase:
    | "Pending"
    | "VerificationWakeDelivered"
    | "ParentInboxCommitted"
    | "ParentWakeDelivered",
  nextPhase:
    | "VerificationWakeDelivered"
    | "ParentInboxCommitted"
    | "ParentWakeDelivered"
    | "Completed",
  now: string,
) =>
  deps.tx.transact(
    deps.store.advance({
      identity: row,
      expectedPhase,
      nextPhase,
      leaseOwner: row.leaseOwner ?? "",
      leaseGeneration: row.leaseGeneration,
      now,
    }),
  );

const probeBoundary = (
  deps: VerificationSignalReconciliationDependencies,
  boundary: VerificationSignalReconciliationQualificationBoundary,
  row: VerificationSignalReconciliationRow,
) =>
  deps.qualificationProbe === undefined
    ? Effect.void
    : Effect.promise(
        () =>
          deps.qualificationProbe?.({
            boundary,
            projectId: row.projectId,
            eventSequence: row.eventSequence,
            leaseGeneration: row.leaseGeneration,
          }) ?? Promise.resolve(),
      );

const handleProvenSource = (
  proof: Extract<Proof, { readonly _tag: "Proven" }>,
  deps: VerificationSignalReconciliationDependencies,
  config: {
    readonly leaseOwner: string;
    readonly leaseTtlMs: number;
  },
): Effect.Effect<
  | "Completed"
  | "Attention:InboxConflict"
  | "Attention:StateCorruption"
  | "Deferred",
  unknown
> =>
  Effect.gen(function* () {
    const current = yield* deps.tx.transact(
      deps.store.find(proof.source.identity),
    );
    const childPass =
      proof.source.verdict === "Pass" &&
      proof.source.parentWorkspaceId !== null;
    const parentWorkspaceId = proof.source.parentWorkspaceId;
    const verificationId = proof.source.verificationId as VerificationId;
    const workId = proof.source.workId as WorkId;
    const entryKey = `child-result:${verificationId}:${proof.source.workRevision}`;
    const inboxIsExact = () =>
      Effect.gen(function* () {
        if (parentWorkspaceId === null) return false;
        const findStored = deps.inbox.findStoredByKey;
        if (findStored === undefined) return false;
        const stored = yield* deps.tx.transact(
          findStored.call(deps.inbox, parentWorkspaceId, entryKey),
        );
        return (
          Option.isSome(stored) &&
          exactChildResultInbox(
            stored.value.entry,
            parentWorkspaceId,
            verificationId,
            workId,
            proof.source.workRevision,
            proof.occurredAt,
          )
        );
      });
    if (current?.phase === "Completed") {
      if (childPass && !(yield* inboxIsExact())) {
        return "Attention:InboxConflict";
      }
      return "Completed";
    }
    if (current?.phase === "Attention") {
      return "Deferred";
    }
    let row: VerificationSignalReconciliationRow;
    const now = yield* deps.clock.now();
    if (current === null) {
      row = yield* deps.tx.transact(
        deps.store.insertPending(
          proof.source,
          config.leaseOwner,
          new Date(Date.parse(now) + config.leaseTtlMs).toISOString(),
          now,
        ),
      );
    } else {
      if (
        current.sourceDigest !== proof.source.sourceDigest ||
        current.effectPlanDigest !== proof.source.effectPlanDigest ||
        current.eventId !== proof.source.eventId
      ) {
        return "Attention:StateCorruption";
      }
      if (
        current.leaseOwner === config.leaseOwner &&
        current.leaseExpiresAt !== null &&
        Date.parse(current.leaseExpiresAt) > Date.parse(now)
      ) {
        row = current;
      } else {
        const claimed = yield* deps.tx.transact(
          deps.store.claim({
            identity: proof.source.identity,
            leaseOwner: config.leaseOwner,
            now,
            leaseTtlMs: config.leaseTtlMs,
          }),
        );
        if (claimed === null) return "Deferred";
        row = claimed;
      }
    }
    if (
      row.leaseOwner !== config.leaseOwner ||
      row.leaseExpiresAt === null ||
      Date.parse(row.leaseExpiresAt) <= Date.parse(now)
    )
      return "Deferred";
    if (
      childPass &&
      (row.phase === "ParentInboxCommitted" ||
        row.phase === "ParentWakeDelivered") &&
      !(yield* inboxIsExact())
    ) {
      return "Attention:InboxConflict";
    }
    const wakeDeps = {
      tx: deps.tx,
      waits: deps.waits,
      works: deps.works,
      scheduler: deps.scheduler,
    };
    if (row.phase === "Pending") {
      yield* deliverVerificationWake(
        {
          verificationId: proof.source.verificationId as VerificationId,
          workId: proof.source.workId as WorkId,
          targetWorkRevision: proof.source.workRevision as never,
          verdict: proof.source.verdict as VerificationVerdict,
          ownerWorkspaceId: proof.source.ownerWorkspaceId,
        },
        wakeDeps,
      );
      yield* probeBoundary(
        deps,
        "AfterVerificationWakeEffectBeforeDisposition",
        row,
      );
      const advanced = yield* advance(
        deps,
        row,
        "Pending",
        "VerificationWakeDelivered",
        yield* deps.clock.now(),
      );
      if (!advanced) return "Deferred";
      yield* probeBoundary(deps, "AfterVerificationWakeDispositionCommit", row);
      row = {
        ...row,
        phase: "VerificationWakeDelivered",
        updatedAt: yield* deps.clock.now(),
      };
    }
    if (!childPass) {
      if (row.phase !== "VerificationWakeDelivered") return "Deferred";
      const completed = yield* advance(
        deps,
        row,
        "VerificationWakeDelivered",
        "Completed",
        yield* deps.clock.now(),
      );
      return completed ? "Completed" : "Deferred";
    }
    if (parentWorkspaceId === null) return "Deferred";
    if (row.phase === "VerificationWakeDelivered") {
      const inboxResult = yield* Effect.result(
        deps.tx.transact(
          Effect.gen(function* () {
            const findStored = deps.inbox.findStoredByKey;
            if (findStored === undefined) return "Conflict" as const;
            let stored = yield* findStored.call(
              deps.inbox,
              parentWorkspaceId,
              entryKey,
            );
            if (Option.isSome(stored)) {
              if (
                !exactChildResultInbox(
                  stored.value.entry,
                  parentWorkspaceId,
                  verificationId,
                  workId,
                  proof.source.workRevision,
                  proof.occurredAt,
                )
              )
                return "Conflict" as const;
            } else {
              yield* deps.inbox.admitUpsert({
                recipientWorkspaceId: parentWorkspaceId,
                entryKey,
                kind: "Message",
                summary: `Child result ready for Work ${workId} revision ${proof.source.workRevision}`,
                admittedAt: proof.occurredAt,
              });
              stored = yield* findStored.call(
                deps.inbox,
                parentWorkspaceId,
                entryKey,
              );
              if (
                Option.isNone(stored) ||
                !exactChildResultInbox(
                  stored.value.entry,
                  parentWorkspaceId,
                  verificationId,
                  workId,
                  proof.source.workRevision,
                  proof.occurredAt,
                )
              )
                return "Conflict" as const;
            }
            const committed = yield* deps.store.advance({
              identity: row,
              expectedPhase: "VerificationWakeDelivered",
              nextPhase: "ParentInboxCommitted",
              leaseOwner: row.leaseOwner ?? "",
              leaseGeneration: row.leaseGeneration,
              now: yield* deps.clock.now(),
            });
            if (!committed) {
              return yield* Effect.fail({
                _tag: "F18InboxPhaseCASLost" as const,
              });
            }
            yield* probeBoundary(
              deps,
              "BeforeParentInboxDispositionCommit",
              row,
            );
            return "Committed" as const;
          }),
        ),
      );
      const inboxOutcome = Result.isSuccess(inboxResult)
        ? inboxResult.success
        : isRecord(inboxResult.failure) &&
            inboxResult.failure._tag === "F18InboxPhaseCASLost"
          ? "Lost"
          : yield* Effect.fail(inboxResult.failure);
      if (inboxOutcome === "Conflict") return "Attention:InboxConflict";
      if (inboxOutcome === "Lost") return "Deferred";
      yield* probeBoundary(deps, "AfterParentInboxDispositionCommit", row);
      row = { ...row, phase: "ParentInboxCommitted" };
    }
    if (row.phase === "ParentInboxCommitted") {
      if (!(yield* inboxIsExact())) return "Attention:InboxConflict";
      yield* deliverWakeSignal(
        {
          workspaceId: parentWorkspaceId,
          reason: "InputArrived",
          detail: {
            verificationId,
            workId,
            targetWorkRevision: proof.source.workRevision,
          },
        },
        {
          tx: deps.tx,
          waits: deps.waits,
          works: deps.works,
          scheduler: deps.scheduler,
        },
      );
      yield* probeBoundary(deps, "AfterParentWakeEffectBeforeDisposition", row);
      const advanced = yield* advance(
        deps,
        row,
        "ParentInboxCommitted",
        "ParentWakeDelivered",
        yield* deps.clock.now(),
      );
      if (!advanced) return "Deferred";
      yield* probeBoundary(deps, "AfterParentWakeDispositionCommit", row);
      row = { ...row, phase: "ParentWakeDelivered" };
    }
    if (row.phase === "ParentWakeDelivered") {
      const completed = yield* advance(
        deps,
        row,
        "ParentWakeDelivered",
        "Completed",
        yield* deps.clock.now(),
      );
      if (completed) {
        yield* probeBoundary(deps, "AfterCompletedDispositionCommit", row);
      }
      return completed ? "Completed" : "Deferred";
    }
    return "Deferred";
  });

export const runVerificationSignalReconciliationSweep = (
  projectId: ProjectId,
  deps: VerificationSignalReconciliationDependencies,
  config: {
    readonly leaseOwner: string;
    readonly leaseTtlMs: number;
    readonly batchSize: number;
  },
): Effect.Effect<VerificationSignalReconciliationSweepResult, unknown> =>
  Effect.gen(function* () {
    if (
      config.leaseOwner.length === 0 ||
      !Number.isSafeInteger(config.leaseTtlMs) ||
      config.leaseTtlMs <= 0 ||
      !Number.isSafeInteger(config.batchSize) ||
      config.batchSize <= 0
    ) {
      return yield* Effect.fail({
        _tag: "PersistenceCorruption" as const,
        repository: "VerificationSignalReconciliationStore" as const,
        operation: "sweep-policy",
        reason: "invalid F18 reconciliation lease or batch policy",
      });
    }
    const candidates = yield* deps.tx.transact(
      Effect.gen(function* () {
        const now = yield* deps.clock.now();
        return yield* deps.store.listDeadLetterCandidates({
          projectId,
          limit: config.batchSize,
          now,
        });
      }),
    );
    if (candidates.length === 0) {
      return { scanned: 0, completed: 0, attention: 0, deferred: 0 };
    }
    const projectResult = yield* deps.tx.transact(
      deps.projects.findById(projectId),
    );
    if (Option.isNone(projectResult)) {
      return yield* Effect.fail({
        _tag: "PersistenceCorruption" as const,
        repository: "VerificationSignalReconciliationStore" as const,
        operation: "project-root",
        reason: "F18 reconciliation Project cannot be proven",
      });
    }
    const rootResult = yield* deps.tx.transact(
      deps.workspaces.findById(projectResult.value.rootWorkspaceId),
    );
    if (
      Option.isNone(rootResult) ||
      rootResult.value.projectId !== projectId ||
      rootResult.value.parentWorkspaceId !== null
    ) {
      return yield* Effect.fail({
        _tag: "PersistenceCorruption" as const,
        repository: "VerificationSignalReconciliationStore" as const,
        operation: "project-root",
        reason: "F18 reconciliation Project root Workspace cannot be proven",
      });
    }
    let completed = 0;
    let attention = 0;
    let deferred = 0;
    for (const candidate of candidates) {
      const sequence = candidate.sequenceRaw;
      if (
        typeof sequence !== "number" ||
        !Number.isSafeInteger(sequence) ||
        sequence <= 0
      ) {
        return yield* Effect.fail({
          _tag: "PersistenceCorruption" as const,
          repository: "VerificationSignalReconciliationStore" as const,
          operation: "dead-letter-identity",
          reason: "workflow dead-letter sequence cannot be proven",
        });
      }
      const proof = yield* deps.tx.transact(
        validateCandidate(candidate, projectId, deps),
      );
      if (proof._tag === "Rejected") {
        const prior = yield* deps.tx.transact(
          deps.store.find({
            consumerId: "workflow-signals",
            projectId,
            eventSequence: sequence,
          }),
        );
        if (prior?.phase === "Attention") {
          attention += 1;
          continue;
        }
        const now = yield* deps.clock.now();
        const sourceIdentity = `workflow-signals:${projectId}:${sequence}`;
        const evidenceDigest = sha256Hex(
          stableJson({ candidate, rawPayload: candidate.payloadJsonRaw }),
        );
        const attentionFactId = sha256Hex(
          `f18-v2-reconciliation-attention-v1\0${sourceIdentity}`,
        );
        yield* deps.tx.transact(
          deps.store.recordAttention({
            identity: {
              consumerId: "workflow-signals",
              projectId,
              eventSequence: sequence,
            },
            eventId: prior?.eventId ?? null,
            failureCode: proof.failureCode,
            evidenceDigest,
            targetWorkspaceId: projectResult.value.rootWorkspaceId,
            firstDetectedAt: now,
            sourceIdentity,
            attentionFactId,
          }),
        );
        const attentionRow = yield* deps.tx.transact(
          deps.store.find({
            consumerId: "workflow-signals",
            projectId,
            eventSequence: sequence,
          }),
        );
        if (attentionRow !== null) {
          yield* probeBoundary(deps, "AfterAttentionCommit", attentionRow);
        }
        attention += 1;
        continue;
      }
      yield* probeBoundary(deps, "AfterSourceValidationBeforeClaim", {
        projectId,
        eventSequence: sequence,
        leaseGeneration: 0,
      } as VerificationSignalReconciliationRow);
      const previous = yield* deps.tx.transact(
        deps.store.find(proof.source.identity),
      );
      if (previous?.phase === "Attention") {
        attention += 1;
        continue;
      }
      const outcome = yield* handleProvenSource(proof, deps, config);
      if (outcome === "Completed") completed += 1;
      else if (
        outcome === "Attention:InboxConflict" ||
        outcome === "Attention:StateCorruption"
      ) {
        const now = yield* deps.clock.now();
        const sourceIdentity = `workflow-signals:${projectId}:${sequence}`;
        yield* deps.tx.transact(
          deps.store.recordAttention({
            identity: proof.source.identity,
            eventId: proof.source.eventId,
            failureCode:
              outcome === "Attention:InboxConflict"
                ? "InboxConflict"
                : "StateCorruption",
            evidenceDigest: proof.source.sourceDigest,
            targetWorkspaceId: projectResult.value.rootWorkspaceId,
            firstDetectedAt: now,
            sourceIdentity,
            attentionFactId: sha256Hex(
              `f18-v2-reconciliation-attention-v1\0${sourceIdentity}`,
            ),
          }),
        );
        const attentionRow = yield* deps.tx.transact(
          deps.store.find(proof.source.identity),
        );
        if (attentionRow !== null) {
          yield* probeBoundary(deps, "AfterAttentionCommit", attentionRow);
        }
        attention += 1;
      } else deferred += 1;
    }
    return {
      scanned: candidates.length,
      completed,
      attention,
      deferred,
    };
  });
