import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type ConcludeVerificationPayload,
  type ConcludeVerificationResult,
  type CriterionResultInput,
  makeConcludeVerificationHandler,
  makeRecordVerificationEvidenceHandler,
  type RecordVerificationEvidencePayload,
  type RecordVerificationEvidenceResult,
} from "../packages/application/src/commands/conclude-verification.js";
import {
  type CommandOutcome,
  type CommandResult,
  type GatewayEnvelope,
  type VerifiedCommandAuthority,
  validateCommandAuthority,
} from "../packages/application/src/index.js";
import {
  CommandId,
  EvidenceId,
  ExecutionId,
  LeaseGeneration,
  parse,
  startVerification,
  VerificationId,
  type VerificationMission,
  type VerificationVerdict,
  WorkId,
  WorkRevision,
} from "../packages/domain/dist/index.js";
import {
  EvidenceRepository,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
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
const EV = (n: number) =>
  parse(EvidenceId)(`evd_00000000-0000-7000-8000-00000000000${n}`);
const CMD = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);
const EXE_1 = parse(ExecutionId)("exe_00000000-0000-7000-8000-000000000001");
const EXE_2 = parse(ExecutionId)("exe_00000000-0000-7000-8000-000000000002");
const UNKNOWN_VER = parse(VerificationId)(
  "ver_00000000-0000-7000-8000-0000000000ff",
);

const mission: VerificationMission = {
  goal: "g",
  criteria: [
    { criterionId: "c1", requirement: "r1", required: true },
    { criterionId: "c2", requirement: "r2", required: true },
  ],
  riskRequirements: [],
};

const seed = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
});

/** P8-002 repository pattern (p8-ddl.test.ts) — seeding bypasses the
 * P8-003 handler; these tests own the Record/Conclude faces only. */
const seedVerification = (verificationId: VerificationId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    yield* tx.transact(
      verifications.insert(
        startVerification({
          verificationId,
          workId: WORK_1,
          targetWorkRevision: parse(WorkRevision)(0),
          missionSnapshot: mission,
        }),
        p7Project,
        p7RootWorkspace,
      ),
    );
  });

const seedEvidence = (
  verificationId: VerificationId,
  evidenceId: EvidenceId,
  criterionId: string,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const evidence = yield* EvidenceRepository;
    yield* tx.transact(
      evidence.append({
        evidenceId,
        verificationId,
        criterionId,
        kind: "ToolObservation",
        artifactRef: null,
        observedEnvironmentRevision: null,
        recordedByExecutionId: EXE_1,
        recordedAt: "t",
      }),
    );
  });

const makeHandlers = Effect.gen(function* () {
  const verifications = yield* VerificationRepository;
  const evidence = yield* EvidenceRepository;
  const works = yield* WorkRepository;
  return {
    record: makeRecordVerificationEvidenceHandler({
      verifications,
      evidence,
    }),
    conclude: makeConcludeVerificationHandler({
      verifications,
      evidence,
      works,
    }),
  };
});

const verifierContext = {
  _tag: "ExecutionOrigin",
  principal: p7TestPrincipal,
  executionId: EXE_1,
  fencingGeneration: parse(LeaseGeneration)(0),
} as const;

const governanceContext = {
  _tag: "External",
  principal: p7TestPrincipal,
} as const;

