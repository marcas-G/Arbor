import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExecutableApprovalStoreLive,
  layer,
  P38_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import type { ToolInvocationId } from "../../../packages/domain/src/index.js";
import {
  DomainEventJournal,
  type ExecutableApprovalBinding,
  ExecutableApprovalStore,
  IdGenerator,
  InboxProjectionStore,
  sha256Hex,
  type ToolInvocationIntent,
  ToolInvocationStore,
  TransactionPort,
} from "../../../packages/ports/src/index.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-012345678ab1";
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-012345678ab1";
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-012345678ab1";
const executionId = "exe_018f2b3c-4d5e-7abc-8def-012345678ab1";
const workerId = "worker:ah7-p4-store";
const workerIncarnationId = "incarnation:ah7-p4-store";
const now = "2026-10-11T00:00:01.000Z";
const fence = {
  executionId: executionId as never,
  workerId,
  workerIncarnationId,
  fencingGeneration: 0 as never,
};
const childPath = resolve(
  "tests/functional/support/ah7-p4-store-crash-child.mjs",
);
const directories: string[] = [];
const activeChildren = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "close");
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

const makeIntent = (
  invocationId: string,
  approvalId: string,
): ToolInvocationIntent => ({
  invocationId: invocationId as never,
  executionId: executionId as never,
  workspaceId: workspaceId as never,
  toolName: "read",
  toolVersion: "1",
  sideEffectSemantics: "Idempotent",
  argumentsJson: "{}",
  resolvedRegions: [],
  approvalId,
  intentAt: now,
});

const bindingFor = (invocationId: string): ExecutableApprovalBinding => {
  const step = Number(invocationId.slice(-12));
  return {
    executionId: executionId as never,
    logicalStepNo: step,
    repairAttempt: 0,
    actionIndex: 0,
    logicalActionId: `action-ah7-p4-store-${step}`,
    projectId: projectId as never,
    workspaceId: workspaceId as never,
    subject: "user:ah7-p4-store" as never,
    callRef: `call-ah7-p4-store-${step}`,
    toolInvocationId: invocationId as ToolInvocationId,
    toolName: "read",
    toolVersion: "1",
    sideEffectSemantics: "Idempotent",
    argumentsJson: "{}",
    actionDigest: sha256Hex(`action:${invocationId}`),
    targetResourceSpaceIds: ["filesystem"],
    controlBasisDigest: sha256Hex(`basis:${invocationId}`),
  };
};

const consumeApproved = (
  approvals: typeof ExecutableApprovalStore.Service,
  invocationId: string,
  approvalId: string,
) =>
  approvals.consumeApproved({
    approvalId,
    expectedRevision: 1,
    consumedBy: invocationId as ToolInvocationId,
    consumedAt: now,
    binding: bindingFor(invocationId),
    executionFence: fence,
  });

