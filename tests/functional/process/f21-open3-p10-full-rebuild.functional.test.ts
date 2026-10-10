import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect, test } from "vitest";
import {
  ClockLive,
  IdGeneratorLive,
  layer,
  P35_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
  WorkspaceResourceActivationStoreLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import { buildSingleWorkspaceLayer } from "../../../apps/single-workspace/src/index.js";
import type {
  AttentionReq,
  AttentionRes,
} from "../../../packages/api-contracts/src/views.js";
import {
  ProjectId,
  parse,
  WorkspaceId,
} from "../../../packages/domain/src/index.js";
import {
  ProjectionQueryPort,
  TransactionPort,
  WorkspaceResourceActivationStore,
} from "../../../packages/ports/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-012345670020");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-012345670020",
);
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-012345670020";
const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
const rebuildWorker = join(
  repositoryRoot,
  "tests",
  "functional",
  "support",
  "f21-open3-full-rebuild-worker.mjs",
);

const setupLayer = (databaseFile: string) => {
  const base = layer({ filename: databaseFile });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorkspaceResourceActivationStoreLive, infra),
  );
};

const seedDatabase = async (databaseFile: string) => {
  const app = setupLayer(databaseFile);
  const setup = Effect.gen(function* () {
    yield* runMigrations(P35_MIGRATIONS);
    const sql = yield* SqlClient;
    const tx = yield* TransactionPort;
    const intents = yield* WorkspaceResourceActivationStore;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `INSERT INTO projects (
            project_id, name, root_workspace_id, project_policy,
            project_policy_revision, default_configuration, environment_ref,
            lifecycle, revision, created_at, updated_at
          ) VALUES (?, 'P10 full rebuild', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
          [projectId, workspaceId],
        );
        yield* sql.unsafe(
          `INSERT INTO workspaces (
            workspace_id, project_id, parent_workspace_id, name,
            responsibility_definition, responsibility_revision, resource_boundary,
            resource_boundary_revision, agent_binding, primary_session_id,
            current_work_id, workspace_policy, workspace_policy_revision,
            revision, lifecycle, created_at, updated_at
          ) VALUES (?, ?, NULL, 'root', '{}', 0,
            '{"basisResponsibilityRevision":0,"addresses":[{"_tag":"FileTree","path":"C:/F21_PRIVATE_TEST_PATH"}]}',
            0, '{}', ?, NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
          [workspaceId, projectId, sessionId],
        );
        yield* sql.unsafe(
          `INSERT INTO sessions (
            session_id, binding_kind, workspace_id, execution_id,
            context_epoch, created_at
          ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
          [sessionId, workspaceId],
        );
        for (const [sequence, eventType, aggregateRef, payload] of [
          [1, "ProjectCreated", projectId, { _tag: "ProjectCreated" }],
          [2, "WorkspaceCreated", workspaceId, { _tag: "WorkspaceCreated" }],
          [
            3,
            "WorkspaceResourceActivationChanged",
            workspaceId,
            {
              _tag: "WorkspaceResourceActivationChanged",
              workspaceId,
              resourceBoundaryRevision: 0,
              status: "Pending",
            },
          ],
        ] as const) {
          yield* sql.unsafe(
            `INSERT INTO domain_events (
              event_id, project_id, sequence, event_type, event_version,
              occurred_at, aggregate_ref, actor, caused_by_command_id,
              caused_by_event_id, correlation_ref, payload_json
            ) VALUES (?, ?, ?, ?, 1, '2026-10-10T00:00:00.000Z', ?,
              'system:workspace-resource-activation', NULL, NULL, NULL, ?)`,
            [
              `evt_018f2b3c-4d5e-7abc-8def-01234567002${sequence}`,
              projectId,
              sequence,
              eventType,
              aggregateRef,
              JSON.stringify(payload),
            ],
          );
        }
        yield* sql.unsafe(
          "INSERT INTO project_event_sequences (project_id, last_sequence) VALUES (?, 3)",
          [projectId],
        );
        yield* sql.unsafe(
          `INSERT INTO consumer_offsets (consumer_id, project_id, last_sequence, updated_at)
           VALUES ('p10-rebuild:attention', ?, 3, 'before-full-rebuild')`,
          [projectId],
        );
      }),
    );
    yield* tx.transact(
      intents.insertPending({
        projectId,
        workspaceId,
        resourceBoundaryRevision: 0 as never,
        status: "Pending",
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-10T00:00:00.000Z",
        activatedAt: null,
      }),
    );
  });
  await Effect.runPromise(Effect.scoped(Effect.provide(setup, app)));

  const db = new DatabaseSync(databaseFile);
  try {
    db.prepare(
      "DELETE FROM domain_events WHERE project_id = ? AND event_type = 'WorkspaceResourceActivationChanged' AND json_extract(payload_json, '$.status') = 'Pending'",
    ).run(projectId);
    db.prepare(
      "DELETE FROM workspace_resource_activation_attention_rows WHERE project_id = ?",
    ).run(projectId);
    const floor = db
      .prepare(
        "SELECT MIN(sequence) AS floor FROM domain_events WHERE project_id = ?",
      )
      .get(projectId) as { floor: number };
    expect(floor.floor).toBe(1);
    return db
      .prepare(
        "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = 'p10-rebuild:attention' AND project_id = ?",
      )
      .get(projectId) as { last_sequence: number };
  } finally {
    db.close();
  }
};

const waitForMarker = async (markerFile: string, child: ChildProcess) => {
  const started = Date.now();
  while (!existsSync(markerFile)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const stderr =
        (child as ChildProcess & { testStderr?: string[] }).testStderr?.join(
          "",
        ) ?? "";
      throw new Error(
        `worker exited before marker; exit=${String(child.exitCode)} signal=${String(child.signalCode)} stderr=${stderr}`,
      );
    }
    if (Date.now() - started > 60_000) {
      throw new Error(`timed out waiting for worker marker ${markerFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return readFileSync(markerFile, "utf8");
};

const startWorker = (
  databaseFile: string,
  mode:
    | "hold-before-commit"
    | "hold-after-commit"
    | "complete-rebuild"
    | "catch-up"
    | "activate",
  markerFile: string,
  startedMarker?: string,
) => {
  const lockWaitMarker =
    mode === "activate"
      ? (startedMarker ?? `${markerFile}.lock-wait`)
      : undefined;
  const child = spawn(
    process.execPath,
    [
      rebuildWorker,
      databaseFile,
      String(projectId),
      String(workspaceId),
      mode,
      markerFile,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...(lockWaitMarker !== undefined
          ? {
              F21_ACTIVATION_LOCK_WAIT_MARKER: lockWaitMarker,
              F21_ACTIVATION_LOCK_ACQUIRED_MARKER: `${lockWaitMarker}.acquired`,
            }
          : {}),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) =>
    stderr.push(chunk.toString("utf8")),
  );
  (child as ChildProcess & { testStderr?: string[] }).testStderr = stderr;
  return child;
};

const killWorker = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      killer.once("error", reject);
      killer.once("exit", () => resolve());
    });
  } else {
    child.kill("SIGKILL");
  }
  await exited;
};

