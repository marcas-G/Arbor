import {
  CommandId,
  type ExecutionId,
  type Principal,
  type ProjectId,
  parse,
  SessionId,
  type Verification,
  type VerificationId,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  ClockService,
  ExecutionRepositoryError,
  ExecutionRepositoryService,
  TransactionOperationalFailure,
  TransactionPortService,
  VerificationRepositoryError,
  VerificationRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { semanticRequestFingerprint } from "./fingerprint.js";
import { newUuid7 } from "./formation-plan.js";
import type { CommandGatewayError, CommandGatewayService } from "./gateway.js";

/** P8 `02` §1. Verifier spawn rides the generic AdmitExecution command via
 * the CommandGateway — this module never imports execution-runtime
 * (DID §10.4.1: verification-runtime deps = domain/ports/application). The
 * owning workspace is the StartVerification-time owner snapshot (v1.11 G4);
 * the execution binds with no causal parent (M-3) — Producer/Verifier
 * separation starts at the binding. Spawn + backfill are idempotent steps
 * after the StartVerification commit; the deterministic command id makes
 * replay return the stored receipt instead of re-admitting. */
export interface SpawnVerifierArgs {
  readonly verification: Verification;
  readonly projectId: ProjectId;
  readonly ownerWorkspaceId: WorkspaceId;
  readonly verifierExecutionId: ExecutionId;
  readonly missionDigest: string;
}

export interface VerifierSpawnDependencies {
  readonly gateway: CommandGatewayService;
  readonly verifications: Pick<
    VerificationRepositoryService,
    "findById" | "bindExecution"
  >;
  readonly executions: Pick<ExecutionRepositoryService, "findById">;
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly clock: Pick<ClockService, "now">;
  readonly principal: Principal;
}

export type VerifierSpawnError =
  | CommandGatewayError
  | VerificationRepositoryError
  | TransactionOperationalFailure;

/** Deterministic AdmitExecution CommandId (P6 `01` §4.2 precedent): a
 * crash-recovery replay of the same (verification, execution) pair
 * resubmits the same command and absorbs at-least-once redelivery via the
 * stored receipt. */
export const verifierAdmitCommandId = (
  verificationId: VerificationId,
  executionId: ExecutionId,
): CommandId =>
  parse(CommandId)(
    `cmd_${newUuid7("verifier-admit", `${verificationId}:${executionId}`)}`,
  );

/** Caller-preallocated-derived ExecutionScoped session id (stable across
 * replays — same execution, same session). */
export const verifierSessionId = (executionId: ExecutionId): SessionId =>
  parse(SessionId)(`ses_${newUuid7("verifier", executionId)}`);

export const verifierMission = (missionDigest: string): string =>
  `verify:${missionDigest}`;

export interface VerifierSpawn {
  readonly admitted: boolean;
}

/** Admit the ExecutionBound verifier execution, then backfill
 * `verificationExecutionIds`. The gateway commits AdmitExecution (session +
 * execution rows atomically) in its own transaction; the bind is a separate
 * idempotent upsert outside it — a crash between the two is closed by
 * re-running `ensureVerifierSpawned`. */
export const spawnVerifier = (
  args: SpawnVerifierArgs,
  deps: VerifierSpawnDependencies,
): Effect.Effect<VerifierSpawn, VerifierSpawnError> =>
  Effect.gen(function* () {
    const verificationId = args.verification.verificationId;
    const payload = {
      _tag: "ExecutionBound" as const,
      executionId: args.verifierExecutionId,
      workspaceId: args.ownerWorkspaceId,
      parentExecutionId: null,
      mission: verifierMission(args.missionDigest),
      sessionId: verifierSessionId(args.verifierExecutionId),
    };
    const commandId = verifierAdmitCommandId(
      verificationId,
      args.verifierExecutionId,
    );
    const issuedAt = yield* deps.clock.now();
    const receipt = yield* deps.gateway.execute(
      {
        commandType: "AdmitExecution",
        commandId,
        projectId: args.projectId,
        actor: deps.principal as never,
        issuedAt,
        payload,
      },
      {
        _tag: "System",
        principal: deps.principal,
        causationRef: `verification:${verificationId}`,
      },
      {
        _tag: "AdmitExecutionAuthority",
        submissionOrigin: "System",
        principal: deps.principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "AdmitExecution",
          projectId: args.projectId,
          actor: deps.principal as never,
          schemaVersion: "1",
          payload,
        }),
        projectId: args.projectId,
        commandKind: "AdmitExecution",
        workspaceId: args.ownerWorkspaceId,
        bindingKind: "ExecutionBound",
      },
    );
    if (receipt.resolution._tag !== "Committed") {
      return { admitted: false };
    }
    yield* deps.tx.transact(
      deps.verifications.bindExecution(
        verificationId,
        args.verifierExecutionId,
        yield* deps.clock.now(),
      ),
    );
    return { admitted: true };
  });

