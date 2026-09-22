import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type AcceptWorkOutcomePayload,
  type CompleteWorkPayload,
  makeAcceptWorkOutcomeHandler,
  makeCompleteWorkHandler,
} from "../packages/application/src/commands/accept-complete.js";
import type {
  CommandOutcome,
  CommandResult,
  GatewayEnvelope,
} from "../packages/application/src/index.js";
import {
  AcceptanceId,
  CommandId,
  parse,
  startVerification,
  VerificationId,
  type VerificationMission,
  type VerificationVerdict,
  WorkId,
  WorkRevision,
} from "../packages/domain/dist/index.js";
import {
  AcceptanceRepository,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "./support/p7-app.js";

const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const ASSIGN_CMD = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");

const VER = (n: number) =>
  parse(VerificationId)(`ver_00000000-0000-7000-8000-00000000000${n}`);
const ACC = (n: number) =>
  parse(AcceptanceId)(`acc_00000000-0000-7000-8000-00000000000${n}`);
const CMD = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);
const WREV = (n: number) => parse(WorkRevision)(n);

const mission: VerificationMission = {
  goal: "g",
  criteria: [{ criterionId: "c1", requirement: "r1", required: true }],
  riskRequirements: [],
};

const seed = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
});

/** Seeds one verification for WORK_1 at the given revision; `undefined`
 * verdict leaves it Open (P8-002 repository pattern, p8-ddl.test.ts). */
const seedVerification = (
  verificationId: VerificationId,
  verdict: VerificationVerdict | undefined,
  targetWorkRevision = 0,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    yield* tx.transact(
      verifications.insert(
        startVerification({
          verificationId,
          workId: WORK_1,
          targetWorkRevision: WREV(targetWorkRevision),
          missionSnapshot: mission,
        }),
        p7Project,
        p7RootWorkspace,
      ),
    );
    if (verdict !== undefined) {
      const concluded = yield* tx.transact(
        verifications.concludeIfOpen(verificationId, verdict, undefined),
      );
      expect(Option.isSome(concluded)).toBe(true);
    }
  });

const makeHandlers = Effect.gen(function* () {
  const works = yield* WorkRepository;
  const workspaces = yield* WorkspaceRepository;
  const verifications = yield* VerificationRepository;
  const acceptances = yield* AcceptanceRepository;
  return {
    accept: makeAcceptWorkOutcomeHandler({ works, verifications, acceptances }),
    complete: makeCompleteWorkHandler({
      works,
      workspaces,
      verifications,
      acceptances,
    }),
  };
});

const context = { _tag: "External", principal: p7TestPrincipal } as const;

const acceptEnvelope = (
  commandId: CommandId,
  payload: AcceptWorkOutcomePayload,
): GatewayEnvelope<AcceptWorkOutcomePayload> => ({
  commandType: "AcceptWorkOutcome",
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

const completeEnvelope = (
  commandId: CommandId,
  payload: CompleteWorkPayload,
): GatewayEnvelope<CompleteWorkPayload> => ({
  commandType: "CompleteWork",
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

type AcceptOutcome = CommandResult<CommandOutcome<unknown>>;
type CompleteOutcome = CommandResult<CommandOutcome<unknown>>;

const expectRejected = (
  outcome: AcceptOutcome | CompleteOutcome,
  tag: string,
) => {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.error._tag).toBe(tag);
  }
};

const storedWorkRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{
    lifecycle: string;
    revision: number;
  }>("SELECT lifecycle, revision FROM works WHERE work_id = ?", [WORK_1]);
  return rows[0]!;
});

const storedCurrentWorkId = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ current_work_id: string | null }>(
    "SELECT current_work_id FROM workspaces WHERE workspace_id = ?",
    [p7RootWorkspace],
  );
  return rows[0]!.current_work_id;
});

const setCurrentWorkBySql = (workId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
      [workId, p7RootWorkspace],
    );
  });

/** Bumps the Work revision via the repository CAS (fields unchanged). */
const refineWorkBySql = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const works = yield* WorkRepository;
  yield* tx.transact(
    Effect.gen(function* () {
      const found = yield* works.findById(WORK_1);
      if (Option.isSome(found)) {
        yield* works.refineIfRevision(
          WORK_1,
          found.value.revision,
          {
            objective: found.value.objective,
            completionExpectation: found.value.completionExpectation,
            verificationMission: found.value.verificationMission,
          },
          WREV(Number(found.value.revision) + 1),
        );
      }
    }),
  );
});

