import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Option } from "effect";
import {
  AgentLoopStepStoreLive,
  ClockLive,
  P39RecoveryEvidenceStoreLive,
  SandboxPolicyRequirementReadPortLive,
  layer as sqliteLayer,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  AgentLoopStepStore,
  canonicalArgumentsDigestV1,
  P39RecoveryEvidenceStore,
  type RecoveryBindingV1,
  recoveryBindingV1Digest,
  SandboxPolicyRequirementReadPort,
  ToolInvocationStore,
  TransactionPort,
  targetResourceIdentityDigestV1,
} from "../../../packages/ports/src/index.js";

const ids = {
  project: "prj_018f2b3c-4d5e-7abc-8def-0123456789d1",
  workspace: "ws_018f2b3c-4d5e-7abc-8def-0123456789d1",
  session: "ses_018f2b3c-4d5e-7abc-8def-0123456789d1",
  work: "wrk_018f2b3c-4d5e-7abc-8def-0123456789d1",
  execution: "exe_018f2b3c-4d5e-7abc-8def-0123456789d1",
  turn: "ptn_018f2b3c-4d5e-7abc-8def-0123456789d1",
  invocation: "tin_018f2b3c-4d5e-7abc-8def-0123456789d1",
} as const;

const now = "2026-10-19T00:00:00.000Z";
const workerId = "worker:sandbox-policy-fixture";
const workerIncarnationId = "incarnation:sandbox-policy-fixture";
const logicalActionId = "lac_018f2b3c-4d5e-7abc-8def-0123456789d1";
const callRef = "sandbox-policy-fixture-call";
const toolName = "shell";
const toolVersion = "1";
const argumentsJson = '{"command":"printf sandbox-policy-marker"}';
const boundaryAddress = (path: string) => ({ _tag: "GitWorktree", path });
const regionFor = (path: string) => ({
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "GitWorktree", path },
});
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Seeds only the canonical project/workspace/work/Execution substrate with
 * SQL (the circular root-workspace FK has no creation port), then uses the
 * production P3/P4/P39 stores to create and verify the exact Pending action. */
