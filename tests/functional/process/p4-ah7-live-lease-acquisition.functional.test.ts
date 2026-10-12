import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

interface LeaseProbe {
  readonly tag: "P4_FENCE_PROBE";
  readonly role: "old" | "new";
  readonly pid: number;
  readonly boundary: string;
  readonly executionId: string;
  readonly fencingGeneration?: number;
  readonly workerId?: string;
  readonly workerIncarnationId?: string;
  readonly invocationId?: string;
  readonly source?: string;
}

interface LeaseRow {
  readonly execution_id: string;
  readonly worker_id: string;
  readonly worker_incarnation_id: string;
  readonly generation: number;
  readonly expires_at: string;
}

interface InvocationRow {
  readonly invocation_id: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
}

interface ExecutionRow {
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
}

const fixtures: ProductionFixture[] = [];
const fenceChild = resolve(
  "tests/functional/support/p4-tool-lease-fencing-child.mjs",
);
let probeLogFile: string | undefined;
let workExecutionId: string | undefined;
let effectObserved = false;

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const recordProbe = (events: LeaseProbe[], line: string) => {
  try {
    const probe = JSON.parse(line) as LeaseProbe;
    if (probe.tag === "P4_FENCE_PROBE") {
      events.push(probe);
      if (
        probe.boundary === "AH7AfterToolEffectBeforeSettlement" &&
        probe.executionId === workExecutionId
      ) {
        effectObserved = true;
      }
      if (probeLogFile !== undefined) {
        appendFileSync(probeLogFile, `${JSON.stringify(probe)}\n`);
      }
    }
  } catch {
    // Keep non-probe daemon output in ProductionFixture diagnostics.
  }
};

const executionRows = (databaseFile: string, executionId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      lease: db
        .prepare(
          "SELECT execution_id, worker_id, worker_incarnation_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .get(executionId) as LeaseRow | undefined,
      invocations: db
        .prepare(
          "SELECT invocation_id, settled_at, settlement_kind FROM tool_invocations WHERE execution_id = ? ORDER BY intent_at",
        )
        .all(executionId) as unknown as InvocationRow[],
      execution: db
        .prepare(
          "SELECT settled_at, settlement_kind FROM executions WHERE execution_id = ?",
        )
        .get(executionId) as ExecutionRow | undefined,
      providerTurnCount: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS turn_count FROM provider_turns WHERE execution_id = ?",
            )
            .get(executionId) as { readonly turn_count: number } | undefined
        )?.turn_count ?? 0,
      ),
      providerAttempts: db
        .prepare(
          `SELECT pt.provider_turn_id, pa.attempt_no, pa.outcome
             FROM provider_turns pt
             JOIN provider_attempts pa USING (provider_turn_id)
            WHERE pt.execution_id = ?
            ORDER BY pt.started_at, pa.attempt_no`,
        )
        .all(executionId) as Array<{
        readonly provider_turn_id: string;
        readonly attempt_no: number;
        readonly outcome: string;
      }>,
    };
  } finally {
    db.close();
  }
};

