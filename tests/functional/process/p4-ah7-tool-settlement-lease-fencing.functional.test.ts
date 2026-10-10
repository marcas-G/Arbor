import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

interface P4FenceProbe {
  readonly tag: "P4_FENCE_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly invocationId?: string;
  readonly callRef?: string;
  readonly fencingGeneration?: number;
}

interface LeaseRow {
  readonly execution_id: string;
  readonly generation: number;
  readonly expires_at: string;
}

interface InvocationRow {
  readonly invocation_id: string;
  readonly execution_id: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
}

const fixtures: ProductionFixture[] = [];
const fenceChild = resolve(
  "tests/functional/support/p4-tool-lease-fencing-child.mjs",
);

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const recordProbe = (events: P4FenceProbe[], line: string) => {
  try {
    const probe = JSON.parse(line) as P4FenceProbe;
    if (probe.tag === "P4_FENCE_PROBE") events.push(probe);
  } catch {
    // Daemon diagnostics remain available from ProductionFixture on failure.
  }
};

const rowsFor = (
  databaseFile: string,
  executionId: string,
  invocationId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      lease: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .get(executionId) as LeaseRow | undefined,
      invocation: db
        .prepare(
          "SELECT invocation_id, execution_id, settled_at, settlement_kind FROM tool_invocations WHERE execution_id = ? ORDER BY intent_at DESC LIMIT 1",
        )
        .get(executionId) as InvocationRow | undefined,
      execution: db
        .prepare(
          "SELECT settlement_kind, settlement_json, settled_at FROM executions WHERE execution_id = ?",
        )
        .get(executionId) as
        | {
            settlement_kind: string | null;
            settlement_json: string | null;
            settled_at: string | null;
          }
        | undefined,
      successfulObservations: db
        .prepare(
          `SELECT payload_json FROM session_entries
            WHERE source_kind = 'AgentLoopAction'
              AND item_type = 'ToolResult'
              AND json_extract(payload_json, '$.invocationId') = ?
              AND json_extract(payload_json, '$.status') = 'Succeeded'`,
        )
        .all(invocationId) as Array<{ readonly payload_json: string }>,
    };
  } finally {
    db.close();
  }
};

