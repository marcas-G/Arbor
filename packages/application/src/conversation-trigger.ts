/**
 * P14 `02` — the deterministic conversation trigger + settle-side write-back.
 *
 * Frozen semantics (G-B, no Chat Runtime invented):
 *   SubmitHumanMessage（durable Pending）
 *     → this trigger（offset-driven consumer step, FIFO oldest-first）
 *     → AdmitExecution(WorkspaceMain, focus=Coordination)
 *     → existing P2/P3 chain
 *     → SettleExecution(Completed(QueryCompleted))
 *     → settle-side write-back (Claimed → Answered)
 *
 * Guarantees:
 *  - one-active-main (S5): while a main execution is active for the root
 *    workspace the message stays durable Pending — no second main, no
 *    interruption of the running execution;
 *  - claim is a single-statement CAS; a lost race yields no admission;
 *  - the executionId is DERIVED from the messageId (deterministic), so
 *    replay/retry converges on the same execution and the deterministic
 *    CommandId absorbs at-least-once redelivery (S6);
 *  - a rejected admission rolls the claim back to Pending →
 *    retry-until-response (no permanently lost message);
 *  - the browser never calls AdmitExecution — this module is the server-side
 *    Application path with a `System` submission context (S8). This module
 *    deliberately does NOT import execution-runtime (DID §10.4.1): the P2
 *    payload shape is mirrored structurally, exactly like verifier-spawn.
 */
import type {
  CommandSubmissionContext,
  Principal,
  ProjectId,
} from "@arbor/domain";
import { Actor, CommandId, ExecutionId, parse } from "@arbor/domain";
import type {
  ClockService,
  ExecutionRepositoryError,
  ExecutionRepositoryService,
  HumanMessageStoreError,
  HumanMessageStoreService,
  ProjectRepositoryError,
  ProjectRepositoryService,
  TransactionPortService,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { CommandAuthorityFact } from "./authority.js";
import { semanticRequestFingerprint } from "./fingerprint.js";
import { newUuid7 } from "./formation-plan.js";
import type { CommandGatewayError, CommandGatewayService } from "./gateway.js";

/** Structural mirror of the frozen P2 `AdmitExecutionPayload` WorkspaceMain
 * arm (P2 `01`); the registered handler validates it. */
interface AdmitWorkspaceMainPayload {
  readonly _tag: "WorkspaceMain";
  readonly executionId: ExecutionId;
  readonly workspaceId: never;
  readonly focus: { readonly _tag: "Coordination" };
}

/** Deterministic derivation (repository convention: `newUuid7(salt, seed)`;
 * verifier-spawn precedent) — a replay of the same message converges on the
 * same execution and the same command, so at-least-once redelivery is
 * absorbed by the stored receipt (S6). */
const deterministicExecutionId = (messageId: string): ExecutionId =>
  parse(ExecutionId)(`exe_${newUuid7("p14-conversation", messageId)}`);

const deterministicCommandId = (messageId: string): CommandId =>
  parse(CommandId)(`cmd_${newUuid7("p14-conversation-admit", messageId)}`);

export interface ConversationTriggerDependencies {
  readonly gateway: CommandGatewayService;
  readonly messages: Pick<
    HumanMessageStoreService,
    "pendingOrderedByCreated" | "claim" | "rollbackClaim"
  >;
  readonly projects: Pick<ProjectRepositoryService, "findById">;
  readonly executions: Pick<
    ExecutionRepositoryService,
    "findActiveMainByWorkspace"
  >;
  readonly clock: Pick<ClockService, "now">;
  /** Store operations run in their own short transactions; the gateway's
   * command transaction stays outermost-free (P1 `05` §1 consumer rule:
   * never nest the gateway's commit boundary). */
  readonly tx: Pick<TransactionPortService, "transact">;
  /** The System principal for trigger-originated admissions (composition
   * wires `runtime:conversation-trigger`). */
  readonly principal: Principal;
}

export type ConversationTriggerError =
  | CommandGatewayError
  | HumanMessageStoreError
  | ExecutionRepositoryError
  | ProjectRepositoryError;

export interface ConversationTriggerOutcome {
  readonly records: ReadonlyArray<string>;
}

/** One deterministic trigger step for a project (S5/S6). */
export const runConversationTrigger = (
  dependencies: ConversationTriggerDependencies,
  projectId: ProjectId,
): Effect.Effect<ConversationTriggerOutcome, ConversationTriggerError> =>
  Effect.gen(function* () {
    const records: Array<string> = [];
    const tx = dependencies.tx;
    const pending = yield* tx.transact(
      dependencies.messages.pendingOrderedByCreated(projectId),
    );
    if (pending.length === 0) {
      return { records };
    }
    const project = yield* tx.transact(
      dependencies.projects.findById(projectId),
    );
    if (Option.isNone(project)) {
      return { records: ["skipped:ProjectNotFound"] };
    }
    const rootWorkspaceId = project.value.rootWorkspaceId;

    // one-active-main (S5): no second main, no interruption — stay queued.
    const active = yield* tx.transact(
      dependencies.executions.findActiveMainByWorkspace(rootWorkspaceId),
    );
    if (Option.isSome(active)) {
      records.push(`queued:${pending[0]?.messageId ?? ""}`);
      return { records };
    }

    const message = pending[0];
    if (message === undefined) {
      return { records };
    }
    const executionId = deterministicExecutionId(message.messageId);
    // FIFO + CAS: exactly one trigger wins the oldest message.
    const claim = yield* tx.transact(
      dependencies.messages.claim(message.messageId, executionId),
    );
    if (claim._tag !== "Claimed") {
      records.push(`skipped:${claim._tag}:${message.messageId}`);
      return { records };
    }

    const payload: AdmitWorkspaceMainPayload = {
      _tag: "WorkspaceMain",
      executionId,
      workspaceId: rootWorkspaceId as never,
      focus: { _tag: "Coordination" },
    };
    const actor = parse(Actor)("system:conversation-trigger");
    const commandId = deterministicCommandId(message.messageId);
    const context: CommandSubmissionContext = {
      _tag: "System",
      principal: dependencies.principal,
      causationRef: `p14-conversation-trigger:${message.messageId}`,
    };
    const authority: CommandAuthorityFact = {
      _tag: "AdmitExecutionAuthority",
      submissionOrigin: "System",
      principal: dependencies.principal,
      commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "AdmitExecution",
        projectId,
        actor,
        schemaVersion: "1",
        payload: payload as unknown,
      }),
      projectId,
      commandKind: "AdmitExecution",
      workspaceId: rootWorkspaceId,
      bindingKind: "WorkspaceMain",
    };
    const receipt = yield* dependencies.gateway.execute(
      {
        commandType: "AdmitExecution",
        commandId,
        projectId,
        actor,
        issuedAt: yield* dependencies.clock.now(),
        causationRef: message.messageId,
        payload: payload as unknown,
      },
      context,
      authority,
    );
    if (receipt.resolution._tag === "Committed") {
      records.push(`admitted:${executionId}`);
      return { records };
    }
    // Rejected (e.g. ActiveExecutionConflict from a lost race): roll the
    // claim back so the message is retried once the active main settles.
    yield* tx.transact(dependencies.messages.rollbackClaim(message.messageId));
    records.push(
      `skipped:${receipt.resolution.error._tag}:${message.messageId}`,
    );
    return { records };
  });

