import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const toolNames = (call: CapturedProviderCall): ReadonlySet<string> =>
  new Set(
    call.tools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => name !== undefined),
  );

const executionsFor = (databaseFile: string, workId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT execution_id, episode_revision, settlement_kind, settlement_json
           FROM executions
          WHERE episode_kind = 'WorkEpisode' AND episode_ref = ?
          ORDER BY episode_revision, admitted_at, execution_id`,
      )
      .all(workId) as Array<{
      execution_id: string;
      episode_revision: number;
      settlement_kind: string | null;
      settlement_json: string | null;
    }>;
  } finally {
    db.close();
  }
};

const beginExternalWrite = (databaseFile: string): DatabaseSync => {
  const db = new DatabaseSync(databaseFile);
  db.exec("PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE");
  return db;
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("RAI-DG-02 terminal Provider settlement / admission / Steer race", () => {
  it("serializes settlement and Steer against an independent SQLite writer and survives pre/post-commit daemon kills", async () => {
    const marker = `RAI-RACE-${crypto.randomUUID().slice(0, 8)}`;
    let terminalRequestSeen!: () => void;
    let releaseTerminalResponse!: () => void;
    const terminalSeen = new Promise<void>((resolve) => {
      terminalRequestSeen = resolve;
    });
    const terminalResponse = new Promise<void>((resolve) => {
      releaseTerminalResponse = resolve;
    });
    const fixture = await startProductionFixture({
      reply: (call) => {
        const names = toolNames(call);
        const context = JSON.stringify(call.messages);
        if (names.has("claim_completion")) {
          return { _tag: "HttpError", status: 400 };
        }
        if (names.has("assign_work") && context.includes(marker)) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work admitted for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Complete ${marker}.`,
                  why: "qualify synchronized terminal-failure recovery",
                  constraints: ["preserve objective during DirectionGuidance"],
                  completionExpectation: "the failed revision remains held",
                  verificationMission: {
                    goal: `Verify ${marker}`,
                    criteria: [
                      {
                        criterionId: "rai-terminal-race",
                        requirement:
                          "only an explicit Steer admits revision one",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "RAI-DG-02 line 14 race qualification",
                },
              };
        }
        return { _tag: "Text", text: `Recovered ${marker}` };
      },
      beforeResponse: async (call) => {
        if (toolNames(call).has("claim_completion")) {
          terminalRequestSeen();
          await terminalResponse;
        }
        return "respond";
      },
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `RAI terminal race ${marker}`,
    );

    await submitHumanMessage(client, project, `Create ${marker}`);
    const approval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "qualify synchronized terminal failure race",
    });
    const current = await waitForPublic(
      () =>
        client.view<{ workId?: string; revision: number } | null>(
          "current-work",
          { workspaceId: project.rootWorkspaceId },
        ),
      (value) => value?.workId !== undefined,
    );
    const workId = current?.workId;
    if (workId === undefined) throw new Error("RAI race WorkId missing");

    await Promise.race([
      terminalSeen,
      delay(60_000).then(() => {
        throw new Error("terminal Provider request was not observed");
      }),
    ]);

    // The daemon has sent the terminal request but cannot receive its result
    // until the independent connection releases this write transaction.
    const settlementLock = beginExternalWrite(fixture.databaseFile);
    releaseTerminalResponse();
    await delay(150);
    expect(executionsFor(fixture.databaseFile, workId)).toEqual([
      expect.objectContaining({
        episode_revision: 0,
        settlement_kind: null,
      }),
    ]);
    settlementLock.exec("COMMIT");
    settlementLock.close();

    await waitForPublic(
      async () => executionsFor(fixture.databaseFile, workId),
      (rows) =>
        rows.length === 1 &&
        rows[0]?.settlement_kind === "Failed" &&
        rows[0]?.settlement_json?.includes(
          "ProviderFailure:RequestRejected",
        ) === true,
      60_000,
    );
    expect(executionsFor(fixture.databaseFile, workId)).toHaveLength(1);

    // Kill while the public Steer command is waiting behind a second SQLite
    // writer. No Work revision or new Execution may appear from that request.
    const beforeSteerLock = beginExternalWrite(fixture.databaseFile);
    let steerSettled = false;
    const preCommitSteer = client
      .command(project.projectId, "SteerWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: 0,
        steer: {
          severity: "Normal",
          guidance: `Explicitly retry ${marker} at revision one.`,
        },
        provenance: { source: "HumanInput" },
      })
      .then(
        () => {
          steerSettled = true;
        },
        () => {
          steerSettled = true;
        },
      );
    await delay(150);
    expect(steerSettled).toBe(false);
    await fixture.crash();
    beforeSteerLock.exec("COMMIT");
    beforeSteerLock.close();
    await preCommitSteer;
    await fixture.restart();

    const held = await client.view<{
      workId?: string;
      revision: number;
    } | null>("current-work", { workspaceId: project.rootWorkspaceId });
    expect(held).toMatchObject({ workId, revision: 0 });
    expect(executionsFor(fixture.databaseFile, workId)).toHaveLength(1);

    // Once Steer commits, immediately killing the daemon preserves r→r+1 and
    // recovery admits no more than one Execution at the new revision.
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: 0,
      steer: {
        severity: "Normal",
        guidance: `Explicitly retry ${marker} at revision one.`,
      },
      provenance: { source: "HumanInput" },
    });
    await fixture.crash();
    await fixture.restart();

    await waitForPublic(
      () =>
        client.view<{ workId?: string; revision: number } | null>(
          "current-work",
          { workspaceId: project.rootWorkspaceId },
        ),
      (value) => value?.workId === workId && value.revision === 1,
    );
    await waitForPublic(
      async () => executionsFor(fixture.databaseFile, workId),
      (rows) => rows.some((row) => row.episode_revision === 1),
      60_000,
    );
    expect(executionsFor(fixture.databaseFile, workId)).toHaveLength(2);
    expect(
      executionsFor(fixture.databaseFile, workId).filter(
        (row) => row.episode_revision === 0,
      ),
    ).toHaveLength(1);
    expect(
      executionsFor(fixture.databaseFile, workId).filter(
        (row) => row.episode_revision === 1,
      ),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 180_000);
});