const recordEnvelope = (
  commandId: CommandId,
  payload: RecordVerificationEvidencePayload,
): GatewayEnvelope<RecordVerificationEvidencePayload> => ({
  commandType: "RecordVerificationEvidence",
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

const concludeEnvelope = (
  commandId: CommandId,
  payload: ConcludeVerificationPayload,
): GatewayEnvelope<ConcludeVerificationPayload> => ({
  commandType: "ConcludeVerification",
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

const recordPayload = (
  verificationId: VerificationId,
  evidenceId: EvidenceId,
  criterionId = "c1",
): RecordVerificationEvidencePayload => ({
  verificationId,
  evidence: {
    evidenceId,
    criterionId,
    kind: "ToolObservation",
    recordedAt: "t",
  },
});

const criterionResult = (
  criterionId: string,
  verdict: VerificationVerdict,
  evidenceRefs: ReadonlyArray<EvidenceId>,
): CriterionResultInput => ({
  criterionId,
  requirement: criterionId === "c1" ? "r1" : "r2",
  required: true,
  verdict,
  evidenceRefs,
});

const concludePayload = (
  verificationId: VerificationId,
  verdict: VerificationVerdict,
  results: ReadonlyArray<CriterionResultInput>,
  conclusionReason?: "Orphaned",
): ConcludeVerificationPayload =>
  conclusionReason === undefined
    ? {
        verificationId,
        verdict,
        criteriaResults: results,
        summaryRef: "summary:1",
      }
    : {
        verificationId,
        verdict,
        criteriaResults: results,
        summaryRef: "summary:1",
        conclusionReason,
      };

type RecordOutcome = CommandResult<
  CommandOutcome<RecordVerificationEvidenceResult>
>;
type ConcludeOutcome = CommandResult<
  CommandOutcome<ConcludeVerificationResult>
>;

const expectRejected = (
  outcome: RecordOutcome | ConcludeOutcome,
  tag: string,
) => {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.error._tag).toBe(tag);
  }
};

const storedVerification = (verificationId: VerificationId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    const found = yield* tx.transact(verifications.findById(verificationId));
    expect(Option.isSome(found)).toBe(true);
    return Option.isSome(found) ? found.value : undefined;
  });

describe("p8-conclude", () => {
  it("RecordVerificationEvidence lands evidence (recordedByExecutionId from the verifier origin); same-evidenceId replay is a no-op; conflicting content is IdempotencyConflict; no domain event", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1));
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;
        const evidence = yield* EvidenceRepository;

        const outcome: RecordOutcome = yield* tx.transact(
          handlers.record.execute(
            recordEnvelope(CMD("0123456789b1"), recordPayload(VER(1), EV(1))),
            verifierContext,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.result).toEqual({
            verificationId: VER(1),
            evidenceId: EV(1),
            state: "Recorded",
          });
          // Evidence is a runtime record (DID §3.7) — never an event.
          expect(outcome.value.events).toHaveLength(0);
        }
        const rows = yield* tx.transact(evidence.listByVerification(VER(1)));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.evidenceId).toBe(EV(1));
        expect(rows[0]!.criterionId).toBe("c1");
        expect(rows[0]!.kind).toBe("ToolObservation");
        expect(rows[0]!.recordedByExecutionId).toBe(EXE_1);

        // Idempotent replay: same content (recordedAt differs) → no-op.
        const replay: RecordOutcome = yield* tx.transact(
          handlers.record.execute(
            recordEnvelope(CMD("0123456789b2"), {
              verificationId: VER(1),
              evidence: {
                evidenceId: EV(1),
                criterionId: "c1",
                kind: "ToolObservation",
                recordedAt: "t2",
              },
            }),
            verifierContext,
          ),
        );
        expect(replay.ok).toBe(true);
        expect(
          yield* tx.transact(evidence.listByVerification(VER(1))),
        ).toHaveLength(1);

        // Same evidenceId, different content → typed conflict, no update.
        const conflict: RecordOutcome = yield* tx.transact(
          handlers.record.execute(
            recordEnvelope(
              CMD("0123456789b3"),
              recordPayload(VER(1), EV(1), "c2"),
            ),
            verifierContext,
          ),
        );
        expectRejected(conflict, "IdempotencyConflict");
      }),
      makeP7App(),
    );
  });

  it("RecordVerificationEvidence rejects VerificationNotFound, terminal (non-Open) verification, and non-execution origins", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;
        const verifications = yield* VerificationRepository;

        const unknown: RecordOutcome = yield* tx.transact(
          handlers.record.execute(
            recordEnvelope(
              CMD("0123456789c1"),
              recordPayload(UNKNOWN_VER, EV(1)),
            ),
            verifierContext,
          ),
        );
        expectRejected(unknown, "VerificationNotFound");
        if (!unknown.ok) {
          expect(unknown.error).toEqual({
            _tag: "VerificationNotFound",
            verificationId: UNKNOWN_VER,
          });
        }

        // One-Open (v1.11 G2): only one Open row per (workId, revision) —
        // conclude VER(2) by repository before keeping VER(1) Open.
        yield* seedVerification(VER(2));
        const concluded = yield* tx.transact(
          verifications.concludeIfOpen(VER(2), "Pass", undefined),
        );
        expect(Option.isSome(concluded)).toBe(true);
        yield* seedVerification(VER(1));
        const terminal: RecordOutcome = yield* tx.transact(
          handlers.record.execute(
            recordEnvelope(CMD("0123456789c2"), recordPayload(VER(2), EV(2))),
            verifierContext,
          ),
        );
        expectRejected(terminal, "TerminalLifecycleMutation");
        if (!terminal.ok) {
          expect(terminal.error).toEqual({
            _tag: "TerminalLifecycleMutation",
            entity: "Verification",
            lifecycle: "Concluded",
          });
        }

        // Verifier-only face: an External submission has no bound Verifier
        // Execution origin to record under.
        const external: RecordOutcome = yield* tx.transact(
          handlers.record.execute(
            recordEnvelope(CMD("0123456789c3"), recordPayload(VER(1), EV(3))),
            governanceContext,
          ),
        );
        expectRejected(external, "AuthorityDenied");
      }),
      makeP7App(),
    );
  });

  it('ConcludeVerification Pass: criteria complete + evidence-bound → Concluded, VerificationConcluded fields (conclusionReason ""), channel1Release, no wake on Pass', async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1));
        yield* seedEvidence(VER(1), EV(1), "c1");
        yield* seedEvidence(VER(1), EV(2), "c2");
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;

        const outcome: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789d1"),
              concludePayload(VER(1), "Pass", [
                criterionResult("c1", "Pass", [EV(1)]),
                criterionResult("c2", "Pass", [EV(2)]),
              ]),
            ),
            verifierContext,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.result).toEqual({
            verificationId: VER(1),
            state: "Concluded",
            verdict: "Pass",
            conclusionReason: undefined,
            wakeSignals: [],
            channel1Release: { workId: WORK_1, targetWorkRevision: 0 },
          });
          expect(outcome.value.events).toHaveLength(1);
          const event = outcome.value.events[0]!;
          expect(event.eventType).toBe("VerificationConcluded");
          expect(event.eventVersion).toBe(1);
          expect(event.aggregateRef).toBe(VER(1));
          expect(event.projectId).toBe(p7Project);
          expect(event.causedByCommandId).toBe(CMD("0123456789d1"));
          expect(event.payload).toEqual({
            verificationId: VER(1),
            workId: WORK_1,
            targetWorkRevision: 0,
            verdict: "Pass",
            conclusionReason: "",
            evidenceRefs: [EV(1), EV(2)],
          });
        }
        const stored = yield* storedVerification(VER(1));
        expect(stored?.state).toEqual({ status: "Concluded", verdict: "Pass" });
      }),
      makeP7App(),
    );
  });

  it("aggregation: required Fail mixed → overall Fail must match (with VerificationReturned wake); a mismatching overall verdict is InvalidVerificationMission and the row stays Open", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1));
        yield* seedEvidence(VER(1), EV(1), "c1");
        yield* seedEvidence(VER(1), EV(2), "c2");
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;

        const fail: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789e1"),
              concludePayload(VER(1), "Fail", [
                criterionResult("c1", "Fail", [EV(1)]),
                criterionResult("c2", "Pass", [EV(2)]),
              ]),
            ),
            verifierContext,
          ),
        );
        expect(fail.ok).toBe(true);
        if (fail.ok) {
          expect(fail.value.result.verdict).toBe("Fail");
          expect(fail.value.result.channel1Release).toEqual({
            workId: WORK_1,
            targetWorkRevision: 0,
          });
          expect(fail.value.result.wakeSignals).toEqual([
            {
              workspaceId: p7RootWorkspace,
              reason: { _tag: "VerificationReturned" },
              detail: {
                verificationId: VER(1),
                workId: WORK_1,
                workRevision: 0,
                verdict: "Fail",
              },
            },
          ]);
        }

        // Evidence ids are a global PK — the second verification uses its
        // own evidence rows.
        yield* seedVerification(VER(2));
        yield* seedEvidence(VER(2), EV(3), "c1");
        yield* seedEvidence(VER(2), EV(4), "c2");
        const mismatch: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789e2"),
              concludePayload(VER(2), "Pass", [
                criterionResult("c1", "Fail", [EV(3)]),
                criterionResult("c2", "Pass", [EV(4)]),
              ]),
            ),
            verifierContext,
          ),
        );
        expectRejected(mismatch, "InvalidVerificationMission");
        if (!mismatch.ok) {
          expect(mismatch.error).toEqual({
            _tag: "InvalidVerificationMission",
            reason: expect.stringContaining("verdict mismatch"),
          });
        }
        const stored = yield* storedVerification(VER(2));
        expect(stored?.state).toEqual({ status: "Open" });
      }),
      makeP7App(),
    );
  });

  it("criteria completeness and evidence binding are enforced (invariant 26)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1));
        yield* seedEvidence(VER(1), EV(1), "c1");
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;

        const missing: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789f1"),
              concludePayload(VER(1), "Pass", [
                criterionResult("c1", "Pass", [EV(1)]),
              ]),
            ),
            verifierContext,
          ),
        );
        expectRejected(missing, "InvalidVerificationMission");
        if (!missing.ok) {
          expect(missing.error).toEqual({
            _tag: "InvalidVerificationMission",
            reason: expect.stringContaining("missing criterion c2"),
          });
        }

        const unbound: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789f2"),
              concludePayload(VER(1), "Unknown", [
                criterionResult("c1", "Unknown", [EV(1)]),
                criterionResult("c2", "Pass", [EV(2)]),
              ]),
            ),
            verifierContext,
          ),
        );
        expectRejected(unbound, "InvalidVerificationMission");
        if (!unbound.ok) {
          expect(unbound.error).toEqual({
            _tag: "InvalidVerificationMission",
            reason: expect.stringContaining("not appended evidence"),
          });
        }

        const emptyRefs: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789f3"),
              concludePayload(VER(1), "Pass", [
                criterionResult("c1", "Pass", [EV(1)]),
                criterionResult("c2", "Pass", []),
              ]),
            ),
            verifierContext,
          ),
        );
        expectRejected(emptyRefs, "InvalidVerificationMission");
        if (!emptyRefs.ok) {
          expect(emptyRefs.error).toEqual({
            _tag: "InvalidVerificationMission",
            reason: expect.stringContaining("binds no evidence"),
          });
        }

        const stored = yield* storedVerification(VER(1));
        expect(stored?.state).toEqual({ status: "Open" });
      }),
      makeP7App(),
    );
  });

  it("Unknown verdict wakes VerificationReturned (channel 2)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1));
        yield* seedEvidence(VER(1), EV(1), "c1");
        yield* seedEvidence(VER(1), EV(2), "c2");
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;

        const outcome: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789a1"),
              concludePayload(VER(1), "Unknown", [
                criterionResult("c1", "Unknown", [EV(1)]),
                criterionResult("c2", "Pass", [EV(2)]),
              ]),
            ),
            verifierContext,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.result.wakeSignals).toHaveLength(1);
          const signal = outcome.value.result.wakeSignals[0]!;
          expect(signal.reason).toEqual({ _tag: "VerificationReturned" });
          expect(signal.detail).toEqual({
            verificationId: VER(1),
            workId: WORK_1,
            workRevision: 0,
            verdict: "Unknown",
          });
        }
      }),
      makeP7App(),
    );
  });

  it("Orphaned path (G5): governance submission + Unknown concludes with conclusionReason (event carries it, no evidence preconditions); Pass+Orphaned is rejected and the row stays Open", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;

        // Orphan by construction: no evidence ever appended.
        yield* seedVerification(VER(1));
        const orphaned: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789a1"),
              concludePayload(VER(1), "Unknown", [], "Orphaned"),
            ),
            governanceContext,
          ),
        );
        expect(orphaned.ok).toBe(true);
        if (orphaned.ok) {
          expect(orphaned.value.result.conclusionReason).toBe("Orphaned");
          expect(orphaned.value.result.channel1Release).toEqual({
            workId: WORK_1,
            targetWorkRevision: 0,
          });
          const event = orphaned.value.events[0]!;
          expect(event.payload).toEqual({
            verificationId: VER(1),
            workId: WORK_1,
            targetWorkRevision: 0,
            verdict: "Unknown",
            conclusionReason: "Orphaned",
            evidenceRefs: [],
          });
        }
        const stored = yield* storedVerification(VER(1));
        expect(stored?.state).toEqual({
          status: "Concluded",
          verdict: "Unknown",
          conclusionReason: "Orphaned",
        });

        // One-Open: VER(1) is now Concluded, so VER(2) seeds cleanly.
        yield* seedVerification(VER(2));
        const passOrphaned: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789a2"),
              concludePayload(VER(2), "Pass", [], "Orphaned"),
            ),
            governanceContext,
          ),
        );
        expectRejected(passOrphaned, "AuthorityDenied");
        const stillOpen = yield* storedVerification(VER(2));
        expect(stillOpen?.state).toEqual({ status: "Open" });
      }),
      makeP7App(),
    );
  });

  it("verdict immutability: after Concluded, both Conclude and Record hit TerminalLifecycleMutation (CAS backstop)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(1));
        yield* seedEvidence(VER(1), EV(1), "c1");
        yield* seedEvidence(VER(1), EV(2), "c2");
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;

        const first: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789a1"),
              concludePayload(VER(1), "Pass", [
                criterionResult("c1", "Pass", [EV(1)]),
                criterionResult("c2", "Pass", [EV(2)]),
              ]),
            ),
            verifierContext,
          ),
        );
        expect(first.ok).toBe(true);

        const reconclude: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789a2"),
              concludePayload(VER(1), "Fail", [
                criterionResult("c1", "Fail", [EV(1)]),
                criterionResult("c2", "Fail", [EV(2)]),
              ]),
            ),
            verifierContext,
          ),
        );
        expectRejected(reconclude, "TerminalLifecycleMutation");
        if (!reconclude.ok) {
          expect(reconclude.error).toEqual({
            _tag: "TerminalLifecycleMutation",
            entity: "Verification",
            lifecycle: "Concluded",
          });
        }

        const record: RecordOutcome = yield* tx.transact(
          handlers.record.execute(
            recordEnvelope(CMD("0123456789a3"), recordPayload(VER(1), EV(3))),
            verifierContext,
          ),
        );
        expectRejected(record, "TerminalLifecycleMutation");

        // PASS never re-judged FAIL: the stored verdict stays Pass.
        const stored = yield* storedVerification(VER(1));
        expect(stored?.state).toEqual({ status: "Concluded", verdict: "Pass" });
      }),
      makeP7App(),
    );
  });

  it("ConcludeVerification rejects VerificationNotFound", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;
        const outcome: ConcludeOutcome = yield* tx.transact(
          handlers.conclude.execute(
            concludeEnvelope(
              CMD("0123456789a1"),
              concludePayload(UNKNOWN_VER, "Pass", []),
            ),
            verifierContext,
          ),
        );
        expectRejected(outcome, "VerificationNotFound");
        if (!outcome.ok) {
          expect(outcome.error).toEqual({
            _tag: "VerificationNotFound",
            verificationId: UNKNOWN_VER,
          });
        }
      }),
      makeP7App(),
    );
  });

  it("ConcludeVerification authority rule: verifier face is exact-bound and never Orphaned; OrphanConclusionAuthority pairs only with Orphaned; the gateway admits both faces", () => {
    const handler = makeConcludeVerificationHandler({
      verifications: undefined as never,
      evidence: undefined as never,
      works: undefined as never,
    });
    const orphanedPayload = concludePayload(VER(1), "Unknown", [], "Orphaned");
    const normalPayload = concludePayload(VER(1), "Pass", []);
    const verifier: VerifiedCommandAuthority = {
      _tag: "VerifierExecutionAuthority",
      principal: p7TestPrincipal,
      commandId: CMD("0123456789a1"),
      semanticRequestFingerprint: "fp" as never,
      projectId: p7Project,
      verificationId: VER(1),
      executionId: EXE_1,
    };
    const governance: VerifiedCommandAuthority = {
      _tag: "OrphanConclusionAuthority",
      principal: p7TestPrincipal,
      commandId: CMD("0123456789a2"),
      semanticRequestFingerprint: "fp" as never,
      projectId: p7Project,
      targetWorkspaceId: p7RootWorkspace,
      verificationId: VER(1),
    };

    expect(handler.commandType).toBe("ConcludeVerification");
    expect(handler.schemaVersion).toBe("1");
    expect(handler.authority.tag).toBe("VerifierExecutionAuthority");
    expect(handler.stopAdmission).toEqual({ _tag: "NormalExecutionMutation" });

    expect(handler.authority.targetMatches(verifier, normalPayload)).toBe(true);
    // Verifier face never submits the Orphaned governance conclusion.
    expect(handler.authority.targetMatches(verifier, orphanedPayload)).toBe(
      false,
    );
    expect(handler.authority.targetMatches(governance, orphanedPayload)).toBe(
      true,
    );
    expect(handler.authority.targetMatches(governance, normalPayload)).toBe(
      false,
    );
    // Exact-bound verificationId.
    expect(
      handler.authority.targetMatches(
        { ...verifier, verificationId: VER(2) },
        normalPayload,
      ),
    ).toBe(false);
    expect(
      handler.authority.targetMatches(
        { ...governance, verificationId: VER(2) },
        orphanedPayload,
      ),
    ).toBe(false);
    // Foreign tags never match.
    expect(
      handler.authority.targetMatches(
        { ...verifier, _tag: "SteerWorkAuthority" as never },
        normalPayload,
      ),
    ).toBe(false);

    // Gateway admission (alsoTags): both faces pass the kind gate with
    // matching facts; a foreign fact is rejected with a kind mismatch.
    const verifierFacts = {
      principal: p7TestPrincipal,
      commandId: verifier.commandId,
      projectId: p7Project,
      semanticRequestFingerprint: "fp" as never,
      submissionOrigin: "ExecutionOrigin",
      payload: normalPayload,
    };
    const governanceFacts = {
      principal: p7TestPrincipal,
      commandId: governance.commandId,
      projectId: p7Project,
      semanticRequestFingerprint: "fp" as never,
      submissionOrigin: "External",
      payload: orphanedPayload,
    };
    const validate = validateCommandAuthority;
    expect(
      Option.isNone(validate(verifier, handler.authority, verifierFacts)),
    ).toBe(true);
    expect(
      Option.isNone(validate(governance, handler.authority, governanceFacts)),
    ).toBe(true);
    const foreign = Option.isSome(
      validate(governance, handler.authority, verifierFacts),
    )
      ? "rejected"
      : "admitted";
    expect(foreign).toBe("rejected");
  });

  it("RecordVerificationEvidence authority rule: exact-bound (tag + verificationId) with the optional execution-membership seam", () => {
    const checked: Array<[string, string]> = [];
    const handler = makeRecordVerificationEvidenceHandler({
      verifications: undefined as never,
      evidence: undefined as never,
      verifyVerifierExecution: (verificationId, executionId) => {
        checked.push([verificationId, executionId]);
        return executionId === EXE_1;
      },
    });
    const payload = recordPayload(VER(1), EV(1));
    const verifier: VerifiedCommandAuthority = {
      _tag: "VerifierExecutionAuthority",
      principal: p7TestPrincipal,
      commandId: CMD("0123456789a1"),
      semanticRequestFingerprint: "fp" as never,
      projectId: p7Project,
      verificationId: VER(1),
      executionId: EXE_1,
    };

    expect(handler.commandType).toBe("RecordVerificationEvidence");
    expect(handler.schemaVersion).toBe("1");
    expect(handler.authority.tag).toBe("VerifierExecutionAuthority");
    expect(handler.stopAdmission).toEqual({ _tag: "NormalExecutionMutation" });

    expect(handler.authority.targetMatches(verifier, payload)).toBe(true);
    expect(
      handler.authority.targetMatches(
        { ...verifier, verificationId: VER(2) },
        payload,
      ),
    ).toBe(false);
    // Not one of this verification's bound Verifier Executions.
    expect(
      handler.authority.targetMatches(
        { ...verifier, executionId: EXE_2 },
        payload,
      ),
    ).toBe(false);
    expect(
      handler.authority.targetMatches(
        { ...verifier, _tag: "SteerWorkAuthority" as never },
        payload,
      ),
    ).toBe(false);
    expect(checked).toEqual([
      [VER(1), EXE_1],
      [VER(2), EXE_1],
      [VER(1), EXE_2],
    ]);
  });
});