describe("P4 lease acquisition while another daemon owns a live lease", () => {
  it("records a real rejected acquisition for the same active Execution", async () => {
    const marker = `P4-LIVE-${crypto.randomUUID().slice(0, 8)}`;
    const steerMarker = `P4-LIVE-STEER-${crypto.randomUUID().slice(0, 8)}`;
    const effectMarker = `P4_LIVE_EFFECT_${marker}`;
    const effectFile = `p4-live-${marker}.txt`;
    const command =
      process.platform === "win32"
        ? `Add-Content -LiteralPath '${effectFile}' -Value '${effectMarker}'`
        : `printf '%s\\n' '${effectMarker}' >> '${effectFile}'`;
    const events: LeaseProbe[] = [];
    let manualWaitCalls = 0;
    let targetToolCalls = 0;
    let signalProviderHeld!: () => void;
    const providerHeld = new Promise<void>((resolveHeld) => {
      signalProviderHeld = resolveHeld;
    });
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolveRelease) => {
      releaseProvider = resolveRelease;
    });

    const fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
      preserveDirectoryOnStop: true,
      firstDaemonEntry: fenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
      },
      onDaemonStdout: (line) => recordProbe(events, line),
      beforeResponse: async (call) => {
        const context = JSON.stringify(call.messages);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          available.has("shell") &&
          context.includes(marker) &&
          context.includes(steerMarker)
        ) {
          signalProviderHeld();
          await providerRelease;
        }
        return "respond";
      },
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
                  why: "qualify live lease admission across daemon processes",
                  constraints: [],
                  completionExpectation: "one shell effect is recorded",
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
                  reason: "P4 live lease acquisition qualification",
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
          if (effectObserved) {
            return {
              _tag: "ToolCall",
              name: "claim_completion",
              arguments: { claim: `The one-time effect ${marker} is present.` },
            };
          }
          targetToolCalls += 1;
          if (targetToolCalls === 1) {
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
          return { _tag: "Text", text: `Finished ${marker}` };
        }
        return { _tag: "Text", text: `Waiting for ${marker}` };
      },
    });
    fixtures.push(fixture);
    probeLogFile = join(fixture.directory, "p4-live-lease-probes.ndjson");

    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "P4 live lease acquisition",
      { resourceSelection: "Profile" },
    );
    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: functionalId("pgr"),
      issuer: "user:local",
      subject: { _tag: "WorkspaceAgent", workspaceId: project.rootWorkspaceId },
      capability: "shell:exec",
      target: project.rootWorkspaceId,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
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
      reason: "P4 live lease acquisition qualification",
    });

    const currentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          objective?: string;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (value) =>
        value?.workId !== undefined &&
        value.objective?.includes(marker) === true,
    );
    if (currentWork?.workId === undefined) {
      throw new Error("P4 live-lease Work was not publicly admitted");
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
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (value) =>
        value !== null &&
        value.workId === currentWork.workId &&
        value.activeExecution === undefined,
    );
    if (idleWork?.workId === undefined) {
      throw new Error("P4 live-lease Work did not reach its Manual wait");
    }
    await client.command(project.projectId, "SteerWork", {
      workId: idleWork.workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: idleWork.revision,
      steer: { severity: "Normal", guidance: `Proceed with ${steerMarker}.` },
      provenance: { source: "HumanInput" },
    });

    let providerGateTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        providerHeld,
        new Promise<never>((_, reject) => {
          providerGateTimer = setTimeout(
            () => reject(new Error("Work Provider request was not held")),
            45_000,
          );
        }),
      ]);
    } finally {
      if (providerGateTimer !== undefined) clearTimeout(providerGateTimer);
    }
    const activeWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (value) =>
        value !== null &&
        value.workId === currentWork.workId &&
        value.activeExecution?.executionId !== undefined,
    );
    const executionId = activeWork?.activeExecution?.executionId;
    if (executionId === undefined) {
      throw new Error(
        "Work Provider request did not expose its active Execution",
      );
    }
    workExecutionId = executionId;
    const oldAcquired = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === executionId,
        ),
      (event) => event !== undefined,
    );
    if (oldAcquired === undefined) {
      throw new Error("Old daemon did not report owning the active Execution");
    }
    const beforeRetry = executionRows(fixture.databaseFile, executionId).lease;
    expect(beforeRetry).toMatchObject({
      execution_id: executionId,
      generation: oldAcquired.fencingGeneration,
    });
    expect(
      Date.parse(beforeRetry?.expires_at ?? "1970-01-01T00:00:00.000Z"),
    ).toBeGreaterThan(Date.now());

    const newDaemon = await fixture.startAdditionalDaemon({
      entry: fenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "new",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
        ARBOR_P4_FENCE_EXPLICIT_EXECUTION_ID: executionId,
      },
      onStdout: (line) => recordProbe(events, line),
    });
    const schedulerSkip = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10PreDispatchSkippedLiveLease" &&
            event.executionId === executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(schedulerSkip?.pid).not.toBe(oldAcquired.pid);
    expect(
      fixture.providerCalls.filter((call) =>
        JSON.stringify(call.messages).includes(steerMarker),
      ),
    ).toHaveLength(1);
    expect(
      executionRows(fixture.databaseFile, executionId).invocations,
    ).toEqual([]);
    const gateDirectory = join(fixture.directory, "p4-fence-gates");
    mkdirSync(gateDirectory, { recursive: true });
    writeFileSync(
      join(gateDirectory, "new-explicit-runExecution.release"),
      "invoke the production runExecution path for the exact active Execution",
    );
    const rejectedAttempt = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10LeaseAcquisitionRejected" &&
            event.executionId === executionId &&
            event.source === "test-runExecution",
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(rejectedAttempt).toMatchObject({
      executionId,
      fencingGeneration: oldAcquired.fencingGeneration,
      workerId: beforeRetry?.worker_id,
      workerIncarnationId: beforeRetry?.worker_incarnation_id,
    });
    expect(rejectedAttempt?.pid).not.toBe(oldAcquired.pid);
    expect(
      fixture.providerCalls.filter((call) =>
        JSON.stringify(call.messages).includes(steerMarker),
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH10AfterLeaseAcquired" &&
          event.executionId === executionId,
      ),
    ).toBe(false);
    const afterRejectedAcquire = executionRows(
      fixture.databaseFile,
      executionId,
    );
    expect(afterRejectedAcquire.lease).toMatchObject({
      worker_id: beforeRetry?.worker_id,
      worker_incarnation_id: beforeRetry?.worker_incarnation_id,
      generation: oldAcquired.fencingGeneration,
    });
    expect(afterRejectedAcquire.invocations).toEqual([]);
    expect(
      events.some(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH10ExplicitRunExecutionError" &&
          event.executionId === executionId,
      ),
    ).toBe(false);

    releaseProvider();
    const effectEvent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterToolEffectBeforeSettlement" &&
            event.executionId === executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(
      executionRows(fixture.databaseFile, executionId).lease?.generation,
    ).toBe(oldAcquired.fencingGeneration);
    expect(
      readFileSync(`${fixture.workspaceDirectory}/${effectFile}`, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line === effectMarker),
    ).toHaveLength(1);
    writeFileSync(
      join(gateDirectory, "old-tool-effect.release"),
      "allow the old owner to settle the observed tool effect",
    );

    const settled = await waitForPublic(
      async () => executionRows(fixture.databaseFile, executionId),
      (rows) =>
        rows.invocations.length === 1 &&
        rows.invocations[0]?.settled_at !== null &&
        rows.execution?.settled_at !== null,
      45_000,
    );
    expect(settled.invocations).toHaveLength(1);
    expect(settled.invocations[0]).toMatchObject({
      invocation_id: effectEvent?.invocationId,
      settlement_kind: "Success",
    });
    expect(settled.execution?.settled_at).not.toBeNull();
    expect(settled.lease?.generation).toBe(oldAcquired.fencingGeneration);
    expect(settled.providerTurnCount).toBe(2);
    expect(settled.providerAttempts).toHaveLength(2);
    expect(
      new Set(
        settled.providerAttempts.map((attempt) => attempt.provider_turn_id),
      ).size,
    ).toBe(settled.providerAttempts.length);
    expect(
      settled.providerAttempts.every(
        (attempt) => attempt.attempt_no === 0 && attempt.outcome === "Success",
      ),
    ).toBe(true);
    expect(
      readFileSync(`${fixture.workspaceDirectory}/${effectFile}`, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line === effectMarker),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
    expect(newDaemon.daemonErrors).toEqual([]);
  }, 180_000);
});
