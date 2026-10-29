import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  functionalId,
  makePublicClient,
  waitForPublic,
} from "../support/public-client.js";

interface S2RevisionRow {
  readonly work_id: string;
  readonly work_revision: number;
  readonly contract_json: string;
  readonly record_kind: string;
  readonly source_command_id: string | null;
}

interface S2VerificationRow {
  readonly verification_id: string;
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly state: string;
  readonly verdict: string | null;
  readonly mission_snapshot: string;
}

interface S2ExecutionRow {
  readonly execution_id: string;
  readonly stop_requested_at: string | null;
  readonly settled_at: string | null;
}

interface S2WorkRow {
  readonly work_id: string;
  readonly lifecycle: string;
  readonly revision: number;
}

interface S2EventRow {
  readonly event_type: string;
  readonly caused_by_command_id: string | null;
  readonly payload_json: string;
}

const fixtures: ProductionFixture[] = [];

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

/** Test oracle only: the public journey causes every write; this helper reads
 * one consistent snapshot from the fixture's disposable database. */
const readS2Snapshot = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  db.exec("BEGIN");
  try {
    return {
      works: db
        .prepare(
          "SELECT work_id, lifecycle, revision FROM works ORDER BY work_id",
        )
        .all() as unknown as S2WorkRow[],
      revisions: db
        .prepare(
          `SELECT work_id, work_revision, contract_json, record_kind,
                  source_command_id
             FROM work_contract_revisions ORDER BY work_id, work_revision`,
        )
        .all() as unknown as S2RevisionRow[],
      verifications: db
        .prepare(
          `SELECT verification_id, work_id, target_work_revision, state,
                  verdict, mission_snapshot
             FROM verifications ORDER BY target_work_revision, verification_id`,
        )
        .all() as unknown as S2VerificationRow[],
      executions: db
        .prepare(
          `SELECT execution_id, stop_requested_at, settled_at
             FROM executions ORDER BY admitted_at, execution_id`,
        )
        .all() as unknown as S2ExecutionRow[],
      providerTurns: db
        .prepare(
          `SELECT provider_turn_id, execution_id FROM provider_turns
            ORDER BY started_at, provider_turn_id`,
        )
        .all() as Array<{
        readonly provider_turn_id: string;
        readonly execution_id: string;
      }>,
      toolInvocations: db
        .prepare(
          `SELECT invocation_id, execution_id, tool_name FROM tool_invocations
            ORDER BY intent_at, invocation_id`,
        )
        .all() as Array<{
        readonly invocation_id: string;
        readonly execution_id: string;
        readonly tool_name: string;
      }>,
      events: db
        .prepare(
          `SELECT event_type, caused_by_command_id, payload_json
             FROM domain_events ORDER BY sequence`,
        )
        .all() as unknown as S2EventRow[],
    };
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
};

