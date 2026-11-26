import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { expect } from "vitest";
import { loadSandboxAuthorityBundleSnapshotCurrent } from "../../../../apps/single-workspace/src/sandbox-authority-bundle.js";
import { SANDBOX_ENV_ALLOWLIST } from "../../../../packages/ports/src/index.js";
import { durableSnapshot } from "../../support/ah-durable-snapshot.js";
import { functionalId, waitForPublic } from "../../support/public-client.js";
import {
  commitSandboxPolicyV3HighWater,
  sandboxPolicyV3TestPair,
  writeSandboxPolicyV3SourceFirst,
} from "../../support/sandbox-policy-v3-source.js";
import type { WorkspaceDetailForSandbox } from "./support.js";
import {
  child,
  durableSandboxRead,
  operatorCommand,
  sandboxDecisionDebug,
  type V6eScenarioState,
} from "./support.js";

export const v6ePhaseSecondActionDrift = async (
  s: V6eScenarioState,
): Promise<void> => {
  const { probeLines, executableProbeLines, schedulerProbeLines, stdoutLines } =
    s;
  const fixture = s.fixture!;
  const client = s.client!;
  const project = s.project!;
  const executionId = s.executionId;
  const firstInvocationId = s.firstInvocationId;
  const initialRead = s.initialRead!;
  const oldPayload = s.oldPayload!;
  const firstSettled = s.firstSettled;
  expect(
    executableProbeLines.find(
      (event) =>
        event.boundary === "P4ExecutableToolRuntimeOutcome" &&
        event.invocationId === firstInvocationId,
    ),
  ).toMatchObject({ outcomeTag: "ExpectedFailure" });

  const probesBeforeSecond = probeLines.length;
  const secondProbe = await waitForPublic(
    async () =>
      probeLines
        .slice(probesBeforeSecond)
        .find((value) => value.boundary === "AH7AfterToolIntentCommit"),
    (value) => value !== undefined,
    30_000,
  ).catch((error: unknown) => {
    const durable = durableSnapshot(fixture.databaseFile);
    throw new Error(
      `second shell action did not reach P4 intent; s.providerCalls=${s.providerCalls}; decision=${JSON.stringify(sandboxDecisionDebug(fixture.databaseFile, executionId))}; probes=${JSON.stringify(probeLines)}; loop=${JSON.stringify({ steps: durable.steps, actions: durable.actions, invocations: durable.toolInvocations })}; stdout=${stdoutLines.slice(-30).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}; wait=${String(error)}`,
      { cause: error },
    );
  });
  if (secondProbe === undefined)
    throw new Error("second AH7 P4 intent probe was not captured");
  const secondExecutionId = String(secondProbe.executionId ?? "");
  const secondInvocationId = String(secondProbe.invocationId ?? "");
  expect(secondExecutionId).toBe(executionId);
  expect(secondInvocationId).toMatch(/^tin_/u);
  expect(secondInvocationId).not.toBe(firstInvocationId);
  const decisionIntentOrder = new DatabaseSync(fixture.databaseFile, {
    readOnly: true,
  });
  try {
    const order = decisionIntentOrder
      .prepare(
        `SELECT d.issued_at AS decisionIssuedAt,
                    i.intent_at AS invocationIntentAt
               FROM sandbox_policy_decisions d
               JOIN tool_invocations i ON i.execution_id = d.execution_id
              WHERE d.execution_id = ? AND i.invocation_id = ?
              ORDER BY d.policy_revision DESC LIMIT 1`,
      )
      .get(executionId, secondInvocationId) as
      | {
          readonly decisionIssuedAt?: string;
          readonly invocationIntentAt?: string;
        }
      | undefined;
    expect(order?.decisionIssuedAt).toBeDefined();
    expect(order?.invocationIntentAt).toBeDefined();
    expect(Date.parse(order?.decisionIssuedAt ?? "")).toBeLessThan(
      Date.parse(order?.invocationIntentAt ?? ""),
    );
  } finally {
    decisionIntentOrder.close();
  }
  const pendingState = durableSandboxRead(
    fixture.databaseFile,
    executionId,
    secondInvocationId,
  );
  const actionRows = pendingState.actions as ReadonlyArray<{
    readonly logical_action_id?: string;
    readonly state?: string;
    readonly action_index?: number;
    readonly logical_step_no?: number;
    readonly disposition_json?: string | null;
  }>;
  const bootstrapAction = actionRows.find(
    (row) => row.logical_step_no === 0 && row.action_index === 0,
  );
  expect(bootstrapAction).toMatchObject({ state: "Applied" });
  expect(
    JSON.parse(String(bootstrapAction?.disposition_json ?? "{}")),
  ).toMatchObject({ _tag: "Applied", status: "Failed" });
  const unavailable = new DatabaseSync(fixture.databaseFile, {
    readOnly: true,
  });
  try {
    const unavailableEvidence = unavailable
      .prepare(
        `SELECT f.provider_id, f.provider_version, f.probe_evidence_ref,
                    f.failure_code, q.state AS queue_state
               FROM sandbox_provider_unavailable_facts f
               JOIN sandbox_provider_unavailable_attention_queue q
                 ON q.attention_fact_id = f.attention_fact_id
                AND q.project_id = f.project_id
              WHERE f.execution_id = ? AND f.policy_revision = 1`,
      )
      .get(executionId) as
      | {
          readonly provider_id?: string;
          readonly provider_version?: string;
          readonly probe_evidence_ref?: string | null;
          readonly failure_code?: string;
          readonly queue_state?: string;
        }
      | undefined;
    expect(
      unavailableEvidence?.provider_id,
      JSON.stringify({
        unavailableEvidence,
        firstSettled,
        firstP4Outcomes: executableProbeLines.filter(
          (event) => event.invocationId === firstInvocationId,
        ),
      }),
    ).toBe("windows-restricted-appcontainer-job");
    expect(unavailableEvidence?.provider_version).toBe("t3d-v1");
    expect(unavailableEvidence?.probe_evidence_ref).toMatch(
      /^blob:sha256:[0-9a-f]{64}$/u,
    );
    expect(unavailableEvidence?.failure_code?.length).toBeGreaterThan(0);
    expect(unavailableEvidence?.queue_state).toMatch(
      /^(Pending|Claimed|Consumed)$/u,
    );
  } finally {
    unavailable.close();
  }
  const pendingActionRows = actionRows.filter((row) => row.state === "Pending");
  const actionRow = pendingActionRows[0];
  const invocationRow = pendingState.invocation as
    | {
        readonly invocation_id?: string;
        readonly effect_admission_state?: string;
        readonly recovery_binding_state?: string;
        readonly settled_at?: string | null;
        readonly observation_json?: Buffer | null;
      }
    | undefined;
  if (
    pendingActionRows.length !== 1 ||
    actionRow?.logical_action_id === undefined ||
    invocationRow?.invocation_id === undefined
  )
    throw new Error(
      `second AH7 route omitted pending action/invocation: ${JSON.stringify(pendingState)}`,
    );
  expect(actionRow.state).toBe("Pending");
  expect(invocationRow).toMatchObject({
    invocation_id: secondInvocationId,
    effect_admission_state: "NotAdmitted",
    recovery_binding_state: "Bound",
    settled_at: null,
    observation_json: null,
  });
  expect(fixture.daemonErrors).toEqual([]);
  const seeded = {
    workspace: project.rootWorkspaceId,
    execution: executionId,
    logicalActionId: actionRow.logical_action_id,
    invocation: secondInvocationId,
  };
  const providerCallsAtPending = s.providerCalls;
  const modelRequestsAtPending = fixture.providerCalls.length;
  const approvedState = pendingState;
  expect(approvedState).toMatchObject({
    decisions: { count: 1 },
    decisionEvents: { count: 1 },
  });
  const schedulerEventsBeforeRestart = schedulerProbeLines.length;
  const executableProbesAtPending = executableProbeLines.length;
  const oldPid = fixture.daemonProcessSnapshot()?.pid;
  await fixture.crash();
  if (s.sourceFilename === undefined)
    throw new Error("schema-50 V3 source path disappeared");
  const driftedPair = sandboxPolicyV3TestPair({
    bundleRevision: 2,
    registryRevision: 2,
    includeRegistryDrift: true,
  });
  writeSandboxPolicyV3SourceFirst(s.sourceFilename, driftedPair);
  const sourceFirstPair = JSON.parse(
    readFileSync(s.sourceFilename, "utf8"),
  ) as {
    readonly sourceIdentity: string;
    readonly bundleCanonicalJson: string;
    readonly highWaterCanonicalJson: string;
  };
  const sourceFirst = await Effect.runPromise(
    loadSandboxAuthorityBundleSnapshotCurrent(
      {
        readVerifiedSandboxAuthorityBundle: () =>
          Effect.succeed({
            sourceIdentity: sourceFirstPair.sourceIdentity,
            canonicalJson: sourceFirstPair.bundleCanonicalJson,
          }),
        readSandboxAuthorityHighWater: () =>
          Effect.succeed(sourceFirstPair.highWaterCanonicalJson),
        commitSandboxAuthorityHighWater: () => Effect.succeed(false),
        appendSandboxAuthorityAudit: () => Effect.succeed(true),
      },
      new Date().toISOString(),
      SANDBOX_ENV_ALLOWLIST,
    ),
  );
  expect(sourceFirst).toMatchObject({ _tag: "Unavailable" });
  commitSandboxPolicyV3HighWater(s.sourceFilename, driftedPair);
  await fixture.restart({
    entry: child,
    daemonEnvironment: {
      ARBOR_AH_BOUNDARY: "disabled",
      ARBOR_TICK_INTERVAL_MS: "60000",
      ARBOR_SCHEDULER_PROBE: "1",
    },
  });
  expect(fixture.daemonProcessSnapshot()?.pid).not.toBe(oldPid);

  const dispatchGate = await waitForPublic(
    async () =>
      schedulerProbeLines
        .slice(schedulerEventsBeforeRestart)
        .find(
          (event) =>
            event.boundary === "PreDispatchLeaseCheck" &&
            event.executionId === seeded.execution &&
            event.dispatchable === false,
        ),
    (event) => event !== undefined,
    20_000,
  );
  expect(dispatchGate).toMatchObject({
    boundary: "PreDispatchLeaseCheck",
    executionId: seeded.execution,
    dispatchable: false,
  });

  const parkedDetail = await waitForPublic(
    () =>
      client.view<WorkspaceDetailForSandbox>("workspace-detail", {
        workspaceId: seeded.workspace,
      }),
    (detail) => detail.sandboxPolicyCandidateRead !== undefined,
  );
  const refreshedRead = parkedDetail.sandboxPolicyCandidateRead;
  if (refreshedRead === undefined)
    throw new Error("refreshed candidate read missing");
  expect(refreshedRead.commonPreconditions.authorityBundleRevision).toBe(2);
  expect(refreshedRead.commonPreconditions.authorityBundleDigest).not.toBe(
    initialRead.commonPreconditions.authorityBundleDigest,
  );
  const refreshedOsCandidate = refreshedRead.candidates.find(
    (candidate) =>
      candidate.kind === "OsEnforced" &&
      candidate.providerId === "windows-restricted-appcontainer-job" &&
      candidate.profile === "ReadOnly" &&
      candidate.networkMode === "Disabled",
  );
  expect(refreshedOsCandidate).toBeDefined();
  expect(
    refreshedOsCandidate?.kind === "OsEnforced"
      ? refreshedOsCandidate.providerRegistryRevision
      : undefined,
  ).toBe(2);
  const parkedState = durableSandboxRead(
    fixture.databaseFile,
    seeded.execution,
    seeded.invocation,
  );
  expect(parkedState.lease).toEqual(approvedState.lease);
  expect(parkedState.actions).toEqual(approvedState.actions);
  expect(parkedState.step).toEqual(approvedState.step);
  expect(parkedState.invocation).toEqual(approvedState.invocation);
  expect(parkedState.invocation).toMatchObject({
    invocation_id: seeded.invocation,
    effect_admission_state: "NotAdmitted",
    recovery_binding_state: "Bound",
    settled_at: null,
    observation_json: null,
  });
  expect(s.providerCalls).toBe(providerCallsAtPending);
  expect(fixture.providerCalls).toHaveLength(modelRequestsAtPending);
  expect(executableProbeLines).toHaveLength(executableProbesAtPending);

  const staleCommandId = functionalId("cmd");
  const stale = await operatorCommand(
    fixture.baseUrl,
    project.projectId,
    "DecideSandboxPolicy",
    oldPayload,
    staleCommandId,
  );
  expect(stale).toMatchObject({
    body: {
      resolution: "TerminalRejected",
      rejection: "StaleSandboxPolicyInputs",
    },
  });
  const afterStale = durableSandboxRead(
    fixture.databaseFile,
    seeded.execution,
    seeded.invocation,
  );
  expect(afterStale.decisions).toEqual(approvedState.decisions);
  expect(afterStale.decisionEvents).toEqual(approvedState.decisionEvents);
  expect(afterStale.lease).toEqual(approvedState.lease);
  expect(afterStale.actions).toEqual(approvedState.actions);
  expect(afterStale.invocation).toEqual(approvedState.invocation);
  expect(s.providerCalls).toBe(providerCallsAtPending);
  expect(fixture.providerCalls).toHaveLength(modelRequestsAtPending);
  const staleReceipt = new DatabaseSync(fixture.databaseFile, {
    readOnly: true,
  });
  try {
    const command = staleReceipt
      .prepare(
        `SELECT command_id, resolution, result_json, terminal_error_json
             FROM commands WHERE command_id = ?`,
      )
      .get(staleCommandId) as
      | {
          readonly command_id?: string;
          readonly resolution?: string;
          readonly result_json?: string | null;
          readonly terminal_error_json?: string | null;
        }
      | undefined;
    expect(command?.command_id).toBe(staleCommandId);
    expect(command?.resolution).toBe("TerminalRejected");
    expect(JSON.stringify(command).includes("StaleSandboxPolicyInputs")).toBe(
      true,
    );
  } finally {
    staleReceipt.close();
  }
};
