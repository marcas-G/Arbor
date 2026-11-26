// Shared P38 approval operations — moved verbatim from
// p38-executable-approval-public.functional.test.ts (B5 split).
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../../../support/lease-qualification.js";
import type { ProductionFixture } from "../../../support/production-fixture.js";
import {
  type createFunctionalProject,
  type makePublicClient,
  waitForPublic,
} from "../../../support/public-client.js";
import { commitTrustedLocalP11Policy } from "../../../support/trusted-local-p11-fixture.js";
import type { ApprovalSnapshot } from "./snapshot.js";
import type { startExecutableApproval } from "./start.js";

export const commitP1BeforeExecutableApproval = async (run: {
  readonly client: ReturnType<typeof makePublicClient>;
  readonly fixture: ProductionFixture;
  readonly project: Awaited<ReturnType<typeof createFunctionalProject>>;
  readonly before: ApprovalSnapshot;
  readonly snapshot: () => ApprovalSnapshot;
  readonly sandboxPolicyExpiresAt: string;
}) => {
  const executionId = run.before.approval?.execution_id;
  if (executionId === undefined) {
    throw new Error("P38 pre-intent policy qualification lacks an Execution");
  }
  const expiresAt = run.sandboxPolicyExpiresAt;
  const readOracle = () => {
    const db = new DatabaseSync(run.fixture.databaseFile, { readOnly: true });
    try {
      const count = (sql: string, ...parameters: ReadonlyArray<string>) =>
        Number(
          (db.prepare(sql).get(...parameters) as { readonly count: number })
            .count,
        );
      return {
        commands: count("SELECT COUNT(*) AS count FROM commands"),
        events: count("SELECT COUNT(*) AS count FROM domain_events"),
        policyDecisions: count(
          "SELECT COUNT(*) AS count FROM sandbox_policy_decisions WHERE execution_id = ?",
          executionId,
        ),
        invocations: count(
          "SELECT COUNT(*) AS count FROM tool_invocations WHERE execution_id = ?",
          executionId,
        ),
        recoveryBindings: count(
          "SELECT COUNT(*) AS count FROM tool_invocation_recovery_bindings b JOIN tool_invocations i USING (invocation_id) WHERE i.execution_id = ?",
          executionId,
        ),
        providerCalls: run.fixture.providerCalls.length,
      };
    } finally {
      db.close();
    }
  };
  const beforeRead = { state: run.snapshot(), writes: readOracle() };
  expect(beforeRead.state.approval?.state).toBe("Pending");
  expect(beforeRead.state.invocation).toBeUndefined();
  expect(beforeRead.state.recoveryBinding).toBeUndefined();
  expect(beforeRead.state.effectCount).toBe(0);
  let detail: { readonly sandboxPolicyCandidateRead?: unknown };
  try {
    detail = await run.client.view<{
      readonly sandboxPolicyCandidateRead?: unknown;
    }>("workspace-detail", { workspaceId: run.project.rootWorkspaceId });
  } catch (error) {
    throw new Error(
      `P38 public CandidateRead failed: ${String(error)}; p4=${JSON.stringify(run.snapshot())}; daemon=${run.fixture.daemonErrors.join(" | ")}; providerCalls=${run.fixture.providerCalls.length}`,
      { cause: error },
    );
  }
  expect(detail.sandboxPolicyCandidateRead).toBeDefined();
  expect(run.snapshot()).toEqual(beforeRead.state);
  expect(readOracle()).toEqual(beforeRead.writes);
  await commitTrustedLocalP11Policy({
    client: run.client,
    baseUrl: run.fixture.baseUrl,
    databaseFile: run.fixture.databaseFile,
    projectId: run.project.projectId,
    workspaceId: run.project.rootWorkspaceId,
    executionId,
    expiresAt,
  });
  expect(run.snapshot()).toEqual(beforeRead.state);
};