describe("S2 public Work revision, verification binding, and Critical Steer", () => {
  it("preserves direction guidance, amends the exact contract, stops the exact main, and replays one receipt after restart", async () => {
    const marker = `S2-${crypto.randomUUID().slice(0, 8)}`;
    const directionGuidance = `S2-DIRECTION-${marker}`;
    const amendedObjective = `S2-AMENDED-OBJECTIVE-${marker}`;
    const amendedMissionGoal = `S2-AMENDED-MISSION-${marker}`;
    const amendment = {
      objective: amendedObjective,
      why: `The human replaced the previous contract for ${marker}.`,
      constraints: [`retain exact S2 revision history for ${marker}`],
      completionExpectation: `the amended outcome for ${marker} is verified`,
      verificationMission: {
        goal: amendedMissionGoal,
        criteria: [
          {
            criterionId: "s2-amended-result",
            requirement: `the amended result for ${marker} is present`,
            required: true,
          },
        ],
        riskRequirements: [],
      },
    };

    let initialClaimRequested = false;
    let amendedClaimRequested = false;
    let verificationReadIssued = false;
    let criticalGateArmed = false;
    let criticalHeldResponseWouldClaimCompletion = false;
    let criticalHeldProviderCall:
      | ProductionFixture["providerCalls"][number]
      | undefined;
    let signalCriticalGate!: () => void;
    let releaseCriticalGate!: () => void;
    const criticalGateReached = new Promise<void>((resolve) => {
      signalCriticalGate = resolve;
    });
    const criticalGateReleased = new Promise<void>((resolve) => {
      releaseCriticalGate = resolve;
    });

    const fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
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
            ? { _tag: "Text", text: `Work admitted for ${marker}.` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Complete the baseline S2 contract for ${marker}.`,
                  why: `Initial contract for ${marker}.`,
                  constraints: [`preserve baseline ${marker}`],
                  completionExpectation: `baseline ${marker} is verified`,
                  verificationMission: {
                    goal: `S2 baseline verification ${marker}`,
                    criteria: [
                      {
                        criterionId: "s2-baseline-result",
                        requirement: `baseline result for ${marker} is present`,
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: `S2 baseline ${marker}`,
                },
              };
        }

        if (available.has("record_verification_evidence")) {
          const evidenceIds = [...context.matchAll(/evd_[0-9a-f-]{36}/gu)].map(
            (match) => match[0],
          );
          const amendedMission = context.includes(amendedMissionGoal);
          const criterionId = amendedMission
            ? "s2-amended-result"
            : "s2-baseline-result";
          const requirement = amendedMission
            ? `the amended result for ${marker} is present`
            : `baseline result for ${marker} is present`;
          if (evidenceIds.length > 0) {
            verificationReadIssued = false;
            return {
              _tag: "ToolCall",
              name: "conclude_verification",
              arguments: {
                verdict: "Pass",
                criteriaResults: [
                  {
                    criterionId,
                    requirement,
                    required: true,
                    verdict: "Pass",
                    evidenceRefs: [evidenceIds.at(-1)],
                  },
                ],
                summary: `S2 public evidence for ${marker}.`,
              },
            };
          }
          if (!verificationReadIssued) {
            verificationReadIssued = true;
            return {
              _tag: "ToolCall",
              name: "read",
              arguments: {
                target: { mount: "workspace", path: "proof.txt" },
                limit: 80,
              },
            };
          }
          return {
            _tag: "ToolCall",
            name: "record_verification_evidence",
            arguments: { criterionId, sourceCallRef: "1" },
          };
        }

        if (available.has("claim_completion")) {
          if (context.includes(amendedObjective)) {
            amendedClaimRequested = true;
            verificationReadIssued = false;
            return {
              _tag: "ToolCall",
              name: "claim_completion",
              arguments: { claim: `complete amended S2 contract ${marker}` },
            };
          }
          if (context.includes(directionGuidance) && criticalGateArmed) {
            criticalHeldResponseWouldClaimCompletion = true;
            verificationReadIssued = false;
            return {
              _tag: "ToolCall",
              name: "claim_completion",
              arguments: { claim: `complete S2 contract ${marker}` },
            };
          }
          if (!initialClaimRequested) {
            initialClaimRequested = true;
            verificationReadIssued = false;
            return {
              _tag: "ToolCall",
              name: "claim_completion",
              arguments: { claim: `complete baseline S2 contract ${marker}` },
            };
          }
          return manualWait(`S2 waits for the next human revision ${marker}`);
        }

        return { _tag: "Text", text: `Observed ${marker}.` };
      },
      beforeResponse: async (call) => {
        const context = JSON.stringify(call.messages);
        if (
          criticalGateArmed &&
          context.includes(directionGuidance) &&
          call.tools.some((tool) => tool.function?.name === "claim_completion")
        ) {
          criticalGateArmed = false;
          criticalHeldProviderCall = call;
          signalCriticalGate();
          await criticalGateReleased;
          return "respond";
        }
        return undefined;
      },
    });
    fixtures.push(fixture);

    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `S2 revision ${marker}`,
      { resourceSelection: "Profile" },
    );
    writeFileSync(
      join(fixture.workspaceDirectory, "proof.txt"),
      `FUNCTIONAL_VERIFIED ${marker}`,
    );
    const rootWork = await admitRootWorkThroughPublicConversation(
      client,
      project,
      marker,
      `Please admit baseline Work ${marker} and independently verify it.`,
    );

    const baseline = await waitForPublic(
      async () => readS2Snapshot(fixture.databaseFile),
      (snapshot) =>
        snapshot.verifications.some(
          (verification) =>
            verification.work_id === rootWork.workId &&
            verification.target_work_revision === 0 &&
            verification.state === "Concluded" &&
            verification.verdict === "Pass",
        ),
      90_000,
    );
    const oldVerification = baseline.verifications.find(
      (verification) =>
        verification.work_id === rootWork.workId &&
        verification.target_work_revision === 0,
    );
    const initialRevision = baseline.revisions.find(
      (revision) =>
        revision.work_id === rootWork.workId && revision.work_revision === 0,
    );
    if (oldVerification === undefined || initialRevision === undefined) {
      throw new Error("S2 baseline verification or initial revision missing");
    }
    const initialContract = JSON.parse(initialRevision.contract_json) as Record<
      string,
      unknown
    >;

    const normalCommandId = functionalId("cmd");
    const normal = await client.rawCommand(
      project.projectId,
      "SteerWork",
      {
        workId: rootWork.workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: 0,
        steer: { severity: "Normal", guidance: directionGuidance },
        provenance: { source: "HumanInput" },
      },
      normalCommandId,
    );
    expect(normal.status).toBe(200);
    expect(
      (normal.payload.body as { readonly resolution?: string }).resolution,
    ).toBe("Committed");
    const directionRevision = await waitForPublic(
      async () => readS2Snapshot(fixture.databaseFile),
      (snapshot) =>
        snapshot.revisions.some(
          (revision) =>
            revision.work_id === rootWork.workId &&
            revision.work_revision === 1,
        ),
    );
    const directionSnapshot = directionRevision.revisions.find(
      (revision) =>
        revision.work_id === rootWork.workId && revision.work_revision === 1,
    );
    expect(directionSnapshot?.record_kind).toBe("DirectionGuidance");
    expect(directionSnapshot?.source_command_id).toBe(normalCommandId);
    expect(JSON.parse(directionSnapshot?.contract_json ?? "null")).toEqual(
      initialContract,
    );
    expect(
      directionRevision.events.some(
        (event) => event.event_type === "ExecutionStopRequested",
      ),
    ).toBe(false);

    criticalGateArmed = true;
    const currentV1 = await waitForPublic(
      () =>
        client.view<{
          readonly workId?: string;
          readonly revision: number;
          readonly status: string;
          readonly activeExecution?: { readonly executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (work) =>
        work?.workId === rootWork.workId &&
        work.revision === 1 &&
        work.activeExecution !== undefined,
      60_000,
    );
    await criticalGateReached;
    const heldProviderCall = criticalHeldProviderCall;
    if (heldProviderCall === undefined) {
      throw new Error(
        "S2 Critical Steer did not capture its held Provider request",
      );
    }
    expect(criticalHeldResponseWouldClaimCompletion).toBe(true);
    expect(JSON.stringify(heldProviderCall.messages)).toContain(
      directionGuidance,
    );
    expect(
      heldProviderCall.tools.some(
        (tool) => tool.function?.name === "claim_completion",
      ),
    ).toBe(true);
    const activeExecutionId = currentV1?.activeExecution?.executionId;
    if (activeExecutionId === undefined) {
      throw new Error("S2 Critical Steer setup has no exact active main");
    }
    const beforeCritical = readS2Snapshot(fixture.databaseFile);
    const preStopProviderTurns = beforeCritical.providerTurns.filter(
      (turn) => turn.execution_id === activeExecutionId,
    );
    const preStopToolInvocations = beforeCritical.toolInvocations.filter(
      (invocation) => invocation.execution_id === activeExecutionId,
    );

    const criticalCommandId = functionalId("cmd");
    const criticalPayload = {
      workId: rootWork.workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: 1,
      steer: {
        severity: "Critical",
        operation: { kind: "ContractAmendment", amendment },
      },
      provenance: { source: "HumanInput" },
    } as const;
    const criticalCommitted = await client.rawCommand(
      project.projectId,
      "SteerWork",
      criticalPayload,
      criticalCommandId,
    );
    expect(criticalCommitted.status).toBe(200);
    expect(
      (criticalCommitted.payload.body as { readonly resolution?: string })
        .resolution,
    ).toBe("Committed");
    releaseCriticalGate();

    const afterCritical = await waitForPublic(
      async () => readS2Snapshot(fixture.databaseFile),
      (snapshot) =>
        snapshot.revisions.some(
          (revision) =>
            revision.work_id === rootWork.workId &&
            revision.work_revision === 2,
        ) &&
        snapshot.executions.some(
          (execution) =>
            execution.execution_id === activeExecutionId &&
            execution.stop_requested_at !== null,
        ),
    );
    const amendedRevision = afterCritical.revisions.find(
      (revision) =>
        revision.work_id === rootWork.workId && revision.work_revision === 2,
    );
    expect(amendedRevision?.record_kind).toBe("ContractAmendment");
    expect(JSON.parse(amendedRevision?.contract_json ?? "null")).toEqual(
      amendment,
    );
    const criticalFacts = afterCritical.events.filter(
      (event) => event.caused_by_command_id === criticalCommandId,
    );
    expect(criticalFacts.map((event) => event.event_type)).toContain(
      "WorkAmended",
    );
    expect(
      criticalFacts.filter(
        (event) => event.event_type === "ExecutionStopRequested",
      ),
    ).toHaveLength(1);
    expect(
      JSON.parse(
        criticalFacts.find(
          (event) => event.event_type === "ExecutionStopRequested",
        )?.payload_json ?? "{}",
      ),
    ).toMatchObject({ executionId: activeExecutionId });
    const quiesced = await waitForPublic(
      async () => readS2Snapshot(fixture.databaseFile),
      (snapshot) =>
        snapshot.executions.some(
          (execution) =>
            execution.execution_id === activeExecutionId &&
            execution.settled_at !== null,
        ),
    );
    // This request was already sent before Critical committed. Its ProviderTurn
    // may settle durably; the exact stopped execution must not start another
    // action. A newly scheduled revision-2 execution is outside this oracle.
    const quiescedProviderTurns = quiesced.providerTurns.filter(
      (turn) => turn.execution_id === activeExecutionId,
    );
    expect([
      preStopProviderTurns.length,
      preStopProviderTurns.length + 1,
    ]).toContain(quiescedProviderTurns.length);
    expect(
      quiesced.toolInvocations.filter(
        (invocation) => invocation.execution_id === activeExecutionId,
      ),
    ).toEqual(preStopToolInvocations);
    expect(
      quiesced.works.find((work) => work.work_id === rootWork.workId),
    ).toMatchObject({ lifecycle: "Open", revision: 2 });
    expect(
      quiesced.events
        .slice(beforeCritical.events.length)
        .map((event) => event.event_type),
    ).not.toContain("WorkOutcomeAccepted");
    expect(
      quiesced.events
        .slice(beforeCritical.events.length)
        .map((event) => event.event_type),
    ).not.toContain("WorkCompleted");

    const staleAcceptance = await client.rawCommand(
      project.projectId,
      "AcceptWorkOutcome",
      {
        acceptanceId: functionalId("acc"),
        workId: rootWork.workId,
        targetWorkRevision: 2,
        verificationId: oldVerification.verification_id,
      },
    );
    expect(
      (staleAcceptance.payload.body as { readonly resolution?: string })
        .resolution,
    ).toBe("TerminalRejected");
    expect(
      (staleAcceptance.payload.body as { readonly rejection?: string })
        .rejection,
    ).toBe("VerificationAcceptanceMismatch");

    await fixture.crash();
    await fixture.restart();
    const replay = await client.rawCommand(
      project.projectId,
      "SteerWork",
      criticalPayload,
      criticalCommandId,
    );
    expect(replay.status).toBe(200);
    expect(replay.payload).toEqual(criticalCommitted.payload);
    const replaySnapshot = readS2Snapshot(fixture.databaseFile);
    expect(
      replaySnapshot.revisions.filter(
        (revision) =>
          revision.work_id === rootWork.workId && revision.work_revision === 2,
      ),
    ).toHaveLength(1);
    expect(
      replaySnapshot.events.filter(
        (event) =>
          event.event_type === "ExecutionStopRequested" &&
          event.caused_by_command_id === criticalCommandId,
      ),
    ).toHaveLength(1);
    expect(
      replaySnapshot.executions.find(
        (execution) => execution.execution_id === activeExecutionId,
      )?.stop_requested_at,
    ).not.toBeNull();

    await waitForPublic(
      async () => ({
        snapshot: readS2Snapshot(fixture.databaseFile),
        amendedClaimRequested,
      }),
      ({ snapshot, amendedClaimRequested: requested }) =>
        requested &&
        snapshot.verifications.some(
          (verification) =>
            verification.work_id === rootWork.workId &&
            verification.target_work_revision === 2 &&
            verification.state === "Concluded" &&
            verification.verdict === "Pass",
        ),
      90_000,
    );
    const finalSnapshot = readS2Snapshot(fixture.databaseFile);
    const newVerification = finalSnapshot.verifications.find(
      (verification) =>
        verification.work_id === rootWork.workId &&
        verification.target_work_revision === 2,
    );
    expect(newVerification).toBeDefined();
    expect(JSON.parse(newVerification?.mission_snapshot ?? "null")).toEqual(
      amendment.verificationMission,
    );
    expect(
      finalSnapshot.verifications.some(
        (verification) =>
          verification.work_id === rootWork.workId &&
          verification.target_work_revision === 1,
      ),
    ).toBe(false);

    const accepted = await client.command(
      project.projectId,
      "AcceptWorkOutcome",
      {
        acceptanceId: functionalId("acc"),
        workId: rootWork.workId,
        targetWorkRevision: 2,
        verificationId: newVerification?.verification_id,
      },
    );
    expect((accepted.body as { readonly resolution?: string }).resolution).toBe(
      "Committed",
    );
    expect(fixture.daemonErrors).toEqual([]);
  }, 180_000);
});
