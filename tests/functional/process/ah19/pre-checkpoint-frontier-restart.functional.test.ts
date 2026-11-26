import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { hashInstructionContent } from "../../../../packages/model-context/src/index.js";
import { startProductionFixture } from "../../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../../support/public-client.js";
import {
  ah19AfterEach,
  ah19WorkSeed,
  approvedRootWorkReply,
  childEntry,
  fixtures,
  holdFirstWorkProviderRequest,
  probes,
  providerRequests,
  readExecutionIdForProviderTurn,
  readSnapshot,
  readTypedSessionRows,
  seedRootWorkViaPublicApproval,
  startReportServer,
} from "./support.js";

afterEach(ah19AfterEach);

describe("AH19 ProviderNative binding recovery", () => {
  it("reconstructs the public latest-64 Work frontier after pre-checkpoint restart", {
    timeout: 240_000,
  }, async () => {
    probes.length = 0;
    providerRequests.length = 0;
    const reportUrl = await startReportServer();
    const marker = `AH19-WORK-PRECHECKPOINT-${crypto.randomUUID()}`;
    const workSeed = ah19WorkSeed(
      "Build a public Work Session frontier across repeated Steer turns.",
      marker,
      "qualify the fixed pre-checkpoint row bound across restart",
    );
    const heldWorkRequest = holdFirstWorkProviderRequest(workSeed);
    const rootReply = approvedRootWorkReply(marker, workSeed);
    const fixture = await startProductionFixture({
      reply: (call, index) => {
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          available.has("claim_completion") &&
          available.has("wait") &&
          JSON.stringify(call.messages).includes(workSeed.objective)
        ) {
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              reason: `AH19 pre-checkpoint fixture pauses the current Work ${marker}`,
              waitSpec: {
                mode: "Any",
                conditions: [{ _tag: "Manual" }],
              },
            },
          };
        }
        return rootReply(call, index);
      },
      beforeResponse: heldWorkRequest.beforeResponse,
      daemonEnvironment: { ARBOR_AH19_REPORT_URL: reportUrl },
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH19 pre-checkpoint public Work frontier",
    );
    const daemonEnvironment = {
      ARBOR_AH19_BOUNDARY: "none",
      ARBOR_AH19_ORDINARY_WORK: "1",
      ARBOR_AH19_CONTEXT_WINDOW: "1000000",
      ARBOR_AH19_REPORT_URL: reportUrl,
    };
    const workId = await seedRootWorkViaPublicApproval(
      fixture,
      client,
      project,
      marker,
      workSeed,
      daemonEnvironment,
      heldWorkRequest,
    );

    const currentWork = async () =>
      client.view<{
        workId?: string;
        revision: number;
        status: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", { workspaceId: project.rootWorkspaceId });
    const awaitIdleWork = () =>
      waitForPublic(
        currentWork,
        (work) =>
          work?.workId === workId &&
          work.status === "Open" &&
          work.activeExecution === undefined,
        60_000,
      );
    const typedRowsNow = () =>
      readTypedSessionRows(fixture.databaseFile, project.rootSessionId);

    const idle = await awaitIdleWork();
    if (idle?.workId !== workId) {
      throw new Error("pre-checkpoint Work stopped being current");
    }
    // B2: keep "rows > 64" satisfiable — 32 steers could land on exactly 64.
    const batchSize = 40;
    for (let index = 0; index < batchSize; index += 1) {
      await client.command(project.projectId, "SteerWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: idle.revision + index,
        steer: {
          severity: "Normal",
          guidance: `AH19 pre-checkpoint public Steer ${index} ${marker}`,
        },
        provenance: { source: "HumanInput" },
      });
    }
    const batchedRevision = idle.revision + batchSize;
    // B2: revision ∧ idle ∧ rows raced projection vs idle; drop idle here.
    await waitForPublic(
      async () => ({
        work: await currentWork(),
        rows: typedRowsNow(),
      }),
      (state) =>
        state.work?.revision === batchedRevision && state.rows.length > 64,
      120_000,
    );
    await awaitIdleWork();

    const beforeRestartRows = typedRowsNow();
    expect(beforeRestartRows.length).toBeGreaterThan(64);
    expect(
      beforeRestartRows.some((row) => row.item_type === "CompactionCheckpoint"),
    ).toBe(false);
    const priorRequests = providerRequests.length;

    await fixture.crash();
    await fixture.restart({ entry: childEntry, daemonEnvironment });
    const idleAfterRestart = await awaitIdleWork();
    if (idleAfterRestart?.workId !== workId) {
      throw new Error("Work was not restored after the pre-checkpoint crash");
    }
    const currentGuidance = `AH19 pre-checkpoint after restart ${marker}`;
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: idleAfterRestart.revision,
      steer: { severity: "Normal", guidance: currentGuidance },
      provenance: { source: "HumanInput" },
    });
    const resumedRequest = await waitForPublic(
      async () =>
        providerRequests
          .slice(priorRequests)
          .find(
            (request) =>
              request.operationKind === "Inference" &&
              request.items.some(
                (item) =>
                  item._tag === "Message" &&
                  item.role === "user" &&
                  item.text?.includes(currentGuidance),
              ),
          ),
      (request) => request !== undefined,
      120_000,
    ).catch(async (error: unknown) => {
      const diagnosticDb = new DatabaseSync(fixture.databaseFile, {
        readOnly: true,
      });
      let recentExecutions: unknown;
      let recentProviderTurns: unknown;
      try {
        recentExecutions = diagnosticDb
          .prepare(
            `SELECT execution_id, episode_kind, episode_revision,
                    settlement_kind, settled_at
               FROM executions ORDER BY admitted_at DESC LIMIT 5`,
          )
          .all();
        recentProviderTurns = diagnosticDb
          .prepare(
            `SELECT provider_turn_id, execution_id, context_epoch,
                    settled_at, finish_reason
               FROM provider_turns ORDER BY rowid DESC LIMIT 8`,
          )
          .all();
      } finally {
        diagnosticDb.close();
      }
      const [work, rows] = await Promise.all([
        currentWork().catch((readError: unknown) => ({
          readError:
            readError instanceof Error ? readError.message : String(readError),
        })),
        Promise.resolve(typedRowsNow()),
      ]);
      throw new Error(
        `post-restart Inference was not observed within 120s: ${error instanceof Error ? error.message : String(error)}; work=${JSON.stringify(work)}; sessionRows=${JSON.stringify({ count: rows.length, tail: rows.slice(-8).map(({ sequence, item_type, source_ref }) => ({ sequence, item_type, source_ref })) })}; recentExecutions=${JSON.stringify(recentExecutions)}; recentProviderTurns=${JSON.stringify(recentProviderTurns)}; requestsAfterSteer=${JSON.stringify(providerRequests.slice(priorRequests).map(({ operationKind, providerTurnId, bindingVariant, workActionHistoryCount }) => ({ operationKind, providerTurnId, bindingVariant, workActionHistoryCount })))}; providerCallCount=${fixture.providerCalls.length}; recentProviderTools=${JSON.stringify(fixture.providerCalls.slice(-8).map((call) => call.tools.map((tool) => tool.function?.name).filter(Boolean)))}; daemonProcess=${JSON.stringify(fixture.daemonProcessSnapshot())}; startup=${JSON.stringify(fixture.startupDiagnostics())}; daemonErrors=${JSON.stringify(fixture.daemonErrors.slice(-20))}`,
      );
    });
    if (resumedRequest === undefined) {
      throw new Error("post-restart Work provider request was not observed");
    }

    const executionId = readExecutionIdForProviderTurn(
      fixture.databaseFile,
      resumedRequest.providerTurnId,
    );
    const snapshot = readSnapshot(fixture.databaseFile, {
      sessionId: project.rootSessionId,
      executionId,
      workId,
    });
    expect(snapshot.checkpoints).toEqual([]);
    const resumedTurn = snapshot.providerTurns.find(
      (turn) => turn.provider_turn_id === resumedRequest.providerTurnId,
    );
    expect(resumedTurn?.manifest_json).toBeTruthy();
    const manifest = JSON.parse(resumedTurn?.manifest_json ?? "{}") as {
      inputFrontier?: {
        firstSequence: number | null;
        lastSequence: number | null;
      };
      controlBasis?: {
        projectPolicyRevision: number;
        workspacePolicyRevision: number;
        responsibilityRevision: number;
        resourceBoundaryRevision: number;
        authorizationDigest: string;
        environmentRevision: string;
        workId?: string;
        workRevision?: number;
      };
      instructionFragments?: ReadonlyArray<{
        identity: string;
        revision: number;
        source: string;
        scope: string;
        hash: string;
      }>;
      contextRefs?: ReadonlyArray<string>;
    };
    const allRowsAfterRequest = typedRowsNow();
    const rawLatest64 = allRowsAfterRequest
      .filter(
        (row) =>
          manifest.inputFrontier?.lastSequence !== null &&
          manifest.inputFrontier?.lastSequence !== undefined &&
          row.sequence <= manifest.inputFrontier.lastSequence,
      )
      .slice(-64);
    expect(rawLatest64).toHaveLength(64);
    const projectedContextRefs = new Set(manifest.contextRefs ?? []);
    const projectedRows = rawLatest64.filter(
      (row) =>
        row.source_kind !== null &&
        row.source_ref !== null &&
        projectedContextRefs.has(
          `session:${row.source_kind}:${row.source_ref}`,
        ),
    );
    expect(projectedRows.length).toBeGreaterThan(0);
    expect(projectedRows.length).toBeLessThanOrEqual(64);
    expect(manifest.inputFrontier).toEqual({
      firstSequence: projectedRows[0]?.sequence,
      lastSequence: projectedRows.at(-1)?.sequence,
    });
    for (const prior of beforeRestartRows) {
      expect(allRowsAfterRequest).toContainEqual(prior);
    }
    expect(
      allRowsAfterRequest.some(
        (row) => row.item_type === "CompactionCheckpoint",
      ),
    ).toBe(false);

    const portableRequest = JSON.parse(
      resumedTurn?.portable_request_json ?? "{}",
    ) as {
      inputItems?: ReadonlyArray<{
        _tag?: string;
        role?: string;
        text?: string;
      }>;
    };
    const resumedGuidanceItems =
      portableRequest.inputItems?.filter(
        (item) =>
          item._tag === "Message" &&
          item.role === "user" &&
          item.text?.includes(currentGuidance),
      ) ?? [];
    expect(
      resumedGuidanceItems,
      JSON.stringify({
        inputFrontier: manifest.inputFrontier,
        contextRefs: manifest.contextRefs,
        inputItems: portableRequest.inputItems,
        tailRows: allRowsAfterRequest.slice(-12),
      }),
    ).toHaveLength(1);

    const controlBasis = manifest.controlBasis;
    expect(controlBasis).toMatchObject({
      workId,
      workRevision: expect.any(Number),
      authorizationDigest: expect.stringMatching(/.+/u),
      projectPolicyRevision: expect.any(Number),
      workspacePolicyRevision: expect.any(Number),
      responsibilityRevision: expect.any(Number),
      resourceBoundaryRevision: expect.any(Number),
    });
    for (const turn of snapshot.providerTurns) {
      const turnManifest = JSON.parse(turn.manifest_json ?? "{}") as {
        controlBasis?: typeof controlBasis;
        instructionFragments?: typeof manifest.instructionFragments;
      };
      expect(turnManifest.controlBasis).toMatchObject({
        workId,
        workRevision: expect.any(Number),
        authorizationDigest: expect.stringMatching(/.+/u),
        projectPolicyRevision: expect.any(Number),
        workspacePolicyRevision: expect.any(Number),
        responsibilityRevision: expect.any(Number),
        resourceBoundaryRevision: expect.any(Number),
        environmentRevision: expect.any(String),
      });
      const turnBasis = turnManifest.controlBasis;
      const expectedPins: ReadonlyArray<readonly [string, number | undefined]> =
        [
          [`work-objective:${workId}`, turnBasis?.workRevision],
          [`work-constraints:${workId}`, turnBasis?.workRevision],
          [`completion-expectation:${workId}`, turnBasis?.workRevision],
          [`verification-mission:${workId}`, turnBasis?.workRevision],
          [
            `responsibility:${project.rootWorkspaceId}`,
            turnBasis?.responsibilityRevision,
          ],
          [
            `resource-boundary:${project.rootWorkspaceId}`,
            turnBasis?.resourceBoundaryRevision,
          ],
        ];
      const portableTurnRequest = JSON.parse(
        turn.portable_request_json ?? "{}",
      ) as {
        instructions?: ReadonlyArray<{
          slotId: string;
          authorityRole: string;
          text: string;
        }>;
      };
      for (const [identity, revision] of expectedPins) {
        const fragment = turnManifest.instructionFragments?.find(
          (candidate) => candidate.identity === identity,
        );
        expect(fragment).toMatchObject({
          identity,
          revision,
          hash: expect.any(String),
          source: "Canonical",
          scope: expect.any(String),
        });
        const expectedAuthorityRole =
          identity.startsWith("responsibility:") ||
          identity.startsWith("resource-boundary:")
            ? "A2"
            : "A3";
        const requestInstruction = portableTurnRequest.instructions?.find(
          (instruction) => instruction.slotId === fragment?.scope,
        );
        expect(requestInstruction).toMatchObject({
          slotId: fragment?.scope,
          authorityRole: expectedAuthorityRole,
          text: expect.any(String),
        });
        expect(hashInstructionContent(requestInstruction?.text ?? "")).toBe(
          fragment?.hash,
        );
      }
      expect(turnManifest.controlBasis?.projectPolicyRevision).toBe(
        controlBasis?.projectPolicyRevision,
      );
      expect(turnManifest.controlBasis?.workspacePolicyRevision).toBe(
        controlBasis?.workspacePolicyRevision,
      );
      expect(turnManifest.controlBasis?.environmentRevision).toBe(
        controlBasis?.environmentRevision,
      );
      expect(turnManifest.controlBasis?.authorizationDigest).toBe(
        controlBasis?.authorizationDigest,
      );
    }
    expect(fixture.daemonErrors).toEqual([]);
  });
});
