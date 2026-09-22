import {
  Actor,
  CommandId,
  type Principal,
  type ProjectId,
  parse,
  VerificationId,
  WorkId,
  type WorkLifecycle,
  WorkRevision,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  AcceptanceRepositoryService,
  VerificationRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { CompleteWorkPayload } from "./commands/accept-complete.js";
import { semanticRequestFingerprint } from "./fingerprint.js";
import { newUuid7 } from "./formation-plan.js";
import type { CommandGatewayService, GatewayEnvelope } from "./gateway.js";

/** P8 `03` §2 (DID v1.11 GQ4/G3): the deterministic completion consumer —
 * the chain-end symmetric closure. `WorkOutcomeAccepted` stays the
 * Parent's semantic decision (Acceptance is a human/governance judgment);
 * this consumer only turns that fact into exactly one `CompleteWork`
 * submission through the CommandGateway. P1 consumer-infrastructure
 * wiring (poll/offset/dead-letters) is a later composition, so the
 * consumer here is a pure events-array-driven function
 * (dependency-coordinator precedent).
 *
 * NO PRECONDITION EXEMPTION (契约 §2, G3): the consumer grants no
 * exemption from the seven-fold precondition — every submission it makes
 * goes through the same `CompleteWork` handler, which re-validates the
 * full (work Open; current-revision Pass verification; current-revision
 * acceptance; triple binding) against current state. The consumer never
 * inspects acceptance semantics and never mutates lifecycle; its only
 * advisory read is the Work row, for the authority fact's
 * `targetWorkspaceId` and the terminal short-circuit below.
 *
 * Idempotency: `CommandId = deterministic f(workId, targetWorkRevision,
 * verificationId)`; at-least-once redelivery of the same event replays
 * the same inputs. A Work already terminal (the Completed replay) is
 * absorbed as a recorded `skip:TerminalLifecycleMutation` without
 * burning a submission — the same record the handler's typed rejection
 * produces (a terminal Work can never legally complete, so the
 * short-circuit legalizes nothing); refine-after-acceptance submits and
 * records the handler's Mismatch rejection. */
export interface CompletionConsumerEvent {
  readonly eventType: string;
  readonly payload: unknown;
  readonly eventId: string;
}

export interface CompletionConsumerDependencies {
  readonly gateway: CommandGatewayService;
  /** Read-model seams for the offset wiring; not consulted here — the
   * handler is authoritative on acceptance/verification state (契约 §2),
   * so the consumer never pre-decides from them. */
  readonly verifications: {
    readonly findById: (
      verificationId: import("@arbor/domain").VerificationId,
    ) => Effect.Effect<
      Option.Option<import("@arbor/domain").Verification>,
      unknown,
      never
    >;
  };
  readonly acceptances: {
    readonly findByWorkRevision: (
      workId: import("@arbor/domain").WorkId,
      targetWorkRevision: number,
    ) => Effect.Effect<Option.Option<unknown>, unknown, never>;
  };
  readonly works: {
    readonly findById: (workId: WorkId) => Effect.Effect<
      Option.Option<{
        readonly workspaceId: WorkspaceId;
        readonly lifecycle: WorkLifecycle;
      }>,
      unknown,
      never
    >;
  };
}

interface WorkOutcomeAcceptedEvent {
  readonly acceptanceId: string;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly verificationId: VerificationId;
}

const asWorkOutcomeAccepted = (
  payload: unknown,
): WorkOutcomeAcceptedEvent | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.acceptanceId !== "string" ||
    typeof candidate.workId !== "string" ||
    typeof candidate.targetWorkRevision !== "number" ||
    typeof candidate.verificationId !== "string"
  ) {
    return null;
  }
  return {
    acceptanceId: candidate.acceptanceId,
    workId: parse(WorkId)(candidate.workId),
    targetWorkRevision: parse(WorkRevision)(candidate.targetWorkRevision),
    verificationId: parse(VerificationId)(candidate.verificationId),
  };
};