const makeFixture = async () => {
  const directory = mkdtempSync(join(tmpdir(), "ah7-p4-store-crash-"));
  directories.push(directory);
  const databaseFile = join(directory, "store-crash.db");
  const sqlite = layer({ filename: databaseFile });
  const ids = Layer.succeed(IdGenerator, {
    generate: <T>(_kind: string) => Effect.succeed("event-ah7-p4-store" as T),
  });
  const inbox = Layer.succeed(InboxProjectionStore, {} as never);
  const journal = Layer.succeed(DomainEventJournal, {} as never);
  const approvals = Layer.provide(
    ExecutableApprovalStoreLive,
    Layer.mergeAll(sqlite, ids, inbox, journal),
  );
  const app = Layer.mergeAll(
    sqlite,
    ids,
    inbox,
    journal,
    approvals,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(ToolInvocationStoreLive, sqlite),
  );
  await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P38_MIGRATIONS);
        const sql = yield* SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(
              `INSERT INTO projects (
                 project_id, name, root_workspace_id, project_policy,
                 project_policy_revision, default_configuration,
                 environment_ref, lifecycle, revision, created_at, updated_at
               ) VALUES (?, 'AH7 store process', ?, '{}', 0, '{}',
                         'local', 'Open', 0, 't0', 't0')`,
              [projectId, workspaceId],
            );
            yield* sql.unsafe(
              `INSERT INTO sessions (
                 session_id, binding_kind, workspace_id, execution_id,
                 context_epoch, created_at
               ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
              [sessionId, workspaceId],
            );
            yield* sql.unsafe(
              `INSERT INTO workspaces (
                 workspace_id, project_id, parent_workspace_id, name,
                 responsibility_definition, responsibility_revision,
                 resource_boundary, resource_boundary_revision, agent_binding,
                 primary_session_id, current_work_id, workspace_policy,
                 workspace_policy_revision, revision, lifecycle,
                 created_at, updated_at
               ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}',
                         ?, NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
              [workspaceId, projectId, sessionId],
            );
            yield* sql.unsafe(
              `INSERT INTO executions (
                 execution_id, project_id, binding_kind, workspace_id,
                 episode_kind, episode_ref, episode_revision,
                 parent_execution_id, mission, session_id, admitted_at,
                 stop_requested_at, settlement_kind, settlement_json,
                 settled_at
               ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL,
                         NULL, 'AH7 store process', ?, 't0', NULL,
                         NULL, NULL, NULL)`,
              [executionId, projectId, workspaceId, sessionId],
            );
            yield* sql.unsafe(
              `INSERT INTO execution_leases (
                 execution_id, worker_id, worker_incarnation_id,
                 generation, expires_at, updated_at
               ) VALUES (?, ?, ?, 0, '2999-01-01T00:00:00.000Z', 't0')`,
              [executionId, workerId, workerIncarnationId],
            );
            for (let index = 101; index <= 106; index += 1) {
              const invocationId = invocationFor(index);
              const approvalId = approvalFor(index);
              const binding = bindingFor(invocationId);
              yield* sql.unsafe(
                `INSERT INTO agent_loop_steps (
                   execution_id,logical_step_no,repair_attempt,provider_turn_id,
                   predecessor_logical_step_no,predecessor_repair_attempt,manifest_id,state,
                   decoder_version,provider_failure_json,repair_disposition_json,successor_json,
                   next_step_reason,decoded_output_hash,model_output_session_sequence,
                   next_action_index,settlement_json,migration_provenance_json,revision,updated_at
                 ) VALUES (?,?,0,?,NULL,NULL,NULL,'ActionsInProgress',NULL,NULL,NULL,NULL,
                           NULL,NULL,NULL,1,NULL,NULL,0,?)`,
                [
                  executionId,
                  binding.logicalStepNo,
                  `ptn-ah7-p4-store-${binding.logicalStepNo}`,
                  now,
                ],
              );
              yield* sql.unsafe(
                `INSERT INTO agent_loop_step_actions (
                   execution_id,logical_step_no,repair_attempt,action_index,
                   logical_action_id,call_ref,route_kind,action_kind,input_hash,
                   state,result_ref,settlement_ref,disposition_json,
                   observation_source_ref,revision,updated_at
                 ) VALUES (?,?,0,0,?,?,'Executable','read',?,'Pending',
                           NULL,NULL,NULL,NULL,0,?)`,
                [
                  executionId,
                  binding.logicalStepNo,
                  binding.logicalActionId,
                  binding.callRef,
                  sha256Hex(binding.argumentsJson),
                  now,
                ],
              );
              yield* sql.unsafe(
                `INSERT INTO action_approvals (
                   approval_id,route_kind,project_id,workspace_id,execution_id,
                   subject_ref,stable_action_id,action_version,side_effect_semantics,
                   action_digest,arguments_json,target_ref,target_resource_space_ids_json,
                   control_basis_digest,state,revision,requested_at,expires_at,
                   decided_at,decided_by,decision_reason,consumed_at,consumed_by,
                   binding_proven,source_state,logical_step_no,repair_attempt,
                   action_index,logical_action_id,call_ref,tool_invocation_id,
                   cancelled_at,cancelled_by,cancellation_reason
                 ) VALUES (?,'Executable',?,?,?,?,?,?,?,?,?,?,?,?, 'Approved',1,
                           ?,? ,?, ?,NULL,NULL,NULL,1,NULL,?,0,0,?,?,?,NULL,NULL,NULL)`,
                [
                  approvalId,
                  projectId,
                  workspaceId,
                  executionId,
                  binding.subject,
                  binding.toolName,
                  binding.toolVersion,
                  binding.sideEffectSemantics,
                  binding.actionDigest,
                  binding.argumentsJson,
                  JSON.stringify(binding.targetResourceSpaceIds),
                  JSON.stringify(binding.targetResourceSpaceIds),
                  binding.controlBasisDigest,
                  now,
                  "2999-01-01T00:00:00.000Z",
                  now,
                  binding.subject,
                  binding.logicalStepNo,
                  binding.logicalActionId,
                  binding.callRef,
                  invocationId,
                ],
              );
            }
          }),
        );
      }),
      app,
    ),
  );
  return { databaseFile, app };
};

const approvalFor = (number: number) =>
  `apr_018f2b3c-4d5e-7abc-8def-${String(number).padStart(12, "0")}`;
