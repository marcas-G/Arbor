import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  P35_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { makeSpawnSpecialistHandler } from "../../apps/single-workspace/src/legacy-directive-handlers.js";
import { CommandGateway } from "../../packages/application/src/index.js";
import { admitSpecialistSettlement } from "../../packages/application/src/specialist-settlement.js";
import {
  ExecutionId,
  type ExecutionSettlement,
  parse,
  settlementFingerprint,
  specialistSettlementEntryKey,
  WorkRevision,
} from "../../packages/domain/dist/index.js";
import {
  Clock,
  FormationProposalStore,
  InboxProjectionStore,
  TransactionPort,
  WorkspaceRepository,
} from "../../packages/ports/src/index.js";
import {
  admitMain,
  countRows,
  EXE_MAIN_C,
  executionContext,
  executionOf,
  idFromText,
  inboxOf,
  MAIN_ADMIT_C,
  makeAcceptanceApp,
  ROOT,
  runAcceptance,
  seedProject,
} from "./support.js";

describe("-acceptance", () => {
  it("Story C: specialist spawn, settlement dedup, parent session zero-write (D3)", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seedProject;
      const admitted = yield* admitMain({
        commandId: MAIN_ADMIT_C,
        executionId: EXE_MAIN_C,
        workspaceId: ROOT,
      });
      expect(admitted.resolution._tag).toBe("Committed");

      const spawnHandler = makeSpawnSpecialistHandler({
        gateway: yield* CommandGateway,
        workspaces: yield* WorkspaceRepository,
        proposals: yield* FormationProposalStore,
        tx: yield* TransactionPort,
        clock: yield* Clock,
      });
      const spawnOutcome = yield* spawnHandler.handle({
        directive: {
          _tag: "SpawnSpecialist",
          spec: {
            mission: "scan the integration slice",
            constraints: [],
            skillIds: [],
          },
        },
        execution: executionOf(EXE_MAIN_C, ROOT),
        context: executionContext(EXE_MAIN_C),
      });
      const specialistId = parse(ExecutionId)(
        spawnOutcome._tag === "Observation"
          ? (idFromText(spawnOutcome.observation.text, "exe_") ?? "")
          : "",
      );
      const boundedExecutions = yield* countRows(
        "executions",
        "WHERE binding_kind = 'execution_bound'",
      );
      const scopedSessions = yield* countRows(
        "sessions",
        "WHERE binding_kind = 'ExecutionScoped'",
      );

      const sessionsBefore = yield* countRows("sessions");
      const inbox = yield* InboxProjectionStore;
      const tx = yield* TransactionPort;
      const settlement: ExecutionSettlement = {
        _tag: "Completed",
        result: {
          _tag: "CompletionClaimed",
          workRevision: parse(WorkRevision)(1),
          claimRef: "claim://specialist/1",
        },
      };
      const firstAdmission = yield* tx.transact(
        admitSpecialistSettlement(
          {
            specialistExecutionId: specialistId,
            parentWorkspaceId: ROOT,
            settlement,
            summary: "specialist finished the slice",
            occurredAt: "t",
          },
          { inbox },
        ),
      );
      const replayAdmission = yield* tx.transact(
        admitSpecialistSettlement(
          {
            specialistExecutionId: specialistId,
            parentWorkspaceId: ROOT,
            settlement,
            summary: "specialist finished the slice (replayed)",
            occurredAt: "t2",
          },
          { inbox },
        ),
      );
      const sessionsAfter = yield* countRows("sessions");
      const parentInbox = yield* inboxOf(ROOT);
      const expectedKey = specialistSettlementEntryKey(
        specialistId,
        settlementFingerprint(settlement),
      );

      const quiescenceOutcome = yield* spawnHandler.handle({
        directive: {
          _tag: "SpawnSpecialist",
          spec: {
            mission: "too late to spawn",
            constraints: [],
            skillIds: [],
          },
        },
        execution: executionOf(EXE_MAIN_C, ROOT, "2026-09-21T00:00:00.000Z"),
        context: executionContext(EXE_MAIN_C),
      });
      const boundedAfterQuiescence = yield* countRows(
        "executions",
        "WHERE binding_kind = 'execution_bound'",
      );

      return {
        spawnOutcome,
        specialistId,
        boundedExecutions,
        scopedSessions,
        firstAdmission,
        replayAdmission,
        sessionsBefore,
        sessionsAfter,
        parentInbox,
        expectedKey,
        quiescenceOutcome,
        boundedAfterQuiescence,
      };
    });
    const result = await runAcceptance(program, makeAcceptanceApp());

    expect(result.spawnOutcome._tag).toBe("Observation");
    if (result.spawnOutcome._tag === "Observation") {
      expect(result.spawnOutcome.observation.text).toContain(
        "specialist admitted",
      );
    }
    expect(result.boundedExecutions).toBe(1);
    expect(result.scopedSessions).toBe(1);

    expect(result.firstAdmission.deduplicated).toBe(false);
    expect(result.firstAdmission.wakeReason).toEqual({ _tag: "InputArrived" });
    expect(result.firstAdmission.entryKey).toBe(result.expectedKey);
    expect(result.replayAdmission.deduplicated).toBe(true);
    expect(result.replayAdmission.entryKey).toBe(result.expectedKey);
    expect(result.parentInbox).toHaveLength(1);
    expect(result.parentInbox[0]?.kind).toBe("SpecialistSettled");
    expect(result.parentInbox[0]?.entryKey).toBe(result.expectedKey);
    expect(result.sessionsAfter).toBe(result.sessionsBefore);

    expect(result.quiescenceOutcome._tag).toBe("Observation");
    if (result.quiescenceOutcome._tag === "Observation") {
      expect(result.quiescenceOutcome.observation.text).toContain("quiescence");
    }
    expect(result.boundedAfterQuiescence).toBe(1);
  });
});
