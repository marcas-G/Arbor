import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../support/lease-qualification.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../support/public-client.js";

interface Probe {
  readonly tag: "AH10_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionKind?: string;
  readonly actionIndex?: number;
  readonly callRef?: string;
  readonly fencingGeneration?: number;
}

const fixtures: ProductionFixture[] = [];
const ah10Child = resolve("tests/functional/support/ah10-process-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const manualWait = (reason: string) => ({
  _tag: "ToolCall" as const,
  name: "wait",
  arguments: {
    reason,
    waitSpec: { mode: "Any" as const, conditions: [{ _tag: "Manual" }] },
  },
});

const readSnapshot = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases",
        )
        .all() as Array<{
        execution_id: string;
        generation: number;
        expires_at: string;
      }>,
      commands: db
        .prepare("SELECT command_id, resolution, result_json FROM commands")
        .all() as Array<{
        command_id: string;
        resolution: string;
        result_json: string | null;
      }>,
      evidence: db
        .prepare(
          "SELECT evidence_id, verification_id, recorded_at FROM verification_evidence",
        )
        .all() as Array<{
        evidence_id: string;
        verification_id: string;
        recorded_at: string;
      }>,
      verifications: db
        .prepare(
          "SELECT verification_id, state, verdict, snapshot_status FROM verifications",
        )
        .all() as Array<{
        verification_id: string;
        state: string;
        verdict: string | null;
        snapshot_status: string;
      }>,
      events: db
        .prepare(
          "SELECT event_type, caused_by_command_id FROM domain_events WHERE event_type = 'VerificationConcluded'",
        )
        .all() as Array<{
        event_type: string;
        caused_by_command_id: string | null;
      }>,
      actions: db
        .prepare(
          "SELECT logical_action_id, action_kind, state FROM agent_loop_step_actions",
        )
        .all() as Array<{
        logical_action_id: string;
        action_kind: string;
        state: string;
      }>,
      observations: db
        .prepare(
          "SELECT source_ref FROM session_entries WHERE source_kind = 'AgentLoopAction' AND entry_kind = 'Observation'",
        )
        .all() as Array<{ source_ref: string }>,
    };
  } finally {
    db.close();
  }
};

const pushProbe = (events: Probe[], line: string) => {
  try {
    const event = JSON.parse(line) as Probe;
    if (event.tag === "AH10_PROBE") events.push(event);
  } catch {
    // Fixture output is retained by the daemon when a qualification fails.
  }
};