const inspectState = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile);
  try {
    return {
      offset: db
        .prepare(
          "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = 'p10-rebuild:attention' AND project_id = ?",
        )
        .get(projectId) as { last_sequence: number },
      floor: db
        .prepare(
          "SELECT MIN(sequence) AS floor FROM domain_events WHERE project_id = ?",
        )
        .get(projectId) as { floor: number },
      rows: db
        .prepare(
          "SELECT workspace_id, resource_boundary_revision FROM workspace_resource_activation_attention_rows WHERE project_id = ?",
        )
        .all(projectId),
      intent: db
        .prepare(
          "SELECT status FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId) as { status: string },
      claims: db
        .prepare(
          "SELECT COUNT(*) AS count FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
        )
        .get(workspaceId) as { count: number },
      activationStatuses: db
        .prepare(
          "SELECT payload_json FROM domain_events WHERE project_id = ? AND event_type = 'WorkspaceResourceActivationChanged' ORDER BY sequence",
        )
        .all(projectId)
        .map(
          (row) =>
            JSON.parse((row as { payload_json: string }).payload_json).status,
        ),
    };
  } finally {
    db.close();
  }
};

const makeDirectory = () => mkdtempSync(join(tmpdir(), "arbor-f21-story-l-"));

const readPublicActivationAttention = async (databaseFile: string) => {
  const app = buildSingleWorkspaceLayer({ databaseFile, projectId });
  const program = Effect.gen(function* () {
    const queries = yield* ProjectionQueryPort;
    const response = yield* queries.query<AttentionReq, AttentionRes>(
      "attention",
      { projectId },
    );
    return response.value.rows;
  });
  return Effect.runPromise(Effect.scoped(Effect.provide(program, app)));
};

