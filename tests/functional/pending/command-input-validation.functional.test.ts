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
import { makeWorkProvider } from "../support/work-provider.js";

const fixtures: ProductionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("F23 external command input validation", () => {
  it("rejects a malformed typed MessageId before writing canonical state", async () => {
    const fixture = await startProductionFixture({
      reply: () => ({ _tag: "Text", text: "No model call expected" }),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F23 malformed command identity",
    );

    const commandId = functionalId("cmd");
    const response = await fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify({
        commandType: "SubmitHumanMessage",
        commandId,
        projectId: project.projectId,
        actor: "user:local",
        issuedAt: new Date().toISOString(),
        payload: {
          messageId: "msg_not-a-uuid-v7",
          targetWorkspaceId: project.rootWorkspaceId,
          bodyRef: "Malformed identity must not enter the journal",
        },
      }),
    });
    const result = (await response.json()) as {
      readonly ok: boolean;
      readonly problem?: {
        readonly code: string;
        readonly message: string;
        readonly safeDetails: {
          readonly commandType?: string;
          readonly issues: ReadonlyArray<{
            readonly path: ReadonlyArray<string | number>;
            readonly rule: string;
          }>;
        };
      };
    };
    expect(response.status).toBe(400);
    expect(result).toMatchObject({
      ok: false,
      problem: {
        code: "InvalidCommandPayload",
        message: "Command payload is invalid",
        safeDetails: {
          commandType: "SubmitHumanMessage",
          issues: [{ path: ["payload", "messageId"], rule: "format" }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("msg_not-a-uuid-v7");
    const db = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT command_id FROM commands WHERE command_id = ?")
          .all(commandId),
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT command_id FROM command_attempts WHERE command_id = ?",
          )
          .all(commandId),
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT event_id FROM domain_events WHERE caused_by_command_id = ?",
          )
          .all(commandId),
      ).toEqual([]);
    } finally {
      db.close();
    }
    const transcript = await client.view<{
      entries: Array<{ body?: string }>;
    }>("transcript", {
      workspaceId: project.rootWorkspaceId,
      conversationOnly: true,
      limit: 20,
    });
    expect(
      transcript.entries.some((entry) =>
        entry.body?.includes("Malformed identity must not enter the journal"),
      ),
    ).toBe(false);
    expect(fixture.daemonErrors).toEqual([]);
  }, 45_000);

  it("rejects an acp_ ID at the public acceptance boundary", async () => {
    const marker = `F23-ACCEPT-${crypto.randomUUID().slice(0, 8)}`;
    const fixture = await startProductionFixture({
      reply: makeWorkProvider({ marker, verdict: "Pass" }),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F23 invalid AcceptanceId",
    );
    await submitHumanMessage(client, project, `请完成目标 ${marker}。`);
    const approval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "F23 exact approval",
    });
    const work = await waitForPublic(
      () =>
        client.view<{ workId?: string } | null>("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      (value) => value?.workId !== undefined,
    );
    if (work?.workId === undefined) throw new Error("approved Work missing");
    const verification = await waitForPublic(
      () =>
        client.view<{
          verificationId?: string;
          targetWorkRevision?: number;
          verdict?: string;
        }>("verification", { workId: work.workId }),
      (value) => value.verificationId !== undefined && value.verdict === "Pass",
      45_000,
    );

    await expect(
      client.command(project.projectId, "AcceptWorkOutcome", {
        acceptanceId: functionalId("acp"),
        workId: work.workId,
        targetWorkRevision: verification.targetWorkRevision,
        verificationId: verification.verificationId,
      }),
    ).rejects.toThrow();
    const unchanged = await client.view<{
      acceptance?: { acceptanceId: string };
    }>("verification", { workId: work.workId });
    expect(unchanged.acceptance).toBeUndefined();
    expect(
      await client.view<{ workId?: string; status: string } | null>(
        "current-work",
        { workspaceId: project.rootWorkspaceId },
      ),
    ).toMatchObject({ workId: work.workId, status: "Open" });
    expect(fixture.daemonErrors).toEqual([]);
  }, 70_000);
});