export interface ConversationSettlementDependencies {
  readonly messages: Pick<
    HumanMessageStoreService,
    "findByClaimedExecution" | "markAnswered"
  >;
  readonly clock: Pick<ClockService, "now">;
  /** Bounded assistant response for the answered message (P14 `02` §4);
   * absent = no response body persisted. */
  readonly responseBodyOf: (
    messageId: string,
  ) => Effect.Effect<string | null, never, never>;
}

/** Settle-side write-back: Claimed → Answered, exactly once per message
 * (idempotent CAS; the settled event may be replayed at-least-once). */
export const runConversationSettlement = (
  dependencies: ConversationSettlementDependencies,
  executionId: string,
): Effect.Effect<
  ReadonlyArray<string>,
  HumanMessageStoreError,
  TransactionScope
> =>
  Effect.gen(function* () {
    const found =
      yield* dependencies.messages.findByClaimedExecution(executionId);
    if (Option.isNone(found)) {
      return ["noop:no-claimed-message"];
    }
    const responseBody = yield* dependencies.responseBodyOf(
      found.value.messageId,
    );
    yield* dependencies.messages.markAnswered(
      found.value.messageId,
      yield* dependencies.clock.now(),
      responseBody,
    );
    return [`answered:${found.value.messageId}`];
  });

export interface ConversationSweepDependencies {
  readonly messages: Pick<
    HumanMessageStoreService,
    "claimedOrderedByCreated" | "markAnswered" | "rollbackClaim"
  >;
  readonly executions: Pick<ExecutionRepositoryService, "findById">;
  readonly clock: Pick<ClockService, "now">;
  /** Bounded assistant response persisted at settle (P14 `02` §4 / `03`): the
   * adapter aggregates the execution's ModelOutput session entries within its
   * window. Absent = no body persisted (transcript shows the turn without text). */
  readonly responseBodyOf: (
    messageId: string,
  ) => Effect.Effect<string | null, never, never>;
}

/** Settle sweep (P14 `02` §4): for every Claimed message whose coordination
 * execution has settled, write Answer back exactly once. Idempotent: a row
 * already Answered is no longer in the Claimed set. */
export const runConversationSettlementSweep = (
  dependencies: ConversationSweepDependencies,
  projectId: ProjectId,
): Effect.Effect<
  ReadonlyArray<string>,
  HumanMessageStoreError | ExecutionRepositoryError,
  TransactionScope
> =>
  Effect.gen(function* () {
    const records: Array<string> = [];
    const claimed =
      yield* dependencies.messages.claimedOrderedByCreated(projectId);
    for (const message of claimed) {
      const executionId = message.claimedByExecutionId;
      if (executionId === null) {
        continue;
      }
      const execution = yield* dependencies.executions.findById(
        parse(ExecutionId)(executionId),
      );
      if (Option.isNone(execution)) {
        // Crash@claim: no live execution — roll the claim back so the
        // message is retried (retry-until-response); never leave it stuck
        // Claimed forever.
        yield* dependencies.messages.rollbackClaim(message.messageId);
        records.push(`stale-claim-rolled-back:${message.messageId}`);
        continue;
      }
      if (execution.value.state.status !== "Settled") {
        continue;
      }
      const responseBody = yield* dependencies.responseBodyOf(
        message.messageId,
      );
      yield* dependencies.messages.markAnswered(
        message.messageId,
        yield* dependencies.clock.now(),
        responseBody,
      );
      records.push(`answered:${message.messageId}`);
    }
    return records;
  });
