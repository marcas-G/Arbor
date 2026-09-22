import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AcceptanceRepositoryLive,
  EvidenceRepositoryLive,
  layer,
  P8_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
  VerificationRepositoryLive,
} from "../adapters/persistence-sqlite/src/index.js";
import type { Acceptance } from "../packages/domain/dist/index.js";
import {
  CommandId,
  concludeVerification,
  type EvidenceId,
  type ExecutionId,
  parse,
  startVerification,
  type Verification,
  type VerificationId,
  type VerificationMission,
  WorkId,
} from "../packages/domain/dist/index.js";
import {
  AcceptanceRepository,
  EvidenceRepository,
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
const ASSIGN_CMD = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const VER_1 =
  "ver_00000000-0000-7000-8000-000000000001" as never as VerificationId;
const VER_2 =
  "ver_00000000-0000-7000-8000-000000000002" as never as VerificationId;
const EV_1 = "evd_00000000-0000-7000-8000-000000000001" as never as EvidenceId;
const EXE_1 =
  "exe_00000000-0000-7000-8000-000000000001" as never as ExecutionId;
const ACC_1 = "acc_00000000-0000-7000-8000-000000000001" as never;

const p8Layer = () => {
  const base = layer({ filename: ":memory:" });
  const tx = Layer.provide(TransactionPortLive, base);
  return Layer.provideMerge(
    Layer.mergeAll(
      VerificationRepositoryLive,
      EvidenceRepositoryLive,
      AcceptanceRepositoryLive,
      tx,
    ),
    base,
  );
};

const seed = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
});

const mission: VerificationMission = {
  goal: "g",
  criteria: [{ criterionId: "c1", requirement: "r1", required: true }],
  riskRequirements: [],
};

const verificationOf = (id: VerificationId): Verification =>
  startVerification({
    verificationId: id,
    workId: WORK_1,
    targetWorkRevision: 0 as never,
    missionSnapshot: mission,
  });

const acceptance: Acceptance = {
  acceptanceId: ACC_1,
  workId: WORK_1,
  targetWorkRevision: 0 as never,
  verificationId: VER_1,
  actor: "user:gov" as never,
  acceptedAt: "t",
};

describe("P8-002 DDL + repositories", () => {
  it("migration 8 creates the four tables", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient;
        const tables = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('verifications','verification_executions','verification_evidence','work_acceptances')",
        );
        expect(tables.map((t) => t.name).sort()).toEqual([
          "verification_evidence",
          "verification_executions",
          "verifications",
          "work_acceptances",
        ]);
      }),
      makeP7App(),
    );
  });

  it("one-Open-per-revision; concluded history unrestricted", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const repos = yield* VerificationRepository;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          repos.insert(verificationOf(VER_1), p7Project, p7RootWorkspace),
        );
        const duplicate = yield* tx
          .transact(
            repos.insert(verificationOf(VER_2), p7Project, p7RootWorkspace),
          )
          .pipe(Effect.flip);
        expect(duplicate._tag).toBe("VerificationRepositoryFailure");
        yield* tx.transact(repos.concludeIfOpen(VER_1, "Pass", undefined));
        yield* tx.transact(
          repos.insert(verificationOf(VER_2), p7Project, p7RootWorkspace),
        );
        const open = yield* tx.transact(
          repos.findOpenByWorkRevision(WORK_1, 0),
        );
        expect(Option.isSome(open)).toBe(true);
      }),
      makeP7App(),
    );
  });

  it("conclude CAS + Orphaned reason + idempotent execution binding", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const repos = yield* VerificationRepository;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          repos.insert(verificationOf(VER_1), p7Project, p7RootWorkspace),
        );
        // minimal durable execution row for the FK
        yield* tx.transact(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql.unsafe(
              "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'ExecutionScoped',?,?,?, 't')",
              ["ses_00000000-0000-7000-8000-000000000002", null, EXE_1, 0],
            );
            yield* sql.unsafe(
              "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'verify', ?, 't', null, null, null, null)",
              [
                EXE_1,
                p7Project,
                p7RootWorkspace,
                "ses_00000000-0000-7000-8000-000000000002",
              ],
            );
          }),
        );
        yield* tx.transact(repos.bindExecution(VER_1, EXE_1, "t"));
        yield* tx.transact(repos.bindExecution(VER_1, EXE_1, "t2"));
        const orphaned = concludeVerification(
          verificationOf(VER_1),
          "Unknown",
          "Orphaned",
        );
        expect(orphaned.ok).toBe(true);
        const concluded = yield* tx.transact(
          repos.concludeIfOpen(VER_1, "Unknown", "Orphaned"),
        );
        expect(Option.isSome(concluded)).toBe(true);
        const replay = yield* tx.transact(
          repos.concludeIfOpen(VER_1, "Pass", undefined),
        );
        expect(Option.isNone(replay)).toBe(true);
        const bound = yield* tx.transact(repos.findById(VER_1));
        expect(
          Option.isSome(bound) &&
            (
              bound.value.verificationExecutionIds as readonly string[]
            ).includes(EXE_1),
        ).toBe(true);
      }),
      makeP7App(),
    );
  });

  it("evidence append-only; acceptance double uniqueness", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const evidence = yield* EvidenceRepository;
        const acceptances = yield* AcceptanceRepository;
        const verifications = yield* VerificationRepository;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          verifications.insert(
            verificationOf(VER_1),
            p7Project,
            p7RootWorkspace,
          ),
        );
        const record = {
          evidenceId: EV_1,
          verificationId: VER_1,
          criterionId: "c1",
          kind: "ToolObservation",
          artifactRef: null,
          observedEnvironmentRevision: null,
          recordedByExecutionId: EXE_1,
          recordedAt: "t",
        };
        yield* tx.transact(evidence.append(record));
        const duplicate = yield* tx
          .transact(evidence.append({ ...record, recordedAt: "t2" }))
          .pipe(Effect.flip);
        expect(duplicate._tag).toBe("EvidenceRepositoryFailure");
        expect(
          yield* tx.transact(evidence.listByVerification(VER_1)),
        ).toHaveLength(1);

        yield* tx.transact(acceptances.insert(acceptance, p7Project));
        const sameRevision = yield* tx
          .transact(
            acceptances.insert(
              {
                ...acceptance,
                acceptanceId:
                  "acc_00000000-0000-7000-8000-000000000002" as never,
              },
              p7Project,
            ),
          )
          .pipe(Effect.flip);
        expect(sameRevision._tag).toBe("AcceptanceRepositoryFailure");
        const found = yield* tx.transact(
          acceptances.findByWorkRevision(WORK_1, 0),
        );
        expect(Option.isSome(found)).toBe(true);
      }),
      makeP7App(),
    );
  });
});
