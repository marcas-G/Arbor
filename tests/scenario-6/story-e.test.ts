import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  P35_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import type { SteerWorkPayload } from "../../packages/application/src/commands/steer-work.js";
import { submitCriticalSteer } from "../../packages/application/src/critical-steer.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
} from "../../packages/application/src/index.js";
import {
  parse,
  Revision,
  WorkRevision,
} from "../../packages/domain/dist/index.js";
import { TransactionPort } from "../../packages/ports/src/index.js";
import {
  ACTOR,
  ADMIT_E,
  ASSIGN_E,
  admitMain,
  CHILD_B_E,
  CHILD_B_E_SESSION,
  CHILD_E,
  CHILD_E_SESSION,
  CRITICAL_STEER_E,
  CRITICAL_STOP_E,
  countRows,
  EXE_MAIN_E,
  inboxOf,
  makeAcceptanceApp,
  NORMAL_STEER_E,
  PRINCIPAL,
  PROJECT,
  ROOT,
  runAcceptance,
  SIBLING_STEER_E,
  STALE_STEER_E,
  STALE_STOP_E,
  scalar,
  seedLineage,
  seedProject,
  WORK_E,
} from "./support.js";
import {
  criticalSteerSubmission,
  steerHandlers,
  submitSteer,
} from "./support-submit.js";