/** P8 `02` §1 crash recovery: replay path per Open Verification — row
 * absent → skip (not our verification); the preallocated id already
 * backfilled **and** its durable Execution admitted → no-op (the idempotent
 * re-bind closes an admit→bind crash gap); otherwise spawn with the same
 * execution id (AdmitExecution replay returns the stored receipt). The
 * JSON `verificationExecutionIds` column is written intent at
 * StartVerification commit — it alone cannot mark spawn done, or a
 * commit-then-crash would leave a permanently verifier-less Open
 * Verification. */
export type EnsureVerifierSpawnedOutcome =
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "Noop" }
  | { readonly _tag: "Spawned"; readonly admitted: boolean };

export const ensureVerifierSpawned = (
  args: SpawnVerifierArgs,
  deps: VerifierSpawnDependencies,
): Effect.Effect<EnsureVerifierSpawnedOutcome, VerifierSpawnError> =>
  Effect.gen(function* () {
    const verificationId = args.verification.verificationId;
    const stored = yield* deps.tx.transact(
      deps.verifications.findById(verificationId),
    );
    if (Option.isNone(stored)) {
      return { _tag: "Skipped" };
    }
    const execution = yield* deps.tx.transact(
      deps.executions.findById(args.verifierExecutionId),
    );
    if (
      Option.isSome(execution) &&
      stored.value.verificationExecutionIds.includes(args.verifierExecutionId)
    ) {
      yield* deps.tx.transact(
        deps.verifications.bindExecution(
          verificationId,
          args.verifierExecutionId,
          yield* deps.clock.now(),
        ),
      );
      return { _tag: "Noop" };
    }
    const spawn = yield* spawnVerifier(args, deps);
    return { _tag: "Spawned", admitted: spawn.admitted };
  });

/** P8 `02` §3 settle-without-conclude fact scan: an Open Verification whose
 * bound verifier executions have all settled (none still active to drive a
 * conclusion) is orphaned — no auto-Unknown, no auto-PASS. The returned
 * list is the fact; Attention recording is 011/012 wiring, not this
 * boundary's. */
export interface OrphanedVerifier {
  readonly verificationId: VerificationId;
  readonly executionId: ExecutionId;
}

export interface VerifierOrphanDependencies {
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly verifications: Pick<VerificationRepositoryService, "listOpen">;
  readonly executions: Pick<ExecutionRepositoryService, "findById">;
}

export type VerifierOrphanError =
  | VerificationRepositoryError
  | ExecutionRepositoryError
  | TransactionOperationalFailure;

export const checkOrphanedVerifiers = (
  deps: VerifierOrphanDependencies,
): Effect.Effect<ReadonlyArray<OrphanedVerifier>, VerifierOrphanError> =>
  deps.tx.transact(
    Effect.gen(function* () {
      const open = yield* deps.verifications.listOpen();
      const orphans: OrphanedVerifier[] = [];
      for (const verification of open) {
        const boundIds = verification.verificationExecutionIds;
        if (boundIds.length === 0) {
          continue;
        }
        const foundOptions = yield* Effect.forEach(boundIds, (executionId) =>
          deps.executions.findById(executionId),
        );
        const found = foundOptions
          .filter(Option.isSome)
          .map((option) => option.value);
        const anyActive = found.some(
          (execution) => execution.state.status === "Active",
        );
        if (anyActive) {
          continue;
        }
        for (const execution of found) {
          if (execution.state.status === "Settled") {
            orphans.push({
              verificationId: verification.verificationId,
              executionId: execution.executionId,
            });
          }
        }
      }
      return orphans;
    }),
  );
