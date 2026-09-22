import type {
  CommandSubmissionContext,
  Principal,
  ProjectId,
  Verification,
  Work,
  WorkId,
  Workspace,
  WorkspaceId,
} from "@arbor/domain";
import {
  Actor,
  CommandId,
  ExecutionId,
  parse,
  VerificationId,
  WorkRevision,
} from "@arbor/domain";
import { Effect, Option } from "effect";
import type { CommandAuthorityFact } from "./authority.js";
import type { StartVerificationPayload } from "./commands/start-verification.js";
import { semanticRequestFingerprint } from "./fingerprint.js";
import { newUuid7 } from "./formation-plan.js";
import type { CommandGatewayService, GatewayEnvelope } from "./gateway.js";

/** P8 `03` §1 (DID v1.11 §5.4): Consumer A — the deterministic consumer from
 * `ExecutionSettled(CompletionClaimed)` to `StartVerification` via the
 * CommandGateway. At-least-once, fully deterministic, no model calls. Its
 * ONLY mutation face is the same `StartVerification` Command the Parent /
 * governance path uses; it never bypasses the Command Handler. P1 consumer
 * wiring (poll/offset/dead-letters) is the later composition, so the
 * consumer here is a pure events-array-driven function
 * (formation-consumer / P7 coordinator precedent). */
export interface VerificationConsumerEvent {
  readonly eventType: string;
  readonly payload: unknown;
  readonly eventId: string;
}

export interface VerificationConsumerDependencies<R> {
  readonly gateway: CommandGatewayService;
  readonly verifications: {
    readonly findOpenByWorkRevision: (
      workId: WorkId,
      targetWorkRevision: number,
    ) => Effect.Effect<Option.Option<Verification>, unknown, R>;
    readonly findById: (
      verificationId: VerificationId,
    ) => Effect.Effect<Option.Option<Verification>, unknown, R>;
  };
  readonly works: {
    readonly findById: (
      workId: WorkId,
    ) => Effect.Effect<Option.Option<Work>, unknown, R>;
  };
  readonly workspaces: {
    readonly findById: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<Option.Option<Workspace>, unknown, R>;
  };
}

/** Caller-preallocated identity set (P8 `02` §1, v1.7 G5): deterministic
 * f(workId, workRevision, claimRef) — at-least-once redelivery is absorbed
 * idempotently by the existing receipt (DID §5.4). */
export interface VerificationSpawnIds {
  readonly commandId: CommandId;
  readonly verificationId: VerificationId;
  readonly verifierExecutionId: ExecutionId;
}

export const verificationSpawnIds = (
  workId: WorkId,
  workRevision: number,
  claimRef: string,
): VerificationSpawnIds => {
  const seed = `${workId}:${workRevision}:${claimRef}`;
  return {
    commandId: parse(CommandId)(
      `cmd_${newUuid7("p8-verification-command", seed)}`,
    ),
    verificationId: parse(VerificationId)(
      `ver_${newUuid7("p8-verification", seed)}`,
    ),
    verifierExecutionId: parse(ExecutionId)(
      `exe_${newUuid7("p8-verifier-execution", seed)}`,
    ),
  };
};

/** M-4 frozen payload: { executionId, workId, workRevision, claimRef }. A
 * non-empty claimRef marks the CompletionClaimed settlement path; a missing
 * workId is a pre-M-4 legacy event (skip, recorded — never replay burn). */
interface SettlementTrigger {
  readonly workId: WorkId;
  readonly workRevision: number;
  readonly claimRef: string;
}

const asCompletionClaimed = (
  payload: unknown,
): SettlementTrigger | { readonly legacy: true } | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.workId !== "string") {
    return { legacy: true };
  }
  if (typeof candidate.claimRef !== "string" || candidate.claimRef === "") {
    return null;
  }
  if (typeof candidate.workRevision !== "number") {
    return { legacy: true };
  }
  return {
    workId: candidate.workId as WorkId,
    workRevision: candidate.workRevision,
    claimRef: candidate.claimRef,
  };
};

/** One record per event decision: "StartVerification" for a committed
 * submission, "skipped:<reason>:<ref>" for pre-check misses and typed
 * gateway rejections, "needSpawn:<verificationId>:<verifierExecutionId>"
 * for the crash-recovery re-spawn hint (below). */