const releaseGate = (
  fixture: ProductionFixture,
  role: string,
  gate: string,
) => {
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${gate}.release`),
    "release",
  );
};

describe("AH10 P8 verification control takeover", () => {
  it("recovers a committed RecordVerificationEvidence command before Observation after two-daemon restart", async () => {
    const marker = `AH10-VCS-RECORD-${crypto.randomUUID().slice(0, 8)}`;
    const events: Probe[] = [];
    let probeArmed = false;
    let seedWaitIssued = false;
    let targetActionCalls = 0;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: (call) => {
        const context = JSON.stringify(call.messages);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          available.has("assign_work") &&
          !available.has("claim_completion") &&
          context.includes(marker)
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work started for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Complete ${marker}.`,
                  why: "qualify AH10 P8 verification receipt takeover",
                  constraints: [],
                  completionExpectation: "independently verified",
                  verificationMission: {
                    goal: `Verify ${marker}`,
                    criteria: [
                      {
                        criterionId: "ah10-verification-takeover",
                        requirement: `verify ${marker}`,
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH10 process fixture",
                },
              };
        }
        if (context.includes(marker) && available.has("claim_completion")) {
          if (!probeArmed) {
            seedWaitIssued = true;
            return manualWait(`seed AH10 P8 verifier takeover ${marker}`);
          }
          return {
            _tag: "ToolCall",
            name: "claim_completion",
            arguments: { claim: `complete ${marker} before verification` },
          };
        }
        if (
          context.includes(marker) &&
          available.has("record_verification_evidence")
        ) {
          const evidenceIds = [...context.matchAll(/evd_[0-9a-f-]{36}/gu)].map(
            (match) => match[0],
          );
          const terminalResults = call.messages.some(
            (message) =>
              message.role === "tool" &&
              message.content?.includes("ToolResult") === true,
          );
          if (!terminalResults) {
            return {
              _tag: "ToolCall",
              name: "read",
              arguments: {
                target: { mount: "workspace", path: "README.md" },
                limit: 80,
              },
            };
          }
          if (evidenceIds.length === 0) {
            targetActionCalls += 1;
            return {
              _tag: "ToolCall",
              name: "record_verification_evidence",
              arguments: {
                criterionId: "ah10-verification-takeover",
                sourceCallRef: "1",
              },
            };
          }
          return {
            _tag: "ToolCall",
            name: "conclude_verification",
            arguments: {
              verdict: "Pass",
              criteriaResults: [
                {
                  criterionId: "ah10-verification-takeover",
                  requirement: `verify ${marker}`,
                  required: true,
                  verdict: "Pass",
                  evidenceRefs: [evidenceIds.at(-1)],
                },
              ],
              summary: `AH10 evidence recorded for ${marker}.`,
            },
          };
        }
        if (available.has("claim_completion")) {
          return {
            _tag: "ToolCall",
            name: "claim_completion",
            arguments: { claim: `complete ${marker}` },
          };
        }
        return { _tag: "Text", text: `Observed ${marker}` };
      },
      onDaemonStdout: (line) => pushProbe(events, line),
    });
    fixtures.push(fixture);
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH10 P8 evidence receipt takeover",
    );
    const work = await admitRootWorkThroughPublicConversation(
      client,
      project,
      marker,
      `Please admit Work ${marker} for verifier receipt recovery.`,
    );
    const waitingWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: unknown;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (current) =>
        seedWaitIssued &&
        current?.workId === work.workId &&
        current.status === "Open" &&
        current.activeExecution === undefined,
    );
    if (waitingWork?.workId !== work.workId)
      throw new Error(
        "P8 takeover fixture did not reach the seeded Manual wait",
      );

    await fixture.crash();
    probeArmed = true;
    await fixture.restart({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND: "record_verification_evidence",
        ARBOR_AH10_GATE_ACTION_KIND: "record_verification_evidence",
      },
    });
    await client.command(project.projectId, "SteerWork", {
      workId: work.workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: waitingWork.revision,
      steer: { severity: "Normal", guidance: `Resume ${marker} verification.` },
      provenance: { source: "HumanInput" },
    });
    const oldAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "record_verification_evidence",
        ),
      (event) => event !== undefined,
      45_000,
    );
    if (oldAction === undefined)
      throw new Error("old RecordVerificationEvidence intent not observed");
    releaseGate(fixture, "old", "action-intent");
    const oldReturn = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.logicalActionId === oldAction.logicalActionId,
        ),
      (event) => event !== undefined,
      30_000,
    );
    expect(oldReturn).toBeDefined();
    const committed = readSnapshot(fixture.databaseFile);
    expect(committed.evidence).toHaveLength(1);
    expect(
      committed.commands.filter(
        (row) =>
          row.resolution === "Committed" &&
          row.result_json?.includes('"evidenceId"'),
      ),
    ).toHaveLength(1);
    expect(committed.observations).toHaveLength(0);
    expect(targetActionCalls).toBe(1);

    await fixture.crash();
    await expireExecutionLeaseAfterOwnerExitForQualification({
      databaseFile: fixture.databaseFile,
      executionId: oldAction.executionId,
      daemon: { crash: fixture.crash, snapshot: fixture.daemonProcessSnapshot },
    });
    const newDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_GATE_ACTION_KIND: "record_verification_evidence",
      },
      onStdout: (line) => pushProbe(events, line),
    });
    const newLease = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldAction.executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(newLease?.fencingGeneration).toBe(1);
    const recoveredAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.logicalActionId === oldAction.logicalActionId,
        ),
      (event) => event !== undefined,
      30_000,
    );
    expect(recoveredAction?.providerTurnId).toBe(oldAction.providerTurnId);
    releaseGate(fixture, "new", "action-result");
    const converged = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile),
      (snapshot) =>
        snapshot.observations.length === 1 && snapshot.evidence.length === 1,
      30_000,
    );
    expect(converged.evidence).toHaveLength(1);
    expect(
      converged.commands.filter(
        (row) =>
          row.resolution === "Committed" &&
          row.result_json?.includes('"evidenceId"'),
      ),
    ).toHaveLength(1);
    expect(converged.observations).toHaveLength(1);
    expect(targetActionCalls).toBe(1);
    await newDaemon.crash();
  }, 180_000);
});
