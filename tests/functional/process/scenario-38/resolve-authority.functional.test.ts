import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { functionalId } from "../../support/public-client.js";
import { p38AfterEach, startExecutableApproval } from "./support.js";

afterEach(p38AfterEach);

describe("pending P38 public Executable approval qualification", () => {
  it("enforces public ResolveExecutableApproval authority and stale-revision receipt semantics", async () => {
    const marker = `P38-RESOLVE-REJECT-${crypto.randomUUID().slice(0, 8)}`;
    const run = await startExecutableApproval(marker);
    const writeSnapshot = () => {
      const db = new DatabaseSync(run.fixture.databaseFile, { readOnly: true });
      try {
        return {
          commands: Number(
            (
              db.prepare("SELECT COUNT(*) AS count FROM commands").get() as {
                readonly count: number;
              }
            ).count,
          ),
          events: Number(
            (
              db
                .prepare("SELECT COUNT(*) AS count FROM domain_events")
                .get() as {
                readonly count: number;
              }
            ).count,
          ),
        };
      } finally {
        db.close();
      }
    };
    const writesBefore = writeSnapshot();
    const postAsActor = async (
      actor: string,
      expectedRevision: number,
      commandId = functionalId("cmd"),
    ) => {
      const response = await fetch(`${run.fixture.baseUrl}/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer local",
        },
        body: JSON.stringify({
          commandType: "ResolveExecutableApproval",
          commandId,
          projectId: run.project.projectId,
          actor,
          issuedAt: new Date().toISOString(),
          payload: {
            approvalId: run.approvalId,
            expectedRevision,
            decision: "Approve",
            reason: "P38 unauthorized/stale no-write qualification",
          },
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };

    const unauthorized = await postAsActor("user:intruder", run.revision);
    expect(unauthorized).toEqual({
      status: 403,
      body: {
        ok: false,
        status: 403,
        problem: {
          code: "authority/denied",
          category: "forbidden",
          message: "authority/denied",
          correlationId: null,
          retryDisposition: "non-retryable",
          safeDetails: { reason: "principal/actor-mismatch" },
        },
      },
    });
    expect(writeSnapshot()).toEqual(writesBefore);
    expect(run.snapshot()).toEqual(run.before);

    const staleCommandId = functionalId("cmd");
    const stale = await postAsActor(
      "user:local",
      run.revision + 1,
      staleCommandId,
    );
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual({
      ok: true,
      status: 200,
      body: {
        commandId: staleCommandId,
        resolution: "TerminalRejected",
        rejection: "RevisionConflict",
      },
    });
    const writesAfterStale = writeSnapshot();
    expect(writesAfterStale).toEqual({
      commands: writesBefore.commands + 1,
      events: writesBefore.events,
    });
    expect(run.snapshot()).toEqual(run.before);
    const staleReplay = await postAsActor(
      "user:local",
      run.revision + 1,
      staleCommandId,
    );
    expect(staleReplay).toEqual(stale);
    expect(writeSnapshot()).toEqual(writesAfterStale);
    expect(run.snapshot()).toEqual(run.before);
  }, 120_000);
});