describe("P4 ToolInvocation settlement under P2 lease takeover", () => {
  it("fences an old generation after its non-idempotent effect and before settlement", async () => {
    const marker = `P4-LEASE-${crypto.randomUUID().slice(0, 8)}`;
    const steerMarker = `P4-LEASE-STEER-${crypto.randomUUID().slice(0, 8)}`;
    const effectMarker = `P4_EFFECT_${marker}`;
    const effectFile = `p4-lease-${marker}.txt`;
    const command =
      process.platform === "win32"
        ? `Add-Content -LiteralPath '${effectFile}' -Value '${effectMarker}'`
        : `printf '%s\\n' '${effectMarker}' >> '${effectFile}'`;
    const events: P4FenceProbe[] = [];
    let manualWaitCalls = 0;
    let targetToolCalls = 0;
    const fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
      firstDaemonEntry: fenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
      },
      onDaemonStdout: (line) => recordProbe(events, line),
      reply: (call) => {
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        const context = JSON.stringify(call.messages);
        if (
          available.has("assign_work") &&
          !available.has("claim_completion") &&
          context.includes(marker)
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work admitted for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Wait for a steer, then append ${effectMarker} once with shell.`,
                  why: "qualify stale P4 settlement fencing",
                  constraints: [],
                  completionExpectation: "the shell effect occurs at most once",
                  verificationMission: {
                    goal: `Verify the one-time effect ${marker}`,
                    criteria: [
                      {
                        criterionId: "one-effect",
                        requirement: `${effectFile} contains ${effectMarker} once`,
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "P4/P2 lease fencing qualification",
                },
              };
        }
        if (
          available.has("claim_completion") &&
          available.has("shell") &&
          context.includes(marker)
        ) {
          if (!context.includes(steerMarker)) {
            manualWaitCalls += 1;
            return {
              _tag: "ToolCall",
              name: "wait",
              arguments: {
                reason: `wait for ${steerMarker}`,
                waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
              },
            };
          }
          targetToolCalls += 1;
          if (targetToolCalls > 4) {
            return { _tag: "HttpError", status: 429 };
          }
          return {
            _tag: "ToolCall",
            name: "shell",
            arguments: {
              command,
              cwd: { mount: "workspace", path: "." },
              timeoutMs: 5_000,
            },
          };
        }
        return { _tag: "Text", text: `Waiting for ${marker}` };
      },
    });
    fixtures.push(fixture);

    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "P4 stale tool settlement fence",
      { resourceSelection: "Profile" },
    );
    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: functionalId("pgr"),
      issuer: "user:local",
      subject: { _tag: "WorkspaceAgent", workspaceId: project.rootWorkspaceId },
      capability: "shell:exec",
      target: project.rootWorkspaceId,
      expiresAt: null,
    });
    await submitHumanMessage(
      client,
      project,
      `请创建一个等待人工指示后执行一次shell写入的Work，目标标记 ${marker}。`,
    );
    const approval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "P4/P2 stale settlement qualification",
    });

    const currentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          objective?: string;
        } | null>("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      (value) =>
        value?.workId !== undefined &&
        value.objective?.includes(marker) === true,
    );
    if (currentWork === null || currentWork.workId === undefined) {
      throw new Error("P4 lease-fencing Work was not publicly admitted");
    }
    await waitForPublic(
      async () => ({ manualWaitCalls }),
      (value) => value.manualWaitCalls > 0,
    );
    const idleWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (value) =>
        value !== null &&
        value.workId === currentWork.workId &&
        value.activeExecution === undefined,
    );
    if (idleWork === null || idleWork.workId === undefined) {
      throw new Error("P4 lease-fencing Work did not reach its Manual wait");
    }
    await client.command(project.projectId, "SteerWork", {
      workId: idleWork.workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: idleWork.revision,
      steer: { severity: "Normal", guidance: `Proceed with ${steerMarker}.` },
      provenance: { source: "HumanInput" },
    });

    const oldEffect = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterToolEffectBeforeSettlement",
        ),
      (event) => event !== undefined,
      45_000,
    );
    if (
      oldEffect === undefined ||
      oldEffect.executionId === undefined ||
      oldEffect.invocationId === undefined ||
      oldEffect.callRef === undefined
    ) {
      throw new Error("Old generation did not expose its post-effect boundary");
    }
    const oldExecutionId = oldEffect.executionId;
    const oldInvocationId = oldEffect.invocationId;
    expect(oldEffect.fencingGeneration).toBeUndefined();
    expect(
      readFileSync(join(fixture.workspaceDirectory, effectFile), "utf8")
        .split(/\r?\n/u)
        .filter((line) => line === effectMarker),
    ).toHaveLength(1);

    mkdirSync(join(fixture.directory, "p4-fence-gates"), { recursive: true });
    writeFileSync(
      join(fixture.directory, "p4-fence-gates", "old-freeze-renewal.request"),
      "pause renewal before takeover",
    );
    await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10BeforeLeaseRenewal" &&
            event.executionId === oldExecutionId,
        ),
      (event) => event !== undefined,
      20_000,
    );

    const leaseDb = new DatabaseSync(fixture.databaseFile);
    try {
      const lease = leaseDb
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .get(oldExecutionId) as LeaseRow | undefined;
      expect(lease).toMatchObject({
        execution_id: oldExecutionId,
        generation: 0,
      });
      leaseDb
        .prepare(
          "UPDATE execution_leases SET expires_at = ? WHERE execution_id = ? AND generation = 0",
        )
        .run("2000-01-01T00:00:00.000Z", oldExecutionId);
    } finally {
      leaseDb.close();
    }

    const newDaemon = await fixture.startAdditionalDaemon({
      entry: fenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "new",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
        ARBOR_P4_FENCE_PAUSE_NEW: "1",
      },
      onStdout: (line) => recordProbe(events, line),
    });
    const newLease = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldExecutionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(newLease?.fencingGeneration).toBe(1);

    writeFileSync(
      join(fixture.directory, "p4-fence-gates", "old-tool-effect.release"),
      "release old P4 owner",
    );
    const oldSettlement = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.executionId === oldExecutionId &&
            (event.boundary === "AH7AfterToolSettlementCommit" ||
              event.boundary === "AH7ToolSettlementFenceRejected"),
        ),
      (event) => event !== undefined,
      20_000,
    );

    const beforeNewDrive = rowsFor(
      fixture.databaseFile,
      oldExecutionId,
      oldInvocationId,
    );
    // Soft assertions retain the complete RED record: baseline commits a
    // stale Success and emits the success-side probe; Action Session fencing
    // separately prevents a successful ToolResult from becoming visible.
    expect.soft(oldSettlement?.boundary).toBe("AH7ToolSettlementFenceRejected");
    expect.soft(beforeNewDrive.invocation).toMatchObject({
      invocation_id: oldEffect.invocationId,
      settled_at: null,
      settlement_kind: null,
    });
    expect.soft(beforeNewDrive.successfulObservations).toEqual([]);
    expect(
      readFileSync(join(fixture.workspaceDirectory, effectFile), "utf8")
        .split(/\r?\n/u)
        .filter((line) => line === effectMarker),
    ).toHaveLength(1);
    expect(
      rowsFor(fixture.databaseFile, oldExecutionId, oldInvocationId)
        .successfulObservations,
    ).toEqual([]);
    expect(
      rowsFor(fixture.databaseFile, oldExecutionId, oldInvocationId).lease,
    ).toMatchObject({ generation: 1 });

    writeFileSync(
      join(fixture.directory, "p4-fence-gates", "new-new-driver.release"),
      "release current generation",
    );
    const afterCurrentDrive = await waitForPublic(
      async () =>
        rowsFor(fixture.databaseFile, oldExecutionId, oldInvocationId),
      (value) =>
        value.invocation?.settlement_kind === "OutcomeUnknown" &&
        value.execution?.settled_at !== null,
      45_000,
    );
    expect(afterCurrentDrive.execution?.settlement_kind).toBe("OutcomeUnknown");
    expect(afterCurrentDrive.invocation?.settlement_kind).toBe(
      "OutcomeUnknown",
    );
    expect(afterCurrentDrive.successfulObservations).toEqual([]);
    expect(
      readFileSync(join(fixture.workspaceDirectory, effectFile), "utf8")
        .split(/\r?\n/u)
        .filter((line) => line === effectMarker),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
    expect(newDaemon.daemonErrors).toEqual([]);
  }, 180_000);
});
