import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_MIGRATIONS,
  runMigrations,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7TestActor,
} from "../../../tests/support/p7-app.js";
import { buildSingleWorkspaceLayer } from "../src/composition.js";
import { runDaemonOnce } from "../src/main.js";

const projectId = p7Project;
const childWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a2";
const childSessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789a2";
const childWorkId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789a2";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const databaseFile = () => {
  const directory = mkdtempSync(join(tmpdir(), "blocked-workepisode-restart-"));
  if (process.platform === "win32") {
    const encoded = Buffer.from(directory, "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference='Stop'",
      `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
      "$acl=Get-Acl -LiteralPath $p",
      "$acl.SetAccessRuleProtection($true,$false)",
      "$acl.Access | ForEach-Object { [void]$acl.RemoveAccessRuleSpecific($_) }",
      "$current=[Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')",
      "$admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')",
      "$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit",
      "$allow=[Security.AccessControl.AccessControlType]::Allow",
      "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current,[Security.AccessControl.FileSystemRights]::Modify,$inherit,[Security.AccessControl.PropagationFlags]::None,$allow))",
      "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,$allow))",
      "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($admins,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,$allow))",
      "Set-Acl -LiteralPath $p -AclObject $acl",
    ].join(";");
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
  }
  directories.push(directory);
  return join(directory, "slice.db");
};

const seedDurableBlockedState = Effect.gen(function* () {
  yield* runMigrations(CURRENT_MIGRATIONS);
  yield* p7SeedProject;
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
        [childSessionId, childWorkspaceId],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,'child','{}',0,'{}',0,'{}',?,?, '{}',0,0,'Active','t','t')",
        [
          childWorkspaceId,
          projectId,
          p7RootWorkspace,
          childSessionId,
          childWorkId,
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,'child work','blocked','[]','done','{}','{}','Open',0,'t','t')",
        [childWorkId, projectId, childWorkspaceId],
      );
      // Model the durable post-offset state of the WorkBlocked P6 transaction:
      // Parent Inbox admitted, child InboxAdvanced wait cleared, and source
      // signal offset advanced together before the process stops.
      yield* sql.unsafe(
        "INSERT INTO inbox_entries (workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at) VALUES (?, 'blocked:child-work', 'WorkBlocked', 'Child Work is blocked', 'blocker-fingerprint', 't', NULL)",
        [p7RootWorkspace],
      );
      yield* sql.unsafe(
        "INSERT INTO consumer_offsets (consumer_id, project_id, last_sequence, updated_at) VALUES ('workflow-signals', ?, 1, 't')",
        [projectId],
      );
    }),
  );
});

const executionCount = (workspaceId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM executions WHERE workspace_id = ?",
      [workspaceId],
    );
    return Number(rows[0]?.count ?? 0);
  });

const runWithDatabase = <A, R>(
  filename: string,
  program: Effect.Effect<A, unknown, R>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program,
        buildSingleWorkspaceLayer({
          databaseFile: filename,
          providerTurns: [],
        }),
      ) as Effect.Effect<A, unknown, never>,
    ),
  );

describe("Blocked WorkEpisode restart readmission", () => {
  it("global scheduler re-admits durable Parent Inbox after the source offset already advanced", async () => {
    const filename = databaseFile();
    const outcome = await runWithDatabase(
      filename,
      Effect.gen(function* () {
        yield* seedDurableBlockedState;
        yield* runDaemonOnce({ principalRef: String(p7TestActor) });
        return {
          parentExecutions: yield* executionCount(p7RootWorkspace),
        };
      }),
    );
    expect(outcome.parentExecutions).toBeGreaterThan(0);
  });

  it("child scope processes its own Open Work but preserves Parent Inbox until Parent/global scope runs", async () => {
    const filename = databaseFile();
    const outcome = await runWithDatabase(
      filename,
      Effect.gen(function* () {
        yield* seedDurableBlockedState;
        yield* runDaemonOnce({
          workspaceId: childWorkspaceId as never,
          principalRef: String(p7TestActor),
        });
        const sql = yield* SqlClient;
        const parentInboxBefore = yield* sql.unsafe<{
          consumed_at: string | null;
        }>(
          "SELECT consumed_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = 'blocked:child-work'",
          [p7RootWorkspace],
        );
        const childExecutions = yield* executionCount(childWorkspaceId);
        const parentBefore = yield* executionCount(p7RootWorkspace);

        yield* runDaemonOnce({
          workspaceId: p7RootWorkspace,
          principalRef: String(p7TestActor),
        });
        return {
          parentInboxBefore,
          childExecutions,
          parentBefore,
          parentAfter: yield* executionCount(p7RootWorkspace),
        };
      }),
    );
    expect(outcome.childExecutions).toBeGreaterThan(0);
    expect(outcome.parentBefore).toBe(0);
    expect(outcome.parentInboxBefore).toEqual([{ consumed_at: null }]);
    expect(outcome.parentAfter).toBeGreaterThan(0);
  });
});
