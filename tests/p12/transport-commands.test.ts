import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  P38_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  makeExternalSubmissionFromServices,
  makeStaticAuthenticator,
  makeTransportCore,
} from "../../apps/single-workspace/src/transport/index.js";
import { ProjectId, parse } from "../../packages/domain/dist/index.js";
import {
  PermissionGrantRepository,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import {
  createCurrentSchemaTestDatabaseFactory,
  withSchema44TestDatabase,
} from "../support/schema44-database.js";
import {
  AGENT,
  countRows,
  createProjectEnvelope,
  HUMAN,
  PROJECT,
  projectGovernanceEnvelope,
  readTransport,
  resetResolverCalls,
  resolverCalls,
  run,
  SHELL_FILES,
  stopEnvelope,
  stubViews,
  WORKSPACE,
} from "./transport-support.js";

let schema44Factory: Awaited<
  ReturnType<typeof createCurrentSchemaTestDatabaseFactory>
>;
beforeAll(async () => {
  schema44Factory = await createCurrentSchemaTestDatabaseFactory({
    prefix: "p12-transport-template-",
  });
}, 120_000);
afterAll(() => schema44Factory.cleanup());

const itWithSchema44Database = (
  name: string,
  body: Parameters<typeof withSchema44TestDatabase>[1],
) => it(name, () => withSchema44TestDatabase(schema44Factory, body), 120_000);

describe("P12-010 transport forwards Commands through the composition root (EC-11)", () => {
  beforeEach(() => {
    resetResolverCalls();
  });

  itWithSchema44Database(
    "forwards a Command; resolver runs at the composition root; no transport write",
    async (database) => {
      const outcome = await run(
        Effect.gen(function* () {
          const submission = yield* makeExternalSubmissionFromServices({
            authenticatedHumans: [],
            directParentOf: [],
          });
          const core = makeTransportCore({
            views: stubViews(),
            authenticator: makeStaticAuthenticator({ "human-token": HUMAN }),
            submission,
          });
          const response = yield* core.submitCommand(
            { token: "human-token" },
            createProjectEnvelope(),
          );
          return { response, projects: yield* countRows("projects") };
        }),
        database.databaseFilename,
      );
      expect(outcome.response.ok).toBe(true);
      if (outcome.response.ok) {
        expect(outcome.response.body.resolution).toBe("Committed");
      }
      expect(outcome.projects).toBe(1);
      expect(resolverCalls).toBe(1);

      // CI-1: transport shells carry no mutation/resolver capability.
      for (const file of SHELL_FILES) {
        const source = readTransport(file);
        for (const forbidden of [
          "@arbor/application",
          "AuthorityResolverPort",
          "CommandGateway",
          "gateway.execute",
          "TransactionPort",
          "SqlClient",
          "persistence-sqlite",
          // RG-16: the human/parent shell plane carries no worker identity.
          "workerId",
          "WorkerIncarnationId",
          "RemoteWorker",
          "WorkerTransport",
        ]) {
          expect(source.includes(forbidden), `${file}: ${forbidden}`).toBe(
            false,
          );
        }
      }
      // The composition root owns the resolver + gateway, never a direct write.
      const composition = readTransport("composition.ts");
      expect(composition.includes("AuthorityResolverPort")).toBe(true);
      expect(composition.includes("gateway.execute")).toBe(true);
      expect(composition.includes("activeGrants")).toBe(true);
      for (const write of [
        ".create(",
        ".put(",
        ".revoke(",
        "journal.append",
        "insertCommitted",
      ]) {
        expect(composition.includes(write), `composition: ${write}`).toBe(
          false,
        );
      }
    },
  );

  it("transport never asserts authority: external Stop without a grant is denied", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        // Adapter-only resolver boundary qualification intentionally uses the
        // explicit P38 prefix; no current production composition is built.
        yield* runMigrations(P38_MIGRATIONS);
        const submission = yield* makeExternalSubmissionFromServices({
          authenticatedHumans: [],
          directParentOf: [],
        });
        const core = makeTransportCore({
          views: stubViews(),
          authenticator: makeStaticAuthenticator({ "agent-token": AGENT }),
          submission,
        });
        const response = yield* core.submitCommand(
          { token: "agent-token" },
          stopEnvelope(AGENT),
        );
        return { response, executions: yield* countRows("executions") };
      }),
    );
    expect(outcome.response.ok).toBe(false);
    if (!outcome.response.ok) {
      expect(outcome.response.problem.code).toBe("authority/denied");
      expect(outcome.response.problem.category).toBe("forbidden");
    }
    expect(outcome.executions).toBe(0);
    expect(resolverCalls).toBe(1);
  });

  it("external Stop from an authenticated human follows the resolver path", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        // Adapter-only resolver boundary qualification intentionally uses the
        // explicit P38 prefix; no current production composition is built.
        yield* runMigrations(P38_MIGRATIONS);
        const submission = yield* makeExternalSubmissionFromServices({
          authenticatedHumans: [HUMAN],
          directParentOf: [],
        });
        const core = makeTransportCore({
          views: stubViews(),
          authenticator: makeStaticAuthenticator({ "human-token": HUMAN }),
          submission,
        });
        return yield* core.submitCommand(
          { token: "human-token" },
          stopEnvelope(HUMAN),
        );
      }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // The resolver produced the trusted fact; the gateway then rejected the
      // missing execution — never an AuthorityDenied.
      expect(outcome.body.resolution).toBe("TerminalRejected");
      expect(outcome.body.rejection).not.toBe("AuthorityDenied");
    }
  });

  itWithSchema44Database(
    "persists a Workspace tool permission through the current external composition, replays after reopen and revokes it",
    async (database) => {
      const grantId = "pgr_018f2b3c-4d5e-7abc-8def-0123456789ab";
      const envelope = {
        commandType: "GrantPermission",
        commandId: "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
        projectId: PROJECT,
        actor: HUMAN,
        issuedAt: "2026-11-16T00:00:00Z",
        payload: {
          permissionGrantId: grantId,
          issuer: HUMAN,
          subject: { _tag: "WorkspaceAgent", workspaceId: WORKSPACE },
          capability: "fs:write",
          target: WORKSPACE,
          expiresAt: null,
        },
      };
      await run(
        Effect.gen(function* () {
          const submission = yield* makeExternalSubmissionFromServices({
            authenticatedHumans: [HUMAN],
            directParentOf: [],
          });
          const core = makeTransportCore({
            views: stubViews(),
            authenticator: makeStaticAuthenticator({ "human-token": HUMAN }),
            submission,
          });
          const created = yield* core.submitCommand(
            { token: "human-token" },
            createProjectEnvelope(),
          );
          expect(created.ok && created.body.resolution).toBe("Committed");
          const response = yield* core.submitCommand(
            { token: "human-token" },
            envelope,
          );
          expect(response.ok && response.body.resolution).toBe("Committed");
          const repo = yield* PermissionGrantRepository;
          const tx = yield* TransactionPort;
          expect(yield* tx.transact(repo.activeGrants(PROJECT))).toMatchObject([
            {
              permissionGrantId: grantId,
              expiresAt: null,
              lifetime: "Workspace",
            },
          ]);
        }),
        database.databaseFilename,
      );
      await run(
        Effect.gen(function* () {
          const submission = yield* makeExternalSubmissionFromServices({
            authenticatedHumans: [HUMAN],
            directParentOf: [],
          });
          const core = makeTransportCore({
            views: stubViews(),
            authenticator: makeStaticAuthenticator({ "human-token": HUMAN }),
            submission,
          });
          const replay = yield* core.submitCommand(
            { token: "human-token" },
            envelope,
          );
          expect(replay.ok && replay.body.resolution).toBe("Committed");
          const sql = yield* SqlClient;
          const receipts = yield* sql.unsafe<{ schema_version: string }>(
            "SELECT schema_version FROM commands WHERE command_id = ?",
            [envelope.commandId],
          );
          expect(receipts).toEqual([{ schema_version: "2" }]);
          const events = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'PermissionChanged' AND caused_by_command_id = ?",
            [envelope.commandId],
          );
          expect(Number(events[0]?.count)).toBe(1);
          const revoked = yield* core.submitCommand(
            { token: "human-token" },
            {
              commandType: "RevokePermission",
              commandId: "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
              projectId: PROJECT,
              actor: HUMAN,
              issuedAt: "2026-11-16T00:01:00Z",
              payload: { permissionGrantId: grantId },
            },
          );
          expect(revoked.ok && revoked.body.resolution).toBe("Committed");
          const repo = yield* PermissionGrantRepository;
          const tx = yield* TransactionPort;
          expect(yield* tx.transact(repo.activeGrants(PROJECT))).toHaveLength(
            0,
          );
        }),
        database.databaseFilename,
      );
    },
  );

  itWithSchema44Database(
    "P15 authenticated human can rename and archive over the real external command composition",
    async (database) => {
      const outcome = await run(
        Effect.gen(function* () {
          const submission = yield* makeExternalSubmissionFromServices({
            authenticatedHumans: [HUMAN],
            directParentOf: [],
          });
          const core = makeTransportCore({
            views: stubViews(),
            authenticator: makeStaticAuthenticator({ "human-token": HUMAN }),
            submission,
          });
          const created = yield* core.submitCommand(
            { token: "human-token" },
            createProjectEnvelope(),
          );
          if (!created.ok) {
            throw new Error(
              `P15 setup CreateProject failed: ${created.problem.code}`,
            );
          }
          const missingTarget = yield* core.submitCommand(
            { token: "human-token" },
            projectGovernanceEnvelope(
              "RenameProject",
              "cmd_018f2b3c-4d5e-7abc-8def-012345678904",
              HUMAN,
              0,
              parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ac"),
            ),
          );
          const renamed = yield* core.submitCommand(
            { token: "human-token" },
            projectGovernanceEnvelope(
              "RenameProject",
              "cmd_018f2b3c-4d5e-7abc-8def-012345678901",
              HUMAN,
              0,
            ),
          );
          const closed = yield* core.submitCommand(
            { token: "human-token" },
            projectGovernanceEnvelope(
              "CloseProject",
              "cmd_018f2b3c-4d5e-7abc-8def-012345678902",
              HUMAN,
              1,
            ),
          );
          const afterClose = yield* core.submitCommand(
            { token: "human-token" },
            projectGovernanceEnvelope(
              "RenameProject",
              "cmd_018f2b3c-4d5e-7abc-8def-012345678903",
              HUMAN,
              2,
            ),
          );
          const sql = yield* SqlClient;
          const project = yield* sql.unsafe<{
            name: string;
            lifecycle: string;
            revision: number;
          }>(
            "SELECT name, lifecycle, revision FROM projects WHERE project_id = ?",
            [PROJECT],
          );
          const events = yield* sql.unsafe<{ event_type: string }>(
            "SELECT event_type FROM domain_events WHERE project_id = ? ORDER BY sequence",
            [PROJECT],
          );
          const missingProject = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM projects WHERE project_id = ?",
            ["prj_018f2b3c-4d5e-7abc-8def-0123456789ac"],
          );
          return {
            created,
            missingTarget,
            renamed,
            closed,
            afterClose,
            project: project[0],
            events,
            missingProjectCount: Number(missingProject[0]?.count),
          };
        }),
        database.databaseFilename,
      );
      expect(outcome.created.ok).toBe(true);
      expect(outcome.missingTarget.ok).toBe(true);
      if (outcome.missingTarget.ok)
        expect(outcome.missingTarget.body.resolution).toBe("TerminalRejected");
      expect(outcome.missingProjectCount).toBe(0);
      expect(outcome.renamed.ok).toBe(true);
      if (outcome.renamed.ok)
        expect(outcome.renamed.body.resolution).toBe("Committed");
      expect(outcome.closed.ok).toBe(true);
      if (outcome.closed.ok)
        expect(outcome.closed.body.resolution).toBe("Committed");
      expect(outcome.afterClose.ok).toBe(true);
      if (outcome.afterClose.ok)
        expect(outcome.afterClose.body.resolution).toBe("TerminalRejected");
      expect(outcome.project).toMatchObject({
        name: "Arbor Next",
        lifecycle: "Closed",
        revision: 2,
      });
      expect(outcome.events.map(({ event_type }) => event_type)).toContain(
        "ProjectRenamed",
      );
      expect(outcome.events.map(({ event_type }) => event_type)).toContain(
        "ProjectClosed",
      );
    },
  );

  itWithSchema44Database(
    "P15 exact WorkspaceAgent grants cannot turn static Agent credentials into project governance",
    async (database) => {
      const outcome = await run(
        Effect.gen(function* () {
          const submission = yield* makeExternalSubmissionFromServices({
            authenticatedHumans: [],
            directParentOf: [],
          });
          const core = makeTransportCore({
            views: stubViews(),
            authenticator: makeStaticAuthenticator({
              "human-token": HUMAN,
              "agent-token": AGENT,
            }),
            submission,
          });
          const created = yield* core.submitCommand(
            { token: "human-token" },
            createProjectEnvelope(),
          );
          if (!created.ok) {
            throw new Error(
              `P15 setup CreateProject failed: ${created.problem.code}`,
            );
          }
          const sql = yield* SqlClient;
          for (const capability of ["RenameProject", "CloseProject"]) {
            yield* sql.unsafe(
              "INSERT INTO permission_grants (permission_grant_id, project_id, scope, issuer, lifetime, state, subject_kind, subject_ref, capability, target, valid_from, expires_at, revision) VALUES (?, ?, ?, ?, 'PT24H', 'Active', 'WorkspaceAgent', ?, ?, ?, '2026-09-01T00:00:00.000Z', '2027-09-01T00:00:00.000Z', 0)",
              [
                `pgr_${capability.toLowerCase()}`,
                PROJECT,
                `${capability}@${PROJECT}`,
                HUMAN,
                WORKSPACE,
                capability,
                PROJECT,
              ],
            );
          }
          const rename = yield* core.submitCommand(
            { token: "agent-token" },
            projectGovernanceEnvelope(
              "RenameProject",
              "cmd_018f2b3c-4d5e-7abc-8def-012345678911",
              AGENT,
              0,
            ),
          );
          const close = yield* core.submitCommand(
            { token: "agent-token" },
            projectGovernanceEnvelope(
              "CloseProject",
              "cmd_018f2b3c-4d5e-7abc-8def-012345678912",
              AGENT,
              0,
            ),
          );
          const project = yield* sql.unsafe<{
            name: string;
            lifecycle: string;
            revision: number;
          }>(
            "SELECT name, lifecycle, revision FROM projects WHERE project_id = ?",
            [PROJECT],
          );
          const projectEvents = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM domain_events WHERE project_id = ?",
            [PROJECT],
          );
          const receipts = yield* sql.unsafe<{ count: number }>(
            "SELECT COUNT(*) AS count FROM commands WHERE command_id IN (?, ?)",
            [
              "cmd_018f2b3c-4d5e-7abc-8def-012345678911",
              "cmd_018f2b3c-4d5e-7abc-8def-012345678912",
            ],
          );
          return {
            created,
            rename,
            close,
            project: project[0],
            projectEvents: Number(projectEvents[0]?.count),
            receipts: Number(receipts[0]?.count),
          };
        }),
        database.databaseFilename,
      );
      expect(outcome.created.ok).toBe(true);
      for (const denied of [outcome.rename, outcome.close]) {
        expect(denied.ok).toBe(false);
        if (!denied.ok) {
          expect(denied.status).toBe(403);
          expect(denied.problem.code).toBe("authority/denied");
          expect(denied.problem.safeDetails.reason).toBe(
            `NoApplicableGrant:${denied === outcome.rename ? "RenameProject" : "CloseProject"}`,
          );
        }
      }
      expect(outcome.project).toMatchObject({
        name: "Arbor",
        lifecycle: "Open",
        revision: 0,
      });
      expect(outcome.projectEvents).toBe(2);
      expect(outcome.receipts).toBe(0);
    },
  );
});
