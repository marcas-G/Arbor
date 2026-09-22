import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  ExecutionRepositoryLive,
  P8_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "../packages/application/src/index.js";
import {
  checkOrphanedVerifiers,
  ensureVerifierSpawned,
  spawnVerifier,
  type VerifierSpawnDependencies,
  verifierAdmitCommandId,
  verifierSessionId,
} from "../packages/application/src/verifier-spawn.js";
import {
  CommandId,
  ExecutionId,
  Principal,
  parse,
  startVerification,
  VerificationId,
  type VerificationMission,
  WorkId,
  WorkRevision,
} from "../packages/domain/dist/index.js";
import {
  Clock,
  ExecutionRepository,
  TransactionPort,
  VerificationRepository,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  runP7,
} from "./support/p7-app.js";

const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const WORK_2 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000002");
const ASSIGN_CMD = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const ASSIGN_CMD_2 = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const VER_1 = parse(VerificationId)("ver_00000000-0000-7000-8000-000000000001");
const VER_2 = parse(VerificationId)("ver_00000000-0000-7000-8000-000000000002");
const EXE_1 = parse(ExecutionId)("exe_00000000-0000-7000-8000-000000000001");
const EXE_2 = parse(ExecutionId)("exe_00000000-0000-7000-8000-000000000002");
const PRINCIPAL = parse(Principal)("runtime:verifier");

const mission: VerificationMission = {
  goal: "verify the outcome",
  criteria: [{ criterionId: "c1", requirement: "tests pass", required: true }],
  riskRequirements: [],
};

/** p7-app extension: makeP7App consumes ExecutionRepositoryLive internally
 * (P2 handler registry) but does not expose the service tag — provide it
 * (plus Clock, same pattern as p8-start-verification's store extension) so
 * test-side deps can share the gateway's repositories. */
const makeP8App = () =>
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.provide(ExecutionRepositoryLive, ClockLive),
      ClockLive,
    ),
    makeP7App(),
  );

const seed = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
});

const seedVerification = (
  verificationId: VerificationId,
  executionIds: ReadonlyArray<ExecutionId> = [],
  workId: WorkId = WORK_1,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    yield* tx.transact(
      verifications.insert(
        startVerification({
          verificationId,
          workId,
          targetWorkRevision: parse(WorkRevision)(0),
          missionSnapshot: mission,
          verificationExecutionIds: executionIds,
        }),
        p7Project,
        p7RootWorkspace,
      ),
    );
  });

const makeDeps = Effect.gen(function* () {
  return {
    gateway: yield* CommandGateway,
    verifications: yield* VerificationRepository,
    executions: yield* ExecutionRepository,
    tx: yield* TransactionPort,
    clock: yield* Clock,
    principal: PRINCIPAL,
  } satisfies VerifierSpawnDependencies;
});

const executionRow = (executionId: ExecutionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<{
      binding_kind: string;
      parent_execution_id: string | null;
      mission: string | null;
      settlement_kind: string | null;
    }>(
      "SELECT binding_kind, parent_execution_id, mission, settlement_kind FROM executions WHERE execution_id = ?",
      [executionId],
    );
  });

const countRows = (table: string, where = "") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} ${where}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

const settleExecution = (executionId: ExecutionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE executions SET settlement_kind = 'Completed', settlement_json = ?, settled_at = ? WHERE execution_id = ?",
      [
        JSON.stringify({
          _tag: "Completed",
          result: { _tag: "QueryCompleted" },
        }),
        "t",
        executionId,
      ],
    );
  });

const spawnArgs = (
  verificationId: VerificationId,
  executionId: ExecutionId,
) => {
  const verification = startVerification({
    verificationId,
    workId: WORK_1,
    targetWorkRevision: parse(WorkRevision)(0),
    missionSnapshot: mission,
  });
  return {
    verification,
    projectId: p7Project,
    ownerWorkspaceId: p7RootWorkspace,
    verifierExecutionId: executionId,
    missionDigest: "verify the outcome [criteria=1 required=1]",
  };
};

