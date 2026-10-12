import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionId,
  LeaseGeneration,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  approvalTargetDigestV1,
  canonicalArgumentsDigestV1,
  DomainEventJournal,
  type ExecutableApprovalBinding,
  type ExecutableApprovalConsumptionReceipt,
  ExecutableApprovalStore,
  IdGenerator,
  InboxProjectionStore,
  P39RecoveryEvidenceStore,
  type RecoveryBindingV1,
  sha256Hex,
  ToolInvocationStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  CURRENT_MIGRATION_BASELINE,
  CURRENT_MIGRATIONS,
  ExecutableApprovalStoreLive,
  layer,
  P36_MIGRATIONS,
  P38_MIGRATIONS,
  P39_MAINTENANCE_MIGRATIONS,
  P39RecoveryEvidenceStoreLive,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789b1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789b1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const principal = parse(Principal)("user:p39-claim-test");
const executionFence = {
  executionId,
  workerId: "worker:p39-claim-test",
  workerIncarnationId: "incarnation:p39-claim-test",
  fencingGeneration: parse(LeaseGeneration)(0),
};
const now = "2026-10-12T12:00:00.000Z";
const expiresAt = "2026-10-13T12:00:00.000Z";
const argumentsJson = '{"path":"claim.txt"}';
const targetResourceSpaceIds = ["filesystem"];

type Scenario = {
  readonly suffix: string;
  readonly logicalStepNo: number;
  readonly fault?:
    | "after-receipt"
    | "after-binding-and-attempt"
    | "before-attempt-insert"
    | "before-bound-update";
};

const invocationIdFor = (suffix: string) =>
  parse(ToolInvocationId)(`tin_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`);

const bindingFor = (
  receipt: ExecutableApprovalConsumptionReceipt,
  logicalStepNo: number,
): RecoveryBindingV1 => ({
  bindingVersion: 1,
  digestAlgorithm: "SHA-256",
  executionId,
  invocationId: receipt.consumedBy,
  providerTurnId: parse(ProviderTurnId)(
    "ptn_018f2b3c-4d5e-7abc-8def-0123456789b1",
  ),
  logicalStepNo,
  repairAttempt: 0,
  logicalActionId: `action-p39-claim-${logicalStepNo}`,
  actionIndex: 0,
  callRef: `call-p39-claim-${logicalStepNo}`,
  toolName: "read",
  toolVersion: "2",
  toolDefinitionHash: "a".repeat(64),
  sideEffectSemantics: "ReadOnly",
  canonicalArgumentsDigest: canonicalArgumentsDigestV1(
    JSON.parse(argumentsJson),
  ),
  targetResourceIdentityDigest: "b".repeat(64),
  resourceBoundaryRevision: 0,
  environmentRevision: "environment-revision-p39",
  authoritySourceRevision: null,
  principalId: String(principal),
  capability: ["fs:read"],
  permissionGrantRevisions: [],
  workspacePolicyRevision: 0,
  projectPolicyRevision: 0,
  controlBasisDigest: "d".repeat(64),
  approvalId: receipt.approvalId,
  approvalSubject: String(receipt.binding.subject),
  approvalPreConsumeRevision: receipt.preConsumeRevision,
  approvalConsumedRevision: receipt.consumedRevision,
  approvalExpiresAt: receipt.expiresAt,
  approvalTargetDigest: approvalTargetDigestV1(
    receipt.binding.targetResourceSpaceIds,
  ),
  approvalActionDigest: receipt.binding.actionDigest,
  approvalConsumedBy: receipt.consumedBy,
  profileId: null,
  profileVersion: null,
  profileHash: null,
  profileProtocol: null,
  effectKey: null,
});

const immutableApprovalBinding = (
  invocationId: ReturnType<typeof invocationIdFor>,
  logicalStepNo: number,
): ExecutableApprovalBinding => ({
  executionId,
  logicalStepNo,
  repairAttempt: 0,
  actionIndex: 0,
  logicalActionId: `action-p39-claim-${logicalStepNo}`,
  projectId,
  workspaceId,
  subject: principal,
  callRef: `call-p39-claim-${logicalStepNo}`,
  toolInvocationId: invocationId,
  toolName: "read",
  toolVersion: "2",
  sideEffectSemantics: "ReadOnly",
  argumentsJson,
  actionDigest: sha256Hex(`action:${logicalStepNo}`),
  targetResourceSpaceIds,
  controlBasisDigest: "d".repeat(64),
});

