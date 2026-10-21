import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  type ScriptedProviderResponse,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForPublic,
} from "../support/public-client.js";
import { makeWorkProvider } from "../support/work-provider.js";

const fixtures: ProductionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const serialized = (call: CapturedProviderCall): string =>
  JSON.stringify(call.messages);

const tools = (call: CapturedProviderCall): ReadonlySet<string> =>
  new Set(
    call.tools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => name !== undefined),
  );

const waitForF18PublicStage = async <T>(
  fixture: ProductionFixture,
  projectId: string,
  stage: string,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    const database = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    let facts: unknown;
    try {
      const reconciliations = database
        .prepare(
          `SELECT event_sequence, phase, lease_generation, failure_code
             FROM verification_signal_reconciliations
            WHERE project_id = ? ORDER BY event_sequence DESC LIMIT 3`,
        )
        .all(projectId);
      const offset = database
        .prepare(
          `SELECT last_sequence FROM consumer_offsets
            WHERE consumer_id = 'workflow-signals' AND project_id = ?`,
        )
        .get(projectId) as { last_sequence: number } | undefined;
      facts = { reconciliations, offset: offset?.last_sequence ?? null };
    } catch {
      facts = { databaseFacts: "unavailable" };
    } finally {
      database.close();
    }
    throw new Error(
      `F18 public wait failed at ${stage}; facts=${JSON.stringify(facts)}`,
      { cause: error },
    );
  }
};