export const expectP38ReceiptProjection = (
  snapshot: ApprovalSnapshot,
  run: {
    readonly approvalId: string;
    readonly revision: number;
    readonly before: ApprovalSnapshot;
  },
  expectedAttempt: {
    readonly admissionState: string;
    readonly admissionSource: string;
  } = { admissionState: "NotAdmitted", admissionSource: "P39Claim" },
) => {
  const approval = snapshot.approval;
  const canonicalBindingJson = snapshot.recoveryBinding?.canonical_binding_json;
  if (
    approval === undefined ||
    canonicalBindingJson === null ||
    canonicalBindingJson === undefined
  ) {
    throw new Error("P38 approval or P39 RecoveryBinding snapshot was absent");
  }
  const binding = JSON.parse(canonicalBindingJson) as Record<string, unknown>;
  const targetResourceSpaceIds = JSON.parse(
    approval.target_resource_space_ids_json,
  ) as ReadonlyArray<string>;
  const approvalTargetDigest = createHash("sha256")
    .update(JSON.stringify({ targetResourceSpaceIds }))
    .digest("hex");
  expect(binding).toMatchObject({
    executionId: approval.execution_id,
    invocationId: approval.tool_invocation_id,
    providerTurnId: snapshot.step?.provider_turn_id,
    logicalStepNo: approval.logical_step_no,
    repairAttempt: approval.repair_attempt,
    logicalActionId: approval.logical_action_id,
    actionIndex: approval.action_index,
    callRef: approval.call_ref,
    approvalId: run.approvalId,
    approvalSubject: approval.subject_ref,
    approvalPreConsumeRevision: run.revision + 1,
    approvalConsumedRevision: run.revision + 2,
    approvalExpiresAt: approval.expires_at,
    approvalTargetDigest,
    approvalActionDigest: approval.action_digest,
    approvalConsumedBy: approval.tool_invocation_id,
  });
  expect(snapshot.recoveryBinding?.recovery_binding_state).toBe("Bound");
  expect(snapshot.recoveryBinding?.recovery_binding_sha256).toMatch(
    /^[0-9a-f]{64}$/u,
  );
  expect(snapshot.recoveryBinding?.binding_sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(snapshot.recoveryBinding?.binding_sha256).toBe(
    snapshot.recoveryBinding?.recovery_binding_sha256,
  );
  expect(snapshot.attempt0).toMatchObject({
    attempt_no: 0,
    admission_state: expectedAttempt.admissionState,
    admission_source: expectedAttempt.admissionSource,
    binding_sha256: snapshot.recoveryBinding?.recovery_binding_sha256,
  });
  expect(approval).toMatchObject({
    state: "Consumed",
    revision: run.revision + 2,
    consumed_by: approval.tool_invocation_id,
  });
};

export const resolveApproval = async (
  client: ReturnType<typeof makePublicClient>,
  projectId: string,
  approvalId: string,
  revision: number,
  decision: "Approve" | "Reject",
) =>
  client.command(projectId, "ResolveExecutableApproval", {
    approvalId,
    expectedRevision: revision,
    decision,
    reason: `P38 public ${decision.toLowerCase()} qualification`,
  });

export const expireStoppedInitialOwner = async (
  run: Awaited<ReturnType<typeof startExecutableApproval>>,
) => {
  const executionId = run.before.approval?.execution_id;
  const owner = run.fixture.daemonProcessSnapshot();
  if (executionId === undefined || owner === null || owner.pid === undefined) {
    throw new Error("P38 Stop owner identity was unavailable before exit");
  }
  const db = new DatabaseSync(run.fixture.databaseFile, { readOnly: true });
  let lease:
    | {
        readonly worker_id: string;
        readonly worker_incarnation_id: string;
        readonly generation: number;
        readonly expires_at: string;
      }
    | undefined;
  try {
    lease = db
      .prepare(
        `SELECT worker_id, worker_incarnation_id, generation, expires_at
           FROM execution_leases WHERE execution_id = ?`,
      )
      .get(executionId) as typeof lease;
  } finally {
    db.close();
  }
  if (lease === undefined) {
    throw new Error("P38 Stop owner lease was absent before process exit");
  }
  await run.fixture.crash();
  const exited = run.fixture.daemonProcessSnapshot();
  if (exited === null || exited.alive || exited.pid !== owner.pid) {
    throw new Error("P38 Stop owner did not exit before exact lease expiry");
  }
  return expireExecutionLeaseAfterOwnerExitForQualification({
    databaseFile: run.fixture.databaseFile,
    executionId,
    expected: {
      generation: lease.generation,
      expiresAt: lease.expires_at,
      workerId: lease.worker_id,
      workerIncarnationId: lease.worker_incarnation_id,
    },
    daemon: {
      crash: run.fixture.crash,
      snapshot: run.fixture.daemonProcessSnapshot,
    },
    ownerEvidence: {
      executionId,
      processId: owner.pid,
      workerId: lease.worker_id,
      workerIncarnationId: lease.worker_incarnation_id,
      generation: lease.generation,
      provenance: "DurableGenerationWithStableIncarnation",
    },
  });
};

export const waitForResumedAction = async (
  snapshot: () => ApprovalSnapshot,
  terminalState: "Consumed" | "Rejected" | "Expired",
) => {
  const expectedActionState =
    terminalState === "Consumed" ? "Applied" : "TerminalRejected";
  const expectedSettlement =
    terminalState === "Consumed" ? "Success" : "Denied";
  const expectedEffectCount = terminalState === "Consumed" ? 1 : 0;
  return waitForPublic(
    async () => snapshot(),
    (value) =>
      value.approval?.state === terminalState &&
      value.action?.state === expectedActionState &&
      value.invocation?.settlement_kind === expectedSettlement &&
      value.effectCount === expectedEffectCount,
    45_000,
  );
};