describe("p8-verifier-spawn", () => {
  it("M-3: AdmitExecution(ExecutionBound) commits with parentExecutionId null and lands a parentless execution row", async () => {
    const result = await runP7(
      Effect.gen(function* () {
        yield* seed;
        const gateway = yield* CommandGateway;
        const sessionId = verifierSessionId(EXE_1);
        const payload = {
          _tag: "ExecutionBound" as const,
          executionId: EXE_1,
          workspaceId: p7RootWorkspace,
          parentExecutionId: null,
          mission: "verify:digest",
          sessionId,
        };
        const commandId = verifierAdmitCommandId(VER_1, EXE_1);
        const receipt = yield* gateway.execute(
          {
            commandType: "AdmitExecution",
            commandId,
            projectId: p7Project,
            actor: PRINCIPAL as never,
            issuedAt: "t",
            payload,
          },
          { _tag: "System", principal: PRINCIPAL, causationRef: "test" },
          {
            _tag: "AdmitExecutionAuthority",
            submissionOrigin: "System",
            principal: PRINCIPAL,
            commandId,
            semanticRequestFingerprint: semanticRequestFingerprint({
              commandType: "AdmitExecution",
              projectId: p7Project,
              actor: PRINCIPAL as never,
              schemaVersion: "1",
              payload,
            }),
            projectId: p7Project,
            commandKind: "AdmitExecution",
            workspaceId: p7RootWorkspace,
            bindingKind: "ExecutionBound",
          } as VerifiedRuntimeCommandAuthority,
        );
        return {
          resolution: receipt.resolution._tag,
          rows: yield* executionRow(EXE_1),
          scoped: yield* countRows(
            "sessions",
            "WHERE binding_kind = 'ExecutionScoped'",
          ),
        };
      }),
      makeP8App(),
    );
    expect(result.resolution).toBe("Committed");
    expect(result.rows[0]?.binding_kind).toBe("execution_bound");
    expect(result.rows[0]?.parent_execution_id).toBeNull();
    expect(result.rows[0]?.mission).toBe("verify:digest");
    expect(result.scoped).toBe(1);
  });

  it("spawnVerifier admits the execution and backfills verificationExecutionIds", async () => {
    const result = await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER_1);
        const deps = yield* makeDeps;
        const spawn = yield* spawnVerifier(spawnArgs(VER_1, EXE_1), deps);
        const tx = yield* TransactionPort;
        const verifications = yield* VerificationRepository;
        const stored = yield* tx.transact(verifications.findById(VER_1));
        return {
          spawn,
          rows: yield* executionRow(EXE_1),
          stored,
        };
      }),
      makeP8App(),
    );
    expect(result.spawn).toEqual({ admitted: true });
    expect(result.rows[0]?.binding_kind).toBe("execution_bound");
    expect(result.rows[0]?.parent_execution_id).toBeNull();
    expect(result.rows[0]?.mission).toBe(
      "verify:verify the outcome [criteria=1 required=1]",
    );
    expect(Option.isSome(result.stored)).toBe(true);
    if (Option.isSome(result.stored)) {
      expect(result.stored.value.verificationExecutionIds).toEqual([EXE_1]);
    }
  });

  it("spawnVerifier replay with the same (verification, execution) pair is idempotent: same stored receipt, one row, bind upsert no-ops", async () => {
    const result = await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER_1);
        const deps = yield* makeDeps;
        const first = yield* spawnVerifier(spawnArgs(VER_1, EXE_1), deps);
        // Deterministic command id + identical payload → the gateway returns
        // the stored Committed receipt instead of re-admitting. A *different*
        // commandId colliding on the same executionId primary key surfaces as
        // a typed ExecutionRepositoryFailure from the sqlite adapter — a
        // foreign-submitter defect, not this replay path.
        const replay = yield* spawnVerifier(spawnArgs(VER_1, EXE_1), deps);
        return {
          first,
          replay,
          executions: yield* countRows("executions"),
          binds: yield* countRows("verification_executions"),
        };
      }),
      makeP8App(),
    );
    expect(result.first).toEqual({ admitted: true });
    expect(result.replay).toEqual({ admitted: true });
    expect(result.executions).toBe(1);
    expect(result.binds).toBe(1);
  });

  it("ensureVerifierSpawned: unknown verification skips; admitted id no-ops (bind healed); commit-then-crash re-spawns", async () => {
    const result = await runP7(
      Effect.gen(function* () {
        yield* seed;
        const deps = yield* makeDeps;

        // unknown verification row → skip, nothing admitted
        const skipped = yield* ensureVerifierSpawned(
          spawnArgs(VER_1, EXE_1),
          deps,
        );
        expect(skipped).toEqual({ _tag: "Skipped" });
        expect(yield* countRows("executions")).toBe(0);

        // P8-003 insert shape: JSON ids written at commit, execution not yet
        // admitted — the commit→spawn crash window re-spawns
        yield* seedVerification(VER_1, [EXE_1]);
        const spawned = yield* ensureVerifierSpawned(
          spawnArgs(VER_1, EXE_1),
          deps,
        );
        expect(spawned).toEqual({ _tag: "Spawned", admitted: true });
        expect(yield* countRows("executions")).toBe(1);

        // admitted + backfilled → no-op (and heals a missing bind row)
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            "DELETE FROM verification_executions WHERE verification_id = ?",
            [VER_1],
          );
        });
        const noop = yield* ensureVerifierSpawned(
          spawnArgs(VER_1, EXE_1),
          deps,
        );
        expect(noop).toEqual({ _tag: "Noop" });
        return {
          executions: yield* countRows("executions"),
          binds: yield* countRows("verification_executions"),
        };
      }),
      makeP8App(),
    );
    expect(result.executions).toBe(1);
    expect(result.binds).toBe(1);
  });

  it("checkOrphanedVerifiers: settled execution under an Open verification is listed; in-progress is not", async () => {
    const result = await runP7(
      Effect.gen(function* () {
        yield* seed;
        const deps = yield* makeDeps;
        const tx = yield* TransactionPort;
        const executions = yield* ExecutionRepository;

        // in progress: Open verification + active bound execution
        yield* seedVerification(VER_1);
        yield* spawnVerifier(spawnArgs(VER_1, EXE_1), deps);
        const before = yield* checkOrphanedVerifiers({
          tx,
          verifications: yield* VerificationRepository,
          executions,
        });
        expect(before).toEqual([]);

        // settle-without-conclude: execution settles, verification stays Open
        yield* settleExecution(EXE_1);
        const after = yield* checkOrphanedVerifiers({
          tx,
          verifications: yield* VerificationRepository,
          executions,
        });

        // second verification on its own work (one-Open per work+revision)
        // still in progress — stays off the list
        const otherReceipt = yield* p7SeedWork(WORK_2, ASSIGN_CMD_2);
        expect(otherReceipt.resolution._tag).toBe("Committed");
        yield* seedVerification(VER_2, [], WORK_2);
        yield* spawnVerifier(spawnArgs(VER_2, EXE_2), deps);
        const withSecond = yield* checkOrphanedVerifiers({
          tx,
          verifications: yield* VerificationRepository,
          executions,
        });
        return { after, withSecond };
      }),
      makeP8App(),
    );
    expect(result.after).toEqual([
      { verificationId: VER_1, executionId: EXE_1 },
    ]);
    expect(result.withSecond).toEqual([
      { verificationId: VER_1, executionId: EXE_1 },
    ]);
  });

  it("checkOrphanedVerifiers: an Open verification with an active sibling execution is not orphaned", async () => {
    const result = await runP7(
      Effect.gen(function* () {
        yield* seed;
        const deps = yield* makeDeps;
        const tx = yield* TransactionPort;
        const executions = yield* ExecutionRepository;
        const verifications = yield* VerificationRepository;

        // one settled + one active verifier on the same verification:
        // the active sibling can still conclude — not orphaned
        yield* seedVerification(VER_1);
        yield* spawnVerifier(spawnArgs(VER_1, EXE_1), deps);
        yield* spawnVerifier(
          { ...spawnArgs(VER_1, EXE_2), missionDigest: "second" },
          deps,
        );
        yield* settleExecution(EXE_1);
        return yield* checkOrphanedVerifiers({ tx, verifications, executions });
      }),
      makeP8App(),
    );
    expect(result).toEqual([]);
  });
});