const serviceLayer = (filename: string) => {
  const db = layer({ filename });
  const ids = Layer.succeed(IdGenerator, {
    generate: <T>(_kind: string) => Effect.succeed("event-p39-claim" as T),
  });
  const inbox = Layer.succeed(InboxProjectionStore, {} as never);
  const journal = Layer.succeed(DomainEventJournal, {} as never);
  const approvals = Layer.provide(
    ExecutableApprovalStoreLive,
    Layer.mergeAll(db, ids, inbox, journal),
  );
  return Layer.mergeAll(
    db,
    ids,
    inbox,
    journal,
    approvals,
    Layer.provide(TransactionPortLive, db),
    Layer.provide(ToolInvocationStoreLive, db),
    Layer.provide(P39RecoveryEvidenceStoreLive, db),
  );
};

const seedProjectExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
           project_id,name,root_workspace_id,project_policy,project_policy_revision,
           default_configuration,environment_ref,lifecycle,revision,created_at,updated_at
         ) VALUES (?,?,?,'{}',0,'{}','local','Open',0,?,?)`,
        [projectId, "P39 claim", workspaceId, now, now],
      );
      yield* sql.unsafe(
        `INSERT INTO sessions (
           session_id,binding_kind,workspace_id,execution_id,context_epoch,created_at
         ) VALUES (?,'WorkspacePrimary',?,NULL,0,?)`,
        [sessionId, workspaceId, now],
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
           workspace_id,project_id,parent_workspace_id,name,responsibility_definition,
           responsibility_revision,resource_boundary,resource_boundary_revision,
           agent_binding,primary_session_id,current_work_id,workspace_policy,
           workspace_policy_revision,revision,lifecycle,created_at,updated_at
         ) VALUES (?,?,NULL,'P39 claim','{}',0,'{}',0,'{}',?,NULL,'{}',0,0,'Active',?,?)`,
        [workspaceId, projectId, sessionId, now, now],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
           execution_id,project_id,binding_kind,workspace_id,mission,session_id,
           admitted_at,stop_requested_at,settlement_kind,settlement_json,settled_at
         ) VALUES (?,?,'execution_bound',?, 'P39 claim', ?, ?,NULL,NULL,NULL,NULL)`,
        [executionId, projectId, workspaceId, sessionId, now],
      );
      yield* sql.unsafe(
        `INSERT INTO execution_leases (
           execution_id,worker_id,worker_incarnation_id,generation,expires_at,updated_at
         ) VALUES (?,?,?,?,?,?)`,
        [
          executionId,
          executionFence.workerId,
          executionFence.workerIncarnationId,
          executionFence.fencingGeneration,
          expiresAt,
          now,
        ],
      );
    }),
  );
});

const seedActionAndApproval = (
  scenario: Scenario,
  invocationId: ReturnType<typeof invocationIdFor>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    expect(CURRENT_MIGRATION_BASELINE).toBe(38);
    expect(CURRENT_MIGRATIONS).toBe(P38_MIGRATIONS);
    const binding = immutableApprovalBinding(
      invocationId,
      scenario.logicalStepNo,
    );
    const approvalId = `eap_p39_claim_${scenario.suffix}`;
    const actionInputHash = sha256Hex(argumentsJson);
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
        scenario.logicalStepNo,
        `ptn_018f2b3c-4d5e-7abc-8def-0123456789${scenario.suffix}`,
        now,
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO agent_loop_step_actions (
         execution_id,logical_step_no,repair_attempt,action_index,logical_action_id,
         call_ref,route_kind,action_kind,input_hash,state,result_ref,settlement_ref,
         disposition_json,observation_source_ref,revision,updated_at
       ) VALUES (?,?,0,0,?,?,'Executable','read',?,'Pending',NULL,NULL,NULL,NULL,0,?)`,
      [
        executionId,
        scenario.logicalStepNo,
        binding.logicalActionId,
        binding.callRef,
        actionInputHash,
        now,
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO action_approvals (
         approval_id,route_kind,project_id,workspace_id,execution_id,subject_ref,
         stable_action_id,action_version,side_effect_semantics,action_digest,
         arguments_json,target_ref,target_resource_space_ids_json,control_basis_digest,
         state,revision,requested_at,expires_at,decided_at,decided_by,decision_reason,
         consumed_at,consumed_by,binding_proven,source_state,logical_step_no,
         repair_attempt,action_index,logical_action_id,call_ref,tool_invocation_id,
         cancelled_at,cancelled_by,cancellation_reason
       ) VALUES (?,'Executable',?,?,?,?,?,?,?,?,?,?,?,?, 'Approved',1,?,?,?,?,NULL,
                 NULL,NULL,1,NULL,?,0,0,?,?,?,NULL,NULL,NULL)`,
      [
        approvalId,
        projectId,
        workspaceId,
        executionId,
        principal,
        binding.toolName,
        binding.toolVersion,
        binding.sideEffectSemantics,
        binding.actionDigest,
        binding.argumentsJson,
        JSON.stringify(targetResourceSpaceIds),
        JSON.stringify(targetResourceSpaceIds),
        binding.controlBasisDigest,
        now,
        expiresAt,
        now,
        principal,
        binding.logicalStepNo,
        binding.logicalActionId,
        binding.callRef,
        invocationId,
      ],
    );
    return { approvalId, binding };
  });

const readDurableClaim = async (
  filename: string,
  approvalId: string,
  invocationId: ReturnType<typeof invocationIdFor>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const approval = yield* sql.unsafe<{
            readonly state: string;
            readonly revision: number;
            readonly consumed_by: string | null;
          }>(
            "SELECT state,revision,consumed_by FROM action_approvals WHERE approval_id=?",
            [approvalId],
          );
          const invocation = yield* sql.unsafe<{
            readonly recovery_binding_state: string;
            readonly recovery_binding_sha256: string | null;
          }>(
            "SELECT recovery_binding_state,recovery_binding_sha256 FROM tool_invocations WHERE invocation_id=?",
            [invocationId],
          );
          const bindings = yield* sql.unsafe<{ readonly n: number }>(
            "SELECT COUNT(*) AS n FROM tool_invocation_recovery_bindings WHERE invocation_id=?",
            [invocationId],
          );
          const attempts = yield* sql.unsafe<{
            readonly n: number;
            readonly attempt_no: number | null;
            readonly admission_state: string | null;
          }>(
            `SELECT COUNT(*) AS n, MIN(attempt_no) AS attempt_no,
                    MIN(admission_state) AS admission_state
               FROM tool_invocation_effect_attempts WHERE invocation_id=?`,
            [invocationId],
          );
          return {
            approval: approval[0],
            invocation: invocation[0],
            bindings: Number(bindings[0]?.n ?? 0),
            attempts: attempts[0],
          };
        }),
        layer({ filename }),
      ),
    ),
  );

const transactionProgram = (
  scenario: Scenario,
  invocationId: ReturnType<typeof invocationIdFor>,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const invocations = yield* ToolInvocationStore;
    const approvals = yield* ExecutableApprovalStore;
    const recovery = yield* P39RecoveryEvidenceStore;
    const sql = yield* SqlClient;
    yield* runMigrations(P36_MIGRATIONS);
    yield* runMigrations(P39_MAINTENANCE_MIGRATIONS);
    yield* seedProjectExecution;
    const seeded = yield* seedActionAndApproval(scenario, invocationId);
    const invocation = {
      invocationId,
      executionId,
      workspaceId,
      toolName: "read",
      toolVersion: "2",
      sideEffectSemantics: "ReadOnly" as const,
      argumentsJson,
      resolvedRegions: [] as const,
      approvalId: seeded.approvalId,
      intentAt: now,
    };
    if (scenario.fault === "before-attempt-insert") {
      yield* sql.unsafe(
        `CREATE TRIGGER p39_test_fail_attempt_insert
         BEFORE INSERT ON tool_invocation_effect_attempts
         WHEN NEW.invocation_id='${invocationId}'
         BEGIN SELECT RAISE(ABORT,'p39 test failure before attempt0'); END`,
      );
    }
    if (scenario.fault === "before-bound-update") {
      yield* sql.unsafe(
        `CREATE TRIGGER p39_test_fail_bound_update
         BEFORE UPDATE OF recovery_binding_state ON tool_invocations
         WHEN NEW.invocation_id='${invocationId}'
           AND NEW.recovery_binding_state='Bound'
         BEGIN SELECT RAISE(ABORT,'p39 test failure before Bound commit'); END`,
      );
    }
    const operation = tx.transact(
      Effect.gen(function* () {
        yield* invocations.recordIntent(invocation, executionFence, now);
        const receipt = yield* approvals.consumeApproved({
          approvalId: seeded.approvalId,
          expectedRevision: 1,
          consumedBy: invocationId,
          consumedAt: now,
          binding: seeded.binding,
          executionFence,
        });
        if (receipt === false || receipt === "ExecutionStopping") {
          return yield* Effect.fail(new Error("P38 approval was not consumed"));
        }
        if (scenario.fault === "after-receipt") {
          return yield* Effect.fail(new Error("injected after P38 receipt"));
        }
        const recoveryBinding = bindingFor(receipt, scenario.logicalStepNo);
        yield* recovery.bindClaim({ binding: recoveryBinding, createdAt: now });
        if (scenario.fault === "after-binding-and-attempt") {
          return yield* Effect.fail(new Error("injected after P39 attempt0"));
        }
        return receipt;
      }),
    );
    const result = yield* Effect.match(operation, {
      onFailure: (cause) => ({ _tag: "Left" as const, left: cause }),
      onSuccess: (receipt) => ({ _tag: "Right" as const, right: receipt }),
    });
    return { approvalId: seeded.approvalId, binding: seeded.binding, result };
  });

const withDb = async <A>(
  scenario: Scenario,
  run: (
    filename: string,
    invocationId: ReturnType<typeof invocationIdFor>,
  ) => Promise<A>,
) => {
  const directory = mkdtempSync(join(tmpdir(), "arbor-p39-claim-"));
  const filename = join(directory, "claim.sqlite");
  const invocationId = invocationIdFor(scenario.suffix);
  try {
    return await run(filename, invocationId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const runScenario = (
  filename: string,
  scenario: Scenario,
  invocationId: ReturnType<typeof invocationIdFor>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        transactionProgram(scenario, invocationId),
        serviceLayer(filename),
      ),
    ),
  );

describe("P39 P38-receipt plus RecoveryBinding claim atomicity", () => {
  it("commits one receipt, binding, attempt-0 and Bound invocation, then exact-ID replay reuses them", async () => {
    await withDb(
      { suffix: "c1", logicalStepNo: 1 },
      async (filename, invocationId) => {
        const initial = await runScenario(
          filename,
          { suffix: "c1", logicalStepNo: 1 },
          invocationId,
        );
        if (initial.result._tag === "Left") throw initial.result.left;
        expect(initial.result._tag).toBe("Right");
        if (initial.result._tag !== "Right") return;
        const receipt = initial.result.right;
        expect(receipt).toMatchObject({
          approvalId: initial.approvalId,
          preConsumeRevision: 1,
          consumedRevision: 2,
          consumedBy: invocationId,
          binding: initial.binding,
        });
        const committed = await readDurableClaim(
          filename,
          initial.approvalId,
          invocationId,
        );
        expect(committed.approval).toEqual({
          state: "Consumed",
          revision: 2,
          consumed_by: invocationId,
        });
        expect(committed.invocation).toMatchObject({
          recovery_binding_state: "Bound",
          recovery_binding_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        expect(committed.bindings).toBe(1);
        expect(committed.attempts).toMatchObject({
          n: 1,
          attempt_no: 0,
          admission_state: "NotAdmitted",
        });

        const replay = await Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                const tx = yield* TransactionPort;
                const approvals = yield* ExecutableApprovalStore;
                const recovery = yield* P39RecoveryEvidenceStore;
                return yield* tx.transact(
                  Effect.gen(function* () {
                    const sameReceipt = yield* approvals.consumeApproved({
                      approvalId: initial.approvalId,
                      expectedRevision: 1,
                      consumedBy: invocationId,
                      consumedAt: now,
                      binding: initial.binding,
                      executionFence,
                    });
                    const sameBinding = yield* recovery.bindClaim({
                      binding: bindingFor(receipt, 1),
                      createdAt: now,
                    });
                    return { sameReceipt, sameBinding };
                  }),
                );
              }),
              serviceLayer(filename),
            ),
          ),
        );
        expect(replay.sameReceipt).toEqual(receipt);
        expect(replay.sameBinding).toBe("AlreadyBound");
        const afterReplay = await readDurableClaim(
          filename,
          initial.approvalId,
          invocationId,
        );
        expect(afterReplay).toEqual(committed);
      },
    );
  });

  it("rolls back intent, P38 receipt, binding and attempt-0 at each precommit fault boundary", async () => {
    for (const [suffix, fault] of [
      ["c2", "after-receipt"],
      ["c3", "before-bound-update"],
      ["c4", "before-attempt-insert"],
      ["c5", "after-binding-and-attempt"],
    ] as const) {
      await withDb(
        { suffix, logicalStepNo: Number.parseInt(suffix[1] ?? "1", 10), fault },
        async (filename, invocationId) => {
          const failed = await runScenario(
            filename,
            {
              suffix,
              logicalStepNo: Number.parseInt(suffix[1] ?? "1", 10),
              fault,
            },
            invocationId,
          );
          expect(failed.result._tag).toBe("Left");
          const afterRollback = await readDurableClaim(
            filename,
            failed.approvalId,
            invocationId,
          );
          expect(afterRollback.approval).toEqual({
            state: "Approved",
            revision: 1,
            consumed_by: null,
          });
          expect(afterRollback.invocation).toBeUndefined();
          expect(afterRollback.bindings).toBe(0);
          expect(afterRollback.attempts?.n).toBe(0);
        },
      );
    }
  });
});
