import { execFile } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { seedP6InboxRebuildFixture } from "../../../apps/single-workspace/test/support/p6-inbox-rebuild-fixture.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import { makePublicClient } from "../support/public-client.js";
import {
  replaceFunctionalFixtureWithSchema48Source,
  upgradeFunctionalSchema48DatabaseToCurrent,
} from "../support/schema44-bootstrap.js";

const execFileAsync = promisify(execFile);
const fixtures: ProductionFixture[] = [];
const projectId = "prj_p6_operator_fixture";
const rootWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a455";
const workId = "wrk_p6_operator_fixture";
const verificationId = "ver_p6_operator_fixture";
const commandId = "cmd_018f2b3c-4d5e-7abc-8def-01234567a459";
const rawReceiptId = "provider-request-raw-private-018f2b3c";
const rawPath = "C:\\private\\operator\\source.json";

const operatorEnvironment = (): NodeJS.ProcessEnv => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== "psmodulepath",
    ),
  ) as NodeJS.ProcessEnv;
  if (process.platform === "win32") {
    const systemRoot = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
    env.PSModulePath = join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    );
  }
  return env;
};

const readPublicReadEffectSnapshot = (databaseFile: string) => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  const count = (table: string) =>
    Number(
      (
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count,
    );
  try {
    return {
      commands: count("commands"),
      domainEvents: count("domain_events"),
      executions: count("executions"),
      providerTurns: count("provider_turns"),
      actionIntents: count("agent_loop_step_actions"),
      canonical: database
        .prepare(
          `SELECT p.project_id, p.revision AS project_revision,
                  w.work_id, w.revision AS work_revision,
                  v.verification_id, v.updated_at AS verification_updated_at,
                  d.command_id, d.created_at AS disposition_created_at
             FROM projects p
             JOIN works w ON w.project_id = p.project_id
             JOIN verifications v ON v.work_id = w.work_id
             JOIN retry_verification_legacy_dispositions d
               ON d.source_work_id = w.work_id
            WHERE p.project_id = ?`,
        )
        .all(projectId),
      inbox: database
        .prepare(
          `SELECT workspace_id, entry_key, kind, summary, correlation_id,
                  admitted_at, consumed_at, revision, updated_at
             FROM inbox_entries ORDER BY workspace_id, entry_key`,
        )
        .all(),
    };
  } finally {
    database.close();
  }
};

afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()?.stop();
});

describe("F23/P6 operator UnboundLegacy public read qualification", () => {
  it("exposes the exact rebuilt Governance Inbox row through the production daemon without raw receipt or path leakage", async () => {
    let expectedUpdatedAt = "";
    let manifest = "";
    const fixture = await startProductionFixture({
      reply: () => "unused",
      setupProbe: async (event) => {
        if (event.stage !== "after-clone") return;
        const source = await replaceFunctionalFixtureWithSchema48Source(
          event.directory,
        );
        seedP6InboxRebuildFixture(source.databaseFile, { route: "Root" });
        const seeded = new DatabaseSync(source.databaseFile);
        try {
          seeded
            .prepare("UPDATE commands SET result_json = ? WHERE command_id = ?")
            .run(
              JSON.stringify({ providerRequestId: rawReceiptId, rawPath }),
              commandId,
            );
        } finally {
          seeded.close();
        }

        manifest = join(event.directory, "p6-public-read-rebuild.jsonl");
        const cli = join(
          process.cwd(),
          "apps",
          "single-workspace",
          "dist",
          "p6-inbox-rebuild.js",
        );
        await execFileAsync(
          process.execPath,
          [
            cli,
            "--database",
            source.databaseFile,
            "--p39-sidecar",
            source.reportFile,
            "--manifest",
            manifest,
          ],
          {
            cwd: process.cwd(),
            env: operatorEnvironment(),
            timeout: 180_000,
            windowsHide: true,
            maxBuffer: 256 * 1024,
          },
        );
        const rebuilt = new DatabaseSync(source.databaseFile, {
          readOnly: true,
        });
        try {
          const row = rebuilt
            .prepare(
              `SELECT workspace_id, kind, summary, correlation_id,
                        admitted_at, consumed_at, revision, updated_at
                   FROM inbox_entries WHERE entry_key = ?`,
            )
            .get(`retry-verification-unbound:${commandId}`) as
            | {
                workspace_id: string;
                kind: string;
                summary: string;
                correlation_id: string;
                admitted_at: string;
                consumed_at: string | null;
                revision: number;
                updated_at: string;
              }
            | undefined;
          expect(row).toMatchObject({
            workspace_id: rootWorkspaceId,
            kind: "Governance",
            summary:
              "A historical RetryVerification receipt has incomplete origin evidence.",
            correlation_id: commandId,
            admitted_at: "2026-10-18T00:00:00.000Z",
            consumed_at: null,
            revision: 1,
          });
          expectedUpdatedAt = row?.updated_at ?? "";
        } finally {
          rebuilt.close();
        }
        await upgradeFunctionalSchema48DatabaseToCurrent(source.databaseFile);
      },
    });
    fixtures.push(fixture);

    const client = makePublicClient(fixture.baseUrl);
    const beforeRead = readPublicReadEffectSnapshot(fixture.databaseFile);
    const readInbox = () =>
      client.view<{
        readonly unconsumed: ReadonlyArray<{
          readonly entryKey: string;
          readonly kind: string;
          readonly summary: string;
          readonly watermark: number;
          readonly target?: Readonly<Record<string, unknown>>;
        }>;
      }>("inbox-view", { workspaceId: rootWorkspaceId });
    const first = await readInbox();
    expect(first.unconsumed).toEqual([
      {
        entryKey: `retry-verification-unbound:${commandId}`,
        kind: "Governance",
        summary:
          "A historical RetryVerification receipt has incomplete origin evidence.",
        watermark: expect.any(Number),
        target: {
          kind: "RetryVerificationUnboundLegacy",
          commandId,
          projectId,
          sourceWorkId: workId,
          sourceVerificationId: verificationId,
          disposition: "UnboundLegacy",
          reasonCode: "OriginEvidenceIncomplete",
          createdAt: "2026-10-18T00:00:00.000Z",
          revision: 1,
          updatedAt: expectedUpdatedAt,
        },
      },
    ]);

    const publicBytes = JSON.stringify(first);
    expect(publicBytes).not.toContain(rawReceiptId);
    expect(publicBytes).not.toContain(rawPath);
    expect(publicBytes).not.toContain(fixture.databaseFile);
    expect(publicBytes).not.toContain(manifest);
    expect(await readInbox()).toEqual(first);
    expect(readPublicReadEffectSnapshot(fixture.databaseFile)).toEqual(
      beforeRead,
    );

    const durable = new DatabaseSync(fixture.databaseFile, {
      readOnly: true,
    });
    try {
      expect(
        durable
          .prepare(
            "SELECT consumed_at, revision FROM inbox_entries WHERE entry_key = ?",
          )
          .get(`retry-verification-unbound:${commandId}`),
      ).toEqual({ consumed_at: null, revision: 1 });
      expect(
        (
          durable.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ).toBe(52);
    } finally {
      durable.close();
    }
    expect(fixture.providerCalls).toHaveLength(0);
  }, 240_000);
});
