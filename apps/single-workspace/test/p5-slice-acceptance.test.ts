import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssignWorkPayload,
  CommandGateway,
  type CreateProjectPayload,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ContextEpochNumber,
  type ExecutionFocus,
  ExecutionId,
  makeProjectPolicy,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { runExecution } from "@arbor/execution-runtime";
import {
  ExecutionScheduler,
  ResourceOwnershipRepository,
  TransactionPort,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  admitExecution,
  buildSliceLayer,
  evaluateAndSelect,
  P7_MIGRATIONS,
  runMigrations,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const exe1 = parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1");
const exe2 = parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a2");
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("user:test");
const context: CommandSubmissionContext = {
  _tag: "System",
  principal,
  causationRef: "c",
};

const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};

const projectPayload: CreateProjectPayload = {
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: workspaceId,
  primarySession: {
    sessionId,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
    responsibilityDefinition: definition,
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceBoundary: {
      basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
      addresses: [{ _tag: "FileTree", path: "." }],
    },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    agentBinding: responsibilityBound(workspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
};

const workPayload: AssignWorkPayload = {
  workId,
  workspaceId,
  expectedWorkspaceRevision: parse(Revision)(0),
  objective: "ship the slice",
  why: "P5",
  constraints: [],
  completionExpectation: "done",
  verificationMission: { goal: "g", criteria: [], riskRequirements: [] },
  provenance: { predecessorWorkId: null, reason: "initial" },
  revision: parse(WorkRevision)(0),
};

const commandId = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-0123456789a${suffix}`);

const p1Authority = (
  tag: "CreateProjectAuthority" | "AssignWorkAuthority",
  payload: CreateProjectPayload | AssignWorkPayload,
  id: CommandId,
): VerifiedCommandAuthority =>
  ({
    _tag: tag,
    principal,
    commandId: id,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType:
        tag === "CreateProjectAuthority" ? "CreateProject" : "AssignWork",
      projectId,
      actor,
      schemaVersion: "1",
      payload,
    }),
    projectId,
    ...(tag === "AssignWorkAuthority"
      ? { targetWorkspaceId: workspaceId }
      : {}),
  }) as VerifiedCommandAuthority;

const envelope = <P>(
  commandType: string,
  payload: P,
  id: CommandId,
): GatewayEnvelope<P> => ({
  commandType,
  commandId: id,
  projectId,
  actor,
  issuedAt: "t",
  payload,
});

const directive = (payload: unknown) => [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c",
    toolName: "arbor_directive",
    argumentsJson: JSON.stringify(payload),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

const turns = [
  [
    {
      _tag: "ToolCallProposed" as const,
      callRef: "c1",
      toolName: "shell",
      argumentsJson: JSON.stringify({
        command: "echo hello",
        cwd: { _tag: "FileTree", path: "." },
      }),
    },
    { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
  ],
  directive({
    _tag: "Yield",
    reason: "waiting",
    waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
  }),
  directive({ _tag: "DeclareDependency", spec: {} }), // P7 owns it; ProposeChildWorkspace is P6-live now
  directive({
    _tag: "CompletionClaim",
    claim: { claimRef: "claim-1", workRevision: 0 },
  }),
];

describe("P5 vertical-slice acceptance", () => {
  it("runs the whole story: work, tool, yield, wake, unsupported, claim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p5-accept-"));
    const app = buildSliceLayer({
      databaseFile: join(dir, "slice.db"),
      providerTurns: turns,
    });

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P7_MIGRATIONS);
          const gateway = yield* CommandGateway;
          const scheduler = yield* ExecutionScheduler;
          const sql = yield* SqlClient;

          const created = yield* gateway.execute(
            envelope("CreateProject", projectPayload, commandId("1")),
            context,
            p1Authority(
              "CreateProjectAuthority",
              projectPayload,
              commandId("1"),
            ),
          );
          const assigned = yield* gateway.execute(
            envelope("AssignWork", workPayload, commandId("2")),
            context,
            p1Authority("AssignWorkAuthority", workPayload, commandId("2")),
          );

          // Story precondition (out of P1–P4 slice scope): the Workspace already
          // holds the resource-ownership claim for its boundary region. No
          // P1–P4 command establishes ownership; it is a governance fact.
          const ownership = yield* ResourceOwnershipRepository;
          const tx0 = yield* TransactionPort;
          yield* tx0.transact(
            ownership.insertClaim({
              claimId: "roc_018f2b3c-4d5e-7abc-8def-0123456789a1",
              workspaceId,
              region: {
                resourceSpaceId: "filesystem",
                normalizedRegion: { kind: "FileTree", path: "." },
              },
              sourceAddressSnapshot: { _tag: "FileTree", path: "." },
              resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
              resolvedAtEnvironmentRevision: "local",
              createdAt: "t",
              releasedAt: null,
            }),
          );

          const step = yield* evaluateAndSelect(workspaceId, principal, {
            _tag: "WorkSelected",
          });
          const decision = step.decision;

          const firstAdmit = yield* admitExecution(
            workspaceId,
            exe1,
            { _tag: "Work", workId },
            principal,
          );
          const conflict = yield* admitExecution(
            workspaceId,
            exe2,
            { _tag: "Work", workId },
            principal,
          );

          const firstSettlement = yield* runExecution(
            exe1,
            { _tag: "WorkSelected" },
            principal,
          );

          console.log("FIRST SETTLEMENT", firstSettlement);
          const exeRows1 = yield* sql.unsafe<{
            execution_id: string;
            settlement_kind: string | null;
            settled_at: string | null;
          }>(
            "SELECT execution_id, settlement_kind, settled_at FROM executions",
          );
          console.log("EXE ROWS after runExecution", exeRows1);
          const waitsAfterYield = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM work_waits",
          );
          const tx = yield* TransactionPort;
          const waitStore = yield* WorkWaitStore;
          yield* tx.transact(waitStore.clear(workId));
          const woken = yield* scheduler.reevaluate(workspaceId, {
            _tag: "HumanIntervention",
          });
          const waitsAfterWake = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM work_waits",
          );

          const unsettled = yield* sql.unsafe<{
            execution_id: string;
            settled_at: string | null;
          }>(
            "SELECT execution_id, settled_at FROM executions WHERE workspace_id = ? AND binding_kind = 'workspace' AND settled_at IS NULL",
            [workspaceId],
          );
          console.log("UNSETTLED before 2nd admit", unsettled);
          yield* admitExecution(
            workspaceId,
            exe2,
            { _tag: "Work", workId },
            principal,
          );
          const secondSettlement = yield* runExecution(
            exe2,
            { _tag: "WorkSelected" },
            principal,
          );

          const works = yield* sql.unsafe<{ lifecycle: string }>(
            "SELECT lifecycle FROM works WHERE work_id = ?",
            [workId],
          );
          const executions = yield* sql.unsafe<{
            execution_id: string;
            session_id: string;
            settlement_kind: string | null;
          }>(
            "SELECT execution_id, session_id, settlement_kind FROM executions ORDER BY execution_id",
          );
          const entries = yield* sql.unsafe<{
            entry_kind: string;
            payload_json: string;
          }>(
            "SELECT entry_kind, payload_json FROM session_entries WHERE session_id = ? ORDER BY sequence",
            [sessionId],
          );
          const verificationTables = yield* sql.unsafe<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%verification%'",
          );

          return {
            created: created.resolution._tag,
            assigned: assigned.resolution._tag,
            decision: decision._tag,
            selections: step.selections,
            focus:
              decision._tag === "Admit" ? decision.focus._tag : decision._tag,
            firstAdmit: (firstAdmit as { resolution: { _tag: string } })
              .resolution._tag,
            conflict: (() => {
              const resolution = (
                conflict as {
                  resolution: { _tag: string; error?: { _tag: string } };
                }
              ).resolution;
              return resolution._tag === "TerminalRejected"
                ? (resolution.error?._tag ?? "TerminalRejected")
                : resolution._tag;
            })(),
            firstSettlement,
            secondSettlement,
            waitsAfterYield: Number(waitsAfterYield[0]?.count ?? 0),
            woken: woken._tag,
            waitsAfterWake: Number(waitsAfterWake[0]?.count ?? 0),
            works,
            executions,
            entries,
            verificationTables: verificationTables.map((t) => t.name),
          };
        }),
        app,
      ) as unknown as Effect.Effect<
        {
          created: string;
          assigned: string;
          selections: ReadonlyArray<string>;
          focus: string;
          decision: string;
          firstAdmit: string;
          conflict: string;
          firstSettlement: { _tag: string; result?: { _tag: string } };
          secondSettlement: { _tag: string; result?: { _tag: string } };
          waitsAfterYield: number;
          woken: string;
          waitsAfterWake: number;
          works: ReadonlyArray<{ lifecycle: string }>;
          executions: ReadonlyArray<{
            execution_id: string;
            session_id: string;
            settlement_kind: string | null;
          }>;
          entries: ReadonlyArray<{ entry_kind: string; payload_json: string }>;
          verificationTables: ReadonlyArray<string>;
        },
        unknown,
        never
      >,
    );

    expect(result.created).toBe("Committed");
    expect(result.assigned).toBe("Committed");
    expect(result.selections).toEqual([workId]);
    expect(result.decision).toBe("Admit");
    expect(result.focus).toBe("Work");
    expect(result.firstAdmit).toBe("Committed");
    expect(result.conflict).toBe("ActiveExecutionConflict");

    expect(result.firstSettlement._tag).toBe("Completed");
    expect(result.secondSettlement._tag).toBe("Completed");
    if (result.firstSettlement._tag === "Completed") {
      expect(result.firstSettlement.result?._tag).toBe("Yielded");
    }
    if (result.secondSettlement._tag === "Completed") {
      expect(result.secondSettlement.result?._tag).toBe("CompletionClaimed");
    }

    expect(result.waitsAfterYield).toBe(1);
    expect(result.woken).toBe("Admit");
    expect(result.waitsAfterWake).toBe(0);

    expect(result.works.map((w) => w.lifecycle)).toEqual(["Open"]);
    expect(new Set(result.executions.map((e) => e.session_id))).toEqual(
      new Set([sessionId]),
    );
    expect(result.executions.map((e) => e.settlement_kind)).toEqual([
      "Completed",
      "Completed",
    ]);

    const kinds = result.entries.map((e) => e.entry_kind);
    expect(kinds).toContain("ModelOutput");
    expect(kinds).toContain("Observation");
    const observations = result.entries
      .filter((e) => e.entry_kind === "Observation")
      .map(
        (e) => JSON.parse(e.payload_json) as { _tag?: string; source?: string },
      );
    expect(
      observations.some(
        (o) =>
          o._tag === undefined &&
          o.source === "Tool" &&
          JSON.stringify(o).includes("exitCode"),
      ),
    ).toBe(true);
    expect(observations.some((o) => o._tag === "DirectiveUnsupported")).toBe(
      true,
    );

    expect(result.verificationTables).toEqual([]);
  });
});