describe("release-functional long-lived responsibility", () => {
  it("F18 proposes, approves, runs and parent-accepts a child result", async () => {
    const marker = `F18-CHILD-${crypto.randomUUID().slice(0, 8)}`;
    let childDirectory = "";
    let allowParentAcceptance = false;
    const childWorkProvider = makeWorkProvider({ marker, verdict: "Pass" });
    const reply = (call: CapturedProviderCall): ScriptedProviderResponse => {
      const available = tools(call);
      const context = serialized(call);
      const readyResultRef = /rref_[a-f0-9]{64}/u.exec(context)?.[0];
      if (
        available.has("accept_result") &&
        readyResultRef !== undefined &&
        allowParentAcceptance
      ) {
        return {
          _tag: "ToolCall",
          name: "accept_result",
          arguments: { resultRef: readyResultRef },
        };
      }
      if (available.has("accept_result") && readyResultRef !== undefined) {
        return {
          _tag: "Text",
          text: "The result is waiting for durable recovery qualification.",
        };
      }
      if (
        available.has("accept_result") &&
        available.has("list_workspaces") &&
        context.includes("Child result ready")
      ) {
        return {
          _tag: "ToolCall",
          name: "list_workspaces",
          arguments: { query: marker },
        };
      }
      if (
        available.has("propose_workspace") &&
        !available.has("claim_completion") &&
        context.includes(marker)
      ) {
        if (context.includes("ProposalRecorded(")) {
          return {
            _tag: "Text",
            text: `Proposal for ${marker} awaits governance`,
          };
        }
        return {
          _tag: "ToolCall",
          name: "propose_workspace",
          arguments: {
            name: `child-${marker}`,
            rationale: "independent long-lived responsibility",
            responsibilityDraft: {
              purpose: `own ${marker}`,
              ownedResponsibilities: [marker],
              obligations: ["deliver a verified result"],
              includes: [],
              excludes: [],
              interfaces: [],
            },
            resourceBoundaryDraft: {
              addresses: [{ _tag: "FileTree", path: childDirectory }],
            },
            initialWork: {
              objective: `Complete ${marker}.`,
              why: "exercise child responsibility delivery",
              constraints: ["do not perform external side effects"],
              completionExpectation: "verified child result",
              verificationMission: {
                goal: `Verify ${marker}`,
                criteria: [
                  {
                    criterionId: "functional-criterion",
                    requirement: `proof.txt contains FUNCTIONAL_VERIFIED for ${marker}`,
                    required: true,
                  },
                ],
                riskRequirements: ["read-only verification"],
              },
            },
          },
        };
      }
      return childWorkProvider(call);
    };

    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      admitWorkspaceDirectory: true,
      reply,
      daemonEnvironment: {
        NODE_ENV: "test",
        ARBOR_F18_TEST_LEASE_TTL_MS: "5000",
      },
    });
    fixtures.push(fixture);
    childDirectory = fixture.workspaceDirectory;
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F18 organization",
      { resourceSelection: "Profile" },
    );

    await submitHumanMessage(
      client,
      project,
      `请为独立长期职责 ${marker} 提议一个子工作区，并附带首个工作。`,
    );
    const governance = await waitForF18PublicStage(
      fixture,
      project.projectId,
      "governance-entry",
      () =>
        waitForPublic(
          () =>
            client.view<{
              unconsumed: Array<{
                entryKey: string;
                kind: string;
                summary: string;
              }>;
            }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
          (value) =>
            value.unconsumed.some(
              (entry) =>
                entry.kind === "Governance" &&
                entry.summary.includes(marker) &&
                /^gov:fpr_[^:]+:\d+$/u.test(entry.entryKey),
            ),
        ),
    );
    const entry = governance.unconsumed.find(
      (candidate) =>
        candidate.summary.includes(marker) &&
        /^gov:fpr_[^:]+:\d+$/u.test(candidate.entryKey),
    );
    const target =
      entry === undefined
        ? null
        : /^gov:(fpr_[^:]+):(\d+)$/u.exec(entry.entryKey);
    if (target === null) throw new Error("no public formation target");

    const before = await client.view<{
      nodes: Array<{ workspaceId: string; name: string }>;
    }>("responsibility-tree", { projectId: project.projectId });
    expect(before.nodes).toHaveLength(1);
    await client.command(project.projectId, "RecordDecision", {
      proposalId: target[1],
      expectedProposalRevision: Number(target[2]),
      outcome: { _tag: "Approve" },
    });

    const childWithWork = await waitForF18PublicStage(
      fixture,
      project.projectId,
      "child-work-created",
      () =>
        waitForPublic(
          () =>
            client.view<{
              nodes: Array<{
                workspaceId: string;
                parentWorkspaceId: string | null;
                name: string;
                currentWork?: { workId?: string; objective: string };
              }>;
            }>("responsibility-tree", { projectId: project.projectId }),
          (tree) =>
            tree.nodes.some(
              (node) =>
                node.parentWorkspaceId === project.rootWorkspaceId &&
                node.name === `child-${marker}` &&
                node.currentWork?.workId !== undefined,
            ),
          45_000,
        ),
    );
    const child = childWithWork.nodes.find(
      (node) => node.parentWorkspaceId === project.rootWorkspaceId,
    );
    const workId = child?.currentWork?.workId;
    if (child === undefined || workId === undefined) {
      throw new Error("child initial Work is not publicly visible");
    }

    const verification = await waitForF18PublicStage(
      fixture,
      project.projectId,
      "initial-verification-snapshot",
      () =>
        waitForPublic(
          () =>
            client.view<{
              verdict?: string;
              criteriaResults?: Array<{
                criterionId: string;
                requirement: string;
                required: boolean;
                verdict: string;
              }>;
            }>("verification", { workId }),
          (value) =>
            value.verdict === "Pass" &&
            value.criteriaResults?.some(
              (result) =>
                result.criterionId === "functional-criterion" &&
                result.verdict === "Pass",
            ) === true,
          30_000,
        ),
    );
    expect(verification.verdict).toBe("Pass");
    expect(verification.criteriaResults).toHaveLength(1);
    expect(verification.criteriaResults?.[0]).toMatchObject({
      criterionId: "functional-criterion",
      required: true,
      verdict: "Pass",
    });
    expect(verification.criteriaResults?.[0]?.requirement).toContain(marker);

    await fixture.crash();
    const database = new DatabaseSync(fixture.databaseFile);
    let eventSequence = 0;
    let inboxKey = "";
    try {
      database.exec("BEGIN IMMEDIATE");
      const event = database
        .prepare(
          `SELECT event_id, sequence, payload_json FROM domain_events
            WHERE project_id = ? AND event_type = 'VerificationConcluded'
            ORDER BY sequence DESC LIMIT 1`,
        )
        .get(project.projectId) as
        | { event_id: string; sequence: number; payload_json: string }
        | undefined;
      if (event === undefined) throw new Error("F18 conclusion event missing");
      eventSequence = Number(event.sequence);
      const payload = JSON.parse(event.payload_json) as {
        verificationId: string;
        targetWorkRevision: number;
      };
      const expectedInboxKey = `child-result:${payload.verificationId}:${payload.targetWorkRevision}`;
      inboxKey = expectedInboxKey;
      database
        .prepare(
          `INSERT OR IGNORE INTO consumer_dead_letters
            (consumer_id, project_id, sequence, reason, created_at)
           VALUES ('workflow-signals', ?, ?, 'unsupported eventVersion 2', ?)`,
        )
        .run(project.projectId, eventSequence, new Date().toISOString());
      database
        .prepare(
          `INSERT INTO consumer_offsets
            (consumer_id, project_id, last_sequence, updated_at)
           VALUES ('workflow-signals', ?, ?, ?)
           ON CONFLICT(consumer_id, project_id) DO UPDATE SET
             last_sequence = MAX(consumer_offsets.last_sequence, excluded.last_sequence),
             updated_at = excluded.updated_at`,
        )
        .run(project.projectId, eventSequence, new Date().toISOString());
      database
        .prepare(
          "DELETE FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
        )
        .run(project.rootWorkspaceId, expectedInboxKey);
      database.exec("COMMIT");
      const offset = database
        .prepare(
          `SELECT last_sequence FROM consumer_offsets
            WHERE consumer_id = 'workflow-signals' AND project_id = ?`,
        )
        .get(project.projectId) as { last_sequence: number } | undefined;
      expect(Number(offset?.last_sequence ?? 0)).toBeGreaterThanOrEqual(
        eventSequence,
      );
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }

    let crashRestartError: unknown;
    try {
      await fixture.restart({
        daemonEnvironment: {
          NODE_ENV: "test",
          ARBOR_F18_TEST_LEASE_TTL_MS: "5000",
          ARBOR_F18_TEST_CRASH_BOUNDARY: "AfterParentInboxDispositionCommit",
        },
      });
    } catch (error) {
      crashRestartError = error;
    }
    if (
      !(crashRestartError instanceof Error) ||
      !crashRestartError.message.includes(
        "F18_TEST_CRASH:AfterParentInboxDispositionCommit",
      )
    ) {
      const diagnostic = new DatabaseSync(fixture.databaseFile, {
        readOnly: true,
      });
      let reconciliationRows: unknown[] = [];
      try {
        reconciliationRows = diagnostic
          .prepare(
            `SELECT project_id, event_sequence, event_id, verification_id,
                    owner_workspace_id, parent_workspace_id, phase, failure_code
               FROM verification_signal_reconciliations
              WHERE project_id = ? ORDER BY event_sequence`,
          )
          .all(project.projectId);
      } finally {
        diagnostic.close();
      }
      throw new Error(
        `expected the exact F18 commit-boundary crash; actual=${String(crashRestartError)}; reconciliation=${JSON.stringify(reconciliationRows)}; daemon=${fixture.daemonErrors.join(" | ")}`,
        { cause: crashRestartError },
      );
    }
    const afterInboxCommit = new DatabaseSync(fixture.databaseFile, {
      readOnly: true,
    });
    try {
      const phase = afterInboxCommit
        .prepare(
          `SELECT phase FROM verification_signal_reconciliations
            WHERE consumer_id = 'workflow-signals' AND project_id = ?
              AND event_sequence = ?`,
        )
        .get(project.projectId, eventSequence) as { phase: string } | undefined;
      expect(phase?.phase).toBe("ParentInboxCommitted");
      const restoredInbox = afterInboxCommit
        .prepare(
          `SELECT consumed_at FROM inbox_entries
            WHERE workspace_id = ? AND entry_key = ?`,
        )
        .get(project.rootWorkspaceId, inboxKey) as
        | { consumed_at: string | null }
        | undefined;
      expect(restoredInbox).toBeDefined();
    } finally {
      afterInboxCommit.close();
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 5_500));
    allowParentAcceptance = true;
    const barrierDirectory = join(
      fixture.directory,
      "f18-source-validation-barrier",
    );
    mkdirSync(barrierDirectory, { recursive: true });
    const competingEnvironment = {
      NODE_ENV: "test",
      ARBOR_F18_TEST_LEASE_TTL_MS: "5000",
      ARBOR_F18_TEST_CRASH_BOUNDARY: "",
      ARBOR_F18_TEST_BARRIER_DIR: barrierDirectory,
    };
    const [additionalDaemon] = await Promise.all([
      fixture.startAdditionalDaemon({
        entry: resolve("tests/functional/support/nonce-daemon-child.mjs"),
        daemonEnvironment: competingEnvironment,
      }),
      fixture.restart({ daemonEnvironment: competingEnvironment }),
    ]);
    expect(
      readdirSync(barrierDirectory).filter((name) =>
        name.startsWith("arrived-"),
      ),
    ).toHaveLength(2);
    const competed = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    try {
      const phase = competed
        .prepare(
          `SELECT phase, lease_generation FROM verification_signal_reconciliations
            WHERE consumer_id = 'workflow-signals' AND project_id = ?
              AND event_sequence = ?`,
        )
        .get(project.projectId, eventSequence) as
        | { phase: string; lease_generation: number }
        | undefined;
      const inboxCount = Number(
        (
          competed
            .prepare(
              `SELECT COUNT(*) AS n FROM inbox_entries
                WHERE workspace_id = ? AND entry_key = ?`,
            )
            .get(project.rootWorkspaceId, inboxKey) as { n: number }
        ).n,
      );
      expect(phase?.phase).toBe("Completed");
      expect(phase?.lease_generation).toBe(2);
      expect(inboxCount).toBe(1);
    } finally {
      competed.close();
    }
    await additionalDaemon.crash();
    const accepted = await waitForF18PublicStage(
      fixture,
      project.projectId,
      "parent-acceptance",
      () =>
        waitForPublic(
          () =>
            client.view<{
              verdict?: string;
              criteriaResults?: Array<{
                criterionId: string;
                requirement: string;
                required: boolean;
                verdict: string;
              }>;
              acceptance?: { acceptanceId: string };
            }>("verification", { workId }),
          (value) =>
            value.verdict === "Pass" &&
            value.acceptance !== undefined &&
            value.criteriaResults?.some(
              (result) =>
                result.criterionId === "functional-criterion" &&
                result.verdict === "Pass",
            ) === true,
          60_000,
        ),
    );
    expect(accepted.acceptance?.acceptanceId).toBeTruthy();
    const completed = await waitForF18PublicStage(
      fixture,
      project.projectId,
      "child-work-completion",
      () =>
        waitForPublic(
          () =>
            client.view<{
              nodes: Array<{
                workspaceId: string;
                currentWork?: { workId?: string };
              }>;
            }>("responsibility-tree", { projectId: project.projectId }),
          (tree) =>
            tree.nodes.find((node) => node.workspaceId === child.workspaceId)
              ?.currentWork === undefined,
        ),
    );
    expect(
      completed.nodes.find((node) => node.workspaceId === child.workspaceId)
        ?.currentWork,
    ).toBeUndefined();
    expect(
      fixture.daemonErrors.filter(
        (message) =>
          !message.includes("F18_TEST_CRASH:AfterParentInboxDispositionCommit"),
      ),
    ).toEqual([]);
  }, 90_000);
});
