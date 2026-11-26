import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../../support/lease-qualification.js";
import { waitForPublic } from "../../support/public-client.js";
import {
  commitP1BeforeExecutableApproval,
  p38AfterEach,
  resolveApproval,
  sandboxPolicyV2DaemonChild,
  startExecutableApproval,
} from "./support.js";

afterEach(p38AfterEach);

describe("pending P38 public Executable approval qualification", () => {
  // Disabled restart recovery re-enters only the exact bound NotAdmitted P4
  // invocation; it never re-samples the Provider action or exposes shell.
  it("terminalizes the same durable NotAdmitted action before effect admission and projects exact unavailable Attention", async () => {
    const marker = `P38-NATIVE-DENIAL-${crypto.randomUUID().slice(0, 8)}`;
    const probes: Array<{
      readonly tag?: string;
      readonly boundary?: string;
      readonly executionId?: string;
      readonly invocationId?: string;
      readonly denialReasonCode?: string;
    }> = [];
    const run = await startExecutableApproval(marker, {
      trustedLocalSandboxPolicy: true,
      firstDaemonEntry: sandboxPolicyV2DaemonChild,
      daemonEnvironment: { ARBOR_AH_BOUNDARY: "AH7AfterToolIntentCommit" },
      onDaemonStdout: (line) => {
        try {
          const event = JSON.parse(line) as (typeof probes)[number];
          if (event.tag === "AH_PROBE") probes.push(event);
        } catch {
          // Ordinary daemon output is diagnostic data, not a probe.
        }
      },
    });
    await commitP1BeforeExecutableApproval(run);
    await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Approve",
    );
    const executionId = run.before.approval?.execution_id;
    const invocationId = run.before.approval?.tool_invocation_id;
    if (executionId === undefined || invocationId === undefined) {
      throw new Error("P38 exact Execution/ToolInvocation identity is absent");
    }
    await waitForPublic(
      async () =>
        probes.find(
          (probe) =>
            probe.boundary === "AH7AfterToolIntentCommit" &&
            probe.executionId === executionId &&
            probe.invocationId === invocationId,
        ),
      (probe) => probe !== undefined,
      60_000,
    );

    const leaseForOwner = () => {
      const owner = run.fixture.daemonProcessSnapshot();
      const processId = owner?.pid;
      if (processId === undefined) {
        throw new Error("P38 denial qualification lost the daemon owner PID");
      }
      const db = new DatabaseSync(run.fixture.databaseFile, { readOnly: true });
      try {
        const lease = db
          .prepare(
            `SELECT worker_id, worker_incarnation_id, generation, expires_at
               FROM execution_leases WHERE execution_id = ?`,
          )
          .get(executionId) as
          | {
              readonly worker_id: string;
              readonly worker_incarnation_id: string;
              readonly generation: number;
              readonly expires_at: string;
            }
          | undefined;
        if (lease === undefined) throw new Error("P38 denial lease is absent");
        return { processId, lease };
      } finally {
        db.close();
      }
    };
    const crashExpireAndRestart = async (boundary: string) => {
      const { processId, lease } = leaseForOwner();
      await run.fixture.crash();
      await expireExecutionLeaseAfterOwnerExitForQualification({
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
          processId,
          workerId: lease.worker_id,
          workerIncarnationId: lease.worker_incarnation_id,
          generation: lease.generation,
          provenance: "DurableGenerationWithStableIncarnation",
        },
      });
      await run.fixture.restart({
        entry: sandboxPolicyV2DaemonChild,
        daemonEnvironment: {
          ARBOR_TEST_ONLY_TRUSTED_LOCAL_PROCESS_EXECUTION: "0",
          ARBOR_AH_BOUNDARY: boundary,
        },
      });
    };

    const preDenial = run.snapshot();
    expect(preDenial.invocation).toMatchObject({
      invocation_id: invocationId,
      effect_admission_state: "NotAdmitted",
      settlement_kind: null,
    });
    expect(preDenial.effectCount).toBe(0);
    await crashExpireAndRestart("NativeProcessModeDenialBeforeCommit");
    const beforeCommitProbe = await waitForPublic(
      async () => ({
        probe: probes.find(
          (probe) =>
            probe.boundary === "NativeProcessModeDenialBeforeCommit" &&
            probe.executionId === executionId &&
            probe.invocationId === invocationId,
        ),
        snapshot: run.snapshot(),
      }),
      (state) =>
        state.probe !== undefined ||
        state.snapshot.invocation?.settlement_kind === "Denied",
      20_000,
    ).catch((error: unknown) => {
      throw new Error(
        `P38 Native denial precommit probe absent: ${String(error)}; snapshot=${JSON.stringify(run.snapshot())}; daemon=${run.fixture.daemonErrors.join(" | ")}; providerCalls=${run.fixture.providerCalls.length}`,
        { cause: error },
      );
    });
    if (beforeCommitProbe.probe === undefined) {
      throw new Error(
        `P38 Native denial settled without its precommit probe: ${JSON.stringify(beforeCommitProbe.snapshot)}`,
      );
    }
    const beforeCommitSnapshot = run.snapshot();
    expect(beforeCommitSnapshot.invocation).toMatchObject({
      invocation_id: invocationId,
      effect_admission_state: "NotAdmitted",
      settlement_kind: null,
    });
    expect(beforeCommitSnapshot.attempt0).toMatchObject({
      admission_state: "NotAdmitted",
      admission_source: "P39Claim",
    });
    expect(beforeCommitSnapshot.effectCount).toBe(0);

    await crashExpireAndRestart("NativeProcessModeDenialAfterCommit");
    const afterCommitProbe = await waitForPublic(
      async () => ({
        probe: probes.find(
          (probe) =>
            probe.boundary === "NativeProcessModeDenialAfterCommit" &&
            probe.executionId === executionId &&
            probe.invocationId === invocationId,
        ),
        snapshot: run.snapshot(),
      }),
      (state) =>
        state.probe !== undefined ||
        state.snapshot.invocation?.settlement_kind === "Denied",
      20_000,
    ).catch((error: unknown) => {
      throw new Error(
        `P38 Native denial aftercommit probe absent: ${String(error)}; snapshot=${JSON.stringify(run.snapshot())}; daemon=${run.fixture.daemonErrors.join(" | ")}; providerCalls=${run.fixture.providerCalls.length}`,
        { cause: error },
      );
    });
    if (afterCommitProbe.probe === undefined) {
      throw new Error(
        `P38 Native denial settled without its aftercommit probe: ${JSON.stringify(afterCommitProbe.snapshot)}`,
      );
    }
    const denied = run.snapshot();
    expect(denied.approval).toMatchObject({
      approval_id: run.approvalId,
      consumed_by: invocationId,
    });
    expect(denied.invocation).toMatchObject({
      invocation_id: invocationId,
      effect_admission_state: "NotAdmitted",
      settlement_kind: "Denied",
      settlement_json: expect.stringContaining("ProcessExecutionDisabled"),
    });
    expect(denied.attempt0).toMatchObject({
      admission_state: "NotAdmitted",
      admission_source: "P39Claim",
    });
    expect(denied.effectCount).toBe(0);
    const evidenceDb = new DatabaseSync(run.fixture.databaseFile, {
      readOnly: true,
    });
    try {
      expect(
        evidenceDb
          .prepare(
            `SELECT result_ref, observation_format_version,
                    observation_json, observation_sha256
               FROM tool_invocations WHERE invocation_id = ?`,
          )
          .get(invocationId),
      ).toEqual({
        result_ref: null,
        observation_format_version: null,
        observation_json: null,
        observation_sha256: null,
      });
      expect(
        evidenceDb
          .prepare(
            `SELECT COUNT(*) AS count FROM tool_invocation_effect_attempts
              WHERE invocation_id = ? AND admission_state = 'MayHaveStarted'`,
          )
          .get(invocationId),
      ).toEqual({ count: 0 });
    } finally {
      evidenceDb.close();
    }
    // The after-commit fault hook pauses before P3 receives the P4 result.
    // Crash that owner and replay the committed denial under a clean daemon so
    // the exact action reaches TerminalRejected before P10 projects Attention.
    await crashExpireAndRestart("");
    const projectedDenial = await waitForPublic(
      async () => run.snapshot(),
      (snapshot) =>
        snapshot.invocation?.invocation_id === invocationId &&
        snapshot.invocation.settlement_kind === "Denied" &&
        snapshot.invocation.effect_admission_state === "NotAdmitted" &&
        snapshot.action?.state === "TerminalRejected",
      60_000,
    ).catch((error: unknown) => {
      throw new Error(
        `${String(error)}; daemon=${run.fixture.daemonErrors.join(" | ")}`,
        { cause: error },
      );
    });
    expect(projectedDenial.invocation).toEqual(denied.invocation);
    expect(projectedDenial.action?.state).toBe("TerminalRejected");
    const attention = await run.client.view<{
      readonly rows: ReadonlyArray<{
        readonly source: string;
        readonly targetWorkspaceId: string;
        readonly dedupKey: string;
        readonly summaryRef: string;
        readonly failureCode?: string;
      }>;
    }>("attention", { projectId: run.project.projectId });
    expect(attention.rows).toContainEqual(
      expect.objectContaining({
        source: "ProcessExecutionUnavailable",
        targetWorkspaceId: run.project.rootWorkspaceId,
        dedupKey: expect.stringMatching(/^[0-9a-f]{64}$/u),
        summaryRef:
          "Process execution is disabled for this daemon; the action was not started.",
        failureCode: "ProcessExecutionDisabled",
      }),
    );

    await crashExpireAndRestart("");
    const replayed = await waitForPublic(
      async () => run.snapshot(),
      (snapshot) =>
        snapshot.invocation?.settlement_kind === "Denied" &&
        snapshot.invocation.invocation_id === invocationId,
      60_000,
    );
    expect(replayed.invocation).toMatchObject({
      invocation_id: invocationId,
      effect_admission_state: "NotAdmitted",
      settlement_kind: "Denied",
      settlement_json: expect.stringContaining("ProcessExecutionDisabled"),
    });
    expect(replayed.effectCount).toBe(0);
    expect(run.fixture.daemonErrors).toEqual([]);
  }, 240_000);
});
