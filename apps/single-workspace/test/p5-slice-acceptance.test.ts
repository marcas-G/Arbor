import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssignWorkPayload,
  CommandGateway,
  type CreateProjectPayload,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "@arbor/application";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ContextEpochNumber,
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
  ToolRuntimePort,
  TransactionPort,
  WorkWaitStore,
} from "@arbor/ports";
import { Cause, Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureLegacyProjectResourceSourceFixture } from "../../../tests/support/legacy-project-resource-source.js";
import {
  createSchema42TestDatabaseFactory,
  type Schema42TestDatabaseFactory,
} from "../../../tests/support/schema42-database.js";
import {
  admitExecution,
  buildSingleWorkspaceLayer,
  evaluateAndSelect,
} from "../src/index.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../src/project-resource-profiles.js";

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
let schema42Factory: Schema42TestDatabaseFactory | undefined;
const schema42Cleanups: Array<() => void> = [];

beforeAll(async () => {
  schema42Factory = await createSchema42TestDatabaseFactory({
    prefix: ".p5-slice-acceptance-template-",
  });
}, 120_000);

afterAll(() => schema42Factory?.cleanup());

const createSchema42Case = () => {
  if (schema42Factory === undefined) {
    throw new Error("Schema-42 test database factory was not prepared.");
  }
  return schema42Factory.create();
};

afterEach(() => {
  for (const cleanup of schema42Cleanups.splice(0)) cleanup();
});

const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};

const projectPayload = (
  resourceSelection: CreateProjectPayload["rootWorkspace"]["resourceSelection"],
): CreateProjectPayload => ({
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
    resourceSelection,
    agentBinding: responsibilityBound(workspaceId),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});

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
      schemaVersion: tag === "CreateProjectAuthority" ? "2" : "1",
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

const wait = (reason: string) => [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c",
    toolName: "wait",
    argumentsJson: JSON.stringify({
      reason,
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

const summarizeToolRuntimeValue = (value: unknown) => {
  if (typeof value !== "object" || value === null) {
    return { valueType: typeof value };
  }
  const record = value as Record<string, unknown>;
  const textField = (...keys: ReadonlyArray<string>): string | null => {
    for (const key of keys) {
      const field = record[key];
      if (typeof field === "string") return field.slice(0, 160);
    }
    return null;
  };
  return {
    tag: textField("_tag"),
    code: textField("code", "reasonCode"),
    stage: textField("stage"),
    effectDisposition: textField("effectDisposition"),
    invocationRef: textField("invocationRef"),
    message: textField("message"),
  };
};

const persistenceFailureFields = new Set([
  "_tag",
  "repository",
  "operation",
  "constraintKind",
  "constraint",
]);
const safePersistenceRepositories = new Set([
  "ToolObservationEvidenceStore",
  "ToolInvocationStore",
  "ArtifactMetadataRepository",
]);
const safePersistenceOperations = new Set([
  "tool-observation-evidence",
  "invocation",
  "artifact-metadata",
]);
const safeConstraintMessages = new Set([
  "invalid P40 tool observation evidence",
  "invalid or immutable P40 tool observation evidence",
  "terminal settlement and selected fact are immutable",
  "recovery binding is immutable",
  "reconciliation settlement requires matching authoritative fact",
  "FOREIGN KEY constraint failed",
  "UNIQUE constraint failed: tool_invocations.invocation_id",
  "unknown",
  "CHECK constraint failed: tool_invocations",
  "CHECK constraint failed: observation_format_version",
  "CHECK constraint failed: observation_json",
  "CHECK constraint failed: observation_sha256",
]);

const summarizePersistenceConstraint = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isNone(failure)) return null;

  let current: unknown = failure.value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    const record = current as Record<string, unknown>;
    if (record._tag === "PersistenceConstraintViolation") {
      const safeFieldNames = Object.keys(record)
        .filter((key) => persistenceFailureFields.has(key))
        .sort();
      const safeValue = (key: string, allowed: ReadonlySet<string>) => {
        const value = record[key];
        return typeof value === "string" && allowed.has(value)
          ? value.slice(0, 160)
          : null;
      };
      return {
        tag: "PersistenceConstraintViolation",
        fields: safeFieldNames,
        repository: safeValue("repository", safePersistenceRepositories),
        operation: safeValue("operation", safePersistenceOperations),
        constraintKind: safeValue(
          "constraintKind",
          new Set(["Constraint", "Unique"]),
        ),
        constraint: safeValue("constraint", safeConstraintMessages),
      };
    }
    if (
      record._tag !== "ToolRuntimeOperationalFailure" &&
      record._tag !== "ToolRuntimeCleanupFailure" &&
      record._tag !== "ArtifactError"
    ) {
      return null;
    }
    current = record.cause;
  }
  return null;
};