const invocationFor = (number: number): ToolInvocationId =>
  `tin_018f2b3c-4d5e-7abc-8def-${String(number).padStart(12, "0")}` as ToolInvocationId;

interface StoreChildHandle {
  readonly child: ChildProcess;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly closed: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly boundary: () => Promise<void>;
}

const startStoreChild = (input: {
  readonly databaseFile: string;
  readonly mode: "claim" | "denial" | "interruption";
  readonly boundary?: "beforeCommit" | "afterCommit";
  readonly invocationId: string;
  readonly approvalId: string;
}): StoreChildHandle => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(process.execPath, [childPath], {
    cwd: resolve("."),
    env: {
      ...process.env,
      ARBOR_AH7_STORE_DB: input.databaseFile,
      ARBOR_AH7_STORE_MODE: input.mode,
      ARBOR_AH7_STORE_BOUNDARY: input.boundary ?? "none",
      ARBOR_AH7_STORE_INVOCATION_ID: input.invocationId,
      ARBOR_AH7_STORE_APPROVAL_ID: input.approvalId,
      ARBOR_AH7_STORE_PROJECT_ID: projectId,
      ARBOR_AH7_STORE_EXECUTION_ID: executionId,
      ARBOR_AH7_STORE_WORKSPACE_ID: workspaceId,
      ARBOR_AH7_STORE_WORKER_ID: workerId,
      ARBOR_AH7_STORE_WORKER_INCARNATION_ID: workerIncarnationId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBuffer = "";
  let resolveBoundary!: () => void;
  let rejectBoundary!: (error: Error) => void;
  const boundarySeen = new Promise<void>((resolveBoundarySeen, reject) => {
    resolveBoundary = () => resolveBoundarySeen();
    rejectBoundary = reject;
  });
  let sawBoundary = false;
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveClose) => {
    child.once("close", (code, signal) => {
      activeChildren.delete(child);
      resolveClose({ code, signal });
    });
  });
  activeChildren.add(child);
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.length > 0) stdout.push(line);
      try {
        const event = JSON.parse(line) as {
          tag?: string;
          mode?: string;
          boundary?: string;
          invocationId?: string;
          pid?: number;
          childAlive?: boolean;
        };
        if (
          event.tag === "AH7_P4_STORE_BOUNDARY" &&
          event.mode === input.mode &&
          event.boundary === input.boundary &&
          event.invocationId === input.invocationId &&
          event.childAlive === true &&
          Number.isInteger(event.pid)
        ) {
          sawBoundary = true;
          resolveBoundary();
        }
      } catch {
        // Preserve non-JSON child output for diagnostics.
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8").trim();
    if (line.length > 0) stderr.push(line);
  });
  child.once("error", (error) => rejectBoundary(error));
  child.once("close", (code, signal) => {
    if (!sawBoundary && input.boundary !== undefined) {
      rejectBoundary(
        new Error(
          `store child exited before boundary: code=${String(code)} signal=${String(signal)} stdout=${stdout.join(" | ")} stderr=${stderr.join(" | ")}`,
        ),
      );
    }
  });
  const boundary = async () => {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("AH7 store child boundary timed out")),
        15_000,
      );
      void boundarySeen.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer),
      );
    });
    await Promise.race([boundarySeen, timeout]);
  };
  return { child, stdout, stderr, closed, boundary };
};

const killStoreChild = async (handle: StoreChildHandle) => {
  expect(handle.child.exitCode).toBeNull();
  expect(handle.child.signalCode).toBeNull();
  expect(handle.child.kill("SIGKILL")).toBe(true);
  const exit = await handle.closed;
  expect(exit).toEqual({ code: null, signal: "SIGKILL" });
  return exit;
};

const runStoreChild = async (input: {
  readonly databaseFile: string;
  readonly mode: "claim" | "denial" | "interruption";
  readonly invocationId: string;
  readonly approvalId: string;
}) => {
  const handle = startStoreChild(input);
  const exit = await handle.closed;
  expect(exit).toEqual({ code: 0, signal: null });
  return handle;
};

interface InvocationSnapshot {
  readonly invocation_id: string;
  readonly effect_admission_state: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
  readonly settlement_json: string | null;
  readonly approval_id: string | null;
}

interface ApprovalSnapshot {
  readonly state: string;
  readonly revision: number;
  readonly consumed_by: string | null;
}