/** Automatic-path deterministic CommandId (§2; DID §5.4; P7
 * satisfactionCommandId precedent): at-least-once redelivery is absorbed
 * idempotently by the existing receipt. Explicit submitters use their own
 * caller-preallocated ids. */
export const completionCommandId = (
  workId: WorkId,
  targetWorkRevision: WorkRevision,
  verificationId: VerificationId,
): CommandId =>
  parse(CommandId)(
    `cmd_${newUuid7(
      "complete-work",
      `${workId}:${targetWorkRevision}:${verificationId}`,
    )}`,
  );

/** One batch record per advisory decision: "CompleteWork" for a committed
 * closure, "skip:<rejection tag>" for the Completed replay
 * (TerminalLifecycleMutation) and any other typed gateway rejection
 * (e.g. the handler's seven-fold VerificationAcceptanceMismatch). Single
 * rejections never interrupt the batch. */
export const runCompletionConsumer = (
  events: ReadonlyArray<CompletionConsumerEvent>,
  dependencies: CompletionConsumerDependencies,
  projectId: ProjectId,
  principal: Principal,
): Effect.Effect<ReadonlyArray<string>, unknown> =>
  Effect.gen(function* () {
    const records: string[] = [];
    const actor = parse(Actor)(principal);

    for (const event of events) {
      if (event.eventType !== "WorkOutcomeAccepted") {
        continue;
      }
      const accepted = asWorkOutcomeAccepted(event.payload);
      if (accepted === null) {
        continue;
      }
      const found = yield* dependencies.works
        .findById(accepted.workId)
        .pipe(Effect.orDie);
      if (Option.isNone(found)) {
        // Referential-integrity break, same convention as the handler and
        // the P7 coordinator — defect, not a domain rejection.
        return yield* Effect.die(
          new Error(`work row not found: ${accepted.workId}`),
        );
      }
      const work = found.value;
      if (work.lifecycle !== "Open") {
        // Completed replay absorption (§2): the deterministic command
        // already closed this Work; a terminal Work can never legally
        // complete, so recording the handler's rejection tag without a
        // submission legalizes nothing and burns no retry.
        records.push("skip:TerminalLifecycleMutation");
        continue;
      }
      const payload: CompleteWorkPayload = {
        workId: accepted.workId,
        expectedWorkRevision: accepted.targetWorkRevision,
      };
      const commandId = completionCommandId(
        accepted.workId,
        accepted.targetWorkRevision,
        accepted.verificationId,
      );
      const envelope: GatewayEnvelope<CompleteWorkPayload> = {
        commandType: "CompleteWork",
        commandId,
        projectId,
        actor,
        issuedAt: new Date().toISOString(),
        causationRef: event.eventId,
        payload,
      };
      // Dead-letter semantics (P1 `05` §3 / `06`): consumer failures
      // quarantine with the offset advance — that wiring is a later
      // composition. At this boundary an operational Effect failure is a
      // defect: the AcceptWorkOutcome produce transaction already
      // committed and is never rolled back by consumption; recovery is
      // catch-up/replay, absorbed by the deterministic CommandId.
      const receipt = yield* dependencies.gateway
        .execute(
          envelope,
          {
            _tag: "System",
            principal,
            causationRef: `p8-completion-consumer:${event.eventId}`,
          },
          {
            _tag: "CompleteWorkAuthority",
            principal,
            commandId,
            semanticRequestFingerprint: semanticRequestFingerprint({
              commandType: "CompleteWork",
              projectId,
              actor,
              schemaVersion: "1",
              payload,
            }),
            projectId,
            targetWorkspaceId: work.workspaceId,
            workId: accepted.workId,
          },
        )
        .pipe(Effect.orDie);
      if (receipt.resolution._tag === "Committed") {
        records.push("CompleteWork");
      } else {
        // Typed rejection (authoritative handler refusal — the seven-fold
        // re-validation spoke): record, never interrupt the batch.
        records.push(`skip:${receipt.resolution.error._tag}`);
      }
    }
    return records;
  });