describe("p8-acceptance-commands", () => {
  it("AcceptWorkOutcome commits the acceptance, emits WorkOutcomeAccepted, and the record is queryable", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1), "Pass");
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const outcome = yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789b1"), {
              acceptanceId: ACC(1),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(1),
            }),
            context,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.events).toHaveLength(1);
          const event = outcome.value.events[0]!;
          expect(event.eventType).toBe("WorkOutcomeAccepted");
          expect(event.eventVersion).toBe(1);
          expect(event.aggregateRef).toBe(WORK_1);
          expect(event.causedByCommandId).toBe(CMD("0123456789b1"));
          expect(event.payload).toEqual({
            acceptanceId: ACC(1),
            workId: WORK_1,
            targetWorkRevision: WREV(0),
            verificationId: VER(1),
            actor: p7TestActor,
          });
        }
        const acceptances = yield* AcceptanceRepository;
        const found = yield* tx.transact(
          acceptances.findByWorkRevision(WORK_1, 0),
        );
        expect(found._tag).toBe("Some");
        if (Option.isSome(found)) {
          expect(found.value.acceptanceId).toBe(ACC(1));
          expect(found.value.verificationId).toBe(VER(1));
        }
      }),
      makeP7App(),
    );
  });

  it("AcceptWorkOutcome rejects VerificationAcceptanceMismatch on Fail verdict, stale revision, and Open verification", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1), "Fail");
        yield* seedVerification(VER(2), "Pass");
        yield* seedVerification(VER(3), undefined);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const failVerdict = yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789c1"), {
              acceptanceId: ACC(1),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(1),
            }),
            context,
          ),
        );
        expectRejected(failVerdict, "VerificationAcceptanceMismatch");
        const staleRevision = yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789c2"), {
              acceptanceId: ACC(2),
              workId: WORK_1,
              targetWorkRevision: WREV(1),
              verificationId: VER(2),
            }),
            context,
          ),
        );
        expectRejected(staleRevision, "VerificationAcceptanceMismatch");
        const openVerification = yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789c3"), {
              acceptanceId: ACC(3),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(3),
            }),
            context,
          ),
        );
        expectRejected(openVerification, "VerificationAcceptanceMismatch");
        const acceptances = yield* AcceptanceRepository;
        expect(
          (yield* tx.transact(acceptances.findByWorkRevision(WORK_1, 0)))._tag,
        ).toBe("None");
      }),
      makeP7App(),
    );
  });

  it("AcceptWorkOutcome rejects VerificationNotFound and WorkNotFound", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const unknownVerification = yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789c4"), {
              acceptanceId: ACC(1),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(9),
            }),
            context,
          ),
        );
        expectRejected(unknownVerification, "VerificationNotFound");
        const unknownWork = yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789c5"), {
              acceptanceId: ACC(1),
              workId: parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000ff"),
              targetWorkRevision: WREV(0),
              verificationId: VER(9),
            }),
            context,
          ),
        );
        expectRejected(unknownWork, "WorkNotFound");
      }),
      makeP7App(),
    );
  });

  it("same-acceptanceId and same-revision replays both reject AcceptanceAlreadyExists (double uniqueness)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1), "Pass");
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const first = yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789d1"), {
              acceptanceId: ACC(1),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(1),
            }),
            context,
          ),
        );
        expect(first.ok).toBe(true);
        // same acceptanceId replay (below the gateway receipt dedup)
        const sameId = yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789d2"), {
              acceptanceId: ACC(1),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(1),
            }),
            context,
          ),
        );
        expectRejected(sameId, "AcceptanceAlreadyExists");
        // same (workId, revision), different acceptanceId
        const otherId = yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789d3"), {
              acceptanceId: ACC(2),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(1),
            }),
            context,
          ),
        );
        expectRejected(otherId, "AcceptanceAlreadyExists");
        const acceptances = yield* AcceptanceRepository;
        const found = yield* tx.transact(
          acceptances.findByWorkRevision(WORK_1, 0),
        );
        expect(found._tag).toBe("Some");
        if (Option.isSome(found)) {
          expect(found.value.acceptanceId).toBe(ACC(1));
        }
      }),
      makeP7App(),
    );
  });

  it("CompleteWork completes the Work, emits WorkCompleted, and atomically clears currentWorkId", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1), "Pass");
        yield* setCurrentWorkBySql(WORK_1);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const accepted = yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789e1"), {
              acceptanceId: ACC(1),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(1),
            }),
            context,
          ),
        );
        expect(accepted.ok).toBe(true);
        expect(yield* storedCurrentWorkId).toBe(WORK_1);
        const outcome = yield* tx.transact(
          handler.complete.execute(
            completeEnvelope(CMD("0123456789e2"), {
              workId: WORK_1,
              expectedWorkRevision: WREV(0),
            }),
            context,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.events).toHaveLength(1);
          const event = outcome.value.events[0]!;
          expect(event.eventType).toBe("WorkCompleted");
          expect(event.eventVersion).toBe(1);
          expect(event.aggregateRef).toBe(WORK_1);
          expect(event.causedByCommandId).toBe(CMD("0123456789e2"));
        }
        const workRow = yield* storedWorkRow;
        expect(workRow.lifecycle).toBe("Completed");
        expect(workRow.revision).toBe(0);
        expect(yield* storedCurrentWorkId).toBe(null);
      }),
      makeP7App(),
    );
  });

  it("CompleteWork keeps currentWorkId untouched when it points at another Work", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const otherWork = parse(WorkId)(
          "wrk_00000000-0000-7000-8000-000000000002",
        );
        const otherReceipt = yield* p7SeedWork(otherWork, CMD("0123456789e5"));
        expect(otherReceipt.resolution._tag).toBe("Committed");
        yield* seedVerification(VER(1), "Pass");
        yield* setCurrentWorkBySql(otherWork);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789e3"), {
              acceptanceId: ACC(1),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(1),
            }),
            context,
          ),
        );
        const outcome = yield* tx.transact(
          handler.complete.execute(
            completeEnvelope(CMD("0123456789e4"), {
              workId: WORK_1,
              expectedWorkRevision: WREV(0),
            }),
            context,
          ),
        );
        expect(outcome.ok).toBe(true);
        expect(yield* storedCurrentWorkId).toBe(otherWork);
      }),
      makeP7App(),
    );
  });

  it("CompleteWork rejects VerificationAcceptanceMismatch without an acceptance", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1), "Pass");
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const noAcceptance = yield* tx.transact(
          handler.complete.execute(
            completeEnvelope(CMD("0123456789f1"), {
              workId: WORK_1,
              expectedWorkRevision: WREV(0),
            }),
            context,
          ),
        );
        expectRejected(noAcceptance, "VerificationAcceptanceMismatch");
        const workRow = yield* storedWorkRow;
        expect(workRow.lifecycle).toBe("Open");
      }),
      makeP7App(),
    );
  });

  it("CompleteWork rejects VerificationAcceptanceMismatch for an acceptance bound to a Fail verification", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(2), "Fail");
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        // acceptance repository-bound to a Fail verification: the
        // seven-fold re-validation must catch it (G3 no submitter exempt)
        const acceptances = yield* AcceptanceRepository;
        yield* tx.transact(
          acceptances.insert(
            {
              acceptanceId: ACC(9),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(2),
              actor: p7TestActor,
              acceptedAt: "t",
            },
            p7Project,
          ),
        );
        const failBound = yield* tx.transact(
          handler.complete.execute(
            completeEnvelope(CMD("0123456789f2"), {
              workId: WORK_1,
              expectedWorkRevision: WREV(0),
            }),
            context,
          ),
        );
        expectRejected(failBound, "VerificationAcceptanceMismatch");
        const workRow = yield* storedWorkRow;
        expect(workRow.lifecycle).toBe("Open");
      }),
      makeP7App(),
    );
  });

  it("CompleteWork rejects VerificationAcceptanceMismatch when the Work revision moved forward past the acceptance", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1), "Pass");
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const accepted = yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789f3"), {
              acceptanceId: ACC(1),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(1),
            }),
            context,
          ),
        );
        expect(accepted.ok).toBe(true);
        yield* refineWorkBySql;
        const movedForward = yield* tx.transact(
          handler.complete.execute(
            completeEnvelope(CMD("0123456789f4"), {
              workId: WORK_1,
              expectedWorkRevision: WREV(0),
            }),
            context,
          ),
        );
        expectRejected(movedForward, "VerificationAcceptanceMismatch");
        // and no acceptance exists at the new revision either
        const ahead = yield* tx.transact(
          handler.complete.execute(
            completeEnvelope(CMD("0123456789f5"), {
              workId: WORK_1,
              expectedWorkRevision: WREV(1),
            }),
            context,
          ),
        );
        expectRejected(ahead, "VerificationAcceptanceMismatch");
        const workRow = yield* storedWorkRow;
        expect(workRow.lifecycle).toBe("Open");
        expect(workRow.revision).toBe(1);
      }),
      makeP7App(),
    );
  });

  it("replaying CompleteWork after Completed rejects TerminalLifecycleMutation", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1), "Pass");
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        yield* tx.transact(
          handler.accept.execute(
            acceptEnvelope(CMD("0123456789a1"), {
              acceptanceId: ACC(1),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              verificationId: VER(1),
            }),
            context,
          ),
        );
        const first = yield* tx.transact(
          handler.complete.execute(
            completeEnvelope(CMD("0123456789a2"), {
              workId: WORK_1,
              expectedWorkRevision: WREV(0),
            }),
            context,
          ),
        );
        expect(first.ok).toBe(true);
        const replay = yield* tx.transact(
          handler.complete.execute(
            completeEnvelope(CMD("0123456789a3"), {
              workId: WORK_1,
              expectedWorkRevision: WREV(0),
            }),
            context,
          ),
        );
        expectRejected(replay, "TerminalLifecycleMutation");
        if (!replay.ok) {
          expect(replay.error).toEqual({
            _tag: "TerminalLifecycleMutation",
            entity: "Work",
            lifecycle: "Completed",
          });
        }
        const workRow = yield* storedWorkRow;
        expect(workRow.lifecycle).toBe("Completed");
      }),
      makeP7App(),
    );
  });
});