test("P10 Story L rebuild rolls back snapshot/offset rewind on kill and linearizes an Active intent", async () => {
  const directory = makeDirectory();
  const databaseFile = join(directory, "story-l.sqlite");
  const markerFile = join(directory, "p10-before.marker");
  const activationMarker = join(directory, "p11-active.marker");
  const activationStarted = join(directory, "p11-started.marker");
  const rebuildMarker = join(directory, "p10-active-rebuild.marker");
  let p10: ChildProcess | undefined;
  let p11: ChildProcess | undefined;
  try {
    const originalOffset = await seedDatabase(databaseFile);
    expect(originalOffset.last_sequence).toBe(3);
    p10 = startWorker(databaseFile, "hold-before-commit", markerFile);
    const before = JSON.parse(await waitForMarker(markerFile, p10)) as {
      boundary: string;
      projectId: string;
      workspaceId: string;
    };
    expect(before).toMatchObject({
      boundary: "P10AfterActivationAttentionRowWriteBeforeProjectionCommit",
      projectId,
      workspaceId,
    });

    // A real independent P11 service/SQLite client starts while P10 holds its
    // reset+snapshot+offset-rewind transaction. It must linearize after P10 is
    // killed and rolls back, never allowing the uncommitted Pending snapshot
    // to become visible after the intent becomes Active.
    p11 = startWorker(
      databaseFile,
      "activate",
      activationMarker,
      activationStarted,
    );
    const lockWait = await waitForMarker(activationStarted, p11);
    expect(lockWait).toMatch(/SQLITE_BUSY|database is locked/i);
    const lockAcquiredMarker = `${activationStarted}.acquired`;
    expect(existsSync(lockAcquiredMarker)).toBe(false);
    await killWorker(p10);
    p10 = undefined;
    expect(await waitForMarker(lockAcquiredMarker, p11)).toContain(
      "writer lock acquired",
    );
    expect(JSON.parse(await waitForMarker(activationMarker, p11))).toEqual({
      _tag: "Activated",
    });
    await killWorker(p11);
    p11 = undefined;

    const afterP11 = inspectState(databaseFile);
    expect(afterP11.offset.last_sequence).toBe(3);
    expect(afterP11.rows).toEqual([]);
    expect(afterP11.intent.status).toBe("Active");
    expect(afterP11.claims.count).toBe(1);
    expect(afterP11.activationStatuses).toEqual(["Active"]);

    const activeRebuild = startWorker(
      databaseFile,
      "complete-rebuild",
      rebuildMarker,
    );
    p10 = activeRebuild;
    const rebuildResult = JSON.parse(
      await waitForMarker(rebuildMarker, p10),
    ) as {
      floor: number;
      replayed: number;
    };
    expect(rebuildResult.floor).toBe(1);
    expect(rebuildResult.replayed).toBe(3);
    await killWorker(p10);
    p10 = undefined;
    const afterActiveRebuild = inspectState(databaseFile);
    expect(afterActiveRebuild.intent.status).toBe("Active");
    expect(afterActiveRebuild.rows).toEqual([]);
    expect(afterActiveRebuild.offset.last_sequence).toBe(4);
    expect(afterActiveRebuild.claims.count).toBe(1);
    expect(afterActiveRebuild.activationStatuses).toEqual(["Active"]);
    expect(
      await readPublicActivationAttention(databaseFile),
    ).not.toContainEqual(
      expect.objectContaining({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
      }),
    );
  } finally {
    if (p11 !== undefined) await killWorker(p11);
    if (p10 !== undefined) await killWorker(p10);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("P10 Story L after-commit kill preserves snapshot and restarted consumer catches up", async () => {
  const directory = makeDirectory();
  const databaseFile = join(directory, "story-l.sqlite");
  const markerFile = join(directory, "p10-after.marker");
  let child: ChildProcess | undefined;
  try {
    const originalOffset = await seedDatabase(databaseFile);
    expect(originalOffset.last_sequence).toBe(3);
    child = startWorker(databaseFile, "hold-after-commit", markerFile);
    const committedMarker = JSON.parse(
      await waitForMarker(markerFile, child),
    ) as {
      boundary: string;
      floor: number;
      rewoundTo: number;
    };
    expect(committedMarker).toMatchObject({
      boundary: "P10AfterResetAndOffsetRewindCommitBeforeCatchUp",
      floor: 1,
      rewoundTo: 0,
    });
    await killWorker(child);
    child = undefined;
    const afterCommitKill = inspectState(databaseFile);
    expect(afterCommitKill.floor.floor).toBe(1);
    expect(afterCommitKill.offset.last_sequence).toBe(0);
    expect(afterCommitKill.rows).toEqual([
      { workspace_id: workspaceId, resource_boundary_revision: 0 },
    ]);
    expect(afterCommitKill.intent.status).toBe("Pending");
    expect(afterCommitKill.claims.count).toBe(0);
    expect(afterCommitKill.activationStatuses).toEqual([]);

    const pendingPublicRows = await readPublicActivationAttention(databaseFile);
    expect(pendingPublicRows).toContainEqual(
      expect.objectContaining({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
      }),
    );

    // P11 commits after the P10 reset/snapshot/rewind commit but before the
    // restarted P10 consumer confirms the Active event. Until catch-up, the
    // same public Attention query still exposes the materialized Pending row.
    const activationMarker = join(directory, "p11-active-after-rebuild.marker");
    child = startWorker(databaseFile, "activate", activationMarker);
    expect(JSON.parse(await waitForMarker(activationMarker, child))).toEqual({
      _tag: "Activated",
    });
    await killWorker(child);
    child = undefined;
    const afterActivationBeforeCatchUp = inspectState(databaseFile);
    expect(afterActivationBeforeCatchUp.intent.status).toBe("Active");
    expect(afterActivationBeforeCatchUp.rows).toHaveLength(1);
    expect(afterActivationBeforeCatchUp.claims.count).toBe(1);
    expect(await readPublicActivationAttention(databaseFile)).toContainEqual(
      expect.objectContaining({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
      }),
    );

    const catchUpMarker = join(directory, "restarted-p10-catch-up.marker");
    child = startWorker(databaseFile, "catch-up", catchUpMarker);
    const catchUp = JSON.parse(await waitForMarker(catchUpMarker, child)) as {
      fromSequence: number;
      lastSequence: number;
      applied: number;
      quarantined: number;
    };
    expect(catchUp).toEqual({
      fromSequence: 0,
      lastSequence: 4,
      applied: 3,
      quarantined: 0,
    });
    await killWorker(child);
    child = undefined;
    const afterRestartCatchUp = inspectState(databaseFile);
    expect(afterRestartCatchUp.offset.last_sequence).toBe(4);
    expect(afterRestartCatchUp.rows).toEqual([]);
    expect(afterRestartCatchUp.intent.status).toBe("Active");
    expect(afterRestartCatchUp.claims.count).toBe(1);
    expect(afterRestartCatchUp.activationStatuses).toEqual(["Active"]);
    expect(
      await readPublicActivationAttention(databaseFile),
    ).not.toContainEqual(
      expect.objectContaining({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
      }),
    );
  } finally {
    if (child !== undefined) await killWorker(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