export const seedSandboxPolicyPendingAction = async (input: {
  readonly databaseFilename: string;
  readonly primaryWorktreePath: string;
}) => {
  const db = new DatabaseSync(input.databaseFilename);
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO projects (project_id, name, root_workspace_id,
        project_policy, project_policy_revision, default_configuration,
        environment_ref, lifecycle, revision, created_at, updated_at)
       VALUES (?, 'sandbox policy qualification', ?, '{}', 0, '{}',
         'local', 'Open', 1, ?, ?)`,
    ).run(ids.project, ids.workspace, now, now);
    db.prepare(
      `INSERT INTO sessions (session_id, binding_kind, workspace_id,
        execution_id, context_epoch, created_at)
       VALUES (?, 'WorkspacePrimary', ?, NULL, 0, ?)`,
    ).run(ids.session, ids.workspace, now);
    db.prepare(
      `INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id,
        name, responsibility_definition, responsibility_revision,
        resource_boundary, resource_boundary_revision, agent_binding,
        primary_session_id, current_work_id, workspace_policy,
        workspace_policy_revision, revision, lifecycle, created_at, updated_at)
       VALUES (?, ?, NULL, 'root', ?, 1, ?, 1, ?, ?, ?, '{}', 0, 3,
         'Active', ?, ?)`,
    ).run(
      ids.workspace,
      ids.project,
      JSON.stringify({
        purpose: "sandbox policy qualification",
        ownedResponsibilities: [],
        obligations: [],
        includes: [],
        excludes: [],
        interfaces: [],
      }),
      JSON.stringify({
        basisResponsibilityRevision: 1,
        addresses: [boundaryAddress(input.primaryWorktreePath)],
      }),
      JSON.stringify({
        _tag: "ResponsibilityBoundAgentBinding",
        workspaceId: ids.workspace,
      }),
      ids.session,
      ids.work,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO works (work_id, project_id, workspace_id, objective, why,
        constraints, completion_expectation, verification_mission,
        provenance, lifecycle, revision, created_at, updated_at)
       VALUES (?, ?, ?, 'sandbox policy qualification', 'test fixture', '[]',
         'park exact action until approval', '{}', '{}', 'Open', 1, ?, ?)`,
    ).run(ids.work, ids.project, ids.workspace, now, now);
    db.prepare(
      `INSERT INTO executions (execution_id, project_id, binding_kind,
        workspace_id, episode_kind, episode_ref, episode_revision,
        parent_execution_id, mission, session_id, admitted_at,
        stop_requested_at, settlement_kind, settlement_json, settled_at)
       VALUES (?, ?, 'workspace', ?, 'WorkEpisode', ?, 1, NULL, NULL, ?, ?,
         NULL, NULL, NULL, NULL)`,
    ).run(
      ids.execution,
      ids.project,
      ids.workspace,
      ids.work,
      ids.session,
      now,
    );
    db.prepare(
      `INSERT INTO provider_turns (provider_turn_id, execution_id,
        session_id, context_epoch, model_ref, output_contract_ref,
        manifest_id, started_at, settled_at, finish_reason, usage_json, created_at)
       VALUES (?, ?, ?, 0, 'fixture-model', 'action-call-v1',
         'manifest:sandbox-policy-fixture', ?, ?, 'stop', '{}', ?)`,
    ).run(ids.turn, ids.execution, ids.session, now, now, now);
    db.prepare(
      `INSERT INTO provider_attempts (provider_turn_id, attempt_no,
        started_at, settled_at, outcome, provider_error_kind,
        transport_metadata_json, success_evidence_version)
       VALUES (?, 0, ?, ?, 'Success', NULL, '{}', 'fixture-v1')`,
    ).run(ids.turn, now, now);
    const outputJson = '{"_tag":"ToolCall","name":"shell"}';
    db.prepare(
      `INSERT INTO session_entries (session_id, sequence, entry_kind,
        item_type, schema_version, context_epoch, payload_json, created_at,
        source_kind, source_ref, content_hash)
       VALUES (?, 1, 'ModelOutput', 'ToolCall', 2, 0, ?, ?,
         'ProviderTurn', ?, ?)`,
    ).run(ids.session, outputJson, now, ids.turn, sha256(outputJson));
    db.prepare(
      `UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?`,
    ).run(ids.work, ids.workspace);
    db.prepare(
      `INSERT INTO agent_execution_state (execution_id, episode_json,
        wake_reason, current_mode, active_skill_refs_json, turn_no,
        recent_directive_refs_json, recent_action_fingerprints_json, updated_at)
       VALUES (?, ?, 'HumanIntervention', NULL, '[]', 0, '[]', '[]', ?)`,
    ).run(
      ids.execution,
      JSON.stringify({
        _tag: "WorkEpisode",
        workId: ids.work,
        targetWorkRevision: 1,
      }),
      now,
    );
    db.prepare(
      `INSERT INTO worktrees (worktree_id, project_id, workspace_id, path,
        repository_ref, branch, state, created_at, retired_at)
       VALUES ('wt_sandbox_policy_fixture', ?, ?, ?, NULL, NULL, 'Active', ?, NULL)`,
    ).run(ids.project, ids.workspace, input.primaryWorktreePath, now);
    db.prepare(
      `INSERT INTO execution_leases (execution_id, worker_id,
        worker_incarnation_id, generation, expires_at, updated_at)
       VALUES (?, ?, ?, 0, '2999-01-01T00:00:00.000Z', ?)`,
    ).run(ids.execution, workerId, workerIncarnationId, now);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  const infra = Layer.mergeAll(
    sqliteLayer({ filename: input.databaseFilename }),
    ClockLive,
  );
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(AgentLoopStepStoreLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(P39RecoveryEvidenceStoreLive, infra),
    Layer.provide(SandboxPolicyRequirementReadPortLive, infra),
  );
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const steps = yield* AgentLoopStepStore;
        const invocations = yield* ToolInvocationStore;
        const recovery = yield* P39RecoveryEvidenceStore;
        const requirements = yield* SandboxPolicyRequirementReadPort;
        const fence = {
          executionId: ids.execution,
          workerId,
          workerIncarnationId,
          fencingGeneration: 0,
        } as const;
        const identity = {
          executionId: ids.execution,
          logicalStepNo: 0,
          repairAttempt: 0,
        } as const;
        const region = regionFor(input.primaryWorktreePath);
        const outputHash = sha256("fixture-provider-output");
        const prepared = {
          identity,
          providerTurnId: ids.turn,
          state: "Prepared" as const,
          nextActionIndex: 0,
          revision: 0,
          updatedAt: now,
        };
        yield* tx.transact(
          Effect.gen(function* () {
            yield* steps.createPrepared(prepared, fence);
            yield* steps.ensureProviderTurnLink(
              {
                identity,
                overflowOrdinal: 0,
                role: "Inference",
                providerTurnId: ids.turn,
                contextEpoch: 0 as never,
                state: "SettledSuccess",
                createdAt: now,
              },
              fence,
            );
            const transitions = [
              {
                from: "Prepared" as const,
                to: "ProviderResultAvailable" as const,
                revision: 1,
                additions: {},
              },
              {
                from: "ProviderResultAvailable" as const,
                to: "OutputAccepted" as const,
                revision: 2,
                additions: {
                  decoderVersion: "fixture-v1",
                  decodedOutputHash: outputHash,
                  modelOutputSessionSequence: 1,
                },
              },
              {
                from: "OutputAccepted" as const,
                to: "ActionsInProgress" as const,
                revision: 3,
                additions: {},
              },
            ];
            let prior = prepared;
            for (const transition of transitions) {
              const next = {
                ...prior,
                ...transition.additions,
                state: transition.to,
                revision: transition.revision,
                updatedAt: now,
              };
              yield* steps.transition(
                {
                  identity,
                  expectedRevision: prior.revision,
                  expectedState: transition.from,
                  next,
                },
                fence,
              );
              prior = next;
            }
            const inputHash = sha256(argumentsJson);
            yield* steps.createAction(
              {
                identity,
                actionIndex: 0,
                logicalActionId,
                callRef,
                routeKind: "Executable",
                actionKind: toolName,
                inputHash,
                state: "Pending",
                revision: 0,
                updatedAt: now,
              },
              fence,
            );
            yield* invocations.recordIntent(
              {
                invocationId: ids.invocation as never,
                executionId: ids.execution as never,
                workspaceId: ids.workspace as never,
                toolName,
                toolVersion,
                sideEffectSemantics: "NonIdempotent",
                argumentsJson,
                resolvedRegions: [region],
                approvalId: null,
                intentAt: now,
              },
              fence,
              now,
            );
            const binding: RecoveryBindingV1 = {
              bindingVersion: 1,
              digestAlgorithm: "SHA-256",
              executionId: ids.execution as never,
              invocationId: ids.invocation as never,
              providerTurnId: ids.turn as never,
              logicalStepNo: 0,
              repairAttempt: 0,
              logicalActionId,
              actionIndex: 0,
              callRef,
              toolName,
              toolVersion,
              toolDefinitionHash: sha256("shell@1:fixture"),
              sideEffectSemantics: "NonIdempotent",
              canonicalArgumentsDigest: canonicalArgumentsDigestV1(
                JSON.parse(argumentsJson) as unknown,
              ),
              targetResourceIdentityDigest: targetResourceIdentityDigestV1([
                region,
              ]),
              resourceBoundaryRevision: 1,
              environmentRevision: "0",
              authoritySourceRevision: null,
              principalId: "user:local",
              capability: null,
              permissionGrantRevisions: [],
              workspacePolicyRevision: 0,
              projectPolicyRevision: 0,
              controlBasisDigest: sha256("fixture-control-basis"),
              approvalId: null,
              approvalSubject: null,
              approvalPreConsumeRevision: null,
              approvalConsumedRevision: null,
              approvalExpiresAt: null,
              approvalTargetDigest: null,
              approvalActionDigest: null,
              approvalConsumedBy: null,
              profileId: null,
              profileVersion: null,
              profileHash: null,
              profileProtocol: null,
              effectKey: null,
            };
            yield* recovery.bindClaim({ binding, createdAt: now });
          }),
        );
        const requirement = yield* tx.transact(
          requirements.findPendingByExecution({
            projectId: ids.project as never,
            workspaceId: ids.workspace as never,
            executionId: ids.execution as never,
          }),
        );
        const record = yield* tx.transact(
          invocations.findById(ids.invocation as never),
        );
        const binding = yield* tx.transact(
          recovery.findBinding(ids.invocation as never),
        );
        const step = yield* tx.transact(
          steps.findCurrent(ids.execution as never),
        );
        const actions = Option.isSome(step)
          ? yield* tx.transact(steps.listActions(step.value.identity))
          : [];
        return { requirement, record, binding, step, actions };
      }),
      stores,
    ),
  );
  if (
    Option.isNone(result.requirement) ||
    Option.isNone(result.record) ||
    result.record.value.effectAdmissionState !== "NotAdmitted" ||
    result.record.value.settledAt !== null ||
    Option.isNone(result.binding) ||
    result.binding.value.bindingSha256 !==
      recoveryBindingV1Digest(
        JSON.parse(result.binding.value.canonicalJson) as RecoveryBindingV1,
      ) ||
    Option.isNone(result.step) ||
    result.step.value.state !== "ActionsInProgress" ||
    result.step.value.nextActionIndex !== 0 ||
    result.actions.length !== 1 ||
    result.actions[0]?.state !== "Pending"
  ) {
    throw new Error(
      "P3/P4 production-store readback did not prove exact pending sandbox action",
    );
  }

  const finalDb = new DatabaseSync(input.databaseFilename, { readOnly: true });
  try {
    const counts = finalDb
      .prepare(
        `SELECT (SELECT COUNT(*) FROM execution_leases WHERE execution_id = ?) AS leases,
        (SELECT COUNT(*) FROM agent_loop_step_actions WHERE execution_id = ? AND state = 'Pending') AS pending_actions,
        (SELECT COUNT(*) FROM tool_invocations WHERE invocation_id = ? AND effect_admission_state = 'NotAdmitted' AND settled_at IS NULL) AS not_admitted,
        (SELECT COUNT(*) FROM tool_invocation_recovery_bindings WHERE invocation_id = ?) AS recovery_bindings`,
      )
      .get(ids.execution, ids.execution, ids.invocation, ids.invocation) as {
      leases: number;
      pending_actions: number;
      not_admitted: number;
      recovery_bindings: number;
    };
    if (
      counts.leases !== 1 ||
      counts.pending_actions !== 1 ||
      counts.not_admitted !== 1 ||
      counts.recovery_bindings !== 1
    ) {
      throw new Error(
        `durable fixture readback mismatch: ${JSON.stringify(counts)}`,
      );
    }
  } finally {
    finalDb.close();
  }
  const cleanupDb = new DatabaseSync(input.databaseFilename);
  try {
    cleanupDb
      .prepare("DELETE FROM execution_leases WHERE execution_id = ?")
      .run(ids.execution);
  } finally {
    cleanupDb.close();
  }
  return {
    ...ids,
    logicalActionId,
    callRef,
    recoveryBindingDigest: result.binding.value.bindingSha256,
  };
};
