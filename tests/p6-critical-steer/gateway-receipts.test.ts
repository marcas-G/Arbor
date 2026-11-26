import { Cause, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type {
  CriticalSteerActiveMain,
  CriticalSteerPreparation,
} from "../../packages/application/src/critical-steer.js";
import {
  CommandId,
  type CommandSubmissionContext,
  parse,
} from "../../packages/domain/dist/index.js";
import {
  admitMainExecution,
  CommandGateway,
  type CommandHandler,
  commandErr,
  criticalPayload,
  Effect,
  executionRow,
  inboxEntries,
  mainExecutionId,
  makeCriticalSteerApp,
  p6Project,
  p6RootWorkspace,
  p6TestActor,
  p6TestPrincipal,
  runCriticalSteer,
  SqlClient,
  type SteerWorkPayload,
  type StopExecutionPayload,
  type StopExecutionResult,
  seedWork,
  semanticRequestFingerprint,
  workId,
  workRow,
} from "./support.js";

const commitSteerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const noActiveSteerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d5",
);
const lateActiveSteerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d8",
);
const concurrentSteerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d6",
);
const stopFailureSteerCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d7",
);

describe("p6-critical-steer", () => {
  it("commits Critical Steer and exact active-main stop through one external Gateway receipt; replay does not reselect", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      yield* admitMainExecution;
      const gateway = yield* CommandGateway;
      const payload = criticalPayload();
      const stopPayload = { executionId: mainExecutionId };
      let preparationCalls = 0;
      const envelope = {
        commandType: "SteerWork",
        commandId: commitSteerCommandId,
        projectId: p6Project,
        actor: p6TestActor,
        issuedAt: "t",
        payload,
        prepareCriticalSteerStop: () => {
          preparationCalls += 1;
          return Effect.succeed({
            _tag: "Ready",
            executionId: mainExecutionId,
            authority: {
              _tag: "StopExecutionAuthority",
              submissionOrigin: "External",
              principal: p6TestPrincipal,
              commandId: commitSteerCommandId,
              semanticRequestFingerprint: semanticRequestFingerprint({
                commandType: "StopExecution",
                projectId: p6Project,
                actor: p6TestActor,
                schemaVersion: "1",
                payload: stopPayload,
              }),
              projectId: p6Project,
              commandKind: "StopExecution",
              executionId: mainExecutionId,
            },
          } satisfies CriticalSteerPreparation);
        },
      };
      const context = { _tag: "External" as const, principal: p6TestPrincipal };
      const authority = {
        _tag: "SteerWorkAuthority" as const,
        principal: p6TestPrincipal,
        commandId: commitSteerCommandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SteerWork",
          projectId: p6Project,
          actor: p6TestActor,
          schemaVersion: "2",
          payload,
        }),
        projectId: p6Project,
        targetWorkspaceId: p6RootWorkspace,
        workId,
      };
      const first = yield* gateway.execute(envelope, context, authority);
      const second = yield* gateway.execute(envelope, context, authority);
      return {
        first,
        second,
        preparationCalls,
        work: yield* workRow,
        execution: yield* executionRow,
        entries: yield* inboxEntries,
        events: yield* Effect.gen(function* () {
          const sql = yield* SqlClient;
          return yield* sql.unsafe<{
            readonly event_type: string;
            readonly caused_by_command_id: string | null;
          }>(
            "SELECT event_type, caused_by_command_id FROM domain_events ORDER BY sequence",
          );
        }),
        receipts: yield* Effect.gen(function* () {
          const sql = yield* SqlClient;
          return yield* sql.unsafe<{ readonly count: number }>(
            "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
            [commitSteerCommandId],
          );
        }),
      };
    });
    const result = await runCriticalSteer(program, makeCriticalSteerApp());
    expect(result.first.resolution._tag).toBe("Committed");
    expect(result.second).toEqual(result.first);
    expect(result.preparationCalls).toBe(1);
    expect(result.work[0]).toMatchObject({ lifecycle: "Open", revision: 1 });
    expect(result.execution[0]?.stop_requested_at).toBe("t");
    expect(result.entries).toHaveLength(1);
    expect(result.receipts[0]?.count).toBe(1);
    expect(result.events.map((event) => event.event_type)).toContain(
      "ExecutionStopRequested",
    );
    expect(
      result.events.filter(
        (event) => event.event_type === "ExecutionStopRequested",
      ),
    ).toEqual([
      {
        event_type: "ExecutionStopRequested",
        caused_by_command_id: commitSteerCommandId,
      },
    ]);
    expect(
      result.events
        .filter((event) => event.caused_by_command_id === commitSteerCommandId)
        .map((event) => event.event_type),
    ).toEqual([
      "WorkSteered",
      "HumanInterventionApplied",
      "ExecutionStopRequested",
    ]);
  });

  it("serializes concurrent same-command advisory misses into one receipt and one Steer+Stop fact set", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      yield* admitMainExecution;
      const gateway = yield* CommandGateway;
      const payload = criticalPayload();
      const stopPayload = { executionId: mainExecutionId };
      let preparationCalls = 0;
      let releasePreparations!: () => void;
      const bothPrepared = new Promise<void>((resolve) => {
        releasePreparations = resolve;
      });
      const envelope = {
        commandType: "SteerWork",
        commandId: concurrentSteerCommandId,
        projectId: p6Project,
        actor: p6TestActor,
        issuedAt: "t",
        payload,
        prepareCriticalSteerStop: () =>
          Effect.promise(async () => {
            preparationCalls += 1;
            if (preparationCalls === 2) releasePreparations();
            await bothPrepared;
            return {
              _tag: "Ready",
              executionId: mainExecutionId,
              authority: {
                _tag: "StopExecutionAuthority",
                submissionOrigin: "External",
                principal: p6TestPrincipal,
                commandId: concurrentSteerCommandId,
                semanticRequestFingerprint: semanticRequestFingerprint({
                  commandType: "StopExecution",
                  projectId: p6Project,
                  actor: p6TestActor,
                  schemaVersion: "1",
                  payload: stopPayload,
                }),
                projectId: p6Project,
                commandKind: "StopExecution",
                executionId: mainExecutionId,
              },
            } satisfies CriticalSteerPreparation;
          }),
      };
      const context = { _tag: "External" as const, principal: p6TestPrincipal };
      const authority = {
        _tag: "SteerWorkAuthority" as const,
        principal: p6TestPrincipal,
        commandId: concurrentSteerCommandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SteerWork",
          projectId: p6Project,
          actor: p6TestActor,
          schemaVersion: "2",
          payload,
        }),
        projectId: p6Project,
        targetWorkspaceId: p6RootWorkspace,
        workId,
      };
      const receipts = yield* Effect.all(
        [
          gateway.execute(envelope, context, authority),
          gateway.execute(envelope, context, authority),
        ],
        { concurrency: "unbounded" },
      );
      const sql = yield* SqlClient;
      return {
        receipts,
        preparationCalls,
        work: yield* workRow,
        execution: yield* executionRow,
        entries: yield* inboxEntries,
        receiptCount: yield* sql.unsafe<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
          [concurrentSteerCommandId],
        ),
        events: yield* sql.unsafe<{
          readonly event_type: string;
          readonly caused_by_command_id: string | null;
        }>(
          "SELECT event_type, caused_by_command_id FROM domain_events WHERE caused_by_command_id = ? ORDER BY sequence",
          [concurrentSteerCommandId],
        ),
      };
    });
    const result = await runCriticalSteer(program, makeCriticalSteerApp());
    expect(result.preparationCalls).toBe(2);
    expect(result.receipts[0]).toEqual(result.receipts[1]);
    expect(result.receipts[0]?.resolution._tag).toBe("Committed");
    expect(result.receiptCount[0]?.count).toBe(1);
    expect(result.work[0]).toMatchObject({ lifecycle: "Open", revision: 1 });
    expect(result.execution[0]?.stop_requested_at).toBe("t");
    expect(result.entries).toHaveLength(1);
    expect(result.events.map((event) => event.event_type)).toEqual([
      "WorkSteered",
      "HumanInterventionApplied",
      "ExecutionStopRequested",
    ]);
  });

  it("rolls back Steer and its Inbox/event/receipt facts when the Stop child rejects", async () => {
    const stopRejectsAfterSteer = (
      handler: CommandHandler<StopExecutionPayload, StopExecutionResult>,
    ): CommandHandler<StopExecutionPayload, StopExecutionResult> => ({
      ...handler,
      execute: (envelope) =>
        Effect.succeed(
          commandErr({
            _tag: "ExecutionNotFound",
            executionId: envelope.payload.executionId,
          }),
        ),
    });
    const program = Effect.gen(function* () {
      yield* seedWork;
      yield* admitMainExecution;
      const gateway = yield* CommandGateway;
      const payload = criticalPayload();
      const context = { _tag: "External" as const, principal: p6TestPrincipal };
      const authority = {
        _tag: "SteerWorkAuthority" as const,
        principal: p6TestPrincipal,
        commandId: stopFailureSteerCommandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SteerWork",
          projectId: p6Project,
          actor: p6TestActor,
          schemaVersion: "2",
          payload,
        }),
        projectId: p6Project,
        targetWorkspaceId: p6RootWorkspace,
        workId,
      };
      const exit = yield* Effect.exit(
        gateway.execute(
          {
            commandType: "SteerWork",
            commandId: stopFailureSteerCommandId,
            projectId: p6Project,
            actor: p6TestActor,
            issuedAt: "t",
            payload,
            prepareCriticalSteerStop: () =>
              Effect.succeed({
                _tag: "Ready",
                executionId: mainExecutionId,
                authority: {
                  _tag: "StopExecutionAuthority",
                  submissionOrigin: "External",
                  principal: p6TestPrincipal,
                  commandId: stopFailureSteerCommandId,
                  semanticRequestFingerprint: semanticRequestFingerprint({
                    commandType: "StopExecution",
                    projectId: p6Project,
                    actor: p6TestActor,
                    schemaVersion: "1",
                    payload: { executionId: mainExecutionId },
                  }),
                  projectId: p6Project,
                  commandKind: "StopExecution",
                  executionId: mainExecutionId,
                },
              } satisfies CriticalSteerPreparation),
          },
          context,
          authority,
        ),
      );
      const sql = yield* SqlClient;
      return {
        exit,
        work: yield* workRow,
        execution: yield* executionRow,
        entries: yield* inboxEntries,
        receiptCount: yield* sql.unsafe<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
          [stopFailureSteerCommandId],
        ),
        events: yield* sql.unsafe<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events WHERE caused_by_command_id = ?",
          [stopFailureSteerCommandId],
        ),
      };
    });
    const result = await runCriticalSteer(
      program,
      makeCriticalSteerApp(":memory:", stopRejectsAfterSteer),
    );
    expect(Exit.isFailure(result.exit)).toBe(true);
    if (Exit.isFailure(result.exit)) {
      expect(
        result.exit.cause.reasons.some((reason) => Cause.isDieReason(reason)),
      ).toBe(true);
    }
    expect(result.work[0]).toMatchObject({ lifecycle: "Open", revision: 0 });
    expect(result.execution[0]?.stop_requested_at).toBeNull();
    expect(result.entries).toHaveLength(0);
    expect(result.receiptCount[0]?.count).toBe(0);
    expect(result.events[0]?.count).toBe(0);
  });

  it("commits Critical Steer without Stop when the transaction has no active main; replay does not reselect", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const gateway = yield* CommandGateway;
      const payload = criticalPayload();
      let preparationCalls = 0;
      const context = { _tag: "External" as const, principal: p6TestPrincipal };
      const authority = {
        _tag: "SteerWorkAuthority" as const,
        principal: p6TestPrincipal,
        commandId: noActiveSteerCommandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SteerWork",
          projectId: p6Project,
          actor: p6TestActor,
          schemaVersion: "2",
          payload,
        }),
        projectId: p6Project,
        targetWorkspaceId: p6RootWorkspace,
        workId,
      };
      const envelope = {
        commandType: "SteerWork",
        commandId: noActiveSteerCommandId,
        projectId: p6Project,
        actor: p6TestActor,
        issuedAt: "t",
        payload,
        prepareCriticalSteerStop: () => {
          preparationCalls += 1;
          return Effect.succeed({ _tag: "NoActiveMain" as const });
        },
      };
      const first = yield* gateway.execute(envelope, context, authority);
      const replay = yield* gateway.execute(envelope, context, authority);
      const sql = yield* SqlClient;
      return {
        first,
        replay,
        preparationCalls,
        work: yield* workRow,
        entries: yield* inboxEntries,
        receipt: yield* sql.unsafe<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
          [noActiveSteerCommandId],
        ),
        events: yield* sql.unsafe<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events WHERE caused_by_command_id = ?",
          [noActiveSteerCommandId],
        ),
        eventTypes: yield* sql.unsafe<{ readonly event_type: string }>(
          "SELECT event_type FROM domain_events WHERE caused_by_command_id = ? ORDER BY sequence",
          [noActiveSteerCommandId],
        ),
        execution: yield* sql.unsafe<{ readonly execution_id: string }>(
          "SELECT execution_id FROM executions WHERE execution_id = ?",
          [mainExecutionId],
        ),
      };
    });
    const result = await runCriticalSteer(program, makeCriticalSteerApp());
    expect(result.first.resolution._tag).toBe("Committed");
    expect(result.replay).toEqual(result.first);
    expect(result.preparationCalls).toBe(1);
    expect(result.work[0]).toMatchObject({ lifecycle: "Open", revision: 1 });
    expect(result.entries).toHaveLength(1);
    expect(result.receipt[0]?.count).toBe(1);
    expect(result.events[0]?.count).toBe(2);
    expect(result.eventTypes.map(({ event_type }) => event_type)).toEqual([
      "WorkSteered",
      "HumanInterventionApplied",
    ]);
    expect(result.execution).toHaveLength(0);
  });

  it("stops a main admitted after no-active preparation but before the outer transaction", async () => {
    const program = Effect.gen(function* () {
      yield* seedWork;
      const gateway = yield* CommandGateway;
      const payload = criticalPayload();
      const context = { _tag: "External" as const, principal: p6TestPrincipal };
      const authority = {
        _tag: "SteerWorkAuthority" as const,
        principal: p6TestPrincipal,
        commandId: lateActiveSteerCommandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SteerWork",
          projectId: p6Project,
          actor: p6TestActor,
          schemaVersion: "2",
          payload,
        }),
        projectId: p6Project,
        targetWorkspaceId: p6RootWorkspace,
        workId,
      };
      let preparationCalls = 0;
      const envelope = {
        commandType: "SteerWork",
        commandId: lateActiveSteerCommandId,
        projectId: p6Project,
        actor: p6TestActor,
        issuedAt: "t",
        payload,
        prepareCriticalSteerStop: ((
          _payload: SteerWorkPayload,
          _context: CommandSubmissionContext,
          activeMain?: CriticalSteerActiveMain,
        ) =>
          Effect.gen(function* () {
            preparationCalls += 1;
            if (activeMain === undefined) {
              // Simulate a main admission after the preparation observed none
              // but before Gateway begins the SteerWork transaction.
              yield* admitMainExecution;
              return { _tag: "NoActiveMain" } as const;
            }
            expect(activeMain).toEqual({
              executionId: mainExecutionId,
              projectId: p6Project,
              workspaceId: p6RootWorkspace,
            });
            const stopPayload = { executionId: activeMain.executionId };
            return {
              _tag: "Ready",
              executionId: activeMain.executionId,
              authority: {
                _tag: "StopExecutionAuthority",
                submissionOrigin: "External",
                principal: p6TestPrincipal,
                commandId: lateActiveSteerCommandId,
                semanticRequestFingerprint: semanticRequestFingerprint({
                  commandType: "StopExecution",
                  projectId: p6Project,
                  actor: p6TestActor,
                  schemaVersion: "1",
                  payload: stopPayload,
                }),
                projectId: p6Project,
                commandKind: "StopExecution",
                executionId: activeMain.executionId,
              },
            } satisfies CriticalSteerPreparation;
          })) as never,
      };
      const receipt = yield* gateway.execute(envelope, context, authority);
      const sql = yield* SqlClient;
      return {
        receipt,
        preparationCalls,
        work: yield* workRow,
        execution: yield* executionRow,
        entries: yield* inboxEntries,
        eventTypes: yield* sql.unsafe<{ readonly event_type: string }>(
          "SELECT event_type FROM domain_events WHERE caused_by_command_id = ? ORDER BY sequence",
          [lateActiveSteerCommandId],
        ),
        receiptCount: yield* sql.unsafe<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
          [lateActiveSteerCommandId],
        ),
      };
    });
    const result = await runCriticalSteer(program, makeCriticalSteerApp());
    expect(result.receipt.resolution._tag).toBe("Committed");
    expect(result.preparationCalls).toBe(2);
    expect(result.work[0]).toMatchObject({ lifecycle: "Open", revision: 1 });
    expect(result.execution[0]?.stop_requested_at).toBe("t");
    expect(result.entries).toHaveLength(1);
    expect(result.receiptCount[0]?.count).toBe(1);
    expect(result.eventTypes.map(({ event_type }) => event_type)).toEqual([
      "WorkSteered",
      "HumanInterventionApplied",
      "ExecutionStopRequested",
    ]);
  });
});