describe("-acceptance", () => {
  it("Story E: Normal steer never interrupts; Critical steer stops atomically", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seedProject;
      yield* seedLineage([
        {
          workspaceId: CHILD_E,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_E_SESSION,
        },
        {
          workspaceId: CHILD_B_E,
          parentWorkspaceId: ROOT,
          sessionId: CHILD_B_E_SESSION,
        },
      ]);

      const gw = yield* CommandGateway;
      const assignPayload = {
        workId: WORK_E,
        workspaceId: CHILD_E,
        expectedWorkspaceRevision: parse(Revision)(0),
        objective: "ship the acceptance slice",
        why: "P6-014",
        constraints: [],
        completionExpectation: "green",
        verificationMission: {
          goal: "g",
          criteria: [],
          riskRequirements: [],
        },
        provenance: { predecessorWorkId: null, reason: "initial" },
        revision: parse(WorkRevision)(0),
      };
      const assigned = yield* gw.execute(
        {
          commandType: "AssignWork",
          commandId: ASSIGN_E,
          projectId: PROJECT,
          actor: ACTOR,
          issuedAt: "t",
          payload: assignPayload,
        },
        { _tag: "External", principal: PRINCIPAL },
        {
          _tag: "AssignWorkAuthority",
          principal: PRINCIPAL,
          commandId: ASSIGN_E,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "AssignWork",
            projectId: PROJECT,
            actor: ACTOR,
            schemaVersion: "1",
            payload: assignPayload,
          }),
          projectId: PROJECT,
          targetWorkspaceId: CHILD_E,
        },
      );
      expect(assigned.resolution._tag).toBe("Committed");

      const admitted = yield* admitMain({
        commandId: ADMIT_E,
        executionId: EXE_MAIN_E,
        workspaceId: CHILD_E,
      });
      expect(admitted.resolution._tag).toBe("Committed");

      const steerPayload = (
        overrides: Partial<SteerWorkPayload> = {},
      ): SteerWorkPayload => ({
        workId: WORK_E,
        workspaceId: CHILD_E,
        steer: {
          severity: "Normal",
          guidance: "cnt-acceptance-guidance-001",
        },
        expectedWorkRevision: parse(WorkRevision)(0),
        provenance: { source: "HumanInput" as const },
        ...overrides,
      });

      const tx = yield* TransactionPort;
      const normal = yield* submitSteer(gw, {
        commandId: NORMAL_STEER_E,
        payload: steerPayload(),
      });
      const workAfterNormal = yield* scalar<string>(
        "SELECT lifecycle AS value FROM works WHERE work_id = ?",
        [WORK_E],
      );
      const workRevisionAfterNormal = yield* scalar<number>(
        "SELECT revision AS value FROM works WHERE work_id = ?",
        [WORK_E],
      );
      const steeredEventsAfterNormal = yield* countRows(
        "domain_events",
        "WHERE event_type = 'WorkSteered'",
      );
      const stopEventsAfterNormal = yield* countRows(
        "domain_events",
        "WHERE event_type = 'ExecutionStopRequested'",
      );
      const executionAfterNormal = yield* scalar<string | null>(
        "SELECT stop_requested_at AS value FROM executions WHERE execution_id = ?",
        [EXE_MAIN_E],
      );
      const inboxAfterNormal = yield* inboxOf(CHILD_E);

      const sibling = yield* submitSteer(gw, {
        commandId: SIBLING_STEER_E,
        payload: steerPayload(),
        authorityTargetWorkspaceId: CHILD_B_E,
      });

      const handlers = yield* steerHandlers;
      const staleOutcome = yield* tx
        .transact(
          submitCriticalSteer(
            criticalSteerSubmission(handlers, {
              steerCommandId: STALE_STEER_E,
              stopCommandId: STALE_STOP_E,
              payload: steerPayload({
                steer: {
                  severity: "Critical",
                  guidance: "cnt-acceptance-guidance-stale",
                },
                expectedWorkRevision: parse(WorkRevision)(9),
              }),
              executionId: EXE_MAIN_E,
            }),
          ),
        )
        .pipe(
          Effect.catchTag("CriticalSteerRejected", (failure) =>
            Effect.succeed(failure),
          ),
        );
      const workRevisionAfterStale = yield* scalar<number>(
        "SELECT revision AS value FROM works WHERE work_id = ?",
        [WORK_E],
      );
      const executionAfterStale = yield* scalar<string | null>(
        "SELECT stop_requested_at AS value FROM executions WHERE execution_id = ?",
        [EXE_MAIN_E],
      );
      const inboxAfterStale = yield* inboxOf(CHILD_E);

      const criticalOutcome = yield* tx.transact(
        submitCriticalSteer(
          criticalSteerSubmission(handlers, {
            steerCommandId: CRITICAL_STEER_E,
            stopCommandId: CRITICAL_STOP_E,
            payload: steerPayload({
              steer: {
                severity: "Critical",
                guidance: "cnt-acceptance-guidance-002",
              },
              expectedWorkRevision: parse(WorkRevision)(1),
            }),
            executionId: EXE_MAIN_E,
          }),
        ),
      );
      const workLifecycleAfterCritical = yield* scalar<string>(
        "SELECT lifecycle AS value FROM works WHERE work_id = ?",
        [WORK_E],
      );
      const workRevisionAfterCritical = yield* scalar<number>(
        "SELECT revision AS value FROM works WHERE work_id = ?",
        [WORK_E],
      );
      const executionAfterCritical = yield* scalar<string | null>(
        "SELECT stop_requested_at AS value FROM executions WHERE execution_id = ?",
        [EXE_MAIN_E],
      );

      return {
        normal,
        workAfterNormal,
        workRevisionAfterNormal,
        steeredEventsAfterNormal,
        stopEventsAfterNormal,
        executionAfterNormal,
        inboxAfterNormal,
        sibling,
        staleOutcome,
        workRevisionAfterStale,
        executionAfterStale,
        inboxAfterStale,
        criticalOutcome,
        workLifecycleAfterCritical,
        workRevisionAfterCritical,
        executionAfterCritical,
      };
    });
    const result = await runAcceptance(program, makeAcceptanceApp());

    expect(result.normal.resolution._tag).toBe("Committed");
    expect(result.workAfterNormal).toBe("Open");
    expect(result.workRevisionAfterNormal).toBe(1);
    expect(result.steeredEventsAfterNormal).toBe(1);
    expect(result.stopEventsAfterNormal).toBe(0);
    expect(result.executionAfterNormal).toBeNull();
    expect(result.inboxAfterNormal).toHaveLength(1);
    expect(result.inboxAfterNormal[0]?.kind).toBe("HumanInput");
    expect(result.inboxAfterNormal[0]?.entryKey).toBe(`steer:${WORK_E}:1`);

    expect(result.sibling.resolution._tag).toBe("TerminalRejected");
    if (result.sibling.resolution._tag === "TerminalRejected") {
      expect(result.sibling.resolution.error._tag).toBe("AuthorityDenied");
    }

    expect(result.staleOutcome._tag).toBe("CriticalSteerRejected");
    if (result.staleOutcome._tag === "CriticalSteerRejected") {
      expect(result.staleOutcome.stage).toBe("SteerWork");
      expect(result.staleOutcome.rejection._tag).toBe("RevisionConflict");
    }
    expect(result.workRevisionAfterStale).toBe(1);
    expect(result.executionAfterStale).toBeNull();
    expect(result.inboxAfterStale).toHaveLength(1);

    expect(result.criticalOutcome._tag).toBe("CriticalSteerCommitted");
    if (result.criticalOutcome._tag === "CriticalSteerCommitted") {
      expect(result.criticalOutcome.steer.result.severity).toBe("Critical");
      expect(result.criticalOutcome.steer.result.fromRevision).toBe(1);
      expect(result.criticalOutcome.steer.result.toRevision).toBe(2);
      // P10 `06` §2 back-fill: the paired HumanInterventionApplied fact
      // rides the same events array as WorkSteered.
      expect(result.criticalOutcome.steer.events).toHaveLength(2);
      expect(result.criticalOutcome.steer.events[0]?.eventType).toBe(
        "WorkSteered",
      );
      expect(result.criticalOutcome.steer.events[1]?.eventType).toBe(
        "HumanInterventionApplied",
      );
      expect(result.criticalOutcome.stop.result.stopRequestedAt).toBe("t");
      expect(result.criticalOutcome.stop.events).toHaveLength(1);
      expect(result.criticalOutcome.stop.events[0]?.eventType).toBe(
        "ExecutionStopRequested",
      );
    }
    expect(result.workLifecycleAfterCritical).toBe("Open");
    expect(result.workRevisionAfterCritical).toBe(2);
    expect(result.executionAfterCritical).toBe("t");
  });
});