const summarizeToolRuntimeCause = (cause: Cause.Cause<unknown>) => ({
  persistenceConstraint: summarizePersistenceConstraint(cause),
  reasons: cause.reasons.slice(0, 4).map((reason) => {
    if (Cause.isFailReason(reason)) {
      return {
        kind: "TypedFailure",
        failure: summarizeToolRuntimeValue(reason.error),
      };
    }
    if (Cause.isDieReason(reason)) {
      return {
        kind: "Defect",
        defect: summarizeToolRuntimeValue(reason.defect),
      };
    }
    return { kind: "Interrupt", fiberId: String(reason.fiberId) };
  }),
});

const boundedDiagnosticJson = (value: unknown): string => {
  const json = JSON.stringify(value);
  return json.length <= 6_000
    ? json
    : JSON.stringify({ truncated: true, jsonPrefix: json.slice(0, 5_800) });
};

const toolRuntimeFailures: Array<ReturnType<typeof summarizeToolRuntimeCause>> =
  [];
const toolRuntimeBoundaries: Array<string> = [];

const turns = [
  [
    {
      _tag: "ToolCallProposed" as const,
      callRef: "c1",
      toolName: "shell",
      argumentsJson: JSON.stringify({
        command: "echo hello",
        cwd: { mount: "workspace", path: "." },
      }),
    },
    { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
  ],
  wait("wait for the first wake"),
  wait("wait for the second wake"),
];

describe("I0 executable/control vertical slice", () => {
  it("routes shell through ToolRuntime and Wait through ControlToolRegistry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p5-accept-"));
    const fixture = createSchema42Case();
    schema42Cleanups.push(fixture.cleanup);
    const projectResourceProfiles = makeProjectResourceProfilePort(
      projectResourceProfilesFromEnvironment({ ARBOR_PROJECT_ROOT: dir }),
    );
    const profile = Effect.runSync(projectResourceProfiles.list())[0];
    if (profile === undefined || !profile.available) {
      throw new Error("P5 host Project Profile must be available");
    }
    const resolvedProfile = Effect.runSync(
      projectResourceProfiles.resolve(
        profile.resourceProfileRef,
        profile.version,
      ),
    );
    if (Option.isNone(resolvedProfile)) {
      throw new Error("P5 host Project Profile did not resolve");
    }
    const canonicalRoot = resolvedProfile.value.canonicalAddress.path;
    expect(canonicalRoot).toBe(realpathSync(dir));
    const selectedProjectPayload = projectPayload({
      _tag: "Profile",
      resourceProfileRef: profile.resourceProfileRef,
      version: profile.version,
    });
    const app = buildSingleWorkspaceLayer({
      databaseFile: fixture.databaseFilename,
      providerTurns: turns,
      projectResourceProfiles,
      toolQualificationProbe: async ({ boundary }) => {
        toolRuntimeBoundaries.push(boundary);
      },
    });

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* ensureLegacyProjectResourceSourceFixture();
          const gateway = yield* CommandGateway;
          const scheduler = yield* ExecutionScheduler;
          const sql = yield* SqlClient;
          const toolRuntime = yield* ToolRuntimePort;
          const mutableToolRuntime = toolRuntime as unknown as {
            invoke: typeof toolRuntime.invoke;
          };
          const originalToolRuntimeInvoke = toolRuntime.invoke;
          mutableToolRuntime.invoke = (intent, toolContext) =>
            originalToolRuntimeInvoke(intent, toolContext).pipe(
              Effect.tapCause((cause) =>
                Effect.sync(() =>
                  toolRuntimeFailures.push(summarizeToolRuntimeCause(cause)),
                ),
              ),
            );

          const created = yield* gateway.execute(
            envelope("CreateProject", selectedProjectPayload, commandId("1")),
            context,
            p1Authority(
              "CreateProjectAuthority",
              selectedProjectPayload,
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
                // P12 `09`: the production resolver emits the frozen object
                // encoding with an ABSOLUTE normalized path (P1 `04` §3.3);
                // the claim fixture must match it.
                normalizedRegion: { kind: "FileTree", path: canonicalRoot },
              },
              sourceAddressSnapshot: {
                _tag: "FileTree",
                path: canonicalRoot,
              },
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
          mutableToolRuntime.invoke = originalToolRuntimeInvoke;

          const settlementRows = yield* sql.unsafe<{
            settlement_kind: string | null;
            settlement_tag: string | null;
            reconciliation_tag: string | null;
            invocation_ref_count: number | null;
          }>(
            `SELECT settlement_kind,
                    json_extract(settlement_json, '$._tag') AS settlement_tag,
                    json_extract(settlement_json, '$.reconciliation._tag') AS reconciliation_tag,
                    json_array_length(settlement_json, '$.reconciliation.invocationRefs') AS invocation_ref_count
               FROM executions WHERE execution_id = ?`,
            [exe1],
          );
          const toolEvidenceRows = yield* sql.unsafe<{
            invocation_id: string;
            tool_name: string;
            effect_admission_state: string;
            settlement_kind: string | null;
            settlement_tag: string | null;
            observation_format_version: string | null;
            observation_tag: string | null;
            observation_body: string | null;
          }>(
            `SELECT invocation_id, tool_name, effect_admission_state,
                    settlement_kind,
                    json_extract(settlement_json, '$._tag') AS settlement_tag,
                    observation_format_version,
                    json_extract(CAST(observation_json AS TEXT), '$._tag') AS observation_tag,
                    substr(json_extract(CAST(observation_json AS TEXT), '$.observation.text'), 1, 120) AS observation_body
               FROM tool_invocations WHERE execution_id = ? ORDER BY invocation_id`,
            [exe1],
          );
          const actionResultRows = yield* sql.unsafe<{
            call_ref: string;
            action_kind: string;
            state: string;
            result_ref: string | null;
            settlement_ref: string | null;
            observation_source_ref: string | null;
            disposition_json: string | null;
          }>(
            `SELECT call_ref, action_kind, state, result_ref, settlement_ref,
                    observation_source_ref, disposition_json
               FROM agent_loop_step_actions WHERE execution_id = ?
              ORDER BY logical_step_no, repair_attempt, action_index LIMIT 8`,
            [exe1],
          );
          const timelineObservationRows = yield* sql.unsafe<{
            entry_kind: string;
            item_type: string;
            source_kind: string | null;
            source_ref: string | null;
            item_tag: string | null;
            call_ref: string | null;
            observation_ref: string | null;
            status: string | null;
          }>(
            `SELECT entry_kind, item_type, source_kind, source_ref,
                    json_extract(payload_json, '$._tag') AS item_tag,
                    json_extract(payload_json, '$.callRef') AS call_ref,
                    json_extract(payload_json, '$.observationRef') AS observation_ref,
                    json_extract(payload_json, '$.status') AS status
               FROM session_entries
              WHERE session_id = ? AND item_type IN ('ToolResult','ControlResult')
              ORDER BY sequence LIMIT 8`,
            [sessionId],
          );
          const readmissionDiagnostic = {
            toolRuntimeFailures: toolRuntimeFailures.slice(0, 8),
            toolRuntimeBoundaries: toolRuntimeBoundaries.slice(0, 16),
            firstSettlement: {
              tag: firstSettlement._tag,
              resultTag:
                firstSettlement._tag === "Completed"
                  ? (firstSettlement.result?._tag ?? null)
                  : null,
            },
            executionSettlement: settlementRows[0] ?? null,
            toolInvocations: toolEvidenceRows.map((row) => ({
              ...row,
              observationBody: row.observation_body?.slice(0, 120) ?? null,
            })),
            actionResults: actionResultRows,
            timelineObservations: timelineObservationRows,
          };
          if (
            firstSettlement._tag !== "Completed" ||
            firstSettlement.result?._tag !== "Yielded"
          ) {
            return yield* Effect.die({
              _tag: "P5ExpectedYieldedBeforeReadmission",
              diagnosticJson: boundedDiagnosticJson(readmissionDiagnostic),
            });
          }

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

          const readmission = yield* Effect.match(
            admitExecution(
              workspaceId,
              exe2,
              { _tag: "Work", workId },
              principal,
            ),
            {
              onFailure: (failure) => ({ _tag: "Failure" as const, failure }),
              onSuccess: () => ({ _tag: "Success" as const }),
            },
          );
          if (readmission._tag === "Failure") {
            const failure =
              typeof readmission.failure === "object" &&
              readmission.failure !== null
                ? {
                    tag:
                      "_tag" in readmission.failure
                        ? String(readmission.failure._tag)
                        : "Unknown",
                    sourceKind:
                      "sourceKind" in readmission.failure
                        ? String(readmission.failure.sourceKind)
                        : null,
                    executionId:
                      "executionId" in readmission.failure
                        ? String(readmission.failure.executionId)
                        : null,
                  }
                : String(readmission.failure).slice(0, 200);
            return yield* Effect.die({
              _tag: "P5ReadmissionBlockedAfterYield",
              diagnosticJson: boundedDiagnosticJson({
                failure,
                ...readmissionDiagnostic,
              }),
            });
          }
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
          const invocations = yield* sql.unsafe<{
            tool_name: string;
            arguments_json: string;
            resolved_regions_json: string;
            settlement_kind: string | null;
          }>(
            "SELECT tool_name, arguments_json, resolved_regions_json, settlement_kind FROM tool_invocations ORDER BY invocation_id",
          );

          return {
            created: created.resolution._tag,
            assigned: assigned.resolution._tag,
            decision: decision._tag,
            selections: step.selections,
            focus: decision._tag === "AdmitWork" ? "Work" : decision._tag,
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
            invocations,
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
          invocations: ReadonlyArray<{
            tool_name: string;
            arguments_json: string;
            resolved_regions_json: string;
            settlement_kind: string | null;
          }>;
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
    expect(result.decision).toBe("AdmitWork");
    expect(result.focus).toBe("Work");
    expect(result.firstAdmit).toBe("Committed");
    expect(result.conflict).toBe("ActiveExecutionConflict");

    expect(result.firstSettlement._tag).toBe("Completed");
    expect(result.secondSettlement._tag).toBe("Completed");
    if (result.firstSettlement._tag === "Completed") {
      expect(result.firstSettlement.result?._tag).toBe("Yielded");
    }
    if (result.secondSettlement._tag === "Completed") {
      expect(result.secondSettlement.result?._tag).toBe("Yielded");
    }

    expect(result.waitsAfterYield).toBe(1);
    expect(result.woken).toBe("AdmitWork");
    expect(result.waitsAfterWake).toBe(0);
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]?.tool_name).toBe("shell");
    expect(
      JSON.parse(result.invocations[0]?.arguments_json ?? "{}"),
    ).toMatchObject({
      command: "echo hello",
    });
    expect(
      result.invocations[0]?.settlement_kind,
      JSON.stringify({
        invocation: result.invocations[0],
        observations: result.entries
          .filter((entry) => entry.entry_kind === "Observation")
          .map((entry) => JSON.parse(entry.payload_json) as unknown),
      }),
    ).toBe("Success");
    expect(
      JSON.parse(result.invocations[0]?.resolved_regions_json ?? "[]"),
    ).not.toHaveLength(0);

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
        (e) =>
          JSON.parse(e.payload_json) as {
            _tag?: string;
            source?: string;
            observation?: { text?: string };
            outputText?: string;
            status?: string;
          },
      );
    const shellObservation = observations.find(
      (o) =>
        o._tag === "ToolResult" &&
        o.status === "Succeeded" &&
        JSON.stringify(o).includes("exitCode"),
    );
    expect(shellObservation).toBeDefined();
    expect(shellObservation?.outputText).toContain('"exitCode":0');
    expect(observations.some((o) => o._tag === "DirectiveUnsupported")).toBe(
      false,
    );

    // P8 verification tables remain available in the current schema fixture.
    expect([...result.verificationTables].sort()).toEqual([
      "verification_evidence",
      "verification_executions",
      "verifications",
    ]);
  });
});