const snapshot = (
  databaseFile: string,
  invocationId: string,
  approvalId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      invocation: db
        .prepare(
          `SELECT invocation_id, effect_admission_state, settled_at,
                  settlement_kind, settlement_json, approval_id
             FROM tool_invocations WHERE invocation_id = ?`,
        )
        .get(invocationId) as InvocationSnapshot | undefined,
      invocationCount: (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
          )
          .get(invocationId) as { count: number }
      ).count,
      approval: db
        .prepare(
          "SELECT state, revision, consumed_by FROM action_approvals WHERE approval_id = ?",
        )
        .get(approvalId) as ApprovalSnapshot | undefined,
      stopRequestedAt: (
        db
          .prepare(
            "SELECT stop_requested_at FROM executions WHERE execution_id = ?",
          )
          .get(executionId) as { stop_requested_at: string | null }
      ).stop_requested_at,
    };
  } finally {
    db.close();
  }
};

describe("AH7 P4 store process crash boundaries", () => {
  it("proves before/after commit claim, Denied and Interrupted recovery with independent Node processes", async () => {
    const { databaseFile, app } = await makeFixture();
    const claimBeforeId = invocationFor(101);
    const claimBeforeApproval = approvalFor(101);
    const claimAfterId = invocationFor(102);
    const claimAfterApproval = approvalFor(102);
    const denialBeforeId = invocationFor(103);
    const denialBeforeApproval = approvalFor(103);
    const denialAfterId = invocationFor(104);
    const denialAfterApproval = approvalFor(104);
    const interruptBeforeId = invocationFor(105);
    const interruptBeforeApproval = approvalFor(105);
    const interruptAfterId = invocationFor(106);
    const interruptAfterApproval = approvalFor(106);

    const beforeClaim = startStoreChild({
      databaseFile,
      mode: "claim",
      boundary: "beforeCommit",
      invocationId: claimBeforeId,
      approvalId: claimBeforeApproval,
    });
    await beforeClaim.boundary();
    await killStoreChild(beforeClaim);
    expect(
      snapshot(databaseFile, claimBeforeId, claimBeforeApproval),
    ).toMatchObject({
      invocation: undefined,
      invocationCount: 0,
      approval: { state: "Approved", revision: 1, consumed_by: null },
    });
    await runStoreChild({
      databaseFile,
      mode: "claim",
      invocationId: claimBeforeId,
      approvalId: claimBeforeApproval,
    });
    expect(
      snapshot(databaseFile, claimBeforeId, claimBeforeApproval),
    ).toMatchObject({
      invocation: {
        invocation_id: claimBeforeId,
        effect_admission_state: "NotAdmitted",
        settled_at: null,
        settlement_kind: null,
        approval_id: claimBeforeApproval,
      },
      invocationCount: 1,
      approval: { state: "Consumed", revision: 2, consumed_by: claimBeforeId },
    });

    const afterClaim = startStoreChild({
      databaseFile,
      mode: "claim",
      boundary: "afterCommit",
      invocationId: claimAfterId,
      approvalId: claimAfterApproval,
    });
    await afterClaim.boundary();
    await killStoreChild(afterClaim);
    const durableClaim = snapshot(
      databaseFile,
      claimAfterId,
      claimAfterApproval,
    );
    expect(durableClaim).toMatchObject({
      invocation: {
        invocation_id: claimAfterId,
        effect_admission_state: "NotAdmitted",
        settled_at: null,
        settlement_kind: null,
        approval_id: claimAfterApproval,
      },
      invocationCount: 1,
      approval: { state: "Consumed", revision: 2, consumed_by: claimAfterId },
    });
    await runStoreChild({
      databaseFile,
      mode: "claim",
      invocationId: claimAfterId,
      approvalId: claimAfterApproval,
    });
    expect(snapshot(databaseFile, claimAfterId, claimAfterApproval)).toEqual(
      durableClaim,
    );

    const beforeDenial = startStoreChild({
      databaseFile,
      mode: "denial",
      boundary: "beforeCommit",
      invocationId: denialBeforeId,
      approvalId: denialBeforeApproval,
    });
    await beforeDenial.boundary();
    await killStoreChild(beforeDenial);
    expect(
      snapshot(databaseFile, denialBeforeId, denialBeforeApproval),
    ).toMatchObject({
      invocation: undefined,
      invocationCount: 0,
      approval: { state: "Approved", revision: 1, consumed_by: null },
    });
    await runStoreChild({
      databaseFile,
      mode: "denial",
      invocationId: denialBeforeId,
      approvalId: denialBeforeApproval,
    });
    expect(
      snapshot(databaseFile, denialBeforeId, denialBeforeApproval),
    ).toMatchObject({
      invocation: {
        invocation_id: denialBeforeId,
        effect_admission_state: "NotAdmitted",
        settlement_kind: "Denied",
        settlement_json: expect.stringContaining("InvocationAuthorityDenied"),
        approval_id: denialBeforeApproval,
      },
      invocationCount: 1,
      approval: { state: "Approved", revision: 1, consumed_by: null },
    });

    const afterDenial = startStoreChild({
      databaseFile,
      mode: "denial",
      boundary: "afterCommit",
      invocationId: denialAfterId,
      approvalId: denialAfterApproval,
    });
    await afterDenial.boundary();
    await killStoreChild(afterDenial);
    const durableDenial = snapshot(
      databaseFile,
      denialAfterId,
      denialAfterApproval,
    );
    expect(durableDenial).toMatchObject({
      invocation: {
        invocation_id: denialAfterId,
        effect_admission_state: "NotAdmitted",
        settlement_kind: "Denied",
        settlement_json: expect.stringContaining("projectionVersion"),
      },
      invocationCount: 1,
      approval: { consumed_by: null },
    });
    await runStoreChild({
      databaseFile,
      mode: "denial",
      invocationId: denialAfterId,
      approvalId: denialAfterApproval,
    });
    expect(snapshot(databaseFile, denialAfterId, denialAfterApproval)).toEqual(
      durableDenial,
    );

    const claimInterruptions = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const store = yield* ToolInvocationStore;
          const approvals = yield* ExecutableApprovalStore;
          const claims = [
            [interruptBeforeId, interruptBeforeApproval],
            [interruptAfterId, interruptAfterApproval],
          ] as const;
          for (const [invocationId, approvalId] of claims) {
            yield* tx.transact(
              Effect.gen(function* () {
                yield* store.recordIntent(
                  makeIntent(invocationId, approvalId),
                  fence,
                  now,
                );
                const consumed = yield* consumeApproved(
                  approvals,
                  invocationId,
                  approvalId,
                );
                if (consumed === false || consumed === "ExecutionStopping") {
                  return yield* Effect.fail(
                    new Error("interruption fixture claim did not commit"),
                  );
                }
              }),
            );
          }
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            "UPDATE executions SET stop_requested_at = ? WHERE execution_id = ?",
            [now, executionId],
          );
        }),
        app,
      ),
    );
    void claimInterruptions;

    const beforeInterruption = startStoreChild({
      databaseFile,
      mode: "interruption",
      boundary: "beforeCommit",
      invocationId: interruptBeforeId,
      approvalId: interruptBeforeApproval,
    });
    await beforeInterruption.boundary();
    await killStoreChild(beforeInterruption);
    expect(
      snapshot(databaseFile, interruptBeforeId, interruptBeforeApproval),
    ).toMatchObject({
      invocation: {
        effect_admission_state: "NotAdmitted",
        settled_at: null,
        settlement_kind: null,
      },
      approval: {
        state: "Consumed",
        revision: 2,
        consumed_by: interruptBeforeId,
      },
      stopRequestedAt: now,
    });
    await runStoreChild({
      databaseFile,
      mode: "interruption",
      invocationId: interruptBeforeId,
      approvalId: interruptBeforeApproval,
    });
    expect(
      snapshot(databaseFile, interruptBeforeId, interruptBeforeApproval),
    ).toMatchObject({
      invocation: {
        effect_admission_state: "NotAdmitted",
        settlement_kind: "Interrupted",
      },
      approval: {
        state: "Consumed",
        revision: 2,
        consumed_by: interruptBeforeId,
      },
      stopRequestedAt: now,
    });

    const afterInterruption = startStoreChild({
      databaseFile,
      mode: "interruption",
      boundary: "afterCommit",
      invocationId: interruptAfterId,
      approvalId: interruptAfterApproval,
    });
    await afterInterruption.boundary();
    await killStoreChild(afterInterruption);
    const durableInterruption = snapshot(
      databaseFile,
      interruptAfterId,
      interruptAfterApproval,
    );
    expect(durableInterruption).toMatchObject({
      invocation: {
        effect_admission_state: "NotAdmitted",
        settlement_kind: "Interrupted",
      },
      approval: {
        state: "Consumed",
        revision: 2,
        consumed_by: interruptAfterId,
      },
    });
    await runStoreChild({
      databaseFile,
      mode: "interruption",
      invocationId: interruptAfterId,
      approvalId: interruptAfterApproval,
    });
    expect(
      snapshot(databaseFile, interruptAfterId, interruptAfterApproval),
    ).toEqual(durableInterruption);
  }, 120_000);
});