export const runVerificationConsumer = <R>(
  events: ReadonlyArray<VerificationConsumerEvent>,
  dependencies: VerificationConsumerDependencies<R>,
  projectId: ProjectId,
  principal: Principal,
): Effect.Effect<ReadonlyArray<string>, unknown, R> =>
  Effect.gen(function* () {
    const records: string[] = [];
    const actor = parse(Actor)(principal);

    /** P8 `02` §1 replay re-spawn determination: an Open Verification whose
     * `verificationExecutionIds` is un-backfilled is the crash window
     * between commit and spawn/backfill. This consumer never spawns
     * (P8-008 wiring owns AdmitExecution); it only returns the
     * `needSpawn` hint — the wiring applies the durable-Execution check
     * before re-spawning with the same id (AdmitExecution idempotent, so
     * a redundant hint is harmless). Backfilled or concluded → no-op. */
    const replayRecord = (
      verification: Verification,
      ids: VerificationSpawnIds,
      workId: WorkId,
    ): string => {
      if (verification.state.status !== "Open") {
        return `skipped:VerificationNotOpen:${verification.verificationId}`;
      }
      if (verification.verificationExecutionIds.length === 0) {
        return `needSpawn:${verification.verificationId}:${ids.verifierExecutionId}`;
      }
      return `skipped:VerificationAlreadyOpen:${workId}`;
    };

    for (const event of events) {
      if (event.eventType !== "ExecutionSettled") {
        continue;
      }
      const trigger = asCompletionClaimed(event.payload);
      if (trigger === null) {
        records.push(`skipped:NotCompletionClaimed:${event.eventId}`);
        continue;
      }
      if ("legacy" in trigger) {
        records.push(`skipped:LegacyExecutionSettled:${event.eventId}`);
        continue;
      }
      const { workId, workRevision, claimRef } = trigger;

      // Store facts, not payload claims (P7 coordinator convention): the
      // Work snapshot decides; a moved revision or terminal Work is a
      // recorded skip, never a submission burned into the journal.
      const stored = yield* dependencies.works
        .findById(workId)
        .pipe(Effect.orDie);
      if (Option.isNone(stored) || stored.value.projectId !== projectId) {
        records.push(`skipped:WorkNotFound:${workId}`);
        continue;
      }
      const work = stored.value;
      if (work.lifecycle !== "Open") {
        records.push(`skipped:TerminalLifecycleMutation:${workId}`);
        continue;
      }
      if (work.revision !== workRevision) {
        records.push(`skipped:RevisionConflict:${workId}`);
        continue;
      }
      const owner = yield* dependencies.workspaces
        .findById(work.workspaceId)
        .pipe(Effect.orDie);
      if (Option.isNone(owner)) {
        records.push(`skipped:WorkspaceNotFound:${workId}`);
        continue;
      }

      const ids = verificationSpawnIds(workId, workRevision, claimRef);

      // At-least-once absorption, two faces: our deterministic id already
      // landed (findById — covers replay and post-conclusion redelivery),
      // or another starter holds the one-Open slot for this revision
      // (findOpenByWorkRevision). Either way the re-spawn hint still
      // fires for an un-backfilled Open row.
      const mine = yield* dependencies.verifications
        .findById(ids.verificationId)
        .pipe(Effect.orDie);
      if (Option.isSome(mine)) {
        records.push(replayRecord(mine.value, ids, workId));
        continue;
      }
      const open = yield* dependencies.verifications
        .findOpenByWorkRevision(workId, workRevision)
        .pipe(Effect.orDie);
      if (Option.isSome(open)) {
        records.push(replayRecord(open.value, ids, workId));
        continue;
      }

      const payload: StartVerificationPayload = {
        verificationId: ids.verificationId,
        workId,
        observedWorkRevision: parse(WorkRevision)(workRevision),
        missionSnapshot: work.verificationMission,
        verifierExecutionId: ids.verifierExecutionId,
        executableMission: false,
      };
      const context: CommandSubmissionContext = {
        _tag: "System",
        principal,
        causationRef: `p8-verification-consumer:${event.eventId}`,
      };
      const envelope: GatewayEnvelope<StartVerificationPayload> = {
        commandType: "StartVerification",
        commandId: ids.commandId,
        projectId,
        actor,
        issuedAt: new Date().toISOString(),
        causationRef: event.eventId,
        payload,
      };
      const authority: CommandAuthorityFact = {
        _tag: "StartVerificationAuthority",
        principal,
        commandId: ids.commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "StartVerification",
          projectId,
          actor,
          schemaVersion: "1",
          payload,
        }),
        projectId,
        targetWorkspaceId: work.workspaceId,
        workId,
      };
      // Operational failures are defects at this boundary (P7 coordinator
      // convention): the settlement transaction already committed; recovery
      // is catch-up replay, absorbed by the deterministic CommandId.
      const receipt = yield* dependencies.gateway
        .execute(envelope, context, authority)
        .pipe(Effect.orDie);
      if (receipt.resolution._tag === "Committed") {
        records.push("StartVerification");
        continue;
      }
      // Typed rejection (e.g. VerificationAlreadyOpen from a lost one-Open
      // race): record, never interrupt the batch.
      records.push(`skipped:${receipt.resolution.error._tag}:${workId}`);
    }
    return records;
  });
